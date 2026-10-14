// The latest dequeue of a task's merge request: why, the landing's run behind it, and the details
// that run holds.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ConflictDetails } from "../src/conflicts.ts";
import { conflictOutcome, landedOutcome } from "../src/landing.ts";
import type { LogStore } from "../src/logs.ts";
import type { ScoringResult } from "../src/results.ts";
import type { RunOutcome, RunStep } from "../src/run-outcome.ts";
import type { RunReport } from "../src/scoring.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { at } from "./support/defined.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");

class MemoryLogs implements LogStore {
  readonly objects = new Map<string, string>();
  async get(key: string) {
    const text = this.objects.get(key);
    return text === undefined ? null : { body: new Response(text).body as ReadableStream };
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
}

const passed: ScoringResult = {
  base: null,
  config: { kind: "none" },
  gate: "passed",
  checks: [],
  metrics: {},
  logs: [],
};

/** The fixture worker's `src/greeting.js` (the spike's conflict), its greeting set to `word`. */
const greeting = (word: string) =>
  `export const GREETING = "${word}";\n\nexport function greet(name) {\n  return \`\${GREETING}, \${name}\`;\n}\n`;

/** A git blob sha. */
const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");

/** The project's files: the greeting, and `src/gone.js` unless `gone` is null. */
const file = (word: string, gone: string | null) => ({
  "src/greeting.js": greeting(word),
  ...(gone === null ? {} : { "src/gone.js": gone }),
});

const workflow = { create: async () => ({}), get: async () => ({ terminate: async () => {} }) };

const JSON_TYPE = { "Content-Type": "application/json" };

/**
 * A project whose task t1 has one attempt, t1a1, selected and landing: main and the attempt both
 * changed `src/greeting.js` from the same base, as in the spike's conflict.
 */
async function setup() {
  const repos = new FakeRepos();
  const logs = new MemoryLogs();
  const runner = { workflow, teardown: async () => {} };
  const { backend, store } = testTaskBackends(repos, now, runner);
  const api = apiRoutes({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    tasks: () => backend,
    logs: () => logs,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const request = (path: string, bearer?: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (bearer !== undefined) headers["Authorization"] = `Bearer ${bearer}`;
    return api.request(path, { ...init, headers }, env);
  };
  const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
    const init = body === undefined ? { method } : { method, body: JSON.stringify(body), headers: JSON_TYPE };
    const res = await request(path, bearer, init);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tokenFor = async (email: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: "{}" }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const bob = await tokenFor("bob@example.com");
  const project = (await call("POST", "/projects", greg, { handle: "throng" })).body;
  const id = project["id"] as string;
  const base = repos.commit(`${id}-main`, { files: file("hello", "x\n") }).hash;
  const p = "/projects/greg/throng";
  await call("POST", `${p}/tasks`, ada, { title: "Fix the greeting" });
  await call("POST", `${p}/tasks/t1/attempts`, bob);
  const head = repos.commit(`${id}-t1a1`, { files: file("hello from a2", "y\n") }).hash;
  await call("POST", `${p}/attempts/t1a1/open`, bob);
  const main = repos.commit(`${id}-main`, { files: file("hello from a1", null) }).hash;

  const tasks = store(id);
  await tasks.drain(id);
  const run = at(tasks.runs.listRuns("t1a1"), -1);
  tasks.scoringFinished(run.id, { status: "done", result: passed });
  expect((await call("POST", `${p}/tasks/t1/selection`, ada, { attempt: "t1a1" })).body["state"]).toBe("queued");
  await tasks.drain(id);
  expect((await call("GET", `${p}/tasks/t1/merge-request`, ada)).body["state"]).toBe("landing");

  /** Ends the landing's run the way its Workflow would report it; returns the run's id. */
  const finish = async (report: RunReport) => {
    const [landing] = tasks.runs.liveLandings();
    if (landing === undefined) throw new Error("nothing is landing");
    expect(await tasks.pipelineReported(landing.id, report)).toBeTruthy();
    return landing.id;
  };
  return { call, request, logs, finish, greg, ada, bob, id, base, head, main, p };
}

/** The conflict a landing's `merge` reports for the spike's conflict, plus a file deleted on main. */
function greetingConflict({ base, head, main }: { base: string; head: string; main: string }): ConflictDetails {
  return {
    attempt: "t1a1",
    head,
    main,
    base,
    files: [
      {
        path: "src/greeting.js",
        type: "content",
        blobs: {
          base: blobSha(greeting("hello")),
          main: blobSha(greeting("hello from a1")),
          attempt: blobSha(greeting("hello from a2")),
        },
        modes: { base: "100644", main: "100644", attempt: "100644" },
        truncated: false,
        hunks: [
          {
            startLine: 1,
            base: ['export const GREETING = "hello";'],
            main: ['export const GREETING = "hello from a1";'],
            attempt: ['export const GREETING = "hello from a2";'],
          },
        ],
      },
      {
        path: "src/gone.js",
        type: "modifyDelete",
        blobs: { base: blobSha("x\n"), main: null, attempt: blobSha("y\n") },
        modes: { base: "100644", main: null, attempt: "100644" },
        truncated: false,
      },
    ],
  };
}

/** A run step, as a landing's run's outcome lists it. */
const step = (name: string, kind: RunStep["kind"], outcome: RunStep["outcome"]): RunStep => ({
  name,
  kind,
  source: name === "land" ? "platform" : "project",
  group: null,
  outcome,
  durationMs: 1,
  notes: [],
  log: null,
});

describe("GET …/tasks/{t}/merge-request/dequeue", () => {
  it("serves a conflict's details from its landing's run, in camelCase, hunks and blobs included", async () => {
    const env = await setup();
    const { call, finish, bob, base, head, main, p } = env;
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob)).status).toBe(404);
    const run = await finish({ status: "done", outcome: conflictOutcome(greetingConflict(env)) });

    const res = await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reason: "conflict",
      run,
      at: "2026-10-10T12:00:00.000Z",
      details: {
        attempt: "t1a1",
        head,
        main,
        base,
        files: [
          {
            path: "src/greeting.js",
            type: "content",
            blobs: {
              base: blobSha(greeting("hello")),
              main: blobSha(greeting("hello from a1")),
              attempt: blobSha(greeting("hello from a2")),
            },
            modes: { base: "100644", main: "100644", attempt: "100644" },
            truncated: false,
            hunks: [
              {
                startLine: 1,
                base: ['export const GREETING = "hello";'],
                main: ['export const GREETING = "hello from a1";'],
                attempt: ['export const GREETING = "hello from a2";'],
              },
            ],
          },
          {
            path: "src/gone.js",
            type: "modifyDelete",
            blobs: { base: blobSha("x\n"), main: null, attempt: blobSha("y\n") },
            modes: { base: "100644", main: null, attempt: "100644" },
            truncated: false,
          },
        ],
      },
    });
    // The merge request names the run behind it, whose outcome keeps the conflict.
    expect((await call("GET", `${p}/tasks/t1/merge-request`, bob)).body["lastDequeue"]).toEqual({
      reason: "conflict",
      run,
      at: "2026-10-10T12:00:00.000Z",
    });
    const detail = await call("GET", `${p}/runs/${run}`, bob);
    expect(detail.body["outcome"]["landed"]).toMatchObject({ kind: "conflict", details: { files: [{}, {}] } });
    expect(detail.body["outcome"]).not.toHaveProperty("conflict");
  });

  it("keys a landing run's `landed` on what happened: the commit it landed", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const sha = "e".repeat(40);
    const run = await finish({ status: "done", outcome: landedOutcome(sha) });
    expect((await call("GET", `${p}/runs/${run}`, bob)).body["outcome"]["landed"]).toEqual({ kind: "landed", sha });
  });

  it("serves a failed gate's failed steps from its landing's run", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const outcome: RunOutcome = {
      base: null,
      config: { kind: "valid" },
      gate: "failed",
      steps: [
        step("deps", "setup", "passed"),
        step("test", "check", "failed"),
        step("e2e", "check", "skipped"),
        step("land", "step", "skipped"),
      ],
      metrics: {},
    };
    const run = await finish({ status: "done", outcome });
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob)).body).toEqual({
      reason: "failedChecks",
      run,
      at: expect.any(String),
      details: { steps: [{ name: "test", kind: "check", outcome: "failed" }] },
    });
  });

  it("serves an errored landing's error from its run", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const run = await finish({ status: "errored", error: "land: main moved; the lease failed" });
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob)).body).toEqual({
      reason: "errored",
      run,
      at: expect.any(String),
      details: { error: "land: main moved; the lease failed" },
    });
  });

  it("is 404 for a task with no merge request, and 400 for a bad reference", async () => {
    const { call, ada, p } = await setup();
    await call("POST", `${p}/tasks`, ada, { title: "other" });
    expect((await call("GET", `${p}/tasks/t2/merge-request/dequeue`, ada)).body["error"]["code"]).toBe("notFound");
    expect((await call("GET", `${p}/tasks/x/merge-request/dequeue`, ada)).status).toBe(400);
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`)).status).toBe(401);
  });

  it("has no log route: the run's own routes serve its steps' logs", async () => {
    const env = await setup();
    const { request, finish, bob, p } = env;
    await finish({ status: "done", outcome: conflictOutcome(greetingConflict(env)) });
    expect((await request(`${p}/tasks/t1/merge-request/dequeue/logs/test`, bob)).status).toBe(404);
  });
});

/** The two routes that diff a landing's conflicting file: by its task's latest dequeue, and by its run. */
const CONFLICT_DIFFS = [
  {
    route: "dequeue",
    url: (p: string, _run: number, path: string) => `${p}/tasks/t1/merge-request/dequeue/files/${path}/diff`,
  },
  { route: "run", url: (p: string, run: number, path: string) => `${p}/runs/${run}/conflict/files/${path}/diff` },
] as const;

describe.each(CONFLICT_DIFFS)("a conflicting file's diff, by its $route", ({ url }) => {
  it("diffs one conflicting file from the base to main, or to the attempt", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const run = await finish({ status: "done", outcome: conflictOutcome(greetingConflict(env)) });

    const toMain = await call("GET", `${url(p, run, "src/greeting.js")}?side=main`, bob);
    expect(toMain.status).toBe(200);
    expect(toMain.body).toMatchObject({
      path: "src/greeting.js",
      status: "modified",
      oldMode: "100644",
      newMode: "100644",
      oldHash: blobSha(greeting("hello")),
      newHash: blobSha(greeting("hello from a1")),
      additions: 1,
      deletions: 1,
      flags: [],
    });
    expect(toMain.body["patch"]).toContain(
      '-export const GREETING = "hello";\n+export const GREETING = "hello from a1";\n',
    );
    const toAttempt = await call("GET", `${url(p, run, "src/greeting.js")}?side=attempt`, bob);
    expect(toAttempt.body["patch"]).toContain('+export const GREETING = "hello from a2";\n');
  });

  it("gives the unified patch for Accept: text/x-diff", async () => {
    const env = await setup();
    const { request, finish, bob, p } = env;
    const run = await finish({ status: "done", outcome: conflictOutcome(greetingConflict(env)) });
    const res = await request(`${url(p, run, "src/greeting.js")}?side=attempt`, bob, {
      headers: { Accept: "text/x-diff" },
    });
    expect(res.headers.get("Content-Type")).toBe("text/x-diff; charset=utf-8");
    expect(await res.text()).toMatch(/^diff --git a\/src\/greeting.js b\/src\/greeting.js\n/u);
  });

  it("shows a file deleted on main as deleted", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const run = await finish({ status: "done", outcome: conflictOutcome(greetingConflict(env)) });
    expect((await call("GET", `${url(p, run, "src/gone.js")}?side=main`, bob)).body).toMatchObject({
      path: "src/gone.js",
      status: "deleted",
      oldHash: blobSha("x\n"),
      newHash: null,
    });
    const toAttempt = await call("GET", `${url(p, run, "src/gone.js")}?side=attempt`, bob);
    expect(toAttempt.body).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
  });

  it("is 404 for a path that isn't conflicting or a landing that didn't conflict, 400 for a bad side", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const diff = (run: number, path: string, side = "main") => call("GET", `${url(p, run, path)}?side=${side}`, bob);
    const failed = await finish({ status: "errored", error: "land: main moved" });
    expect((await diff(failed, "src/greeting.js")).status).toBe(404);
    expect((await diff(failed, "src/greeting.js", "base")).status).toBe(400);
  });

  it("is 404 for a path the conflict didn't touch", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const run = await finish({ status: "done", outcome: conflictOutcome(greetingConflict(env)) });
    const res = await call("GET", `${url(p, run, "src/other.js")}?side=main`, bob);
    expect(res.body["error"]["code"]).toBe("notFound");
  });
});
