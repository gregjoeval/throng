import type { InferResponseType } from "hono/client";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { client, FileDiff } from "@/lib/api";
import type { ArenaAttempt, Metric, TaskArena } from "@/lib/arena";
import type { Attempt, ListedTask } from "@/lib/tasks";

/** `GET /api/me` for a human signed in through Access, typed from the platform's routes. */
export const me: InferResponseType<typeof client.api.me.$get, 200> = {
  user: { id: "u1", handle: "ada", email: "ada@example.com", createdAt: "2026-10-10T12:00:00.000Z" },
  alias: null,
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
    checks: [],
    metrics: [],
    taskBranch: null,
    selection: null,
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
    alias: null,
    state: "draft",
    fork: ref,
    remote: `https://throng.test/git/greg/throng/${ref}.git`,
    branch: null,
    note: "",
    createdAt: me.user.createdAt,
    closedAt: null,
    mergedSha: null,
    archivedSha: null,
    needsUpdate: false,
    scoring: { status: "none", sha: null },
    mergeRequest: null,
    verdicts: { head: null, merge: 0, revise: 0, reject: 0 },
    ...fields,
  };
}

/** An arena's selection and vote unless given others: the task's creator selects, and no vote is open. */
export const NO_VOTE: Pick<TaskArena, "selection" | "vote"> = { selection: { policy: "creator" }, vote: null };

/**
 * Handlers serving `tasks` and their `attempts` in any project: the list (by `?state=`, open and
 * closed when it's absent), each task, each task's attempts, and its arena (each attempt unpushed
 * and unscored). Use with `server.use(...)`.
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
    http.get("*/api/projects/:owner/:project/tasks/:t/arena", ({ params }) => {
      const found = find(params["t"]);
      if (found === undefined) return notFound(`no task ${params["t"]}`);
      const arena = attempts
        .filter((a) => a.task === found.number)
        .map((a) =>
          arenaAttempt(a.task, a.number, { state: a.state, author: a.author, alias: a.alias, sha: null, base: null }),
        );
      return HttpResponse.json({ ...NO_VOTE, task: found.ref, metrics: [], attempts: arena });
    }),
  ];
}

type Result = NonNullable<ArenaAttempt["result"]>;

/** One of `_diff`'s sizes. */
const diffMetric = (value: number) => ({ source: "platform", type: "number", value, order: "asc" }) as const;

/**
 * A result's metrics: `_diff`'s sizes, `values` as project numbers (higher is better), and
 * `_preview.url`, null unless a URL is given.
 */
export function scoredMetrics({
  files = 1,
  additions = 2,
  values = {},
  preview = null,
}: {
  files?: number;
  additions?: number;
  values?: Record<string, number>;
  preview?: string | null;
} = {}): Result["metrics"] {
  return {
    "_diff.filesChanged": diffMetric(files),
    "_diff.additions": diffMetric(additions),
    ...Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        { source: "project", type: "number", value, order: "desc" } as const,
      ]),
    ),
    "_preview.url": { source: "platform", type: "string", format: "url", value: preview },
  };
}

/** A config check that ran. */
export function check(
  name: string,
  outcome: Result["checks"][number]["outcome"],
  durationMs = 900,
): Result["checks"][number] {
  return { name, source: "project", outcome, durationMs, notes: [] };
}

/** One of Throng's own checks, `_diff` or `_preview`, which never gate. */
export function platformCheck(name: string, outcome: Result["checks"][number]["outcome"]): Result["checks"][number] {
  return { name, source: "platform", outcome, durationMs: 0, notes: [] };
}

/** A done result whose gate passed with a `test` check, its metrics as `scoredMetrics()` gives them. */
export function result(fields: Partial<Result> = {}): Result {
  return {
    base: "b".repeat(40),
    config: { kind: "valid" },
    gate: "passed",
    checks: [check("test", "passed")],
    metrics: scoredMetrics(),
    logs: [],
    run: 1,
    finishedAt: me.user.createdAt,
    ...fields,
  };
}

/** The base every arena attempt has unless given another: a commit on `main`. */
export const BASE = "ba5e".padEnd(40, "0");

/**
 * Attempt `t<task>a<number>` as the arena returns it: open, by `bob`, pushed at a sha of its own,
 * on `BASE`, not yet scored.
 */
export function arenaAttempt(taskNumber: number, number: number, fields: Partial<ArenaAttempt> = {}): ArenaAttempt {
  return {
    ref: `t${taskNumber}a${number}`,
    state: "open",
    author: bob,
    alias: null,
    status: "none",
    sha: `${taskNumber}${number}`.padEnd(40, "c"),
    base: { sha: BASE, on: "main" },
    needsUpdate: false,
    verdicts: { head: null, merge: 0, revise: 0, reject: 0 },
    ...fields,
  };
}

/**
 * Handlers serving task `t<n>` with `attempts` everywhere the task page reads them: the task, its
 * attempts (the list's view of the same refs and states, with `notes` by ref) and its arena, plus
 * the declared `metrics` and the arena's selection policy and open vote, `voting`.
 */
export function serveArena(
  t: ListedTask,
  attempts: ArenaAttempt[],
  metrics: Metric[] = [],
  notes: Record<string, string> = {},
  voting: Partial<Pick<TaskArena, "selection" | "vote">> = {},
) {
  const listed = attempts.map((a) =>
    attempt(t.number, Number(a.ref.slice(a.ref.lastIndexOf("a") + 1)), {
      state: a.state,
      author: a.author,
      note: notes[a.ref] ?? "",
    }),
  );
  return [
    http.get("*/api/projects/:owner/:project/tasks/:t/arena", () =>
      HttpResponse.json({ ...NO_VOTE, ...voting, task: t.ref, metrics, attempts }),
    ),

    ...serveTasks([t], listed),
  ];
}

/**
 * A compare handler answering each `{from}...{to}` with the files `filesFor(to, from)` gives, and
 * recording every range asked for in `asked`.
 */
export function serveCompare(filesFor: (to: string, from: string) => FileDiff[], asked: string[] = []) {
  return http.get("*/api/projects/:owner/:project/compare/:range", ({ params, request }) => {
    const range = String(params["range"]);
    const [from = "", to = ""] = range.split("...");
    asked.push(`${range}${new URL(request.url).search}`);
    const files = filesFor(to, from);
    return HttpResponse.json({
      from: { ref: from, sha: from },
      to: { ref: to, sha: to },
      oldTree: "1".repeat(40),
      newTree: "2".repeat(40),
      files,
      totals: {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      },
      truncated: false,
    });
  });
}

/** `main`'s head in `serveRefs` unless given another. */
export const MAIN = "3a1e".padEnd(40, "0");

/** A handler serving the project's refs: `main` at `sha` (null: no commits yet), and no attempts. */
export function serveRefs(sha: string | null = MAIN) {
  return http.get("*/api/projects/:owner/:project/refs", () =>
    HttpResponse.json({ main: { ref: "main", sha }, active: [], archived: [] }),
  );
}

/** A file added with one line, as a diff lists it. */
export function addedFile(path: string): FileDiff {
  return {
    path,
    status: "added",
    oldMode: null,
    newMode: "100644",
    oldHash: null,
    newHash: "3".repeat(40),
    additions: 1,
    deletions: 0,
    flags: [],
    patch: [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      `+++ b/${path}`,
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n"),
  };
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
