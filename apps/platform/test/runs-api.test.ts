// The project's runs over REST: the list across every line with its filters and cursor, one run with
// its outcome, and cancelling one.

import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ScoringResult } from "../src/results.ts";
import { runOutcome } from "../src/run-outcome.ts";
import { pipelineFor, runReport } from "../src/scoring.ts";
import type { ScoringTrigger } from "../src/scoring.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { defined } from "./support/defined.ts";
import type { Json } from "./support/json.ts";
import { PASSED } from "./support/results.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");

/** A result whose setup and check ran: `test` passed with a `url` metric. */
const RESULT: ScoringResult = {
  ...PASSED,
  config: { kind: "valid" },
  checks: [{ name: "test", source: "project", outcome: "passed", durationMs: 900, notes: [] }],
  metrics: {
    test: { type: "enum", value: "passed", values: ["passed", "failed"], source: "platform" },
    preview: { type: "string", value: "https://t1a1.example.com", format: "url", source: "project" },
  },
  logs: ["setup.1", "test"],
};

async function setup() {
  const repos = new FakeRepos();
  const stopped: string[] = [];
  const runner = {
    workflow: {
      create: async () => ({}),
      get: async (id: string) => ({ terminate: async () => void stopped.push(id) }),
    },
    teardown: async () => {},
  };
  const { backend, store, sql } = testTaskBackends(repos, now, runner);
  const api = apiRoutes({ verifierFor: () => verify, now, repos: () => repos, tasks: () => backend });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
    const headers: Record<string, string> = bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` };
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
  const headers = { Authorization: `Bearer ${greg}`, "Content-Type": "application/json" };
  const created = await api.request("/projects", { method: "POST", headers, body: '{"handle":"throng"}' }, env);
  const projectId = ((await created.json()) as Json)["id"] as string;
  const me = (await call("GET", "/me", ada)).body as { user: User };
  const queue = () => store(projectId).scoring;

  /**
   * Queues a run on `line` at a new head, as ada; returns its id. Only attempt lines request runs so
   * far, so the row is written as the queue writes one.
   */
  let heads = 0;
  const run = (line: string, trigger: ScoringTrigger = "push") => {
    const sha = (++heads).toString(16).padStart(40, "0");
    const [row] = sql(projectId).exec<{ id: number }>(
      `INSERT INTO pipeline_runs (project, line, sha, pipeline, trigger, user_id, status, instance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING id`,
      projectId,
      line,
      sha,
      pipelineFor(line),
      trigger,
      me.user.id,
      `${line}-${sha}`,
      now().getTime(),
    );
    return row?.id ?? 0;
  };
  /** Starts queued runs, then ends run `id` with `result`. */
  const finish = async (id: number, result: ScoringResult = RESULT) => {
    await queue().drain();
    expect(queue().finish(id, runReport({ status: "done", result }))).toBeTruthy();
  };
  const setStatus = (id: number, status: string) =>
    sql(projectId).exec("UPDATE pipeline_runs SET status = ? WHERE id = ?", status, id);
  return { call, greg, ada, tokenFor, run, finish, setStatus, queue, stopped, base: "/projects/greg/throng" };
}

describe("GET /projects/{owner}/{project}/runs", () => {
  it("lists every line's runs newest first, with each one's line, pipeline, gate and who asked", async () => {
    const { call, ada, run, finish, base } = await setup();
    const first = run("t1a1", "open");
    await finish(first);
    run("main");
    run("t2");

    const res = await call("GET", `${base}/runs`, ada);
    expect(res.status).toBe(200);
    expect(res.body["next"]).toBeNull();
    expect(res.body["runs"].map((r: Json) => [r["id"], r["line"], r["pipeline"], r["status"], r["gate"]])).toEqual([
      [3, "t2", "default", "queued", null],
      [2, "main", "main", "queued", null],
      [1, "t1a1", "default", "done", "passed"],
    ]);
    expect(res.body["runs"][2]).toEqual({
      id: 1,
      line: "t1a1",
      pipeline: "default",
      sha: "1".padStart(40, "0"),
      trigger: "open",
      status: "done",
      trusted: false,
      requestedBy: { id: expect.any(String), handle: "ada" },
      alias: null,
      createdAt: "2026-10-10T12:00:00.000Z",
      startedAt: "2026-10-10T12:00:00.000Z",
      finishedAt: "2026-10-10T12:00:00.000Z",
      superseded: false,
      gate: "passed",
      cancellable: false,
      waiting: null,
    });
  });

  it("filters by a line, by `main`, by every task line, and by status", async () => {
    const { call, ada, run, setStatus, base } = await setup();
    run("t1a1");
    run("main");
    const waiting = run("t1");
    setStatus(waiting, "waiting");
    run("t2a1");

    const ids = async (query: string) =>
      (await call("GET", `${base}/runs?${query}`, ada)).body["runs"].map((r: Json) => r["id"]);
    expect(await ids("line=t1a1")).toEqual([1]);
    expect(await ids("line=main")).toEqual([2]);
    expect(await ids("line=tasks")).toEqual([4, 3, 1]);
    expect(await ids("status=waiting")).toEqual([3]);
    expect(await ids("line=tasks&status=queued")).toEqual([4, 1]);
    expect(await ids("line=t9")).toEqual([]);
  });

  it("pages by cursor: each page's `next` is the cursor of the one after it", async () => {
    const { call, ada, run, base } = await setup();
    for (const line of ["t1a1", "t1a2", "t1a3", "t1a4", "t1a5"]) run(line);

    const first = await call("GET", `${base}/runs?limit=2`, ada);
    expect(first.body["runs"].map((r: Json) => r["id"])).toEqual([5, 4]);
    expect(first.body["next"]).toBe(4);
    const second = await call("GET", `${base}/runs?limit=2&cursor=4`, ada);
    expect(second.body["runs"].map((r: Json) => r["id"])).toEqual([3, 2]);
    const last = await call("GET", `${base}/runs?limit=2&cursor=${second.body["next"]}`, ada);
    expect(last.body).toMatchObject({ runs: [{ id: 1 }], next: null });
  });

  it("refuses a bad line, status or cursor, an unknown project, and a caller without a token", async () => {
    const { call, ada, base } = await setup();
    for (const query of ["line=feature", "status=done,queued", "status=scoring", "cursor=0", "limit=101"]) {
      expect((await call("GET", `${base}/runs?${query}`, ada)).status, query).toBe(400);
    }
    expect((await call("GET", "/projects/greg/nothing/runs", ada)).status).toBe(404);
    expect((await call("GET", `${base}/runs`)).status).toBe(401);
  });
});

describe("GET /projects/{owner}/{project}/runs/{runId}", () => {
  it("gives the run with its outcome's steps in run order and its metrics", async () => {
    const { call, ada, run, finish, base } = await setup();
    const id = run("t1a1");
    await finish(id);

    const res = await call("GET", `${base}/runs/${id}`, ada);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, line: "t1a1", status: "done", gate: "passed", error: null, result: RESULT });
    const { steps, ...outcome } = runOutcome(RESULT);
    expect(res.body["outcome"]).toEqual({ ...outcome, steps: steps.map((step) => ({ ...step, after: [] })) });
    expect(res.body["outcome"]["steps"].map((s: Json) => [s["name"], s["kind"], s["log"]])).toEqual([
      ["setup.1", "setup", "setup.1"],
      ["test", "check", "test"],
    ]);
  });

  it("gives a run without an outcome until it is done", async () => {
    const { call, ada, run, base } = await setup();
    const id = run("main");
    expect((await call("GET", `${base}/runs/${id}`, ada)).body).toMatchObject({
      status: "queued",
      outcome: null,
      result: null,
      cancellable: true,
    });
  });
});

/** A run on `t1a1` waiting for the owner, naming DEPLOY; returns its id and head. */
async function waitingRun(t: Awaited<ReturnType<typeof setup>>) {
  const id = t.run("t1a1");
  const sha = defined(t.queue().getRun(id)?.sha);
  t.queue().moveHead("t1a1", sha, false);
  await t.queue().drain();
  expect(t.queue().wait(defined(t.queue().getRun(id)), ["DEPLOY"])).toBeTruthy();
  return { id, sha };
}

describe("POST /projects/{owner}/{project}/runs/{runId}/start", () => {
  it("lists a waiting run with the head Start names, its attempt and the secrets it would hold", async () => {
    const t = await setup();
    const { id, sha } = await waitingRun(t);
    const res = await t.call("GET", `${t.base}/runs/${id}`, t.ada);
    expect(res.body).toMatchObject({
      status: "waiting",
      cancellable: true,
      waiting: { head: sha, attempt: "t1a1", secrets: ["DEPLOY"] },
    });
    const listed = await t.call("GET", `${t.base}/runs?status=waiting`, t.ada);
    expect(listed.body["runs"][0]["waiting"]).toEqual({ head: sha, attempt: "t1a1", secrets: ["DEPLOY"] });
  });

  it("starts it for the owner at the head they name: queued again, trusted, triggered `start`", async () => {
    const t = await setup();
    const { id, sha } = await waitingRun(t);
    const res = await t.call("POST", `${t.base}/runs/${id}/start`, t.greg, { sha });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      sha,
      status: "queued",
      trusted: true,
      trigger: "start",
      requestedBy: { handle: "greg" },
      alias: null,
      waiting: null,
    });
  });

  it("refuses another head, a run that isn't waiting, anyone but the owner, and the owner under an alias", async () => {
    const t = await setup();
    const { id, sha } = await waitingRun(t);
    const stale = await t.call("POST", `${t.base}/runs/${id}/start`, t.greg, { sha: "f".repeat(40) });
    expect(stale.status).toBe(409);
    expect(stale.body["error"]["code"]).toBe("invalidState");
    expect((await t.call("POST", `${t.base}/runs/${id}/start`, t.ada, { sha })).status).toBe(403);
    const gregClaude = await t.tokenFor("greg@example.com", "claude");
    const aliased = await t.call("POST", `${t.base}/runs/${id}/start`, gregClaude, { sha });
    expect(aliased.status).toBe(403);
    expect(aliased.body["error"]["message"]).toBe("only the project owner, acting as themselves, may");
    expect((await t.call("POST", `${t.base}/runs/${id + 1}/start`, t.greg, { sha })).status).toBe(404);
    expect((await t.call("POST", `${t.base}/runs/${id}/start`, t.greg, {})).status).toBe(400);
    expect((await t.call("POST", `${t.base}/runs/${id}/start`, undefined, { sha })).status).toBe(401);
    const queued = t.run("t2a1");
    const notWaiting = await t.call("POST", `${t.base}/runs/${queued}/start`, t.greg, { sha });
    expect(notWaiting.status).toBe(409);
    expect((await t.call("GET", `${t.base}/runs/${id}`, t.greg)).body).toMatchObject({ status: "waiting" });
  });
});

describe("POST /projects/{owner}/{project}/runs/{runId}/cancel", () => {
  it("cancels a queued, waiting or running run for the owner, and stops one that started", async () => {
    const { call, greg, run, setStatus, queue, stopped, base } = await setup();
    const running = run("t2a1");
    await queue().drain();
    const queued = run("t1a1");
    const waiting = run("t1");
    setStatus(waiting, "waiting");

    for (const id of [queued, waiting, running]) {
      const res = await call("POST", `${base}/runs/${id}/cancel`, greg);
      expect(res.status, `run ${id}`).toBe(200);
      expect(res.body).toMatchObject({ id, status: "cancelled", cancellable: false });
    }
    await queue().drain();
    expect(stopped).toHaveLength(1);
  });

  it("refuses a run that ended, and `main`'s running run, which may be deploying", async () => {
    const { call, greg, run, finish, queue, base } = await setup();
    const done = run("t1a1");
    await finish(done);
    const deploying = run("main");
    await queue().drain();

    for (const id of [done, deploying]) {
      const res = await call("POST", `${base}/runs/${id}/cancel`, greg);
      expect(res.status, `run ${id}`).toBe(409);
      expect(res.body["error"]["code"]).toBe("invalidState");
    }
    expect((await call("GET", `${base}/runs/${deploying}`, greg)).body).toMatchObject({ status: "running" });
  });

  it("is the owner's alone, is 404 for an unknown run, and needs a token", async () => {
    const { call, ada, greg, tokenFor, run, base } = await setup();
    const id = run("t1a1");
    expect((await call("POST", `${base}/runs/${id}/cancel`, ada)).status).toBe(403);
    expect((await call("POST", `${base}/runs/${id + 1}/cancel`, greg)).status).toBe(404);
    expect((await call("POST", `${base}/runs/${id}/cancel`)).status).toBe(401);
    const gregClaude = await tokenFor("greg@example.com", "claude");
    expect((await call("POST", `${base}/runs/${id}/cancel`, gregClaude)).status).toBe(200);
  });
});
