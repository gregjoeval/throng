// The git proxy: serves a project's repos over git's smart HTTP at
//
//   /git/<owner>/<project>.git/*          the origin, `<projectId>-main`
//   /git/<owner>/<project>/t42a3.git/*    an attempt's fork, `<projectId>-t42a3`
//
// and passes `info/refs`, `git-upload-pack` and `git-receive-pack` through to Artifacts with a
// token minted by Throng, which never reaches the client. Callers authenticate with a Throng token
// as the Basic password or a bearer header. Any valid token may read; pushes are checked against claims first. A push
// of a branch to the origin never lands there: push-to-create sends it to an attempt's fork (see
// `pushToCreate`). See the spec's "Git proxy" and "Push-to-create" sections and
// `docs/research/git-proxy.md`.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AccessBindings } from "./access.ts";
import { gitAuth } from "./auth.ts";
import type { AuthEnv, AuthOptions } from "./auth.ts";
import { taskBranchHead } from "./base.ts";
import { ServiceError } from "./errors.ts";
import { attemptRemote } from "./git-remotes.ts";
import {
  commandList,
  concat,
  isDelete,
  ProtocolError,
  readPushRequest,
  readReport,
  rejectionReport,
  renameRefs,
  updatedRefs,
  writeReport,
  zeroId,
} from "./pkt-line.ts";
import type { PushReport, PushRequest, RefUpdate } from "./pkt-line.ts";
import { resolveProject } from "./projects.ts";
import { forkRepo, originRepo } from "./repos.ts";
import type { Repos, TokenScope } from "./repos.ts";
import { headAttemptRef } from "./scoring.ts";
import type { ScoringRequest } from "./scoring.ts";
import {
  attemptRef,
  isTaskBranchNamespace,
  parseAttemptRef,
  parseTaskBranchRef,
  taskBranchRef,
  taskRef,
} from "./task-refs.ts";
import type {
  AttemptInput,
  BranchRoute,
  ProjectContext,
  PushNotice,
  PushRecord,
  StoredAttempt,
  StoredTask,
  TaskMethod,
} from "./task-store.ts";
import type { TaskBackend } from "./tasks.ts";

/** How long a minted Artifacts token lives. */
export const UPSTREAM_TOKEN_TTL_SECONDS = 60 * 60;
/** A cached token is replaced once it has less than this left, so no request carries a dying one. */
export const UPSTREAM_TOKEN_MARGIN_MS = 5 * 60 * 1000;

const REMOTE_PATH = /^\/git\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u;
const SERVICES = ["git-upload-pack", "git-receive-pack"] as const;
type Service = (typeof SERVICES)[number];

/** Request headers git sends that Artifacts needs; everything else, cookies included, is dropped. */
const FORWARDED_REQUEST_HEADERS = ["Accept", "Content-Encoding", "Content-Type", "Git-Protocol", "User-Agent"];
/** Response headers passed back. `WWW-Authenticate` never is, so git never prompts for Artifacts' credentials. */
const FORWARDED_RESPONSE_HEADERS = ["Cache-Control", "Content-Type", "Expires", "Pragma"];

const MAIN = "refs/heads/main";
const BRANCH_PREFIX = "refs/heads/";
/** How long push-to-create waits for a new fork to be readable before giving up on the push. */
const FORK_READY_TIMEOUT_MS = 60_000;
const FORK_READY_POLL_MS = 250;

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
    let taskBranch: number | null = null;
    if (target.service === "git-receive-pack") {
      // Claims are checked on every push request, so a hand-off or close between git's requests counts.
      const claim =
        target.attempt === null
          ? null
          : await call(backend, "authorizePush", [target.project, c.var.actor, target.attempt]);
      if (target.endpoint === "info/refs") {
        if (claim !== null) return text(claim.code === "notFound" ? 404 : 403, `Push rejected: ${claim.message}`);
      } else {
        const read = await readCommands(c);
        if (read instanceof Response) return read;
        pushed = read;
        const refusal = claim?.message ?? (target.attempt === null ? originRefusal(pushed) : null);
        if (refusal !== null) return reject(c, target, pushed, refusal);
        taskBranch = target.attempt === null ? taskBranchPush(pushed) : null;
        if (taskBranch !== null) {
          const task = taskBranch;
          const outcome = await backend.call("authorizeTaskBranchPush", [target.project, c.var.actor, { task }]);
          if (!outcome.ok) return reject(c, target, pushed, outcome.message);
        } else if (target.attempt === null && pushed.updates.length > 0) {
          return pushToCreate(c, target, pushed, backend, { repos, tokens, fetch: upstreamFetch });
        }
      }
    }

    let upstream: Response;
    try {
      const prefix = pushed === null ? null : { bytes: pushed.consumed, length: contentLength(c) };
      upstream = await forward(c, target, scope, prefix, { repos, tokens, fetch: upstreamFetch });
    } catch (error) {
      if ((error as { code?: unknown }).code === "NOT_FOUND") return text(404, `No repository at ${c.req.path}`);
      throw error;
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
    if (
      upstream.ok &&
      upstream.body !== null &&
      pushed !== null &&
      target.attempt !== null &&
      pushed.updates.length > 0
    ) {
      const reply = await recordForkPush(c, target, target.attempt, pushed, backend, upstream);
      return new Response(reply, { status: upstream.status, headers });
    }
    if (upstream.ok && upstream.body !== null && pushed !== null && taskBranch !== null) {
      const reply = await recordTaskBranchPush(c, target, taskBranch, pushed, backend, upstream);
      return new Response(reply, { status: upstream.status, headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
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
 * merge queue, and the origin keeps no other refs but task branches. A push of one task branch
 * (`refs/tasks/t42`) goes to the origin once its task allows the pusher (`taskBranchPush`). A push
 * of one branch goes to push-to-create, which sends it to an attempt's fork; one pack can only land
 * in one repo, so a push of several refs is refused whole. A probe, with no updates, goes through.
 */
function originRefusal(push: PushRequest): Refusal | null {
  const { updates } = push;
  const reasons = updates.map((update): string | null => {
    if (update.ref === MAIN) return "main only advances through the merge queue; push to an attempt's fork instead";
    if (isTaskBranchNamespace(update.ref)) {
      if (parseTaskBranchRef(update.ref) === null) return "task branches look like refs/tasks/t42";
      if (isDelete(update)) return "a task branch can't be deleted";
      if (updates.length > 1) return "push a task branch on its own";
      return null;
    }
    if (!update.ref.startsWith(BRANCH_PREFIX))
      return "the origin keeps no refs but main and task branches; push a branch to make an attempt";
    if (isDelete(update)) return "the origin keeps no branches but main";
    if (updates.length > 1) return "push one branch at a time to the origin; each becomes its own attempt";
    if (!push.capabilities.has("report-status") && !push.capabilities.has("report-status-v2")) {
      return "pushing a branch to the origin needs a git that asks for report-status";
    }
    return null;
  });
  if (reasons.every((r) => r === null)) return null;
  return (update) => reasons[updates.indexOf(update)] ?? "rejected";
}

/** The task whose task branch a push to the origin updates, or null when it updates none. */
function taskBranchPush({ updates: [update, ...rest] }: PushRequest): number | null {
  if (update === undefined || rest.length > 0) return null;
  return parseTaskBranchRef(update.ref);
}

/**
 * Push-to-create: sends a push of origin branch `B` to an attempt's fork as its `main`. The task
 * store routes it (`routeBranchPush`) to the pusher's own active attempt on `B`, or to a new
 * attempt, refusing it when `B` is someone else's or a `t<n>/` task can't take it. For a new
 * attempt the order is:
 *
 * 1. the store holds `B`, draws the numbers and forks the origin;
 * 2. the proxy waits for the fork and forwards the push to it, renamed to `refs/heads/main`;
 * 3. once the fork reports the ref updated, the store reads the head commit back through `Repos`
 *    and creates the task (titled from the commit) and the opened attempt (`completeBranchPush`).
 *
 * The task needs the commit's message, which can only be read once the pack is indexed, and the
 * new fork is the one place it may land: the origin never stores branches but `main`. Any failure
 * after step 1, a refused push included, abandons it (`abandonBranchPush`): the fork is deleted
 * and the branch freed, so no fork, attempt or task is left behind. The client only sees `ok` once
 * the attempt exists.
 *
 * The response is buffered so the report can name `B` rather than the fork's `main`, and carry
 * `remote:` lines with the task's URL and the attempt's remote. A receive-pack response is a
 * report and some progress, never a pack, so buffering it is cheap.
 *
 * The client builds its pack against the origin's `main`, so a later push lands only if the fork
 * has those objects: after `main` moves on, a push that builds on the new `main` must go to the
 * attempt's own remote instead.
 */
async function pushToCreate(
  c: GitContext,
  target: Target,
  push: PushRequest,
  backend: TaskBackend,
  upstream: Upstream,
): Promise<Response> {
  const [update] = push.updates as [RefUpdate];
  const branch = update.ref.slice(BRANCH_PREFIX.length);
  const { project } = target;
  const actor = c.var.actor;
  // A fork that can't be made fails here; the store has already freed the branch.
  const routed = await backend.call("routeBranchPush", [project, actor, { branch }]).catch((error: unknown) => {
    console.error({ event: "git.push_to_create_failed", branch, error: String(error) });
    return null;
  });
  if (routed === null) return text(502, `Couldn't make a fork for ${branch}. Try again.`);
  if (!routed.ok) return reject(c, target, push, routed.message);
  const route = routed.value as BranchRoute;
  const attempt: AttemptInput =
    route.kind === "attempt"
      ? { task: route.attempt.task, number: route.attempt.number }
      : { task: route.task, number: route.number };
  const name = attemptRef(attempt.task, attempt.number);
  const fork = forkRepo(project.id, name);

  let pending = route.kind === "create";
  const abandon = async () => {
    if (!pending) return;
    pending = false;
    const undone = await backend.call("abandonBranchPush", [project, actor, attempt]);
    if (!undone.ok) console.error({ event: "git.abandon_failed", repo: fork, error: undone.message });
  };

  try {
    if (pending) await forkReady(upstream.repos, fork);
    const [head] = await upstream.repos.listCommits(fork, { ref: "main", limit: 1 });
    const before = head?.hash ?? zeroId(update.after);
    const forkUpdate: RefUpdate = { ref: MAIN, before, after: update.after };
    const commands = commandList(push, [forkUpdate]);
    const length = contentLength(c);
    const prefix: Prefix = {
      bytes: concat([commands, push.consumed.subarray(push.commandLength)]),
      length: length === null ? null : length - push.commandLength + commands.length,
    };
    const forkTarget: Target = { ...target, attempt, repo: fork, endpoint: "git-receive-pack" };
    const response = await forward(c, forkTarget, "write", prefix, upstream);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) upstream.tokens.forget(fork, "write");
      console.error({ event: "git.upstream_failed", repo: fork, status: response.status });
      await abandon();
      return text(502, `The repository host refused the push to ${name}. Try again.`);
    }

    const sideband = push.capabilities.has("side-band-64k");
    let report: PushReport;
    try {
      report = readReport(new Uint8Array(await response.arrayBuffer()), sideband);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      report = { lines: ["unpack ok", `ng ${MAIN} the repository host's reply couldn't be read`], other: [] };
    }
    const landed = report.lines.includes("unpack ok") && report.lines.includes(`ok ${MAIN}`);

    let messages: string[] = [];
    if (!landed) {
      await abandon();
      if (route.kind === "attempt" && nonFastForward(report)) messages = await pullFirst(target, attempt, c, backend);
    } else if (route.kind === "create") {
      const done = await backend.call("completeBranchPush", [
        project,
        actor,
        { ...attempt, head: update.after, updates: [forkUpdate] },
      ]);
      if (done.ok) {
        pending = false;
        const made = done.value as { task: StoredTask; attempt: StoredAttempt; scoring: ScoringRequest };
        const taskBranch = route.newTask ? null : await taskBranchHead(upstream.repos, project.id, attempt.task);
        messages = [
          ...createdLines(c, made.task, made.attempt, branch, route.newTask),
          ...taskBranchLines(attempt.task, taskBranch),
          ...scoringLines(made),
        ];
      } else {
        await abandon();
        report = refuse(report, done.message);
      }
    } else {
      const recorded = await backend.call("recordPush", [project, actor, { ...attempt, updates: [forkUpdate] }]);
      if (!recorded.ok) console.error({ event: "git.record_push_failed", error: recorded.message });
      messages = [
        `Updated ${name} on ${taskRef(attempt.task)} from branch ${branch}.`,
        ...links(c, attempt.task, name),
        ...(recorded.ok ? recordLines(c, recorded.value as PushRecord) : []),
      ];
    }

    console.log({ event: "git.push_to_create", repo: fork, branch, user: actor.user.id, route: route.kind, landed });
    const reply = writeReport(
      renameRefs(report, (ref) => (ref === MAIN ? update.ref : ref)),
      messages,
      sideband,
    );
    return new Response(reply, {
      status: 200,
      headers: { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-cache" },
    });
  } catch (error) {
    await abandon();
    console.error({ event: "git.push_to_create_failed", repo: fork, branch, error: String(error) });
    return text(502, `The push of ${branch} to ${name} failed. Try again.`);
  }
}

/** Waits until a new fork can be read; Artifacts may take a moment after `fork` resolves. */
async function forkReady(repos: Repos, name: string): Promise<void> {
  const began = Date.now();
  for (;;) {
    try {
      await repos.get(name);
      return;
    } catch (error) {
      if (Date.now() - began > FORK_READY_TIMEOUT_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, FORK_READY_POLL_MS));
    }
  }
}

/** `report` with the fork's `main` turned from `ok` to `ng` for `reason`. */
function refuse(report: PushReport, reason: string): PushReport {
  const line = `ng ${MAIN} ${reason.replace(/\s+/gu, " ").trim()}`;
  return { ...report, lines: report.lines.map((l) => (l === `ok ${MAIN}` ? line : l)) };
}

/**
 * The `remote:` line naming the task branch a new attempt started from, so its author fetches it
 * and builds on it: their push replaced the fork's `main`, which began at the task head.
 */
function taskBranchLines(task: number, head: { sha: string } | null): string[] {
  if (head === null) return [];
  const ref = taskRef(task);
  return [`${ref} has a task branch at ${head.sha}; fetch ${taskBranchRef(task)} first and build on it.`];
}

/** The `remote:` line for a push that queued scoring of an attempt's head, if it did. */
function scoringLines({ scoring }: { scoring: ScoringRequest | null }): string[] {
  if (scoring === null || !scoring.queued) return [];
  const { run } = scoring;
  return [`scoring queued for ${headAttemptRef(run)} (${run.sha})`];
}

/** The `remote:` lines for a push recorded on an attempt's fork: scoring, then its merge request's news. */
function recordLines(c: GitContext, record: PushRecord): string[] {
  return [...scoringLines(record), ...mergeRequestLines(c, record.mergeRequest)];
}

/** The `remote:` lines telling the pusher their merge request was dequeued, or now needs review. */
function mergeRequestLines(c: GitContext, notice: PushNotice | null): string[] {
  if (notice === null) return [];
  const mr = `merge request ${taskRef(notice.task)}`;
  const lines: string[] = [];
  if (notice.dequeue !== null) {
    const { reason, files } = notice.dequeue;
    const count = files === null ? "" : `: ${files} ${files === 1 ? "file" : "files"}`;
    lines.push(
      `${mr} dequeued (${reason})${count} — ${projectApi(c)}/tasks/${taskRef(notice.task)}/merge-request/dequeue`,
    );
  }
  if (notice.needsReview !== null) lines.push(`${mr} needs review: new head ${notice.needsReview}`);
  return lines;
}
/** The `remote:` lines for a push that made an attempt. */
function createdLines(
  c: GitContext,
  task: StoredTask,
  attempt: StoredAttempt,
  branch: string,
  newTask: boolean,
): string[] {
  const what = newTask
    ? `Created ${taskRef(task.number)} "${task.title}" with attempt ${attempt.fork}, opened, from branch ${branch}.`
    : `Added attempt ${attempt.fork}, opened, to ${taskRef(task.number)} "${task.title}" from branch ${branch}.`;
  return [
    what,
    ...links(c, task.number, attempt.fork),
    `Push ${branch} again, here or to the attempt's remote, to update it.`,
  ];
}

/** The task's URL and the attempt's remote, from the request's own origin and path. */
function links(c: GitContext, task: number, attempt: string): string[] {
  const { origin, pathname } = new URL(c.req.url);
  const [, owner = "", project = ""] = REMOTE_PATH.exec(pathname) ?? [];
  return [
    `  Task:    ${projectApi(c)}/tasks/${taskRef(task)}`,
    `  Attempt: ${attemptRemote(origin, owner, project, attempt)}`,
  ];
}

/** The project's API URL, from the request's own origin and path. */
function projectApi(c: GitContext): string {
  const { origin, pathname } = new URL(c.req.url);
  const [, owner = "", project = ""] = REMOTE_PATH.exec(pathname) ?? [];
  return `${origin}/api/projects/${owner}/${project}`;
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
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    await reader.cancel().catch(() => {});
    return text(400, `Push rejected: ${error.message}.`);
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
    alias: c.var.actor.alias,
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

/** Bytes to send ahead of the rest of the request body, and the whole body's length if known. */
interface Prefix {
  bytes: Uint8Array;
  length: number | null;
}

/** Sends the request on to the repo in Artifacts with Throng's token, sending `prefix` first. */
async function forward(
  c: GitContext,
  target: Target,
  scope: TokenScope,
  prefix: Prefix | null,
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
    body = prefix === null ? c.req.raw.body : replay(prefix.bytes, c.req.raw.body, prefix.length);
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
  })().catch((error: unknown) => {
    console.error({ event: "git.replay_failed", error: String(error) });
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

interface ByteStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/** The Workers-only streams, looked up at runtime so the module also loads in Node. */
interface WorkersStreams {
  FixedLengthStream?: new (length: number) => ByteStream;
  IdentityTransformStream?: new () => ByteStream;
}

function contentLength(c: GitContext): number | null {
  const length = Number(c.req.header("Content-Length") ?? NaN);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/**
 * Records a push Artifacts accepted on an attempt's fork: journals the refs its report says were
 * updated (`recordPush`, which also queues scoring of an open attempt's new head) and adds a
 * `remote:` line when scoring was queued. The response is buffered for that, which is cheap: a
 * receive-pack response is a report and some progress, never a pack. One that can't be read is
 * passed on as it came, and nothing is recorded.
 */
async function recordForkPush(
  c: GitContext,
  target: Target,
  attempt: AttemptInput,
  push: PushRequest,
  backend: TaskBackend,
  upstream: Response,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const sideband = push.capabilities.has("side-band-64k");
  let report: PushReport;
  try {
    report = readReport(bytes, sideband);
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    console.error({ event: "git.report_unreadable", repo: target.repo, error: error.message });
    return bytes;
  }
  const ok = new Set(updatedRefs(bytes, sideband));
  const updates = push.updates.filter((u) => ok.has(u.ref));
  if (updates.length === 0) {
    const notice = nonFastForward(report) ? await pullFirst(target, attempt, c, backend) : [];
    return notice.length === 0 ? bytes : writeReport(report, notice, sideband);
  }

  const recorded = await backend
    .call("recordPush", [target.project, c.var.actor, { ...attempt, updates }])
    .catch((error: unknown) => ({ ok: false, message: String(error) }) as const);
  if (!recorded.ok) {
    // The push landed either way; only its journal entry and scoring are missing.
    console.error({ event: "git.record_push_failed", repo: target.repo, error: recorded.message });
    return bytes;
  }
  const messages = recordLines(c, recorded.value as PushRecord);
  return messages.length === 0 ? bytes : writeReport(report, messages, sideband);
}

/** Whether the host refused the fork's `main` as not a fast-forward. */
function nonFastForward(report: PushReport): boolean {
  return report.lines.some((line) => /^ng refs\/heads\/main (?:non-fast-forward|fetch first)/u.test(line));
}

/**
 * The `remote:` line for a push the fork refused as non-fast-forward when a follow wrote its head:
 * the task branch was merged in, and the author hasn't pulled it. Git refuses such a push before
 * sending it unless it is forced, so only a forced push the host refuses gets here.
 */
async function pullFirst(
  target: Target,
  attempt: AttemptInput,
  c: GitContext,
  backend: TaskBackend,
): Promise<string[]> {
  const outcome = await backend
    .call("pullFirstNotice", [target.project, c.var.actor, attempt])
    .catch((error: unknown) => ({ ok: false, message: String(error) }) as const);
  if (!outcome.ok) {
    console.error({ event: "git.pull_first_failed", repo: target.repo, error: outcome.message });
    return [];
  }
  return outcome.value === null ? [] : [outcome.value as string];
}

/**
 * Records a push of a task branch the origin accepted (`recordTaskBranchPush`), which queues a
 * follow of the new task head for each of the task's active attempts, and names them in a `remote:`
 * line. The response is buffered for that, as `recordForkPush` does. One that can't be read, or that
 * didn't update the task branch, is passed on as it came.
 */
async function recordTaskBranchPush(
  c: GitContext,
  target: Target,
  task: number,
  push: PushRequest,
  backend: TaskBackend,
  upstream: Response,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const sideband = push.capabilities.has("side-band-64k");
  let report: PushReport;
  try {
    report = readReport(bytes, sideband);
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    console.error({ event: "git.report_unreadable", repo: target.repo, error: error.message });
    return bytes;
  }
  const ref = taskBranchRef(task);
  const update = push.updates.find((u) => u.ref === ref);
  if (update === undefined || !updatedRefs(bytes, sideband).includes(ref)) return bytes;

  const recorded = await backend
    .call("recordTaskBranchPush", [target.project, c.var.actor, { task, head: update.after }])
    .catch((error: unknown) => ({ ok: false, message: String(error) }) as const);
  if (!recorded.ok) {
    // The task branch moved either way; only its attempts' follows are missing.
    console.error({ event: "git.record_task_branch_failed", repo: target.repo, error: recorded.message });
    return bytes;
  }
  const following = recorded.value as string[];
  if (following.length === 0) return bytes;
  const line = `${taskRef(task)}'s task branch is at ${update.after}; merging it into ${following.join(", ")}.`;
  return writeReport(report, [line], sideband);
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
    return { remote: remote.replace(/\/+$/u, ""), token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
  }

  /** Forgets settled tokens past their expiry, so the cache doesn't grow with every repo ever served. */
  #prune(): void {
    const now = this.#now().getTime();
    for (const [key, entry] of this.#cache) {
      const forgetIfExpired = async () => {
        const token = await entry.catch(() => null);
        if (token !== null && token.expiresAt <= now && this.#cache.get(key) === entry) this.#cache.delete(key);
      };
      void forgetIfExpired();
    }
  }
}
