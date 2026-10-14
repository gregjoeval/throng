// The platform API from the browser: a typed `hc` client over same-origin `/api/*`, which throng-web
// forwards to the platform with the signed-in user attached (see `src/server/forward.ts`).

import { queryOptions, experimental_streamedQuery as streamedQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { AppType } from "@throng/platform/app";
import { runEnded } from "@throng/platform/run-status";
import type { RunStatus } from "@throng/platform/run-status";
import { hc, parseResponse } from "hono/client";
import type { ClientResponse, InferResponseType } from "hono/client";
import { PlatformError } from "@/lib/errors";
import { attemptHint, encodePath } from "@/lib/paths";

/**
 * Same-origin, so the browser's Access session rides along. Calls go through the global `fetch` at
 * request time, which is what Mock Service Worker intercepts in tests.
 */
export const client = hc<AppType>("/", { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) });

/**
 * Query options for one platform call. The data is the endpoint's success body, typed from the
 * platform's routes; any other status rejects with hono's `DetailedError`.
 *
 * @example useQuery(apiQuery(["me"], (init) => client.api.me.$get(undefined, { init })))
 */
export function apiQuery<const K extends QueryKey, R extends ClientResponse<unknown>>(
  queryKey: K,
  request: (init: RequestInit) => Promise<R>,
) {
  return queryOptions({ queryKey, queryFn: ({ signal }) => parseResponse(request({ signal })) });
}

/** The caller: their user, and the alias and token they act with (both null in the browser). */
export const meQuery = apiQuery(["me"], (init) => client.api.me.$get(undefined, { init }));

/** The projects the signed-in user owns, by handle. */
export const projectsQuery = apiQuery(["projects"], (init) => client.api.projects.$get(undefined, { init }));

/** A project, by its owner's handle and its own: what every project API path starts with. */
export interface ProjectRef {
  owner: string;
  project: string;
}

/** One project by its owner's handle and its own; a 404 means there's no such project. */
export const projectQuery = (projectRef: ProjectRef) =>
  apiQuery(["projects", projectRef.owner, projectRef.project], (init) =>
    client.api.projects[":owner"][":project"].$get({ param: projectRef }, { init }),
  );

const projectApi = client.api.projects[":owner"][":project"];

/**
 * One page of first-parent history from a ref, newest first. `attempt` is the fork to look a sha up
 * in; `offset` is how many commits to skip.
 */
export const commitsQuery = (
  projectRef: ProjectRef,
  ref: string,
  { attempt, offset = 0 }: { attempt?: string; offset?: number } = {},
) =>
  apiQuery(["projects", projectRef.owner, projectRef.project, "commits", ref, { attempt, offset }], (init) =>
    projectApi.commits[":ref"].$get(
      {
        param: { ...projectRef, ref },
        query: { offset: String(offset), ...(attempt === undefined ? {} : { attempt }) },
      },
      { init },
    ),
  );

/** One commit's message, author, committer, parents and tree. */
export const commitQuery = (projectRef: ProjectRef, sha: string, attempt?: string) =>
  apiQuery(["projects", projectRef.owner, projectRef.project, "commit", sha, { attempt }], (init) =>
    projectApi.commit[":sha"].$get(
      { param: { ...projectRef, sha }, query: attempt === undefined ? {} : { attempt } },
      { init },
    ),
  );

/** A commit's diff as JSON (the endpoint can also answer with the raw patch, which the browser never asks for). */
export type CommitDiff = Extract<
  InferResponseType<(typeof projectApi.commit)[":sha"]["diff"]["$get"], 200>,
  { files: unknown }
>;
export type FileDiff = CommitDiff["files"][number];
export type DiffFlag = FileDiff["flags"][number];

/** One commit's diff against its first parent: a patch per file, flags where a cap left it out. */
export const commitDiffQuery = (projectRef: ProjectRef, sha: string, attempt?: string) => ({
  ...apiQuery(["projects", projectRef.owner, projectRef.project, "commit", sha, "diff", { attempt }], (init) =>
    projectApi.commit[":sha"].diff.$get(
      { param: { ...projectRef, sha }, query: attempt === undefined ? {} : { attempt } },
      { init },
    ),
  ),
  select: (data: CommitDiff | string | Response): CommitDiff => {
    if (typeof data === "object" && "files" in data) return data;
    throw new Error("The platform didn't answer with a JSON diff.");
  },
});

/**
 * Creates a project owned by the signed-in user, importing `sourceUrl` into its `main` when given.
 * Rejects with hono's `DetailedError` on failure.
 */
export async function createProject({ handle, sourceUrl }: { handle: string; sourceUrl?: string }) {
  const source = sourceUrl === undefined ? {} : { source: { url: sourceUrl } };
  return parseResponse(client.api.projects.$post({ json: { handle, ...source } }));
}

// A project's tasks and attempts. Every key starts `["project", "owner/project"]`, then names the
// task (`"task", "t42"`) or attempt (`"attempt", "t42a3"`) it reads, as the arena spec's **Data and
// updates** lays out, so a mutation invalidates a task's queries by its key prefix and the WebSocket
// upgrade can address the same keys.

/** How often a task page refetches what it shows while the page is visible. */
export const TASK_POLL_MS = 3000;

/** The key prefix of everything read from one project's tasks. */
export const projectKey = (projectRef: ProjectRef) => ["project", `${projectRef.owner}/${projectRef.project}`] as const;

/** The key prefix of everything read about one task: invalidate it after changing the task. */
export const taskKey = (projectRef: ProjectRef, task: string) => [...projectKey(projectRef), "task", task] as const;

const tasksApi = projectApi.tasks;
/** The tasks API's client, for inferring its response types. */
export type TasksApi = typeof tasksApi;
type TaskListState = NonNullable<Parameters<typeof tasksApi.$get>[0]["query"]["state"]>;

/** The project's tasks in one state, by number, each with its attempt count, best gate and merge request state. */
export const tasksQuery = (projectRef: ProjectRef, state: TaskListState) =>
  apiQuery([...projectKey(projectRef), "tasks", state], (init) =>
    tasksApi.$get({ param: projectRef, query: { state } }, { init }),
  );

/** Creates an open task, created by the signed-in user. Rejects with hono's `DetailedError` on failure. */
export async function createTask(projectRef: ProjectRef, task: { title: string; body: string }) {
  return parseResponse(tasksApi.$post({ param: projectRef, json: task }));
}

/**
 * Closes a task, and its active attempts with it, or makes it obsolete, and its active attempts
 * with it. Rejects with hono's `DetailedError` on failure.
 */
export async function endTask(projectRef: ProjectRef, task: string, how: "close" | "obsolete") {
  return parseResponse(tasksApi[":t"][how].$post({ param: { ...projectRef, t: task } }));
}

/** One task by its reference (`t42`), polled while the page is visible. */
export const taskQuery = (projectRef: ProjectRef, task: string) => ({
  ...apiQuery(taskKey(projectRef, task), (init) =>
    tasksApi[":t"].$get({ param: { ...projectRef, t: task } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/**
 * The task's arena: every attempt, obsolete ones included, by number, with its scoring status,
 * current result, base and verdict counts, and the metrics the config declares. Polled while the
 * page is visible.
 */
export const taskArenaQuery = (projectRef: ProjectRef, task: string) => ({
  ...apiQuery([...taskKey(projectRef, task), "arena"], (init) =>
    tasksApi[":t"].arena.$get({ param: { ...projectRef, t: task } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/** The diff from one tree to another, as the compare endpoint answers it: a commit diff's shape. */
export type Compare = Pick<CommitDiff, "files" | "totals" | "truncated"> & {
  from: { ref: string; sha: string };
  to: { ref: string; sha: string };
};

/** A project's API path, `/api/projects/<owner>/<project>`, for URLs `hc` can't type. */
export const projectPath = (projectRef: ProjectRef) =>
  `/api/projects/${[projectRef.owner, projectRef.project].map(encodeURIComponent).join("/")}`;

/** GETs a hand-built platform URL as JSON; any other status throws a `PlatformError`. */
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw await PlatformError.from(res);
  return (await res.json()) as T;
}

/**
 * The diff from `from`'s tree to `to`'s (two refs, usually shas), with `attempt` the fork to find
 * them in. Addressed by sha, it's never refetched: a moved head is a new query. The route takes the
 * range as one path segment, which `hc` can't type, so the URL is built here.
 */
export const compareQuery = (projectRef: ProjectRef, from: string, to: string, attempt?: string) =>
  queryOptions({
    queryKey: [...projectKey(projectRef), "compare", from, to, { attempt }] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) => {
      const query = attempt === undefined ? "" : `?attempt=${encodeURIComponent(attempt)}`;
      return getJson<Compare>(`${projectPath(projectRef)}/compare/${from}...${to}${query}`, signal);
    },
  });

/** The task's latest merge request, open or not, polled while the page is visible. */
export const mergeRequestQuery = (projectRef: ProjectRef, task: string) => ({
  ...apiQuery([...taskKey(projectRef, task), "merge-request"], (init) =>
    tasksApi[":t"]["merge-request"].$get({ param: { ...projectRef, t: task } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/**
 * Why the merge request last left the queue, the landing's run behind it, and the conflict, failed
 * steps or error that run holds. Keyed by when it happened, so a later dequeue is a new query.
 */
export const dequeueQuery = (projectRef: ProjectRef, task: string, at: string) =>
  apiQuery([...taskKey(projectRef, task), "dequeue", at], (init) =>
    tasksApi[":t"]["merge-request"].dequeue.$get({ param: { ...projectRef, t: task } }, { init }),
  );

/** The sides a conflicting file diffs to from its merge base: `main`, or the approved head. */
export type ConflictSide = "main" | "attempt";

/**
 * A conflicting file's diff from its merge base to `side`, from the file's URL under a route that
 * serves them (`…/files/<path>/diff`). The path is a tail of path segments, which `hc` can't type,
 * so the URL is built here. A conflict never changes, so it's never refetched.
 */
const conflictDiffQuery = (key: QueryKey, base: string, path: string, side: ConflictSide) =>
  queryOptions({
    queryKey: [...key, "conflict", path, side] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) => getJson<FileDiff>(`${base}/files/${encodePath(path)}/diff?side=${side}`, signal),
  });

export type ConflictDiffQueryOptions = ReturnType<typeof conflictDiffQuery>;

/** One conflicting file of the task's latest dequeue (at `at`), diffed from its merge base to `side`. */
export const dequeueConflictDiffQuery = (
  projectRef: ProjectRef,
  task: string,
  at: string,
  path: string,
  side: ConflictSide,
) =>
  conflictDiffQuery(
    [...taskKey(projectRef, task), "dequeue", at],
    `${projectPath(projectRef)}/tasks/${encodeURIComponent(task)}/merge-request/dequeue`,
    path,
    side,
  );

/**
 * Selects `attempt` as the task's merge request, closing its other active attempts. Rejects with
 * hono's `DetailedError` on failure.
 */
export async function selectAttempt(projectRef: ProjectRef, task: string, attempt: string) {
  return parseResponse(tasksApi[":t"].selection.$post({ param: { ...projectRef, t: task }, json: { attempt } }));
}

const voteApi = tasksApi[":t"].vote;

/**
 * Opens a vote on the task among its passing attempts, taking ballots until `deadline` (ISO 8601) if
 * given. Rejects with hono's `DetailedError` on failure.
 */
export async function openVote(projectRef: ProjectRef, task: string, deadline?: string) {
  const json = deadline === undefined ? {} : { deadline };
  return parseResponse(voteApi.open.$post({ param: { ...projectRef, t: task }, json }));
}

/** Casts the signed-in user's ballot for `attempt`, replacing theirs. Rejects on failure. */
export async function castVote(projectRef: ProjectRef, task: string, attempt: string) {
  return parseResponse(voteApi.$post({ param: { ...projectRef, t: task }, json: { attempt } }));
}

/** Adds `attempt`, passing now, to the task's open vote. Rejects on failure. */
export async function addVoteCandidate(projectRef: ProjectRef, task: string, attempt: string) {
  return parseResponse(voteApi.candidates.$post({ param: { ...projectRef, t: task }, json: { attempt } }));
}

/** Closes the task's open vote, selecting its winner, or `attempt` to break a tie. Rejects on failure. */
export async function closeVote(projectRef: ProjectRef, task: string, attempt?: string) {
  const json = attempt === undefined ? {} : { attempt };
  return parseResponse(voteApi.close.$post({ param: { ...projectRef, t: task }, json }));
}

/** Approves the source attempt's current head, or cancels the merge request. Rejects on failure. */
export async function actOnMergeRequest(projectRef: ProjectRef, task: string, how: "approve" | "cancel") {
  return parseResponse(tasksApi[":t"]["merge-request"][how].$post({ param: { ...projectRef, t: task } }));
}

/** Reopens a closed attempt as a draft. Rejects with hono's `DetailedError` on failure. */
export async function reopenAttempt(projectRef: ProjectRef, attempt: string) {
  return parseResponse(projectApi.attempts[":a"].reopen.$post({ param: { ...projectRef, a: attempt } }));
}

/** The refs a project can be browsed at: `main`, the active attempts and the archived ones, each with its head. */
export const refsQuery = (projectRef: ProjectRef) =>
  apiQuery([...projectKey(projectRef), "refs"], (init) => projectApi.refs.$get({ param: projectRef }, { init }));

export type Refs = InferResponseType<typeof projectApi.refs.$get, 200>;

/**
 * `main`'s current head (null before the first push), polled while the page is visible: the arena's
 * "current main" reference compares against it by sha, so a moved `main` is a new compare.
 */
export const mainHeadQuery = (projectRef: ProjectRef) => ({
  ...refsQuery(projectRef),
  select: (refs: { main: { sha: string | null } }) => refs.main.sha,
  refetchInterval: TASK_POLL_MS,
});

/** Where a browse read looks: a ref, a path in it (`""` for the root), and the fork to find a sha in. */
export interface BrowseAt {
  ref: string;
  path: string;
  attempt?: string | undefined;
}

/**
 * One directory's entries at a ref, folders first. With `sizes`, each file has its size too, which
 * costs the platform a read per file: ask only where sizes show.
 */
export const treeQuery = (projectRef: ProjectRef, { ref, path, attempt }: BrowseAt, { sizes = false } = {}) =>
  apiQuery([...projectKey(projectRef), "tree", ref, encodePath(path), { attempt, sizes }], (init) => {
    const param = { ...projectRef, ref: encodeURIComponent(ref) };
    const query = { ...attemptHint(attempt), ...(sizes ? { sizes: "true" as const } : {}) };
    // `hc` puts params into the URL as given, so each segment of a path is encoded here.
    const tail = encodePath(path);
    return tail === ""
      ? projectApi.tree[":ref"].$get({ param, query }, { init })
      : projectApi.tree[":ref"][":path{.+}"].$get({ param: { ...param, path: tail }, query }, { init });
  });

export type Tree = InferResponseType<(typeof projectApi.tree)[":ref"]["$get"], 200>;
export type TreeEntry = Tree["entries"][number];

/** One file at a ref: its metadata, and its text when it's text up to 1 MB. */
export const blobQuery = (projectRef: ProjectRef, { ref, path, attempt }: BrowseAt) =>
  apiQuery([...projectKey(projectRef), "blob", ref, encodePath(path), { attempt }], (init) =>
    projectApi.blob[":ref"][":path{.+}"].$get(
      { param: { ...projectRef, ref: encodeURIComponent(ref), path: encodePath(path) }, query: attemptHint(attempt) },
      { init },
    ),
  );

export type Blob = InferResponseType<(typeof projectApi.blob)[":ref"][":path{.+}"]["$get"], 200>;

/** Queues scoring of a draft's head now. Rejects with hono's `DetailedError` on failure. */
export async function scoreNow(projectRef: ProjectRef, attempt: string) {
  return parseResponse(projectApi.attempts[":a"].score.$post({ param: { ...projectRef, a: attempt } }));
}

/** Queues scoring of an open attempt's head again. Rejects with hono's `DetailedError` on failure. */
export async function rescore(projectRef: ProjectRef, attempt: string) {
  return parseResponse(projectApi.attempts[":a"].rescore.$post({ param: { ...projectRef, a: attempt } }));
}

/** The task's attempts by number, obsolete ones left out, polled while the page is visible. */
export const taskAttemptsQuery = (projectRef: ProjectRef, task: string) => ({
  ...apiQuery([...taskKey(projectRef, task), "attempts"], (init) =>
    tasksApi[":t"].attempts.$get({ param: { ...projectRef, t: task }, query: {} }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/** The key prefix of everything read about one attempt: invalidate it after changing the attempt. */
export const attemptKey = (projectRef: ProjectRef, attempt: string) =>
  [...projectKey(projectRef), "attempt", attempt] as const;

const attemptApi = projectApi.attempts[":a"];

/** An attempt's scoring runs, newest first, superseded and cancelled ones included, polled. */
export const attemptRunsQuery = (projectRef: ProjectRef, attempt: string) => ({
  ...apiQuery([...attemptKey(projectRef, attempt), "runs"], (init) =>
    attemptApi.runs.$get({ param: { ...projectRef, a: attempt } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

export type RunDetail = InferResponseType<typeof attemptApi.runs.$get, 200>["runs"][number];

/** Every verdict on the attempt, on every head it has had, oldest first, polled. */
export const verdictsQuery = (projectRef: ProjectRef, attempt: string) => ({
  ...apiQuery([...attemptKey(projectRef, attempt), "verdicts"], (init) =>
    attemptApi.verdicts.$get({ param: { ...projectRef, a: attempt } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

export type Verdict = InferResponseType<typeof attemptApi.verdicts.$get, 200>["verdicts"][number];

/**
 * Posts the signed-in user's verdict on the attempt's current head, replacing theirs on that head.
 * Rejects with hono's `DetailedError` on failure.
 */
export async function postVerdict(
  projectRef: ProjectRef,
  attempt: string,
  verdict: Pick<Verdict, "recommendation" | "body">,
) {
  return parseResponse(attemptApi.verdicts.$post({ param: { ...projectRef, a: attempt }, json: verdict }));
}

/** How often a run that hasn't settled, and the runs list, are refetched while visible, in milliseconds. */
export const RUN_POLL_MS = 3000;

/**
 * The runs list's filters and page: one line, `main` or `tasks`, a status, the cursor a page starts
 * at, and how many runs a page holds (the platform's default when absent).
 */
export interface RunsFilter {
  line?: string | undefined;
  status?: RunStatus | undefined;
  cursor?: number | undefined;
  limit?: number | undefined;
}

/** One page of the project's runs, newest first. */
const runsPage = (projectRef: ProjectRef, { line, status, cursor, limit }: RunsFilter, init: RequestInit) =>
  parseResponse(
    projectApi.runs.$get(
      {
        param: projectRef,
        query: {
          ...(line === undefined ? {} : { line }),
          ...(status === undefined ? {} : { status }),
          ...(cursor === undefined ? {} : { cursor: String(cursor) }),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      },
      { init },
    ),
  );

/** A page of the project's runs, newest first, polled. */
export const runsQuery = (projectRef: ProjectRef, filter: RunsFilter) => ({
  ...queryOptions({
    queryKey: [...projectKey(projectRef), "runs", filter] as const,
    queryFn: ({ signal }) => runsPage(projectRef, filter, { signal }),
  }),
  refetchInterval: RUN_POLL_MS,
});

/**
 * Every run of the project waiting for the owner, newest first: each page, following `next` to the
 * last, so none is left out however many wait. Polled.
 */
export const waitingRunsQuery = (projectRef: ProjectRef) => ({
  ...queryOptions({
    queryKey: [...projectKey(projectRef), "runs", "waiting", "all"] as const,
    queryFn: async ({ signal }) => {
      const runs: Run[] = [];
      let cursor: number | undefined;
      do {
        const page = await runsPage(projectRef, { status: "waiting", cursor }, { signal });
        runs.push(...page.runs);
        // Each page's `next` is older than its cursor; one that isn't would page forever.
        cursor = page.next !== null && (cursor === undefined || page.next < cursor) ? page.next : undefined;
      } while (cursor !== undefined);
      return runs;
    },
  }),
  refetchInterval: RUN_POLL_MS,
});

export type Run = InferResponseType<typeof projectApi.runs.$get, 200>["runs"][number];

/** The key of one run: invalidate it after changing the run. */
export const runKey = (projectRef: ProjectRef, run: number) => [...projectKey(projectRef), "run", run] as const;

/** One conflicting file of the conflict a landing's run hit, diffed from its merge base to `side`. */
export const runConflictDiffQuery = (projectRef: ProjectRef, run: number, path: string, side: ConflictSide) =>
  conflictDiffQuery(runKey(projectRef, run), `${projectPath(projectRef)}/runs/${run}/conflict`, path, side);

/**
 * One run with its outcome, polled until it ended. A waiting run is still polled, though it rests
 * until someone acts (the platform calls it settled): that someone may be the owner in another tab,
 * or a push that replaces it.
 */
export const runQuery = (projectRef: ProjectRef, run: number) => ({
  ...apiQuery([...runKey(projectRef, run), "detail"], (init) =>
    projectApi.runs[":runId"].$get({ param: { ...projectRef, runId: String(run) } }, { init }),
  ),
  refetchInterval: (query: { state: { data?: { status: RunStatus } | undefined } }) =>
    query.state.data !== undefined && runEnded(query.state.data) ? false : RUN_POLL_MS,
});

export type RunWithOutcome = InferResponseType<(typeof projectApi.runs)[":runId"]["$get"], 200>;

/** Cancels a run; only the project owner may. Rejects with hono's `DetailedError` on failure. */
export async function cancelRun(projectRef: ProjectRef, run: number) {
  return parseResponse(projectApi.runs[":runId"].cancel.$post({ param: { ...projectRef, runId: String(run) } }));
}

/**
 * Starts a run waiting for the owner at `sha`, the head they reviewed; only the owner acting as
 * themselves may. Rejects with hono's `DetailedError` on failure, such as a line that moved on.
 */
export async function startRun(projectRef: ProjectRef, run: number, sha: string) {
  return parseResponse(
    projectApi.runs[":runId"].start.$post({ param: { ...projectRef, runId: String(run) }, json: { sha } }),
  );
}

/**
 * One step's log of a run, streamed: the text read so far, growing as chunks arrive. A stored log
 * never changes, so it's never refetched.
 */
export const runLogQuery = (projectRef: ProjectRef, run: number, step: string) =>
  queryOptions({
    queryKey: [...runKey(projectRef, run), "log", step] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: streamedQuery({
      streamFn: async function* ({ signal }) {
        const res = await projectApi.runs[":runId"].logs[":step"].$get(
          { param: { ...projectRef, runId: String(run), step } },
          { init: { signal } },
        );
        if (!res.ok || res.body === null) throw await PlatformError.from(res);
        yield* res.body.pipeThrough(new TextDecoderStream());
      },
      reducer: (text: string, chunk: string) => text + chunk,
      initialValue: "",
    }),
  });

const secretsApi = projectApi.secrets;

/** The project's secrets by name: each one's pipelines and last change, never its value. Only maintainers may read them. */
export const secretsQuery = (projectRef: ProjectRef) =>
  apiQuery([...projectKey(projectRef), "secrets"], (init) => secretsApi.$get({ param: projectRef }, { init }));

export type Secret = InferResponseType<typeof secretsApi.$get, 200>["secrets"][number];
export type Pipeline = Secret["pipelines"][number];
/** Where `main`'s config names a secret, and whether it has a value and is allowed wherever it runs. */
export type SecretUse = InferResponseType<typeof secretsApi.$get, 200>["uses"][number];

/** Sets a secret's value, its pipelines, or both; what's left out is kept. Rejects with hono's `DetailedError`. */
export async function putSecret(
  projectRef: ProjectRef,
  name: string,
  change: { value?: string; pipelines?: Pipeline[] },
) {
  return parseResponse(secretsApi[":name"].$put({ param: { ...projectRef, name }, json: change }));
}

/** Deletes a secret. Rejects with hono's `DetailedError` on failure. */
export async function deleteSecret(projectRef: ProjectRef, name: string) {
  return parseResponse(secretsApi[":name"].$delete({ param: { ...projectRef, name } }));
}

const tokensApi = client.api.tokens;

/** The signed-in user's Throng tokens, newest first, expired and revoked ones included; never a plaintext. */
export const tokensQuery = apiQuery(["tokens"], (init) => tokensApi.$get(undefined, { init }));

export type Token = InferResponseType<typeof tokensApi.$get, 200>["tokens"][number];

/**
 * Mints a token for `alias` (null: the user as themselves) that expires in `expiresIn` seconds. The
 * plaintext and the platform's public URL are only in this response. Rejects with hono's `DetailedError`.
 */
export async function mintToken(input: { alias: string | null; expiresIn: number }) {
  return parseResponse(tokensApi.$post({ json: input }));
}

export type MintedToken = Awaited<ReturnType<typeof mintToken>>;

/** Revokes one of the signed-in user's tokens. Rejects with hono's `DetailedError` on failure. */
export async function revokeToken(id: string) {
  return parseResponse(tokensApi[":id"].$delete({ param: { id } }));
}
