import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// HTTPS interception re-signs traffic with the Containers CA, and exec() does not inherit the
// environment from start(), so every command gets this.
const EXEC_ENV = {
  GIT_SSL_CAINFO: CA_PATH,
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "throng",
  GIT_AUTHOR_EMAIL: "throng@localhost",
  GIT_COMMITTER_NAME: "throng",
  GIT_COMMITTER_EMAIL: "throng@localhost",
};

/** Git remotes the sandbox may reach, each with the token the Worker adds on its behalf. */
export interface GitGrant {
  remote: string;
  token: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Time spent starting the container, or 0 if it was already running. */
  startMs: number;
  runMs: number;
}

interface GitAuthProps {
  grants: GitGrant[];
}

interface CheckSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly GitAuth: LoopbackForExport<typeof GitAuth>;
  };
}

/**
 * Every HTTPS request the sandbox makes to the Artifacts host lands here. The Worker adds the
 * repo's token, so the token never enters the container (where `npm test` runs untrusted code).
 */
export class GitAuth extends WorkerEntrypoint<Env, GitAuthProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const grant = this.ctx.props.grants.find((g) => {
      const remote = new URL(g.remote);
      return (
        url.host === remote.host && (url.pathname === remote.pathname || url.pathname.startsWith(`${remote.pathname}/`))
      );
    });
    if (grant === undefined || url.protocol !== "https:") {
      return new Response(`no grant for ${url.host}${url.pathname}\n`, { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${grant.token}`);
    return fetch(new Request(request, { headers }));
  }
}

/** One container per check, named by the check's Workflow instance id. */
export class CheckSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #exports: CheckSandboxState["exports"];

  constructor(ctx: CheckSandboxState, env: Env) {
    super(ctx, env);
    if (ctx.container === undefined) throw new Error("The container binding is not configured");
    this.#container = ctx.container;
    this.#exports = ctx.exports;
  }

  /** Runs a bash script in /workspace, starting the container (with git grants) if needed. */
  async run(script: string, grants: GitGrant[]): Promise<RunResult> {
    const startMs = await this.#ensureStarted(grants);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), COMMAND_TIMEOUT_MS);
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

  async #ensureStarted(grants: GitGrant[]): Promise<number> {
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
    const auth = this.#exports.GitAuth({ props: { grants } });
    for (const host of new Set(grants.map((g) => new URL(g.remote).host))) {
      await this.#container.interceptOutboundHttps(host, auth);
    }
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    // start() isn't awaited; the first exec is when the container is actually usable.
    const probe = await this.#container.exec(["true"]);
    await probe.exitCode;
    return Date.now() - began;
  }
}
