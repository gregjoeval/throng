// A local stand-in for Artifacts: bare repos in a temp directory, served over smart HTTP by real
// `git http-backend`, behind the same bearer-token check Artifacts makes. It implements `Repos`,
// so the git proxy and the task store run against it unchanged. Also `serve`, which puts a Hono
// app on a local port so real `git` can talk to it.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { copyRepoRef } from "../../src/git-client.ts";
import type { Commit, CopyRef, RepoInfo, Repos, RepoToken, TokenScope, TreeEntry } from "../../src/repos.ts";

const exec = promisify(execFile);

/** The `git` tests run: whatever is on PATH, as in CI. */
export const GIT = "git";

/** An environment for git that ignores the machine's own config and never prompts. */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    LC_ALL: "C",
  };
}

export async function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const { stdout } = await exec(GIT, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Runs git and returns its exit status and output instead of throwing on failure. */
export async function tryGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(GIT, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout, stderr };
  }
}

interface Minted {
  repo: string;
  scope: TokenScope;
  expiresAt: number;
}

interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class LocalGitHost implements Repos {
  readonly root: string;
  readonly #server: Server;
  readonly #tokens = new Map<string, Minted>();
  #minted = 0;
  /** Every `mintToken` call, in order. */
  readonly mints: { name: string; scope: TokenScope }[] = [];
  /** Every upstream request, with the bearer it carried. */
  readonly requests: { method: string; path: string; bearer: string | null }[] = [];
  /** The clock tokens expire against. */
  now: () => number = Date.now;

  private constructor(root: string, server: Server) {
    this.root = root;
    this.#server = server;
  }

  static async start(): Promise<LocalGitHost> {
    const root = await mkdtemp(join(tmpdir(), "throng-git-host-"));
    let host: LocalGitHost | undefined;
    const server = createServer((req, res) => {
      const respond = async () => {
        let response: HostResponse;
        try {
          response = await host!.#handle(req);
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(String(err));
          return;
        }
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      };
      void respond();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = new LocalGitHost(root, server);
    return host;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  /** A repo's bare directory on disk. */
  path(name: string): string {
    return join(this.root, `${name}.git`);
  }

  /** The sha `ref` points at in a repo, or null. */
  async head(name: string, ref = "refs/heads/main"): Promise<string | null> {
    const found = await tryGit(this.path(name), gitEnv(this.root), "rev-parse", "--verify", "-q", ref);
    return found.ok ? found.stdout.trim() : null;
  }

  /** Every token minted so far, so tests can check none leaked. */
  tokens(): string[] {
    return [...this.#tokens.keys()];
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.root, { recursive: true, force: true });
  }

  // --- Repos -----------------------------------------------------------------------------------

  async create(name: string, opts: { defaultBranch?: string } = {}): Promise<RepoInfo & { token: string }> {
    if (await this.#exists(name)) throw repoError("ALREADY_EXISTS", name);
    await git(
      this.root,
      gitEnv(this.root),
      "init",
      "-q",
      "--bare",
      "-b",
      opts.defaultBranch ?? "main",
      this.path(name),
    );
    await this.#allowPush(name);
    const { token } = await this.mintToken(name, "write", 3600);
    return { ...(await this.get(name)), token };
  }

  async get(name: string): Promise<RepoInfo> {
    if (!(await this.#exists(name))) throw repoError("NOT_FOUND", name);
    return { name, remote: `${this.origin}/${name}.git`, defaultBranch: "main", parent: null };
  }

  async fork(source: string, name: string): Promise<void> {
    if (!(await this.#exists(source))) throw repoError("NOT_FOUND", source);
    if (await this.#exists(name)) throw repoError("ALREADY_EXISTS", name);
    await git(this.root, gitEnv(this.root), "clone", "-q", "--bare", this.path(source), this.path(name));
    await this.#allowPush(name);
  }

  async delete(name: string): Promise<boolean> {
    const existed = await this.#exists(name);
    await rm(this.path(name), { recursive: true, force: true });
    return existed;
  }

  async list(prefix: string): Promise<string[]> {
    return (await readdir(this.root))
      .filter((f) => f.endsWith(".git"))
      .map((f) => f.slice(0, -4))
      .filter((n) => n.startsWith(prefix))
      .toSorted();
  }

  async mintToken(name: string, scope: TokenScope, ttl: number): Promise<RepoToken> {
    if (!(await this.#exists(name))) throw repoError("NOT_FOUND", name);
    this.mints.push({ name, scope });
    const token = `art_${scope}_${++this.#minted}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = this.now() + ttl * 1000;
    this.#tokens.set(token, { repo: name, scope, expiresAt });
    return { token, scope, expiresAt: new Date(expiresAt).toISOString() };
  }

  async readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null> {
    const found = await tryGit(this.path(name), gitEnv(this.root), "show", `${args.ref}:${args.path}`);
    return found.ok ? new Blob([found.stdout]) : null;
  }

  async listCommits(name: string, args: { ref: string; limit: number }): Promise<Commit[]> {
    if (!(await this.#exists(name))) throw repoError("NOT_FOUND", name);
    const format = ["%H", "%T", "%P", "%an", "%ae", "%cn", "%ce", "%at", "%ct", "%B"].join("%x00");
    const found = await tryGit(
      this.path(name),
      gitEnv(this.root),
      "log",
      "--first-parent",
      `--max-count=${args.limit}`,
      `--format=${format}%x1e`,
      args.ref,
      "--",
    );
    if (!found.ok) return [];
    return found.stdout
      .split("\x1e")
      .map((entry) => entry.replace(/^\n/, ""))
      .filter((entry) => entry !== "")
      .map((entry) => {
        const [
          hash = "",
          treeHash = "",
          parents = "",
          an = "",
          ae = "",
          cn = "",
          ce = "",
          at = "0",
          ct = "0",
          message = "",
        ] = entry.split("\0");
        return {
          hash,
          treeHash,
          message,
          author: { name: an, email: ae },
          committer: { name: cn, email: ce },
          parents: parents.split(" ").filter(Boolean),
          authoredAt: Number(at),
          committedAt: Number(ct),
        };
      });
  }

  async readCommit(): Promise<Commit | null> {
    throw new Error("LocalGitHost doesn't read commits");
  }

  async readTree(): Promise<TreeEntry[] | null> {
    throw new Error("LocalGitHost doesn't read trees");
  }

  /** The production client, over real smart HTTP to `git http-backend`. */
  async copyRef(args: CopyRef): Promise<string | null> {
    return copyRepoRef(this, fetch, args);
  }

  async readBlob(): Promise<Blob | null> {
    throw new Error("LocalGitHost doesn't read blobs");
  }

  // --- internals -------------------------------------------------------------------------------

  async #exists(name: string): Promise<boolean> {
    return (await readdir(this.root)).includes(`${name}.git`);
  }

  async #allowPush(name: string): Promise<void> {
    await git(this.path(name), gitEnv(this.root), "config", "http.receivepack", "true");
  }

  /** Checks the bearer as Artifacts would, then runs `git http-backend` as a CGI. */
  async #handle(req: IncomingMessage): Promise<HostResponse> {
    const url = new URL(req.url ?? "/", this.origin);
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
    this.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, bearer });
    const body = await readAll(req);

    const repo = /^\/([^/]+)\.git\//.exec(url.pathname)?.[1];
    const write = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
    const minted = bearer === null ? undefined : this.#tokens.get(bearer);
    if (
      minted === undefined ||
      minted.repo !== repo ||
      minted.expiresAt <= this.now() ||
      (write && minted.scope !== "write")
    ) {
      return { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="artifacts"' }, body: Buffer.from("no\n") };
    }

    const child = spawn(GIT, ["http-backend"], {
      env: {
        ...gitEnv(this.root),
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "throng",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        ...(req.headers["content-encoding"] === undefined
          ? {}
          : { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] }),
        ...(req.headers["git-protocol"] === undefined ? {} : { GIT_PROTOCOL: String(req.headers["git-protocol"]) }),
      },
    });
    // git may answer and exit before reading the whole body (a refused push, say); its reply is
    // what counts, so a broken pipe on the way in isn't an error.
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    const [out] = await Promise.all([readAll(child.stdout), new Promise((resolve) => child.on("close", resolve))]);
    const split = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, split).toString("latin1");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.split("\r\n")) {
      const colon = line.indexOf(":");
      const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    return { status, headers, body: out.subarray(split + 4) };
  }
}

/** A response a test app sent, with its body. */
export interface Recorded {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

/** Serves `app.fetch` on a local port, recording every response it sends. */
export async function serve(
  app: { fetch: (request: Request, env: unknown) => Response | Promise<Response> },
  env: unknown,
): Promise<{ origin: string; responses: Recorded[]; close: () => Promise<void> }> {
  const responses: Recorded[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = `http://${req.headers.host}${req.url}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const init = {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
      } as RequestInit;
      const response = await app.fetch(new Request(url, init), env);
      const recorded: Recorded = { status: response.status, headers: [...response.headers], body: Buffer.alloc(0) };
      responses.push(recorded);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const chunks: Buffer[] = [];
      if (response.body !== null) {
        for await (const chunk of response.body) {
          chunks.push(Buffer.from(chunk));
          res.write(chunk);
        }
      }
      recorded.body = Buffer.concat(chunks);
      res.end();
    })().catch((err: unknown) => {
      res.destroy(err as Error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    responses,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function repoError(code: "NOT_FOUND" | "ALREADY_EXISTS", name: string): Error {
  return Object.assign(new Error(`${code}: ${name}`), { code });
}
