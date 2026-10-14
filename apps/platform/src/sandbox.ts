import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { SandboxSize } from "./config";
import { interceptedHosts, outboundDecision } from "./network";
import type { OutboundAccess } from "./network";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a script may run when its caller gives no timeout. */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/**
 * The prefix `wrangler dev` gives the images it builds locally. Snapshots are a deployed Containers
 * feature only, so a local run takes none and every check's container runs the setups itself.
 */
const LOCAL_IMAGE_PREFIX = "cloudflare-dev/";
/** Where a container keeps the snapshot it took, until its run releases it. */
const SNAPSHOT_KEY = "snapshot";

// HTTPS interception re-signs traffic with the Containers CA, and exec() does not inherit the
// environment from start(), so every command gets this.
const EXEC_ENV = {
  GIT_SSL_CAINFO: CA_PATH,
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_TERMINAL_PROMPT: "0",
  // npm's update check can't reach the registry (internet is off) and cost ~10 s per `npm test`.
  npm_config_update_notifier: "false",
  NO_UPDATE_NOTIFIER: "1",
  GIT_AUTHOR_NAME: "throng",
  GIT_AUTHOR_EMAIL: "throng@localhost",
  GIT_COMMITTER_NAME: "throng",
  GIT_COMMITTER_EMAIL: "throng@localhost",
};

/** How a container starts: what it may reach and its instance type, both fixed once it runs. */
export interface StartOptions {
  /** What the container may reach; fixed when it starts. */
  access: OutboundAccess;
  /** The instance type the container starts at; a container already running keeps its own. */
  size: SandboxSize;
}

export interface RunOptions extends StartOptions {
  /** How long the script may run before it is stopped. */
  timeoutMs?: number;
  /** Variables the script gets on top of the container's own, such as a pipeline run's `THRONG_*`. */
  env?: Record<string, string>;
}

/**
 * A snapshot of a container's whole filesystem, taken once its setups ran. Snapshots have no delete
 * yet: Cloudflare keeps one until 30 days after it was taken or last restored.
 */
export interface SandboxSnapshot {
  id: string;
  /** In bytes. */
  size: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Time spent starting the container, or 0 if it was already running. */
  startMs: number;
  runMs: number;
}

interface RunSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly OutboundAuth: LoopbackForExport<typeof OutboundAuth>;
  };
}

/**
 * Every intercepted HTTPS request from the sandbox lands here. The Worker adds any credential, so no
 * token ever enters the container (where `npm test` runs untrusted code). What's allowed is decided
 * by `outboundDecision`; this only carries it out.
 */
export class OutboundAuth extends WorkerEntrypoint<Env, OutboundAccess> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const decision = outboundDecision(request.method, url, this.ctx.props);
    switch (decision.action) {
      case "deny": {
        return new Response(`no grant for ${request.method} ${url.host}${url.pathname}\n`, { status: 403 });
      }
      case "pass": {
        return fetch(request);
      }
      case "bearer": {
        return fetch(withBearer(request, decision.token));
      }
    }
  }
}

function withBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

/**
 * One container of a run, named by the run's Workflow instance id and what it runs (`grants.ts`).
 */
export class RunSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #exports: RunSandboxState["exports"];
  readonly #kv: SyncKvStorage;

  constructor(ctx: RunSandboxState, env: Env) {
    super(ctx, env);
    if (ctx.container === undefined) throw new Error("The container binding is not configured");
    this.#container = ctx.container;
    this.#exports = ctx.exports;
    this.#kv = ctx.storage.kv;
  }

  /**
   * Runs a bash script in /workspace, starting the container (with its grants and size) from the
   * image if it isn't running.
   */
  async run(
    script: string,
    { access, size, timeoutMs = COMMAND_TIMEOUT_MS, env = {} }: RunOptions,
  ): Promise<RunResult> {
    const startMs = this.#container.running ? 0 : await this.#start({ access, size }, timeoutMs, null);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const began = Date.now();
    try {
      const process = await this.#container.exec(["bash", "-c", script], {
        cwd: "/workspace",
        env: { ...env, ...EXEC_ENV },
        signal: abort.signal,
      });
      const output = await process.output();
      const decoder = new TextDecoder();
      return {
        exitCode: output.exitCode,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        startMs,
        runMs: Date.now() - began,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Starts the container from `snapshot` rather than the image, for a script that `run` runs next
   * (with a `timeoutMs` no longer than this one's). False when it didn't come up, with the container
   * stopped again, so a caller can retry or run from the image instead. A container already running
   * is left as it is.
   */
  async restore(snapshot: SandboxSnapshot, options: StartOptions, timeoutMs = COMMAND_TIMEOUT_MS): Promise<boolean> {
    if (this.#container.running) return true;
    try {
      await this.#start(options, timeoutMs, snapshot);
      return true;
    } catch (error) {
      console.warn({ event: "sandbox.restore_failed", snapshot: snapshot.id, error: String(error) });
      await this.destroy().catch(() => {});
      return false;
    }
  }

  /**
   * Snapshots the running container's whole filesystem, for other containers to start from, and
   * keeps it until `releaseSnapshot`. Null under `wrangler dev`, which takes no snapshots. Throws if
   * the container isn't running, or the snapshot fails.
   */
  async snapshot(): Promise<SandboxSnapshot | null> {
    if (this.#container.images.sandbox?.startsWith(LOCAL_IMAGE_PREFIX) ?? false) return null;
    const { id, size } = await this.#container.snapshotContainer({});
    const snapshot = { id, size };
    this.#kv.put(SNAPSHOT_KEY, snapshot);
    return snapshot;
  }

  /**
   * Lets go of the snapshot this container took, once its run is done with it, whether it finished
   * or was cancelled; nothing when it took none. Containers can't delete a snapshot yet, so this
   * records that it's no longer used, and Cloudflare deletes it 30 days after it was taken or last
   * restored. Every run releases its snapshot here, so deleting it is one change once Containers can.
   */
  releaseSnapshot(): void {
    const snapshot = this.#kv.get<SandboxSnapshot>(SNAPSHOT_KEY);
    if (snapshot === undefined) return;
    console.log({ event: "sandbox.snapshot_expires", snapshot: snapshot.id, size: snapshot.size });
    this.#kv.delete(SNAPSHOT_KEY);
  }

  async destroy(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  /** Starts the container from the image, or from `snapshot`, and returns how long that took. */
  async #start({ access, size }: StartOptions, timeoutMs: number, snapshot: SandboxSnapshot | null): Promise<number> {
    const began = Date.now();
    // Only intercepted HTTPS leaves the container.
    if (snapshot === null) {
      const image = this.#container.images.sandbox;
      if (image === undefined) throw new Error("The sandbox image is not configured");
      this.#container.start({ image, instance: size, enableInternet: false });
    } else {
      this.#container.start({ containerSnapshot: { id: snapshot.id }, instance: size, enableInternet: false });
    }
    const auth = this.#exports.OutboundAuth({ props: access });
    for (const host of interceptedHosts(access)) {
      await this.#container.interceptOutboundHttps(host, auth);
    }
    // A long script may print nothing for a while; the container must outlive it.
    await this.#container.setInactivityTimeout(Math.max(INACTIVITY_TIMEOUT_MS, timeoutMs));
    // start() isn't awaited; the first exec is when the container is actually usable.
    const probe = await this.#container.exec(["true"]);
    await probe.exitCode;
    return Date.now() - began;
  }
}
