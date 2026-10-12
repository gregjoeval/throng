import { hc, parseResponse } from "hono/client";
import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ApiRoutes } from "../src/api.ts";
import { parseConfig } from "../src/config.ts";
import type { FollowParams } from "../src/follows.ts";
import { buildResult, withPreview } from "../src/results.ts";
import type { LegacyResult, ScoringResult } from "../src/results.ts";
import type { ScoringOutcome } from "../src/scoring.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");
const OUTCOMES = ["passed", "failed", "timedOut", "errored", "skipped"];

const CONFIG = parseConfig(`checks:
  - name: test
    command: npm test
  - name: bundle
    command: npm run size
    required: false
metrics:
  - { name: coverage, from: test.coverage.pct, type: number, unit: "%" }
  - { name: bundle_kb, from: bundle.size.kb, type: number, order: asc }
preview: {}
`);

/** A run's result as the Workflow builds it: two checks with a metric each, and a deployed Preview. */
function result(overrides: Partial<ScoringResult> = {}): ScoringResult {
  const scored = buildResult(CONFIG, {
    base: "b".repeat(40),
    shortstat: " 1 file changed, 2 insertions(+)",
    builtinMs: 5,
    setupFailed: null,
    checks: [
      { exit: 0, durationMs: 900, metrics: { coverage: { value: 81.5 } } },
      { exit: 1, durationMs: 300, metrics: { bundle_kb: { value: 120 } } },
    ],
  });
  return { ...withPreview(scored, { ok: true, url: "https://t1a1.preview.test" }, 40), ...overrides };
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
  const followed: FollowParams[] = [];
  const follow = { workflow: { create: async ({ params }: { params: FollowParams }) => followed.push(params) } };
  const { backend, store } = testTaskBackends(repos, now, runner, undefined, follow);
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
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
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
  const me = (await call("GET", "/me", ada)).body as { user: User; alias: null };
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

  /** Marks ada's attempt needs update: the task branch moves and its follow conflicts. */
  const conflict = async (task: number, attempt: number) => {
    const tasks = store(projectId);
    const project = { id: projectId, owner: "" };
    const head = repos.commit(`${projectId}-main`, { files: { "test.txt": "t\n" }, branch: `tasks-t${task}` }).hash;
    tasks.recordTaskBranchPush(project, me, { task, head });
    await tasks.drain(projectId);
    const started = followed.findLast((p) => p.task === task && p.attempt === attempt);
    if (started === undefined) throw new Error(`no follow of t${task}a${attempt}`);
    expect(tasks.claimFollowPush(started.follow)).toBeTruthy();
    const before = repos.ref(`${projectId}-t${task}a${attempt}`, "refs/heads/main") ?? root;
    expect(await tasks.followFinished(started.follow, { kind: "conflict", head: before })).toBeTruthy();
  };
  return {
    api,
    env,
    repos,
    projectId,
    root,
    call,
    greg,
    ada,
    bob,
    base,
    drafts,
    commit,
    push,
    scoring,
    finish,
    conflict,
  };
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
        alias: null,
        status: "done",
        sha: scored,
        base: { sha: root, on: "main" },
        needsUpdate: false,
        verdicts: expect.anything(),
        result: {
          ...result(),
          run: 1,
          finishedAt: "2026-10-10T12:00:00.000Z",
        },
      },
      {
        ref: "t1a2",
        state: "draft",
        author: expect.anything(),
        alias: null,
        verdicts: expect.anything(),
        status: "running",
        sha: running,
        base: { sha: root, on: "main" },
        needsUpdate: false,
      },
      {
        ref: "t1a3",
        state: "draft",
        author: expect.anything(),
        alias: null,
        verdicts: expect.anything(),
        status: "none",
        sha: null,
        base: { sha: root, on: "main" },
        needsUpdate: false,
      },
      {
        ref: "t1a4",
        state: "draft",
        author: expect.anything(),
        alias: null,
        verdicts: expect.anything(),
        status: "none",
        sha: moved,
        base: { sha: root, on: "main" },
        needsUpdate: false,
      },
    ]);
  });

  it("gives a current result's checks with their source, and every metric in one flat map", async () => {
    const { call, ada, base, drafts, commit, finish } = await setup();
    await drafts();
    commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/score`, ada);
    await finish(1, { status: "done", result: result() });

    const arena = (await call("GET", `${base}/tasks/t1/arena`, ada)).body;
    const current = arena["attempts"][0]["result"] as Json;
    expect(current).not.toHaveProperty("builtin");
    expect(current).not.toHaveProperty("preview");
    expect((current["checks"] as Json[]).map((c) => [c["name"], c["source"], c["outcome"]])).toEqual([
      ["_diff", "platform", "passed"],
      ["test", "project", "passed"],
      ["bundle", "project", "failed"],
      ["_preview", "platform", "passed"],
    ]);
    expect(current["metrics"]).toEqual({
      _diff: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
      "_diff.filesChanged": { source: "platform", type: "number", value: 1, order: "asc" },
      "_diff.additions": { source: "platform", type: "number", value: 2, order: "asc" },
      "_diff.deletions": { source: "platform", type: "number", value: 0, order: "asc" },
      test: { source: "project", type: "enum", value: "passed", values: OUTCOMES },
      coverage: { source: "project", type: "number", value: 81.5, order: "desc", unit: "%" },
      bundle: { source: "project", type: "enum", value: "failed", values: OUTCOMES },
      bundle_kb: { source: "project", type: "number", value: 120, order: "asc" },
      _preview: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
      "_preview.url": { source: "platform", type: "string", format: "url", value: "https://t1a1.preview.test" },
    });
  });

  it("answers in the current shape for a result stored with builtin and preview", async () => {
    const { call, ada, base, drafts, commit, finish } = await setup();
    await drafts();
    commit("t1a1", "one\n");
    await call("POST", `${base}/attempts/t1a1/score`, ada);
    const legacy: LegacyResult = {
      base: null,
      config: { kind: "valid" },
      gate: "passed",
      checks: [
        { name: "test", required: true, outcome: "passed", durationMs: 9, metrics: { coverage: 80 }, notes: [] },
      ],
      builtin: { filesChanged: 2, additions: 5, deletions: 1, durationMs: 3 },
      preview: { status: "failed" },
      logs: ["test"],
    };
    await finish(1, { status: "done", result: legacy as unknown as ScoringResult });

    const run = (await call("GET", `${base}/runs/1`, ada)).body["result"] as Json;
    expect(run).not.toHaveProperty("builtin");
    expect(run).toMatchObject({
      checks: [{ name: "_diff" }, { name: "test", source: "project" }, { name: "_preview", outcome: "failed" }],
      metrics: {
        "_diff.additions": { value: 5 },
        coverage: { source: "project", type: "number", value: 80 },
        "_preview.url": { value: null },
      },
    });
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
      "  - name: bundle",
      "    command: pnpm build",
      "metrics:",
      "  - { name: coverage, from: test.coverage.pct, type: number, unit: '%' }",
      "  - { name: bundle_kb, from: bundle.size.kb, type: number, order: asc }",
    ].join("\n");
    repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n", ".throng/config.yml": config } });
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["metrics"]).toEqual([
      { name: "coverage", from: "test.coverage.pct", type: "number", unit: "%", order: "desc", source: "project" },
      { name: "bundle_kb", from: "bundle.size.kb", type: "number", unit: null, order: "asc", source: "project" },
    ]);
  });

  it("declares the task's own metrics after the project's, each with its source", async () => {
    const { call, ada, repos, projectId, base, drafts } = await setup();
    await drafts(1);
    const config = [
      "checks:",
      "  - name: test",
      "    command: pnpm test",
      "metrics:",
      "  - { name: coverage, from: test.coverage.pct, type: number, unit: '%' }",
    ].join("\n");
    repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n", ".throng/config.yml": config } });
    const lines = { name: "lines", from: "test.coverage.lines", type: "number", order: "asc" };
    expect((await call("PATCH", `${base}/tasks/t1`, ada, { metrics: [lines] })).status).toBe(200);
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["metrics"]).toEqual([
      { name: "coverage", from: "test.coverage.pct", type: "number", unit: "%", order: "desc", source: "project" },
      { ...lines, unit: null, source: "task" },
    ]);
  });

  it("shows where a forked attempt came from, and bases it on main, not on its source", async () => {
    const { call, ada, repos, projectId, root, base, drafts, commit } = await setup();
    await drafts(1);
    const source = commit("t1a1", "one\n");
    await call("POST", `${base}/tasks/t1/attempts`, ada, { from: "t1a1" });
    commit("t1a1", "one more\n");
    expect(repos.ref(`${projectId}-t1a2`, "refs/heads/main")).toBe(source);
    const res = await call("GET", `${base}/tasks/t1/arena`, ada);
    expect(res.body["attempts"].map((a: Json) => [a["ref"], a["base"], a["forkedFrom"]])).toEqual([
      ["t1a1", { sha: root, on: "main" }, undefined],
      ["t1a2", { sha: root, on: "main" }, "t1a1"],
    ]);
    expect("forkedFrom" in res.body["attempts"][0]).toBeFalsy();
  });

  it("says which attempts need update", async () => {
    const { call, ada, base, drafts, conflict } = await setup();
    await drafts(2);
    expect(
      (await call("GET", `${base}/tasks/t1/arena`, ada)).body["attempts"].map((a: Json) => a["needsUpdate"]),
    ).toEqual([false, false]);
    await conflict(1, 2);
    const res = await call("GET", `${base}/tasks/t1/arena`, ada);
    expect(res.body["attempts"].map((a: Json) => [a["ref"], a["needsUpdate"]])).toEqual([
      ["t1a1", false],
      ["t1a2", true],
    ]);
    const needsUpdate = async (ref: string) => (await call("GET", `${base}/attempts/${ref}`, ada)).body["needsUpdate"];
    expect([await needsUpdate("t1a1"), await needsUpdate("t1a2")]).toEqual([false, true]);
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
      alias: null,
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
