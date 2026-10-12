import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ScoringResult } from "../src/results.ts";
import type { ScoringOutcome } from "../src/scoring.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { at } from "./support/defined.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");

const RESULT: ScoringResult = {
  base: "b".repeat(40),
  config: { kind: "none" },
  gate: "passed",
  checks: [],
  builtin: { filesChanged: 1, additions: 2, deletions: 0, durationMs: 5 },
  preview: { status: "none" },
  logs: [],
};

async function setup() {
  const repos = new FakeRepos();
  const runner = {
    workflow: { create: async () => ({}), get: async () => ({ terminate: async () => {} }) },
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
    const res = await api.request(`https://throng.test${path}`, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const adaClaude = await tokenFor("ada@example.com", "claude");
  const bob = await tokenFor("bob@example.com");
  const projectId = (await call("POST", "/projects", greg, { handle: "throng" })).body["id"] as string;
  repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n" } });
  const base = "/projects/greg/throng";
  const project = { id: projectId, owner: "" };
  const me = (await call("GET", "/me", ada)).body as { user: User; alias: null };

  // A task by greg with two draft attempts by ada.
  await call("POST", `${base}/tasks`, greg, { title: "Fix it" });
  await call("POST", `${base}/tasks/t1/attempts`, ada, { count: 2 });

  /** Pushes a new head to ada's attempt `t1a<n>` and records it, as the git proxy does once it lands. */
  const push = (attempt: number, content: string) => {
    const fork = `${projectId}-t1a${attempt}`;
    const before = repos.ref(fork, "refs/heads/main") ?? "0".repeat(40);
    const after = repos.commit(fork, { files: { "README.md": content } }).hash;
    store(projectId).recordPush(project, me, {
      task: 1,
      number: attempt,
      updates: [{ ref: "refs/heads/main", before, after }],
    });
    return after;
  };
  /** Starts queued runs, then reports how ada's attempt `t1a<n>`'s latest run ended. */
  const finish = async (attempt: number, outcome: ScoringOutcome = { status: "done", result: RESULT }) => {
    const scoring = store(projectId).scoring;
    await scoring.drain();
    const run = at(scoring.listRuns({ task: 1, attempt }), -1);
    expect(store(projectId).scoringFinished(run.id, outcome)).toBeTruthy();
  };
  /** Starts a wait on `t1a<n>`; its answer arrives once something changes or the timers run out. */
  const wait = (attempt: number, query: string, token = ada) =>
    call("GET", `${base}/attempts/t1a${attempt}?${query}`, token);
  /** Lets every pending request reach its wait. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  return { call, store, projectId, greg, ada, adaClaude, bob, base, push, finish, wait, settle };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("waiting on an attempt", () => {
  it("answers with the attempt and changed: false once the wait runs out with nothing changed", async () => {
    const { wait, settle } = await setup();
    let answered = false;
    const answer = wait(1, "wait=2").then((a) => {
      answered = true;
      return a;
    });
    await settle();
    await vi.advanceTimersByTimeAsync(1999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { status, body } = await answer;
    expect(status).toBe(200);
    expect(body).toMatchObject({ ref: "t1a1", state: "draft", changed: false });
  });
});
