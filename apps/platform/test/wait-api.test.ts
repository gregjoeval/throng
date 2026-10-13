import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import type { ScoringResult } from "../src/results.ts";
import type { ScoringOutcome } from "../src/scoring.ts";
import type { TaskBackend } from "../src/tasks.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { at } from "./support/defined.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");

const RESULT: ScoringResult = {
  base: "b".repeat(40),
  config: { kind: "none" },
  gate: "passed",
  checks: [],
  metrics: {},
  logs: [],
};

async function setup() {
  const repos = new FakeRepos();
  const runner = {
    workflow: { create: async () => ({}), get: async () => ({ terminate: async () => {} }) },
    teardown: async () => {},
  };
  const { backend, store } = testTaskBackends(repos, now, runner);
  // Counts the waits that reached the project's store, which snapshots them as they arrive. Each
  // can be dropped as a reset of the project's Durable Object drops it (see `evict`).
  let arrived = 0;
  const drops: ((error: Error) => void)[] = [];
  const counting = (projectId: string): TaskBackend => ({
    call: async (method, args) => {
      if (method !== "waitForAttempt") return backend(projectId).call(method, args);
      arrived++;
      const dropped = new Promise<never>((_, reject) => drops.push(reject));
      return Promise.race([backend(projectId).call(method, args), dropped]);
    },
  });
  /**
   * What a deploy, or an eviction, does to the waits in flight: the Durable Object's waiters live in
   * memory, so the runtime fails each caller's RPC with a reset error.
   */
  const evict = () => {
    for (const drop of drops.splice(0)) {
      drop(
        Object.assign(new Error("Durable Object reset because its code was updated."), { durableObjectReset: true }),
      );
    }
  };
  const api = apiRoutes({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    tasks: () => counting,
  });
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
  const push = async (attempt: number, content: string) => {
    const fork = `${projectId}-t1a${attempt}`;
    const before = repos.ref(fork, "refs/heads/main") ?? "0".repeat(40);
    const after = repos.commit(fork, { files: { "README.md": content } }).hash;
    const updates = [{ ref: "refs/heads/main", before, after }];
    const outcome = await backend(projectId).call("recordPush", [project, me, { task: 1, number: attempt, updates }]);
    expect(outcome.ok).toBeTruthy();
    return after;
  };
  /** Starts queued runs, then reports how ada's attempt `t1a<n>`'s latest run ended. */
  const finish = async (attempt: number, outcome: ScoringOutcome = { status: "done", result: RESULT }) => {
    const scoring = store(projectId).scoring;
    await scoring.drain();
    const run = at(scoring.listRuns({ task: 1, attempt }), -1);
    expect(store(projectId).scoringFinished(run.id, outcome)).toBeTruthy();
  };
  /**
   * Starts a wait on `t1a<n>` and lets it reach the store. `answered()` tells whether it has been
   * answered yet; `answer` is the response.
   */
  const wait = async (attempt: number, query: string, token = ada) => {
    let done = false;
    const before = arrived;
    const answer = call("GET", `${base}/attempts/t1a${attempt}?${query}`, token).then((res) => {
      done = true;
      return res;
    });
    // The request is answered without reaching the store when it is invalid.
    const reached = () => arrived > before || done;
    while (!reached()) await settle();
    await settle();
    return { answer, answered: () => done };
  };

  return { call, store, projectId, greg, ada, adaClaude, bob, base, push, finish, wait, evict };
}

/** Lets every pending request run as far as it can without the clock moving. */
async function settle() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getting an attempt", () => {
  it("answers at once without wait, with its git remote and no changed", async () => {
    const { call, ada, base, projectId } = await setup();
    const { status, body } = await call("GET", `${base}/attempts/t1a1?until=scored`, ada);
    expect(status).toBe(200);
    expect(body["remote"]).toBe("https://throng.test/git/greg/throng/t1a1.git");
    expect(body["remote"]).not.toContain(projectId);
    expect(body).not.toHaveProperty("changed");
  });

  it("names every attempt's remote, in lists and new attempts too", async () => {
    const { call, ada, base } = await setup();
    const listed = (await call("GET", `${base}/tasks/t1/attempts`, ada)).body["attempts"] as Json[];
    expect(listed.map((a) => a["remote"])).toEqual([
      "https://throng.test/git/greg/throng/t1a1.git",
      "https://throng.test/git/greg/throng/t1a2.git",
    ]);
    const created = (await call("POST", `${base}/tasks/t1/attempts`, ada)).body["attempts"] as Json[];
    expect(created[0]?.["remote"]).toBe("https://throng.test/git/greg/throng/t1a3.git");
  });

  it.each([["wait=0"], ["wait=31"], ["wait=1.5"], ["wait=2&until=never"]])("rejects %s", async (query) => {
    const { call, ada, base } = await setup();
    expect((await call("GET", `${base}/attempts/t1a1?${query}`, ada)).status).toBe(400);
  });
});

describe("waiting on an attempt", () => {
  it("answers with the attempt and changed: false once the wait runs out with nothing changed", async () => {
    const { wait } = await setup();
    const { answer, answered } = await wait(1, "wait=2");
    await vi.advanceTimersByTimeAsync(1999);
    expect(answered()).toBeFalsy();
    await vi.advanceTimersByTimeAsync(1);
    const { status, body } = await answer;
    expect(status).toBe(200);
    expect(body).toMatchObject({ ref: "t1a1", state: "draft", changed: false });
  });

  it("answers stateChanged once the attempt's state changes", async () => {
    const { call, ada, base, wait } = await setup();
    const { answer, answered } = await wait(1, "wait=30&until=stateChanged");
    await call("PATCH", `${base}/attempts/t1a1`, ada, { note: "still drafting" });
    await settle();
    expect(answered()).toBeFalsy();
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    expect((await answer).body).toMatchObject({ state: "open", note: "still drafting", changed: true });
  });

  it("answers scored once the current head gets a done or errored run, not on the push before it", async () => {
    const { call, ada, base, wait, push, finish } = await setup();
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    const { answer, answered } = await wait(1, "wait=30&until=scored");
    const head = await push(1, "one\n");
    await settle();
    expect(answered()).toBeFalsy();
    await finish(1);
    expect((await answer).body).toMatchObject({ scoring: { status: "done", sha: head }, changed: true });

    const next = await push(1, "two\n");
    const errored = await wait(1, "wait=30&until=scored");
    expect(errored.answered()).toBeFalsy();
    await finish(1, { status: "errored", error: "sandbox lost" });
    expect((await errored.answer).body).toMatchObject({ scoring: { status: "errored", sha: next }, changed: true });
  });

  it("answers scored at once when the current head already has a done or errored run", async () => {
    const { call, ada, base, push, finish } = await setup();
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    const head = await push(1, "one\n");
    await finish(1);
    // No timer runs: the answer comes without the clock moving.
    const { status, body } = await call("GET", `${base}/attempts/t1a1?wait=30&until=scored`, ada);
    expect(status).toBe(200);
    expect(body).toMatchObject({ scoring: { status: "done", sha: head }, changed: true });
  });

  it("still waits on `any` for a change when the head is already scored", async () => {
    const { call, ada, base, push, finish, wait } = await setup();
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    await push(1, "one\n");
    await finish(1);
    const { answer, answered } = await wait(1, "wait=30");
    await settle();
    expect(answered()).toBeFalsy();
    await call("POST", `${base}/attempts/t1a1/draft`, ada);
    expect((await answer).body).toMatchObject({ state: "draft", changed: true });
  });

  it("answers mergeRequestChanged once the attempt is selected, and once its merge request moves", async () => {
    const { call, ada, greg, base, wait, finish, push } = await setup();
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    const selected = await wait(1, "wait=30&until=mergeRequestChanged");
    await call("POST", `${base}/tasks/t1/selection`, greg, { attempt: "t1a1" });
    expect((await selected.answer).body).toMatchObject({ mergeRequest: { state: "pending" }, changed: true });

    // Its approved head's run passing the gate queues it.
    const queued = await wait(1, "wait=30&until=mergeRequestChanged");
    await finish(1);
    expect((await queued.answer).body).toMatchObject({ mergeRequest: { state: "queued" }, changed: true });

    // A new push dequeues it.
    const dequeued = await wait(1, "wait=30&until=mergeRequestChanged");
    await push(1, "two\n");
    expect((await dequeued.answer).body).toMatchObject({
      mergeRequest: { state: "needsReview", lastDequeue: { reason: "newPush" } },
      changed: true,
    });
  });

  it("answers any on whichever changes first", async () => {
    const { call, ada, base, wait } = await setup();
    const { answer } = await wait(1, "wait=30");
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    expect((await answer).body).toMatchObject({ state: "open", changed: true });
  });

  it("wakes every waiter on the attempt together, and none on another attempt", async () => {
    const { call, ada, bob, adaClaude, base, wait } = await setup();
    const waits = await Promise.all([
      wait(1, "wait=30&until=stateChanged"),
      wait(1, "wait=30", bob),
      wait(1, "wait=30", adaClaude),
    ]);
    const other = await wait(2, "wait=30");
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    const bodies = await Promise.all(waits.map(async (w) => (await w.answer).body));
    expect(bodies.map((b) => b["changed"])).toEqual([true, true, true]);
    expect(other.answered()).toBeFalsy();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await other.answer).body).toMatchObject({ ref: "t1a2", state: "draft", changed: false });
  });

  it("answers at once, unchanged, past a user's ten waiting requests in the project, whatever their aliases", async () => {
    const { call, ada, adaClaude, bob, base, wait } = await setup();
    const held = await Promise.all(
      Array.from({ length: 10 }, (_, i) => wait(1 + (i % 2), "wait=30", i < 5 ? ada : adaClaude)),
    );
    expect(held.some((w) => w.answered())).toBeFalsy();
    const over = await wait(1, "wait=30&until=stateChanged", adaClaude);
    expect(over.answered()).toBeTruthy();
    expect((await over.answer).body).toMatchObject({ ref: "t1a1", changed: false });
    // Another user still may.
    const bobs = await wait(1, "wait=30", bob);
    expect(bobs.answered()).toBeFalsy();
    // Once one is answered, the user may wait again.
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    await settle();
    const again = await wait(1, "wait=30", ada);
    expect(again.answered()).toBeFalsy();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await again.answer).body["changed"]).toBeFalsy();
  });

  it("answers changed: false when a deploy or eviction drops the wait, and the client can wait again", async () => {
    const { call, ada, base, wait, evict } = await setup();
    const dropped = await wait(1, "wait=30&until=stateChanged");
    evict();
    const { status, body } = await dropped.answer;
    expect(status).toBe(200);
    expect(body).toMatchObject({ ref: "t1a1", state: "draft", changed: false });

    const again = await wait(1, "wait=30&until=stateChanged");
    expect(again.answered()).toBeFalsy();
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    expect((await again.answer).body).toMatchObject({ state: "open", changed: true });
  });

  it("answers 404 for an attempt that doesn't exist, without waiting", async () => {
    const { call, ada, base } = await setup();
    expect((await call("GET", `${base}/attempts/t1a9?wait=30`, ada)).status).toBe(404);
  });
});
