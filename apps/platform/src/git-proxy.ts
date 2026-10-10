// The git proxy: serves a project's repos over git's smart HTTP at
//
//   /git/<owner>/<project>.git/*          the origin, `<projectId>-main`
//   /git/<owner>/<project>/t42a3.git/*    an attempt's fork, `<projectId>-t42a3`
//
// and passes `info/refs`, `git-upload-pack` and `git-receive-pack` through to Artifacts with a
// token minted by Throng, which never reaches the client. Callers authenticate with a Throng token
// as the Basic password. Any valid token may read; pushes are checked against claims first. See
// the spec's "Git proxy" section and `docs/research/git-proxy.md`.

import { Hono, type Context } from "hono";
import { gitAuth, type AuthEnv, type AuthOptions } from "./auth.ts";
import { ServiceError } from "./errors.ts";
import {
  concat,
  isDelete,
  ProtocolError,
  readPushRequest,
  rejectionReport,
  updatedRefs,
  type PushRequest,
  type RefUpdate,
} from "./pkt-line.ts";
import { resolveProject } from "./projects.ts";
import { forkRepo, originRepo, type Repos, type TokenScope } from "./repos.ts";
import { attemptRef, parseAttemptRef, type AttemptInput, type ProjectContext, type TaskMethod } from "./task-store.ts";
import type { TaskBackend } from "./tasks.ts";
import type { AccessBindings } from "./access.ts";

/** How long a minted Artifacts token lives. */
export const UPSTREAM_TOKEN_TTL_SECONDS = 60 * 60;
/** A cached token is replaced once it has less than this left, so no request carries a dying one. */
export const UPSTREAM_TOKEN_MARGIN_MS = 5 * 60 * 1000;
/** Most bytes of a receive-pack response kept to read its report; the rest still reaches the client. */
const MAX_REPORT_BYTES = 1024 * 1024;

const REMOTE_PATH = /^\/git\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = ["git-upload-pack", "git-receive-pack"] as const;
type Service = (typeof SERVICES)[number];

/** Request headers git sends that Artifacts needs; everything else, cookies included, is dropped. */
const FORWARDED_REQUEST_HEADERS = ["Accept", "Content-Encoding", "Content-Type", "Git-Protocol", "User-Agent"];
/** Response headers passed back. `WWW-Authenticate` never is, so git never prompts for Artifacts' credentials. */
const FORWARDED_RESPONSE_HEADERS = ["Cache-Control", "Content-Type", "Expires", "Pragma"];

const MAIN = "refs/heads/main";

export interface GitProxyOptions extends AuthOptions {
  /** The environment's repos: production passes the Artifacts-backed `reposFor`, tests a local git server. */
  repos: (env: AccessBindings) => Repos;
  /** The task backend for a project id, as the API takes it. */
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend;
  /** The fetch that reaches Artifacts; tests may pass their own. */
  fetch?: typeof fetch;
}

/** Which repo a request addresses, and what it asks for. */
interface Target {
  project: ProjectContext;
  /** The attempt whose fork it is, or null for the origin. */
  attempt: AttemptInput | null;
  repo: string;
  service: Service;
  /** `info/refs`, or the service's POST endpoint. */
  endpoint: "info/refs" | Service;
}

type GitContext = Context<AuthEnv>;

/** The `/git` routes. Mount with `app.route("/git", gitRoutes(...))`. */
export function gitRoutes(options: GitProxyOptions) {
  const upstreamFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const tokens = new UpstreamTokens(options.now ?? (() => new Date()));
  const app = new Hono<AuthEnv>();

  app.use("*", gitAuth(options));
  app.all("*", async (c) => {
    const target = await resolveTarget(c);
    if (target instanceof Response) return target;
    const backend = options.tasks(c.env)(target.project.id);
    const repos = options.repos(c.env);
    const scope: TokenScope = target.service === "git-receive-pack" ? "write" : "read";

    let pushed: PushRequest | null = null;
    if (target.service === "git-receive-pack") {
      // Claims are checked on every push request, so a hand-off or close between git's requests counts.
      const claim =
        target.attempt === null
          ? null
          : await call(backend, "authorizePush", [target.project, c.var.actor, target.attempt]);
      if (target.endpoint === "info/refs") {
        if (claim !== null) return text(claim.code === "not_found" ? 404 : 403, `Push rejected: ${claim.message}`);
      } else {
        const read = await readCommands(c);
        if (read instanceof Response) return read;
        pushed = read;
        const refusal = claim?.message ?? (target.attempt === null ? originRefusal(pushed.updates) : null);
        if (refusal !== null) return reject(c, target, pushed, refusal);
      }
    }

    let upstream: Response;
    try {
      upstream = await forward(c, target, scope, pushed, { repos, tokens, fetch: upstreamFetch });
    } catch (err) {
      if ((err as { code?: unknown }).code === "NOT_FOUND") return text(404, `No repository at ${c.req.path}`);
      throw err;
    }
    if (upstream.status === 401 || upstream.status === 403 || (upstream.status >= 300 && upstream.status < 400)) {
      tokens.forget(target.repo, scope);
      console.error({ event: "git.upstream_refused", repo: target.repo, scope, status: upstream.status });
      await upstream.body?.cancel();
      return text(502, "The repository host refused Throng's credentials. Try again.");
    }

    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    let body = upstream.body;
    if (upstream.ok && body !== null && pushed !== null && target.attempt !== null && pushed.updates.length > 0) {
      const [client, report] = body.tee();
      body = client;
      const attempt = target.attempt;
      const update = pushed;
      background(
        c,
        recordPush(report, update, (updates) =>
          backend.call("recordPush", [target.project, c.var.actor, { ...attempt, updates }]),
        ),
      );
    }
    return new Response(body, { status: upstream.status, headers });
  });

  return app;
}

/** Reads the request's path into a target, or answers it when it names nothing we serve. */
async function resolveTarget(c: GitContext): Promise<Target | Response> {
  const match = REMOTE_PATH.exec(c.req.path);
  if (match === null) return text(404, "Not a Throng git remote. Remotes look like /git/<owner>/<project>.git.");
  const [, owner = "", handle = "", attemptSegment, endpoint = ""] = match;

  let service: Service;
  if (endpoint === "info/refs") {
    const asked = c.req.query("service");
    if (c.req.method !== "GET" || !isService(asked)) return text(403, "Throng serves git over smart HTTP only.");
    service = asked;
  } else {
    if (c.req.method !== "POST" || !isService(endpoint)) return text(404, "Not found.");
    service = endpoint;
  }

  let attempt: AttemptInput | null = null;
  if (attemptSegment !== undefined) {
    attempt = parseAttemptRef(attemptSegment);
    if (attempt === null || attemptRef(attempt.task, attempt.number) !== attemptSegment) {
      return text(404, `No attempt ${attemptSegment}. Attempt remotes look like /git/<owner>/<project>/t42a3.git.`);
    }
  }

  const found = await resolveProject(c.env.DB, owner, handle);
  if (found === null) return text(404, `No project ${owner}/${handle}.`);
  const project = { id: found.id, owner: found.owner.id };
  const repo =
    attempt === null ? originRepo(project.id) : forkRepo(project.id, attemptRef(attempt.task, attempt.number));
  return { project, attempt, repo, service, endpoint: endpoint === "info/refs" ? "info/refs" : service };
}

/**
 * Why a push to the origin is refused, or null to let it through. `main` only advances through the
 * merge queue. Every other branch belongs to push-to-create, which turns it into an attempt; until
 * that lands (#108), those are refused too. A probe, with no updates, goes through.
 */
function originRefusal(updates: RefUpdate[]): Refusal | null {
  if (updates.length === 0) return null;
  return (update) => {
    if (update.ref === MAIN) return "main only advances through the merge queue; push to an attempt's fork instead";
    if (isDelete(update)) return "the origin keeps no branches but main";
    return "pushing a branch to the origin isn't supported yet; push to an attempt's fork instead";
  };
}

/** Why a push is refused: one reason for every ref, or a reason per ref. */
type Refusal = string | ((update: RefUpdate) => string);

/** Reads the receive-pack command list off the request body, or answers a body we won't forward. */
async function readCommands(c: GitContext): Promise<PushRequest | Response> {
  const encoding = c.req.header("Content-Encoding");
  if (encoding !== undefined && encoding !== "identity") return text(415, "Compressed pushes aren't supported.");
  const body = c.req.raw.body;
  if (body === null) return text(400, "A push needs a body.");
  const reader = body.getReader();
  try {
    return await readPushRequest(reader);
  } catch (err) {
    if (!(err instanceof ProtocolError)) throw err;
    await reader.cancel().catch(() => {});
    return text(400, `Push rejected: ${err.message}.`);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Refuses a push without contacting Artifacts: a `report-status` marking every ref `ng` with its
 * reason when the client asked for one, so git prints them per ref, or a plain 403 otherwise.
 */
async function reject(c: GitContext, target: Target, push: PushRequest, refusal: Refusal): Promise<Response> {
  const reasons = push.updates.map((update) => (typeof refusal === "string" ? refusal : refusal(update)));
  console.log({
    event: "git.push_rejected",
    repo: target.repo,
    user: c.var.actor.user.id,
    agent: c.var.actor.agent,
    refs: push.updates.map((u) => u.ref),
  });
  // Read the rest of the pack, so the client sees our answer rather than a broken pipe.
  await c.req.raw.body?.pipeTo(new WritableStream()).catch(() => {});
  const report = push.updates.length === 0 ? null : rejectionReport(push, reasons);
  if (report === null) return text(403, `Push rejected: ${reasons[0] ?? refusal}`);
  return new Response(report, {
    status: 200,
    headers: { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-cache" },
  });
}

interface Upstream {
  repos: Repos;
  tokens: UpstreamTokens;
  fetch: typeof fetch;
}

/** Sends the request on to the repo in Artifacts with Throng's token, replaying any body already read. */
async function forward(
  c: GitContext,
  target: Target,
  scope: TokenScope,
  pushed: PushRequest | null,
  { repos, tokens, fetch }: Upstream,
): Promise<Response> {
  const { remote, token } = await tokens.get(repos, target.repo, scope);
  const url =
    target.endpoint === "info/refs" ? `${remote}/info/refs?service=${target.service}` : `${remote}/${target.endpoint}`;
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  let body: ReadableStream<Uint8Array> | null = null;
  if (c.req.method === "POST") {
    body = pushed === null ? c.req.raw.body : replay(pushed.consumed, c.req.raw.body, contentLength(c));
  }
  // `manual`, so a redirect can't carry our token to another host. `duplex` is for Node's fetch.
  const init = { method: c.req.method, headers, body, redirect: "manual", duplex: "half" } as RequestInit;
  return fetch(url, init);
}

/** A stream of `prefix` and then the rest of `rest`, spliced natively where the runtime can. */
function replay(
  prefix: Uint8Array,
  rest: ReadableStream<Uint8Array> | null,
  length: number | null,
): ReadableStream<Uint8Array> {
  const { readable, writable } = passThrough(length);
  void (async () => {
    const writer = writable.getWriter();
    await writer.write(prefix);
    if (rest === null) return writer.close();
    writer.releaseLock();
    return rest.pipeTo(writable);
  })().catch((cause: unknown) => {
    console.error({ event: "git.replay_failed", error: String(cause) });
  });
  return readable;
}

/**
 * An identity stream. In Workers a known length keeps the upstream request's `Content-Length` and a
 * native stream keeps the copy off the JS thread; elsewhere (Node tests) a plain `TransformStream`.
 */
function passThrough(length: number | null): ByteStream {
  const { FixedLengthStream, IdentityTransformStream } = globalThis as WorkersStreams;
  if (length !== null && FixedLengthStream !== undefined) return new FixedLengthStream(length);
  if (IdentityTransformStream !== undefined) return new IdentityTransformStream();
  return new TransformStream<Uint8Array, Uint8Array>();
}

type ByteStream = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** The Workers-only streams, looked up at runtime so the module also loads in Node. */
interface WorkersStreams {
  FixedLengthStream?: new (length: number) => ByteStream;
  IdentityTransformStream?: new () => ByteStream;
}

function contentLength(c: GitContext): number | null {
  const length = Number(c.req.header("Content-Length") ?? NaN);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/** Journals the refs Artifacts reports it updated, once the response has been read. */
async function recordPush(
  report: ReadableStream<Uint8Array>,
  push: PushRequest,
  record: (updates: RefUpdate[]) => Promise<unknown>,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of report) {
    // Keep reading past the cap: a tee'd branch left unread would buffer the rest of the response.
    if (size < MAX_REPORT_BYTES) chunks.push(chunk);
    size += chunk.length;
  }
  const ok = new Set(updatedRefs(concat(chunks), push.capabilities.has("side-band-64k")));
  const updates = push.updates.filter((u) => ok.has(u.ref));
  if (updates.length > 0) await record(updates);
}

/** Runs `work` after the response, in a Worker for as long as it needs; logs its failure. */
function background(c: GitContext, work: Promise<void>): void {
  const logged = work.catch((cause: unknown) => {
    console.error({ event: "git.record_push_failed", error: String(cause) });
  });
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    // Not in a Worker (Node tests): the promise runs on its own.
  }
}

/** Calls a task method; null when it succeeds, its `ServiceError` when it refuses. */
async function call(backend: TaskBackend, method: TaskMethod, args: unknown[]): Promise<ServiceError | null> {
  const outcome = await backend.call(method, args);
  return outcome.ok ? null : new ServiceError(outcome.code, outcome.message);
}

function isService(value: string | undefined): value is Service {
  return (SERVICES as readonly (string | undefined)[]).includes(value);
}

/** A plain-text answer; git prints a `text/plain` error body to the user. */
function text(status: 400 | 403 | 404 | 415 | 502, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

interface CachedToken {
  remote: string;
  token: string;
  /** Ms since epoch. */
  expiresAt: number;
}

/**
 * Artifacts tokens cached per repo and scope for this isolate, so git traffic doesn't mint one per
 * request against the namespace's control-plane limit. A token is replaced once it is within
 * `UPSTREAM_TOKEN_MARGIN_MS` of expiring; concurrent requests share one mint.
 */
export class UpstreamTokens {
  readonly #now: () => Date;
  readonly #cache = new Map<string, Promise<CachedToken>>();

  constructor(now: () => Date) {
    this.#now = now;
  }

  async get(repos: Repos, repo: string, scope: TokenScope): Promise<CachedToken> {
    const key = `${repo} ${scope}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      const found = await cached.catch(() => null);
      if (found !== null && found.expiresAt - this.#now().getTime() > UPSTREAM_TOKEN_MARGIN_MS) return found;
      if (this.#cache.get(key) !== cached) return this.get(repos, repo, scope);
    }
    this.#prune();
    const minting = this.#mint(repos, repo, scope);
    this.#cache.set(key, minting);
    minting.catch(() => {
      if (this.#cache.get(key) === minting) this.#cache.delete(key);
    });
    return minting;
  }

  /** Drops a cached token, e.g. after Artifacts refused it. */
  forget(repo: string, scope: TokenScope): void {
    this.#cache.delete(`${repo} ${scope}`);
  }

  async #mint(repos: Repos, repo: string, scope: TokenScope): Promise<CachedToken> {
    const { remote } = await repos.get(repo);
    const minted = await repos.mintToken(repo, scope, UPSTREAM_TOKEN_TTL_SECONDS);
    return { remote: remote.replace(/\/+$/, ""), token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
  }

  /** Forgets settled tokens past their expiry, so the cache doesn't grow with every repo ever served. */
  #prune(): void {
    const now = this.#now().getTime();
    for (const [key, entry] of this.#cache) {
      void entry.then(
        (t) => {
          if (t.expiresAt <= now && this.#cache.get(key) === entry) this.#cache.delete(key);
        },
        () => {},
      );
    }
  }
}
