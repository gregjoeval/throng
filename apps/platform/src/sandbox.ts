import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { CLOUDFLARE_API_HOST, interceptedHosts, outboundDecision, type OutboundAccess } from "./network";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
/** How long a script may run when its caller gives no timeout. */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

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

export interface RunOptions {
  /** What the container may reach; fixed when it starts. */
  access: OutboundAccess;
  /** How long the script may run before it is stopped. */
  timeoutMs?: number;
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
    if (url.host === CLOUDFLARE_API_HOST) {
      console.log({ event: "sandbox.cloudflare-api", method: request.method, path: url.pathname, decision });
    }
    switch (decision.action) {
      case "deny":
        return new Response(`no grant for ${request.method} ${url.host}${url.pathname}\n`, { status: 403 });
      case "pass":
        return fetch(request);
      case "bearer":
        return fetch(withBearer(request, decision.token));
      case "preview-token":
        return fetch(withBearer(request, this.env.CF_PREVIEW_TOKEN));
    }
  }
}

function withBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

/** One container per role of a run, named by the run's Workflow instance id and the role. */
export class RunSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #exports: RunSandboxState["exports"];

  constructor(ctx: RunSandboxState, env: Env) {
    super(ctx, env);
    if (ctx.container === undefined) throw new Error("The container binding is not configured");
    this.#container = ctx.container;
    this.#exports = ctx.exports;
  }

  /** Runs a bash script in /workspace, starting the container (with its grants) if needed. */
  async run(script: string, { access, timeoutMs = COMMAND_TIMEOUT_MS }: RunOptions): Promise<RunResult> {
    const startMs = await this.#ensureStarted(access, timeoutMs);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const began = Date.now();
    try {
      const process = await this.#container.exec(["bash", "-c", script], {
        cwd: "/workspace",
        env: EXEC_ENV,
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

  async destroy(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
  }

  async #ensureStarted(access: OutboundAccess, timeoutMs: number): Promise<number> {
    if (this.#container.running) return 0;
    const image = this.#container.images.sandbox;
    if (image === undefined) throw new Error("The sandbox image is not configured");
    const began = Date.now();
    this.#container.start({
      image,
      instance: "lite",
      // Only intercepted HTTPS leaves the container.
      enableInternet: false,
    });
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
