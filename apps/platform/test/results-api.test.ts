import { hc, parseResponse } from "hono/client";
import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ApiRoutes } from "../src/api.ts";
import type { ScoringResult } from "../src/results.ts";
import type { ScoringOutcome } from "../src/scoring.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");

function result(overrides: Partial<ScoringResult> = {}): ScoringResult {
  return {
    base: "b".repeat(40),
    config: { kind: "valid" },
    gate: "passed",
    checks: [
      { name: "test", required: true, outcome: "passed", durationMs: 900, metrics: { coverage: 81.5 }, notes: [] },
      { name: "bundle", required: false, outcome: "failed", durationMs: 300, metrics: { bundle_kb: 120 }, notes: [] },
    ],
    builtin: { filesChanged: 1, additions: 2, deletions: 0, durationMs: 5 },
    preview: { status: "none" },
    logs: [],
    ...overrides,
  };
}

async function setup() {
  const repos = new FakeRepos();
  const runner = {
    workflow: {
      create: async () => ({}),
      get: async () => ({ terminate: async () => {} }),
    },
    teardown: async () => {},
  };
  const { backend, store } = testTaskBackends(repos, now, runner);
  const api = apiRoutes({ verifierFor: () => verify, now, repos: () => repos, tasks: () => backend });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (bearer !== undefined) headers["Authorization"] = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tokenFor = async (email: string, agent?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ agent }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const bob = await tokenFor("bob@example.com");
  const projectId = (await call("POST", "/projects", greg, { handle: "throng" })).body["id"] as string;
  const root = repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n" } }).hash;
  const base = "/projects/greg/throng";
  const scoring = () => store(projectId).scoring;

  /** A task by ada with `count` draft attempts by ada. */
  const drafts = async (count = 1) => {
    const task = (await call("POST", `${base}/tasks`, ada, { title: "Fix it" })).body;
    await call("POST", `${base}/tasks/${task["ref"]}/attempts`, ada, { count });
    return task["ref"] as string;
  };
  /** Commits a new head on the attempt's fork, as a push would. */
  const commit = (attempt: string, content: string) =>
    repos.commit(`${projectId}-${attempt}`, { files: { "README.md": content } }).hash;
  const me = (await call("GET", "/me", ada)).body as { user: User; agent: null };
  /** Pushes a new head to ada's attempt and records it, as the git proxy does once it lands. */
  const push = (task: number, attempt: number, content: string) => {
    const fork = `t${task}a${attempt}`;
    const before = repos.ref(`${projectId}-${fork}`, "refs/heads/main") ?? "0".repeat(40);
    const after = commit(fork, content);
    store(projectId).recordPush({ id: projectId, owner: "" }, me, {
      task,
      number: attempt,
      updates: [{ ref: "refs/heads/main", before, after }],
    });
    return after;
  };
  /** Starts queued runs, then reports how run `id` ended. */
  const finish = async (id: number, outcome: ScoringOutcome) => {
    await scoring().drain();
    expect(scoring().finish(id, outcome)).toBeTruthy();
  };

  return { api, env, repos, projectId, root, call, greg, ada, bob, base, drafts, commit, push, scoring, finish };
}

describe("OpenAPI document", () => {
  it("describes the scoring routes, the score and rescore requests included", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/openapi.json");
    const paths = body["paths"] as Record<string, Json>;
    const op = (path: string, method: string) => paths[`/projects/{owner}/{project}${path}`]?.[method]?.["operationId"];
    expect(op("/attempts/{a}/score", "post")).toBe("scoreAttempt");
    expect(op("/attempts/{a}/rescore", "post")).toBe("rescoreAttempt");
    expect(op("/attempts/{a}/scoring", "get")).toBe("getAttemptScoring");
    expect(op("/attempts/{a}/runs", "get")).toBe("listAttemptRuns");
    expect(op("/runs/{runId}", "get")).toBe("getRun");
    expect(op("/tasks/{t}/arena", "get")).toBe("getTaskArena");
    for (const schema of [
      "ScoringStatus",
      "CurrentResult",
      "ScoringResult",
      "RunDetail",
      "TaskArena",
      "ArenaAttempt",
    ]) {
      expect(body["components"]["schemas"][schema], schema).toBeDefined();
    }
  });

  it("types the scoring routes for an hc client", async () => {
    const { api, env, ada, drafts } = await setup();
    await drafts();
    const client = hc<ApiRoutes>("http://api.test", {
      fetch: (input: string | URL | Request, init?: RequestInit) => api.request(input, init, env),
      headers: { Authorization: `Bearer ${ada}` },
    });
    const project = client.projects[":owner"][":project"];
    const param = { owner: "greg", project: "throng" };
    const arena = await parseResponse(project.tasks[":t"].arena.$get({ param: { ...param, t: "t1" } }));
    const scoring = await parseResponse(project.attempts[":a"].scoring.$get({ param: { ...param, a: "t1a1" } }));
    const runs = await parseResponse(project.attempts[":a"].runs.$get({ param: { ...param, a: "t1a1" } }));
    const run = await project.runs[":runId"].$get({ param: { ...param, runId: "1" } });
    expect(arena.attempts[0]?.status).toBe("none");
    expect(scoring.sha).toBeNull();
    expect(runs.runs).toEqual([]);
    expect(run.status).toBe(404);
  });
});

describe("the arena", () => {
  it("gives every attempt's current result in one call, whatever state its scoring is in", async () => {
    const { call, ada, bob, root, base, drafts, commit, push, scoring, finish } = await setup();
    await drafts(4);
    const scored = commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/score`, ada);
    await finish(1, { status: "done", result: result() });
    const running = commit("t1a2", "two\n");
    await call("POST", `${base}/attempts/t1a2/score`, ada);
    await scoring().drain();
    commit("t1a4", "four\n");
    await call("POST", `${base}/attempts/t1a4/score`, ada);
    await finish(3, { status: "done", result: result({ gate: "failed" }) });
    const moved = push(1, 4, "four again\n");

    const res = await call("GET", `${base}/tasks/t1/arena`, bob);
    expect(res.status).toBe(200);
    expect(res.body["task"]).toBe("t1");
    expect(res.body["attempts"]).toEqual([
      {
        ref: "t1a1",
        state: "draft",
        author: { id: expect.any(String), handle: "ada" },
        status: "done",
        sha: scored,
        base: { sha: root, on: "main" },
        verdicts: expect.anything(),
        result: {
          ...result(),
          run: 1,
          finishedAt: "2026-10-10T12:00:00.000Z",
          metrics: { coverage: 81.5, bundle_kb: 120 },
        },
      },
      {
        ref: "t1a2",
        state: "draft",
        author: expect.anything(),
        verdicts: expect.anything(),
        status: "running",
        sha: running,
        base: { sha: root, on: "main" },
      },
      {
        ref: "t1a3",
        state: "draft",
        author: expect.anything(),
        verdicts: expect.anything(),
        status: "none",
        sha: null,
        base: { sha: root, on: "main" },
      },
      {
        ref: "t1a4",
        state: "draft",
        author: expect.anything(),
        verdicts: expect.anything(),
        status: "none",
        sha: moved,
        base: { sha: root, on: "main" },
      },
    ]);
  });

  it("derives each active attempt's base from its current head: the task branch when the task has one", async () => {
    const { call, ada, repos, projectId, root, base, drafts, commit } = await setup();
    await drafts(2);
    commit("t1a1", "one\n");
    const origin = `${projectId}-main`;
    const tests = repos.commit(origin, {
      files: { "README.md": "hi\n", "t.test": "x\n" },
      branch: "task",
      parents: [root],
    });
    repos.commit(origin, { files: { "README.md": "main moved\n" } });
    repos.setRef(origin, "refs/tasks/t1", tests.hash);
    repos.push(origin, `${projectId}-t1a2`, "refs/heads/main", tests.hash);
    commit("t1a2", "two\n");

    const res = await call("GET", `${base}/tasks/t1/arena`, ada);
    expect(res.body["attempts"].map((a: Json) => [a["ref"], a["status"], a["base"]])).toEqual([
      ["t1a1", "none", { sha: root, on: "task" }],
      ["t1a2", "none", { sha: tests.hash, on: "task" }],
    ]);
  });

  it("declares the metrics of the config on main, with their units and which way is better", async () => {
    const { call, ada, repos, projectId, base, drafts } = await setup();
    await drafts(1);
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["metrics"]).toEqual([]);
    const config = [
      "checks:",
      "  - name: test",
      "    command: pnpm test",
      "    metrics: [{ name: coverage, unit: '%', order: desc }]",
      "  - name: bundle",
      "    command: pnpm build",
      "    metrics: [{ name: bundle_kb, order: asc }]",
    ].join("\n");
    repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n", ".throng/config.yml": config } });
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["metrics"]).toEqual([
      { name: "coverage", unit: "%", order: "desc" },
      { name: "bundle_kb", unit: null, order: "asc" },
    ]);
  });

  it("gives an ended attempt no base", async () => {
    const { call, greg, ada, base, drafts, commit } = await setup();
    await drafts(1);
    commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/obsolete`, greg);
    const res = await call("GET", `${base}/tasks/t1/arena`, ada);
    expect(res.body["attempts"][0]).toMatchObject({ state: "obsolete", base: null });
  });

  it("keeps obsolete attempts in, with their state, so a UI can filter them", async () => {
    const { call, greg, ada, base, drafts } = await setup();
    await drafts(2);
    await call("POST", `${base}/attempts/t1a2/obsolete`, greg);
    const res = await call("GET", `${base}/tasks/1/arena`, ada);
    expect(res.body["attempts"].map((a: Json) => [a["ref"], a["state"]])).toEqual([
      ["t1a1", "draft"],
      ["t1a2", "obsolete"],
    ]);
  });

  it("is 404 for an unknown task, 400 for a bad reference and 401 without a caller", async () => {
    const { call, ada, base, drafts } = await setup();
    await drafts(1);
    expect((await call("GET", `${base}/tasks/t9/arena`, ada)).status).toBe(404);
    expect((await call("GET", `${base}/tasks/x/arena`, ada)).status).toBe(400);
    expect((await call("GET", `${base}/tasks/t1/arena`)).status).toBe(401);
  });
});

describe("scoring runs", () => {
  it("lists an attempt's runs newest first, superseded and cancelled ones included, and gets one", async () => {
    const { call, ada, bob, base, drafts, commit, push, finish } = await setup();
    await drafts();
    const first = commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    await finish(1, { status: "done", result: result() });
    const second = push(1, 1, "two\n");
    const third = push(1, 1, "three\n");

    const list = await call("GET", `${base}/attempts/t1a1/runs`, bob);
    expect(list.status).toBe(200);
    expect(list.body["runs"].map((r: Json) => [r["id"], r["sha"], r["status"], r["superseded"]])).toEqual([
      [3, third, "queued", false],
      [2, second, "cancelled", true],
      [1, first, "done", true],
    ]);

    const one = await call("GET", `${base}/runs/1`, bob);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({
      id: 1,
      ref: "t1a1",
      sha: first,
      trigger: "open",
      status: "done",
      requestedBy: { id: expect.any(String), handle: "ada" },
      agent: null,
      createdAt: "2026-10-10T12:00:00.000Z",
      startedAt: "2026-10-10T12:00:00.000Z",
      finishedAt: "2026-10-10T12:00:00.000Z",
      superseded: true,
      error: null,
      result: result(),
    });
    expect(list.body["runs"][2]).toEqual(one.body);
  });

  it("shows an errored run's error and no result", async () => {
    const { call, ada, base, drafts, commit, finish } = await setup();
    await drafts();
    commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/score`, ada);
    await finish(1, { status: "errored", error: "sandbox lost" });
    expect((await call("GET", `${base}/runs/1`, ada)).body).toMatchObject({
      status: "errored",
      error: "sandbox lost",
      result: null,
    });
    expect((await call("GET", `${base}/attempts/t1a1/scoring`, ada)).body).toMatchObject({ status: "errored" });
  });

  it("is 404 for an unknown run or attempt and 400 for a bad run id", async () => {
    const { call, ada, base, drafts } = await setup();
    await drafts();
    expect((await call("GET", `${base}/attempts/t1a1/runs`, ada)).body).toEqual({ runs: [] });
    expect((await call("GET", `${base}/runs/7`, ada)).status).toBe(404);
    expect((await call("GET", `${base}/attempts/t1a9/runs`, ada)).status).toBe(404);
    expect((await call("GET", `${base}/runs/x`, ada)).status).toBe(400);
    expect((await call("GET", `/projects/greg/nothing/runs/1`, ada)).status).toBe(404);
    expect((await call("GET", `${base}/runs/1`)).status).toBe(401);
  });
});

describe("attempt scoring", () => {
  it("is none with no sha for an attempt that was never pushed", async () => {
    const { call, bob, base, drafts } = await setup();
    await drafts();
    const res = await call("GET", `${base}/attempts/t1a1/scoring`, bob);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "none", sha: null });
  });

  it("follows the head's run from queued to running to done, with its result", async () => {
    const { call, ada, bob, base, drafts, commit, scoring, finish } = await setup();
    await drafts();
    const head = commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/score`, ada);
    const path = `${base}/attempts/t1a1/scoring`;
    expect((await call("GET", path, bob)).body).toEqual({ status: "queued", sha: head });

    await scoring().drain();
    expect((await call("GET", path, bob)).body).toEqual({ status: "running", sha: head });

    await finish(1, { status: "done", result: result() });
    const done = await call("GET", path, bob);
    expect(done.body).toEqual({
      status: "done",
      sha: head,
      result: {
        ...result(),
        run: 1,
        finishedAt: "2026-10-10T12:00:00.000Z",
        metrics: { coverage: 81.5, bundle_kb: 120 },
      },
    });
  });

  it("keeps the head's result while a rescore of it runs, and never returns a superseded one", async () => {
    const { call, ada, greg, base, drafts, commit, push, scoring, finish } = await setup();
    await drafts();
    commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    await finish(1, { status: "done", result: result() });
    await call("POST", `${base}/attempts/t1a1/rescore`, greg);
    await scoring().drain();
    const path = `${base}/attempts/t1a1/scoring`;
    expect((await call("GET", path, ada)).body).toMatchObject({ status: "running", result: { run: 1 } });

    const newer = push(1, 1, "two\n");
    expect((await call("GET", path, ada)).body).toEqual({ status: "queued", sha: newer });
  });

  it("drops a draft's result once a push moves its head, though the draft isn't scored", async () => {
    const { call, ada, base, drafts, commit, push, finish } = await setup();
    await drafts();
    commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/score`, ada);
    await finish(1, { status: "done", result: result() });
    const newer = push(1, 1, "two\n");
    expect((await call("GET", `${base}/attempts/t1a1/scoring`, ada)).body).toEqual({ status: "none", sha: newer });
  });

  it("is 404 for an unknown attempt and 400 for a bad reference, and needs a caller", async () => {
    const { call, ada, base, drafts } = await setup();
    await drafts();
    expect((await call("GET", `${base}/attempts/t1a9/scoring`, ada)).status).toBe(404);
    expect((await call("GET", `${base}/attempts/t1/scoring`, ada)).status).toBe(400);
    expect((await call("GET", `${base}/attempts/t1a1/scoring`)).status).toBe(401);
  });
});
