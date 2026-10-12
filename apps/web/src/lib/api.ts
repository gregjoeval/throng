// The platform API from the browser: a typed `hc` client over same-origin `/api/*`, which throng-web
// forwards to the platform with the signed-in user attached (see `src/server/forward.ts`).

import { queryOptions } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { AppType } from "@throng/platform/app";
import { hc, parseResponse } from "hono/client";
import type { ClientResponse } from "hono/client";

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

/** One task by its reference (`t42`), polled while the page is visible. */
export const taskQuery = (owner: string, project: string, task: string) => ({
  ...apiQuery(taskKey(owner, project, task), (init) =>
    tasksApi[":t"].$get({ param: { owner, project, t: task } }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});

/** The task's attempts by number, obsolete ones left out, polled while the page is visible. */
export const taskAttemptsQuery = (owner: string, project: string, task: string) => ({
  ...apiQuery([...taskKey(owner, project, task), "attempts"], (init) =>
    tasksApi[":t"].attempts.$get({ param: { owner, project, t: task }, query: {} }, { init }),
  ),
  refetchInterval: TASK_POLL_MS,
});
