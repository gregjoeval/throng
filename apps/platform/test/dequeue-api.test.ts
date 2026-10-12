// The latest dequeue of a task's merge request: its details, the display diff of each conflicting
// file, and a failed retest's logs.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ConflictDetails } from "../src/conflicts.ts";
import type { LandingOutcome } from "../src/landing.ts";
import type { LogStore } from "../src/logs.ts";
import type { ScoringResult } from "../src/results.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { testTaskBackends } from "./support/task-backend.ts";

type Json = Record<string, any>;

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
  builtin: { filesChanged: 0, additions: 0, deletions: 0, durationMs: 1 },
  preview: { status: "none" },
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

/**
 * A project whose task t1 has one attempt, t1a1, selected and landing: main and the attempt both
 * changed `src/greeting.js` from the same base, as in the spike's conflict.
 */
async function setup() {
  const repos = new FakeRepos();
  const logs = new MemoryLogs();
  const runner = { workflow, teardown: async () => {} };
  const { backend, store } = testTaskBackends(repos, now, runner, runner);
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
  const run = tasks.scoring.listRuns({ task: 1, attempt: 1 }).at(-1)!;
  tasks.scoringFinished(run.id, { status: "done", result: passed });
  expect((await call("POST", `${p}/tasks/t1/selection`, ada, { attempt: "t1a1" })).body["state"]).toBe("queued");
  await tasks.drain(id);
  expect((await call("GET", `${p}/tasks/t1/merge-request`, ada)).body["state"]).toBe("landing");

  /** Ends the landing (the first one) the way its Workflow would report it. */
  const finish = async (outcome: LandingOutcome) => {
    expect(await tasks.landingFinished(1, outcome)).toBe(true);
  };
  return { call, request, logs, finish, greg, ada, bob, id, base, head, main, p };
}

const JSON_TYPE = { "Content-Type": "application/json" };

/** The details the Landing Workflow reports for the spike's conflict, plus a file deleted on main. */
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
        type: "modify_delete",
        blobs: { base: blobSha("x\n"), main: null, attempt: blobSha("y\n") },
        modes: { base: "100644", main: null, attempt: "100644" },
        truncated: false,
      },
    ],
  };
}

describe("GET …/tasks/{t}/merge-request/dequeue", () => {
  it("serves a conflict's details in snake_case, hunks and blobs included", async () => {
    const env = await setup();
    const { call, finish, bob, base, head, main, p } = env;
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob)).status).toBe(404);
    await finish({ kind: "conflict", details: greetingConflict(env) });

    const res = await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reason: "conflict",
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
                start_line: 1,
                base: ['export const GREETING = "hello";'],
                main: ['export const GREETING = "hello from a1";'],
                attempt: ['export const GREETING = "hello from a2";'],
              },
            ],
          },
          {
            path: "src/gone.js",
            type: "modify_delete",
            blobs: { base: blobSha("x\n"), main: null, attempt: blobSha("y\n") },
            modes: { base: "100644", main: null, attempt: "100644" },
            truncated: false,
          },
        ],
      },
    });
  });

  it("serves failed checks details as stored", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const details = { checks: [{ name: "test", outcome: "failed", log: "test" }] };
    await finish({ kind: "failed_checks", details: details as never });
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`, bob)).body).toEqual({
      reason: "failed_checks",
      at: expect.any(String),
      details,
    });
  });

  it("is 404 for a task with no merge request, and 400 for a bad reference", async () => {
    const { call, ada, p } = await setup();
    await call("POST", `${p}/tasks`, ada, { title: "other" });
    expect((await call("GET", `${p}/tasks/t2/merge-request/dequeue`, ada)).body["error"]["code"]).toBe("not_found");
    expect((await call("GET", `${p}/tasks/x/merge-request/dequeue`, ada)).status).toBe(400);
    expect((await call("GET", `${p}/tasks/t1/merge-request/dequeue`)).status).toBe(401);
  });
});

describe("GET …/tasks/{t}/merge-request/dequeue/files/{path}/diff", () => {
  it("diffs one conflicting file from the base to main, or to the attempt", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    await finish({ kind: "conflict", details: greetingConflict(env) });

    const toMain = await call("GET", `${p}/tasks/t1/merge-request/dequeue/files/src/greeting.js/diff?side=main`, bob);
    expect(toMain.status).toBe(200);
    expect(toMain.body).toMatchObject({
      path: "src/greeting.js",
      status: "modified",
      old_mode: "100644",
      new_mode: "100644",
      old_hash: blobSha(greeting("hello")),
      new_hash: blobSha(greeting("hello from a1")),
      additions: 1,
      deletions: 1,
      flags: [],
    });
    expect(toMain.body["patch"]).toContain(
      '-export const GREETING = "hello";\n+export const GREETING = "hello from a1";\n',
    );
    const toAttempt = await call(
      "GET",
      `${p}/tasks/t1/merge-request/dequeue/files/src/greeting.js/diff?side=attempt`,
      bob,
    );
    expect(toAttempt.body["patch"]).toContain('+export const GREETING = "hello from a2";\n');
  });

  it("gives the unified patch for Accept: text/x-diff", async () => {
    const env = await setup();
    const { request, finish, bob, p } = env;
    await finish({ kind: "conflict", details: greetingConflict(env) });
    const res = await request(`${p}/tasks/t1/merge-request/dequeue/files/src/greeting.js/diff?side=attempt`, bob, {
      headers: { Accept: "text/x-diff" },
    });
    expect(res.headers.get("Content-Type")).toBe("text/x-diff; charset=utf-8");
    expect(await res.text()).toMatch(/^diff --git a\/src\/greeting.js b\/src\/greeting.js\n/);
  });

  it("shows a file deleted on main as deleted", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    await finish({ kind: "conflict", details: greetingConflict(env) });
    const res = await call("GET", `${p}/tasks/t1/merge-request/dequeue/files/src/gone.js/diff?side=main`, bob);
    expect(res.body).toMatchObject({
      path: "src/gone.js",
      status: "deleted",
      old_hash: blobSha("x\n"),
      new_hash: null,
    });
    const toAttempt = await call("GET", `${p}/tasks/t1/merge-request/dequeue/files/src/gone.js/diff?side=attempt`, bob);
    expect(toAttempt.body).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
  });

  it("is 404 for a path that isn't conflicting or a dequeue that isn't a conflict, 400 for a bad side", async () => {
    const env = await setup();
    const { call, finish, bob, p } = env;
    const diff = (path: string, side = "main") =>
      call("GET", `${p}/tasks/t1/merge-request/dequeue/files/${path}/diff?side=${side}`, bob);
    expect((await diff("src/greeting.js")).status).toBe(404);
    await finish({ kind: "conflict", details: greetingConflict(env) });
    expect((await diff("src/other.js")).body["error"]["code"]).toBe("not_found");
    expect((await diff("src/greeting.js", "base")).status).toBe(400);
  });
});

describe("GET …/tasks/{t}/merge-request/dequeue/logs/{name}", () => {
  it("streams a failed retest's log from the landing that stored it", async () => {
    const env = await setup();
    const { request, logs, finish, bob, id, head, p } = env;
    logs.objects.set(`logs/${id}/t1a1/${head}/landing-1/test.log`, "1 failed\n");
    await finish({ kind: "failed_checks", details: { checks: [{ name: "test", outcome: "failed", log: "test" }] } });

    const res = await request(`${p}/tasks/t1/merge-request/dequeue/logs/test`, bob);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("1 failed\n");
  });

  it("is 404 for a check with no stored log, or a dequeue that isn't failed checks", async () => {
    const env = await setup();
    const { request, finish, bob, p } = env;
    expect((await request(`${p}/tasks/t1/merge-request/dequeue/logs/test`, bob)).status).toBe(404);
    await finish({
      kind: "failed_checks",
      details: { checks: [{ name: "lint", outcome: "timed_out", log: null }] },
    });
    for (const name of ["lint", "test", "..%2Fx"]) {
      expect((await request(`${p}/tasks/t1/merge-request/dequeue/logs/${name}`, bob)).status, name).toBe(404);
    }
  });
});
