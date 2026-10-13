// The platform API from the browser: a typed `hc` client over same-origin `/api/*`, which throng-web
// forwards to the platform with the signed-in user attached (see `src/server/forward.ts`).

import { queryOptions, experimental_streamedQuery as streamedQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { AppType } from "@throng/platform/app";
import { hc, parseResponse } from "hono/client";
import type { ClientResponse, InferResponseType } from "hono/client";
import { PlatformError } from "@/lib/errors";

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

/** Creates a project owned by the signed-in user. Rejects with hono's `DetailedError` on failure. */
export async function createProject(handle: string) {
  return parseResponse(client.api.projects.$post({ json: { handle } }));
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
 * The diff from `from`'s tree to `to`'s (two shas), with `attempt` the fork to find them in. It's
 * addressed by sha, so it's never refetched: a moved head is a new query. The route takes the range
 * as one path segment, which `hc` can't type, so the URL is built here.
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
 * Why the merge request last left the queue, with the conflict, failed checks or error. Keyed by
 * when it happened, so a later dequeue is a new query.
 */
export const dequeueQuery = (projectRef: ProjectRef, task: string, at: string) =>
  apiQuery([...taskKey(projectRef, task), "dequeue", at], (init) =>
    tasksApi[":t"]["merge-request"].dequeue.$get({ param: { ...projectRef, t: task } }, { init }),
  );

/** The URL of a log of the checks behind a `failedChecks` dequeue. */
export const dequeueLogUrl = (projectRef: ProjectRef, task: string, name: string) =>
  `${projectPath(projectRef)}/tasks/${encodeURIComponent(task)}/merge-request/dequeue/logs/${encodeURIComponent(name)}`;

/**
 * One conflicting file of the dequeue at `at`, diffed from the merge base to `main` or to the
 * attempt. The path is a tail of path segments, which `hc` can't type, so the URL is built here.
 */
export const dequeueFileDiffQuery = (
  projectRef: ProjectRef,
  task: string,
  at: string,
  path: string,
  side: "main" | "attempt",
) =>
  queryOptions({
    queryKey: [...taskKey(projectRef, task), "dequeue", at, "file", path, side] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) => {
      const tail = path.split("/").map(encodeURIComponent).join("/");
      const base = `${projectPath(projectRef)}/tasks/${encodeURIComponent(task)}/merge-request/dequeue`;
      return getJson<FileDiff>(`${base}/files/${tail}/diff?side=${side}`, signal);
    },
  });

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

/**
 * `main`'s current head (null before the first push), polled while the page is visible: the arena's
 * "current main" reference compares against it by sha, so a moved `main` is a new compare.
 */
export const mainHeadQuery = (projectRef: ProjectRef) => ({
  ...apiQuery([...projectKey(projectRef), "refs"], (init) => projectApi.refs.$get({ param: projectRef }, { init })),
  select: (refs: { main: { sha: string | null } }) => refs.main.sha,
  refetchInterval: TASK_POLL_MS,
});

/** Queues scoring of a draft's head now. Rejects with hono's `DetailedError` on failure. */
export async function scoreNow(projectRef: ProjectRef, attempt: string) {
  return parseResponse(projectApi.attempts[":a"].score.$post({ param: { ...projectRef, a: attempt } }));
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

/**
 * One log of a scoring run, streamed: the text read so far, growing as chunks arrive. A stored log
 * never changes, so it's never refetched.
 */
export const runLogQuery = (projectRef: ProjectRef, run: number, name: string) =>
  queryOptions({
    queryKey: [...projectKey(projectRef), "run", run, "log", name] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: streamedQuery({
      streamFn: async function* ({ signal }) {
        const res = await projectApi.runs[":runId"].logs[":name"].$get(
          { param: { ...projectRef, runId: String(run), name } },
          { init: { signal } },
        );
        if (!res.ok || res.body === null) throw await PlatformError.from(res);
        yield* res.body.pipeThrough(new TextDecoderStream());
      },
      reducer: (text: string, chunk: string) => text + chunk,
      initialValue: "",
    }),
  });
