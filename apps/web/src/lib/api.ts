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

/** The caller: their user, and the agent and token they act with (both null in the browser). */
export const meQuery = apiQuery(["me"], (init) => client.api.me.$get(undefined, { init }));

/** The projects the signed-in user owns, by handle. */
export const projectsQuery = apiQuery(["projects"], (init) => client.api.projects.$get(undefined, { init }));

/** One project by its owner's handle and its own; a 404 means there's no such project. */
export const projectQuery = (owner: string, project: string) =>
  apiQuery(["projects", owner, project], (init) =>
    client.api.projects[":owner"][":project"].$get({ param: { owner, project } }, { init }),
  );

const projectApi = client.api.projects[":owner"][":project"];

/**
 * One page of first-parent history from a ref, newest first. `attempt` is the fork to look a sha up
 * in; `offset` is how many commits to skip.
 */
export const commitsQuery = (
  owner: string,
  project: string,
  ref: string,
  { attempt, offset = 0 }: { attempt?: string; offset?: number } = {},
) =>
  apiQuery(["projects", owner, project, "commits", ref, { attempt, offset }], (init) =>
    projectApi.commits[":ref"].$get(
      {
        param: { owner, project, ref },
        query: { offset: String(offset), ...(attempt === undefined ? {} : { attempt }) },
      },
      { init },
    ),
  );

/** One commit's message, author, committer, parents and tree. */
export const commitQuery = (owner: string, project: string, sha: string, attempt?: string) =>
  apiQuery(["projects", owner, project, "commit", sha, { attempt }], (init) =>
    projectApi.commit[":sha"].$get(
      { param: { owner, project, sha }, query: attempt === undefined ? {} : { attempt } },
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
export const commitDiffQuery = (owner: string, project: string, sha: string, attempt?: string) => ({
  ...apiQuery(["projects", owner, project, "commit", sha, "diff", { attempt }], (init) =>
    projectApi.commit[":sha"].diff.$get(
      { param: { owner, project, sha }, query: attempt === undefined ? {} : { attempt } },
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
export const projectKey = (owner: string, project: string) => ["project", `${owner}/${project}`] as const;

/** The key prefix of everything read about one task: invalidate it after changing the task. */
export const taskKey = (owner: string, project: string, task: string) =>
  [...projectKey(owner, project), "task", task] as const;

const tasksApi = client.api.projects[":owner"][":project"].tasks;
type TaskListState = NonNullable<Parameters<typeof tasksApi.$get>[0]["query"]["state"]>;

/** The project's tasks in one state, by number, each with its attempt count, best gate and merge request state. */
export const tasksQuery = (owner: string, project: string, state: TaskListState) =>
  apiQuery([...projectKey(owner, project), "tasks", state], (init) =>
    tasksApi.$get({ param: { owner, project }, query: { state } }, { init }),
  );

/** Creates an open task, created by the signed-in user. Rejects with hono's `DetailedError` on failure. */
export async function createTask(owner: string, project: string, task: { title: string; body: string }) {
  return parseResponse(tasksApi.$post({ param: { owner, project }, json: task }));
}

/**
 * Closes a task, and its active attempts with it, or makes it obsolete, and its active attempts
 * with it. Rejects with hono's `DetailedError` on failure.
 */
export async function endTask(owner: string, project: string, task: string, how: "close" | "obsolete") {
  return parseResponse(tasksApi[":t"][how].$post({ param: { owner, project, t: task } }));
}

/** One task by its reference (`t42`), polled while the page is visible. */
export const taskQuery = (owner: string, project: string, task: string) => ({
  ...apiQuery(taskKey(owner, project, task), (init) =>
    tasksApi[":t"].$get({ param: { owner, project, t: task } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/**
 * The task's arena: every attempt, obsolete ones included, by number, with its scoring status,
 * current result, base and verdict counts, and the metrics the config declares. Polled while the
 * page is visible.
 */
export const taskArenaQuery = (owner: string, project: string, task: string) => ({
  ...apiQuery([...taskKey(owner, project, task), "arena"], (init) =>
    tasksApi[":t"].arena.$get({ param: { owner, project, t: task } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/** The diff from one tree to another, as the compare endpoint answers it: a commit diff's shape. */
export type Compare = Pick<CommitDiff, "files" | "totals" | "truncated"> & {
  from: { ref: string; sha: string };
  to: { ref: string; sha: string };
};

/**
 * The diff from `from`'s tree to `to`'s (two shas), with `attempt` the fork to find them in. It's
 * addressed by sha, so it's never refetched: a moved head is a new query. The route takes the range
 * as one path segment, which `hc` can't type, so the URL is built here.
 */
export const compareQuery = (owner: string, project: string, from: string, to: string, attempt?: string) =>
  queryOptions({
    queryKey: [...projectKey(owner, project), "compare", from, to, { attempt }] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }): Promise<Compare> => {
      const path = [owner, project].map(encodeURIComponent).join("/");
      const query = attempt === undefined ? "" : `?attempt=${encodeURIComponent(attempt)}`;
      const res = await fetch(`/api/projects/${path}/compare/${from}...${to}${query}`, { signal });
      if (!res.ok) throw await PlatformError.from(res);
      return (await res.json()) as Compare;
    },
  });

/** The task's attempts by number, obsolete ones left out, polled while the page is visible. */
export const taskAttemptsQuery = (owner: string, project: string, task: string) => ({
  ...apiQuery([...taskKey(owner, project, task), "attempts"], (init) =>
    tasksApi[":t"].attempts.$get({ param: { owner, project, t: task }, query: {} }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/** The key prefix of everything read about one attempt: invalidate it after changing the attempt. */
export const attemptKey = (owner: string, project: string, attempt: string) =>
  [...projectKey(owner, project), "attempt", attempt] as const;

const attemptApi = projectApi.attempts[":a"];

/** An attempt's scoring runs, newest first, superseded and cancelled ones included, polled. */
export const attemptRunsQuery = (owner: string, project: string, attempt: string) => ({
  ...apiQuery([...attemptKey(owner, project, attempt), "runs"], (init) =>
    attemptApi.runs.$get({ param: { owner, project, a: attempt } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

export type RunDetail = InferResponseType<typeof attemptApi.runs.$get, 200>["runs"][number];

/** Every verdict on the attempt, on every head it has had, oldest first, polled. */
export const verdictsQuery = (owner: string, project: string, attempt: string) => ({
  ...apiQuery([...attemptKey(owner, project, attempt), "verdicts"], (init) =>
    attemptApi.verdicts.$get({ param: { owner, project, a: attempt } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

export type Verdict = InferResponseType<typeof attemptApi.verdicts.$get, 200>["verdicts"][number];

/**
 * Posts the signed-in user's verdict on the attempt's current head, replacing theirs on that head.
 * Rejects with hono's `DetailedError` on failure.
 */
export async function postVerdict(
  owner: string,
  project: string,
  attempt: string,
  verdict: Pick<Verdict, "recommendation" | "body">,
) {
  return parseResponse(attemptApi.verdicts.$post({ param: { owner, project, a: attempt }, json: verdict }));
}

/**
 * One log of a scoring run, streamed: the text read so far, growing as chunks arrive. A stored log
 * never changes, so it's never refetched.
 */
export const runLogQuery = (owner: string, project: string, run: number, name: string) =>
  queryOptions({
    queryKey: [...projectKey(owner, project), "run", run, "log", name] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: streamedQuery({
      streamFn: async function* ({ signal }) {
        const res = await projectApi.runs[":runId"].logs[":name"].$get(
          { param: { owner, project, runId: String(run), name } },
          { init: { signal } },
        );
        if (!res.ok || res.body === null) throw await PlatformError.from(res);
        yield* res.body.pipeThrough(new TextDecoderStream());
      },
      reducer: (text: string, chunk: string) => text + chunk,
      initialValue: "",
    }),
  });
