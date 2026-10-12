import type { InferResponseType } from "hono/client";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { client } from "@/lib/api";
import type { Attempt, ListedTask } from "@/lib/tasks";

/** `GET /api/me` for a human signed in through Access, typed from the platform's routes. */
export const me: InferResponseType<typeof client.api.me.$get, 200> = {
  user: { id: "u1", handle: "ada", email: "ada@example.com", createdAt: "2026-10-10T12:00:00.000Z" },
  agent: null,
  token: null,
};

type Project = InferResponseType<typeof client.api.projects.$get, 200>["projects"][number];

/** A project owned by `ada`, as the platform returns it. */
export function project(handle: string, owner = me.user): Project {
  return { id: `id-${handle}`, handle, owner: { id: owner.id, handle: owner.handle }, createdAt: me.user.createdAt };
}

/** `ada`'s projects in the default handlers. */
export const projects: Project[] = [project("alpha"), project("beta")];

export const notFound = (message: string) =>
  HttpResponse.json({ error: { code: "notFound", message } }, { status: 404 });

/** `bob`, who owns no project in the default handlers. */
export const bob = { id: "u2", handle: "bob" };

/** Task `t<number>`, open, created by `ada`, with no attempts, as the task list shows it. */
export function task(number: number, fields: Partial<ListedTask> = {}): ListedTask {
  return {
    ref: `t${number}`,
    number,
    title: `Task ${number}`,
    body: "",
    creator: { id: me.user.id, handle: me.user.handle },
    state: "open",
    createdAt: me.user.createdAt,
    closedAt: null,
    closedBy: null,
    attemptLimit: null,
    taskBranch: null,
    attemptCount: 0,
    bestGate: null,
    mergeRequestState: null,
    ...fields,
  };
}

/** Attempt `t<task>a<number>`, a draft by `bob`. */
export function attempt(taskNumber: number, number: number, fields: Partial<Attempt> = {}): Attempt {
  const ref = `t${taskNumber}a${number}`;
  return {
    ref,
    task: taskNumber,
    number,
    author: bob,
    state: "draft",
    fork: ref,
    branch: null,
    note: "",
    createdAt: me.user.createdAt,
    closedAt: null,
    mergedSha: null,
    archivedSha: null,
    scoring: { status: "none", sha: null },
    mergeRequest: null,
    verdicts: { head: null, merge: 0, revise: 0, reject: 0 },
    ...fields,
  };
}

/**
 * Handlers serving `tasks` and their `attempts` in any project: the list (by `?state=`, open and
 * closed when it's absent), each task, and each task's attempts. Use with `server.use(...)`.
 */
export function serveTasks(tasks: ListedTask[], attempts: Attempt[] = []) {
  const find = (ref: unknown) => tasks.find((t) => t.ref === ref);
  return [
    http.get("*/api/projects/:owner/:project/tasks", ({ request }) => {
      const state = new URL(request.url).searchParams.get("state");
      const shown = tasks.filter((t) => (state === null ? t.state !== "obsolete" : t.state === state));
      return HttpResponse.json({ tasks: shown });
    }),
    http.get("*/api/projects/:owner/:project/tasks/:t", ({ params }) => {
      const found = find(params["t"]);
      return found === undefined ? notFound(`no task ${params["t"]}`) : HttpResponse.json(found);
    }),
    http.get("*/api/projects/:owner/:project/tasks/:t/attempts", ({ params }) => {
      const found = find(params["t"]);
      if (found === undefined) return notFound(`no task ${params["t"]}`);
      return HttpResponse.json({ attempts: attempts.filter((a) => a.task === found.number) });
    }),
  ];
}

/** Default platform API handlers; override per test with `server.use(...)`. */
export const handlers = [
  http.get("*/api/me", () => HttpResponse.json(me)),
  http.get("*/api/projects", () => HttpResponse.json({ projects })),
  http.get("*/api/projects/:owner/:project", ({ params }) => {
    const found = projects.find((p) => p.owner.handle === params["owner"] && p.handle === params["project"]);
    return found === undefined
      ? notFound(`no project ${params["owner"]}/${params["project"]}`)
      : HttpResponse.json(found);
  }),
];

export const server = setupServer(...handlers);
