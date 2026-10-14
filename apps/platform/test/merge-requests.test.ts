import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import type { DequeueCause } from "../src/merge-requests.ts";
import type { Gate, ScoringResult } from "../src/results.ts";
import type { PipelineParams, PipelineWorkflowBinding, ScoringOutcome } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptInput, ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { conflictDetails, ERRORED } from "./support/conflicts.ts";
import { at, defined } from "./support/defined.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ORIGIN = "abc123-main";

function actor(id: string, alias: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias };
}

const owner = actor("owner001");
const cat = actor("cat00001");
const catAlias = actor("cat00001", "claude");
const ada = actor("ada00001");
const bob = actor("bob00001");

class FakeWorkflow implements PipelineWorkflowBinding {
  async create(_options: { id: string; params: PipelineParams }): Promise<unknown> {
    return {};
  }
  async get(_id: string): Promise<{ terminate: () => Promise<void> }> {
    return { terminate: async () => {} };
  }
}

function result(gate: Gate = "passed"): ScoringResult {
  return {
    base: "b".repeat(40),
    config: { kind: "none" },
    gate,
    checks: [],
    metrics: {},
    logs: [],
  };
}

const done = (gate: Gate = "passed"): ScoringOutcome => ({ status: "done", result: result(gate) });

/**
 * A task by cat, with attempts by ada and bob. `score` finishes the attempt's latest run, as its
 * Scoring Workflow would report it; `push` lands a new commit on an attempt's fork through the proxy.
 */
async function setup() {
  const repos = new FakeRepos();
  void repos.create(ORIGIN, { defaultBranch: "main" });
  const base = repos.commit(ORIGIN, { files: { "README.md": "hi\n" }, message: "init" });
  const sql = testSql();
  let clock = Date.parse("2026-10-10T12:00:00.000Z");
  const store = new TaskStore({
    sql,
    repos,
    now: () => new Date((clock += 1000)),
    scoring: { workflow: new FakeWorkflow(), teardown: async () => {} },
  });
  const journal = () =>
    (sql.db.prepare("SELECT kind, detail FROM journal ORDER BY id").all() as { kind: string; detail: string }[]).map(
      (e): Record<string, unknown> => ({ kind: e.kind, ...(JSON.parse(e.detail) as Record<string, unknown>) }),
    );
  const mrEvents = () =>
    journal()
      .filter((e) => e["mergeRequest"] !== undefined)
      .map((e) => e.kind);

  const task = store.createTask(PROJECT, cat, { title: "Fix it" });
  const [a1] = await store.createAttempts(PROJECT, ada, { task: task.number });
  const [a2] = await store.createAttempts(PROJECT, bob, { task: task.number });
  const refs = [defined(a1, "attempt 1"), defined(a2, "attempt 2")].map((a) => ({ task: a.task, number: a.number }));
  const [ref1, ref2] = refs as [AttemptInput, AttemptInput];

  const author = (ref: AttemptInput) => (ref.number === 1 ? ada : bob);
  const open = async (ref: AttemptInput) => store.openAttempt(PROJECT, author(ref), ref);
  /** Finishes the attempt's latest run with `outcome`, starting it first. */
  const score = async (ref: AttemptInput, outcome: ScoringOutcome = done()) => {
    await store.scoring.drain();
    const run = at(store.scoring.listRuns(`t${ref.task}a${ref.number}`), -1);
    store.scoringFinished(run.id, outcome);
  };
  let n = 0;
  const push = (ref: AttemptInput) => {
    const before = store.getAttempt(PROJECT, owner, ref).scoring.sha ?? base.hash;
    const after = repos.commit(`abc123-t${ref.task}a${ref.number}`, { files: { "README.md": `push ${++n}\n` } }).hash;
    store.recordPush(PROJECT, author(ref), { ...ref, updates: [{ ref: "refs/heads/main", before, after }] });
    return after;
  };
  const mr = () => store.getMergeRequest(PROJECT, owner, { task: task.number });
  return { repos, base, store, journal, mrEvents, task, ref1, ref2, open, score, push, mr };
}

async function code(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  const err = await (typeof promise === "function" ? Promise.resolve().then(promise) : promise).then(
    () => null,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return (err as ServiceError).code;
}

describe("selection", () => {
  it("creates a pending merge request approving the attempt's head, and closes its siblings", async () => {
    const { store, base, ref1, ref2, open, mr, mrEvents, repos } = await setup();
    await open(ref1);
    await open(ref2);

    const selected = await store.selectAttempt(PROJECT, catAlias, { ...ref1 });
    expect(selected).toMatchObject({
      task: 1,
      attempt: 1,
      state: "pending",
      approved_head: base.hash,
      approved_by: { user: cat.user.id, alias: "claude" },
      created_by: { user: cat.user.id, alias: "claude" },
      queued_at: null,
      position: null,
      last_dequeue: null,
      merge_sha: null,
    });
    expect(mr()).toEqual(selected);
    expect(store.getAttempt(PROJECT, owner, ref2).state).toBe("closed");
    expect(store.getAttempt(PROJECT, owner, ref2).archived_sha).not.toBeNull();
    expect(await repos.list("abc123-t1a")).toEqual(["abc123-t1a1"]);
    expect(store.getTask(PROJECT, owner, { task: 1 }).state).toBe("open");
    expect(mrEvents()).toEqual(["selected", "approved"]);
  });
});
describe("pending → queued", () => {
  it("queues once the approved head's run is done with a passing gate", async () => {
    const { store, ref1, open, score, mr, mrEvents } = await setup();
    await open(ref1);
    expect((await store.selectAttempt(PROJECT, cat, ref1)).state).toBe("pending");
    await score(ref1);
    expect(mr()).toMatchObject({ state: "queued", queued_at: expect.any(String), position: 1 });
    expect(mrEvents()).toEqual(["selected", "approved", "queued"]);
  });

  it("queues at selection when the head's gate has already passed", async () => {
    const { store, ref1, open, score } = await setup();
    await open(ref1);
    await score(ref1);
    expect(await store.selectAttempt(PROJECT, cat, ref1)).toMatchObject({ state: "queued", position: 1 });
  });

  it("stays pending on a failed gate or an errored run", async () => {
    const { store, ref1, open, score, mr } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    await score(ref1, done("failed"));
    expect(mr().state).toBe("pending");
    await store.rescore(PROJECT, cat, ref1);
    await score(ref1, { status: "errored", error: "sandbox lost" });
    expect(mr().state).toBe("pending");
  });

  it("waits for a rescore running on the approved head, and follows its gate", async () => {
    const { store, ref1, open, score, mr } = await setup();
    await open(ref1);
    await score(ref1, done("failed"));
    await store.selectAttempt(PROJECT, cat, ref1);
    await store.rescore(PROJECT, cat, ref1);
    expect(mr().state).toBe("pending");
    await score(ref1);
    expect(mr().state).toBe("queued");
  });

  it("ignores runs of other attempts", async () => {
    const { store, ref1, open, score, mr } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    const other = store.createTask(PROJECT, cat, { title: "Other" });
    const made = at(await store.createAttempts(PROJECT, ada, { task: other.number }), 0);
    const ref = { task: made.task, number: made.number };
    await store.openAttempt(PROJECT, ada, ref);
    await score(ref);
    expect(mr().state).toBe("pending");
  });
});

describe("selection permissions and requirements", () => {
  it("lets the task creator or the project owner (or their aliases) select, not others", async () => {
    const { store, ref1, open } = await setup();
    await open(ref1);
    expect(await code(store.selectAttempt(PROJECT, ada, ref1))).toBe("forbidden");
    expect(await code(store.selectAttempt(PROJECT, bob, ref1))).toBe("forbidden");
    expect((await store.selectAttempt(PROJECT, actor("owner001", "codex"), ref1)).state).toBe("pending");
  });

  it("requires an open attempt on an open task with no open merge request", async () => {
    const { store, ref1, ref2, open } = await setup();
    expect(await code(store.selectAttempt(PROJECT, cat, ref1))).toBe("invalidState");
    await open(ref1);
    await open(ref2);
    await store.selectAttempt(PROJECT, cat, ref1);
    expect(await code(store.selectAttempt(PROJECT, cat, ref1))).toBe("invalidState");
    expect(store.hasOpenMergeRequest(PROJECT, cat, { task: 1 })).toBeTruthy();
    expect(await code(store.createAttempts(PROJECT, bob, { task: 1 }))).toBe("invalidState");
    expect(await code(store.reopenAttempt(PROJECT, bob, ref2))).toBe("invalidState");
  });

  it("lets the task creator select their own attempt", async () => {
    const { store } = await setup();
    const task = store.createTask(PROJECT, cat, { title: "Mine" });
    const mine = at(await store.createAttempts(PROJECT, cat, { task: task.number }), 0);
    const ref = { task: mine.task, number: mine.number };
    await store.openAttempt(PROJECT, cat, ref);
    expect(await store.selectAttempt(PROJECT, catAlias, ref)).toMatchObject({ task: 2, attempt: 1, state: "pending" });
  });

  it("merges a single-attempt task through the same call, closing nothing else", async () => {
    const { store } = await setup();
    const task = store.createTask(PROJECT, cat, { title: "Solo" });
    const only = at(await store.createAttempts(PROJECT, ada, { task: task.number }), 0);
    const ref = { task: only.task, number: only.number };
    await store.openAttempt(PROJECT, ada, ref);
    expect((await store.selectAttempt(PROJECT, cat, ref)).state).toBe("pending");
    expect(store.getAttempt(PROJECT, cat, ref).state).toBe("open");
  });
});

describe("approve and cancel", () => {
  it("lets only the task creator or the project owner approve or cancel", async () => {
    const { store, ref1, open, push } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    push(ref1);
    for (const who of [ada, bob]) {
      expect(await code(store.approveMergeRequest(PROJECT, who, { task: 1 }))).toBe("forbidden");
      expect(await code(() => store.cancelMergeRequest(PROJECT, who, { task: 1 }))).toBe("forbidden");
    }
    expect((await store.approveMergeRequest(PROJECT, owner, { task: 1 })).state).toBe("pending");
    expect(store.cancelMergeRequest(PROJECT, catAlias, { task: 1 }).state).toBe("cancelled");
  });

  it("approves the source's current head from needsReview, and queues once it passes", async () => {
    const { store, ref1, open, push, score, mr, mrEvents } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    const head = push(ref1);
    expect(mr()).toMatchObject({ state: "needsReview" });
    const approved = await store.approveMergeRequest(PROJECT, owner, { task: 1 });
    expect(approved).toMatchObject({ state: "pending", approved_head: head, approved_by: { user: owner.user.id } });
    await score(ref1);
    expect(mr().state).toBe("queued");
    expect(mrEvents()).toEqual(["selected", "approved", "needsReview", "approved", "queued"]);
  });

  it("refuses to approve a queued, landing or closed merge request", async () => {
    const { store, ref1, open, score } = await setup();
    await open(ref1);
    await score(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    expect(await code(store.approveMergeRequest(PROJECT, cat, { task: 1 }))).toBe("invalidState");
    store.startLanding(PROJECT, null);
    expect(await code(store.approveMergeRequest(PROJECT, cat, { task: 1 }))).toBe("invalidState");
    store.cancelMergeRequest(PROJECT, cat, { task: 1 });
    expect(await code(store.approveMergeRequest(PROJECT, cat, { task: 1 }))).toBe("invalidState");
    expect(await code(() => store.cancelMergeRequest(PROJECT, cat, { task: 1 }))).toBe("invalidState");
  });

  it.each(["pending", "needsReview", "queued", "landing"] as const)("cancels from %s", async (from) => {
    const { store, ref1, open, score, push, mr, mrEvents } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    if (from === "needsReview") push(ref1);
    if (from === "queued" || from === "landing") await score(ref1);
    if (from === "landing") store.startLanding(PROJECT, null);
    expect(mr().state).toBe(from);
    store.cancelMergeRequest(PROJECT, cat, { task: 1 });
    const inQueue = from === "queued" || from === "landing";
    expect(mr()).toMatchObject({
      state: "cancelled",
      position: null,
      last_dequeue: inQueue ? { reason: "cancelled" } : null,
    });
    expect(mrEvents().at(-1)).toBe("cancelled");
    expect(mrEvents().at(-2) === "dequeued").toBe(inQueue);
    expect(store.getTask(PROJECT, cat, { task: 1 }).state).toBe("open");
    expect(store.getAttempt(PROJECT, cat, ref1).state).toBe("open");
  });

  it("lets a task be selected again after a cancel", async () => {
    const { store, ref1, ref2, open, mr } = await setup();
    await open(ref1);
    await open(ref2);
    await store.selectAttempt(PROJECT, cat, ref1);
    store.cancelMergeRequest(PROJECT, cat, { task: 1 });
    await store.reopenAttempt(PROJECT, bob, ref2);
    await store.openAttempt(PROJECT, bob, ref2);
    expect(await store.selectAttempt(PROJECT, cat, ref2)).toMatchObject({ attempt: 2, state: "pending" });
    expect(mr().attempt).toBe(2);
    expect(store.getAttempt(PROJECT, cat, ref1).state).toBe("closed");
  });
});

describe("a push to the source attempt", () => {
  it.each(["pending", "queued", "landing"] as const)("moves %s to needsReview", async (from) => {
    const { store, ref1, open, score, push, mr, mrEvents } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    if (from !== "pending") await score(ref1);
    if (from === "landing") store.startLanding(PROJECT, null);
    expect(mr().state).toBe(from);
    push(ref1);
    const inQueue = from !== "pending";
    const lastDequeue = inQueue ? { reason: "newPush" } : null;
    expect(mr()).toMatchObject({ state: "needsReview", position: null, last_dequeue: lastDequeue });
    expect(mrEvents().at(-1)).toBe("needsReview");
    expect(mrEvents().at(-2) === "dequeued").toBe(inQueue);
    expect(store.getAttempt(PROJECT, cat, ref1).merge_request).toEqual({
      state: "needsReview",
      last_dequeue: lastDequeue,
    });
  });

  it("keeps needsReview, and never requeues on its own", async () => {
    const { store, ref1, open, score, push, mr, mrEvents } = await setup();
    await open(ref1);
    await score(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    push(ref1);
    const events = mrEvents().length;
    await score(ref1);
    push(ref1);
    await score(ref1);
    expect(mr().state).toBe("needsReview");
    expect(mrEvents()).toHaveLength(events);
  });

  it("leaves a cancelled merge request alone", async () => {
    const { store, ref1, open, push, mr } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    store.cancelMergeRequest(PROJECT, cat, { task: 1 });
    push(ref1);
    expect(mr().state).toBe("cancelled");
  });
});

describe("the source attempt ending", () => {
  const ends = {
    "closing it": (store: TaskStore, ref: AttemptInput) => store.closeAttempt(PROJECT, ada, ref),
    "making it obsolete": (store: TaskStore, ref: AttemptInput) => store.obsoleteAttempt(PROJECT, owner, ref),
    "closing its task": (store: TaskStore) => store.closeTask(PROJECT, cat, { task: 1 }),
    "making its task obsolete": (store: TaskStore) => store.obsoleteTask(PROJECT, owner, { task: 1 }),
  };
  it.each(Object.entries(ends))("cancels the merge request: %s", async (how, end) => {
    const { store, ref1, open, score, mr, mrEvents } = await setup();
    await open(ref1);
    await score(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    await end(store, ref1);
    expect(mr()).toMatchObject({ state: "cancelled", last_dequeue: { reason: "cancelled" } });
    expect(mrEvents().slice(-2)).toEqual(["dequeued", "cancelled"]);
  });
});

/** Adds a task by cat with one opened, scored attempt by ada, and selects it; returns its number. */
async function queuedTask(env: Awaited<ReturnType<typeof setup>>, title: string): Promise<number> {
  const task = env.store.createTask(PROJECT, cat, { title });
  const made = at(await env.store.createAttempts(PROJECT, ada, { task: task.number }), 0);
  const ref = { task: made.task, number: made.number };
  await env.store.openAttempt(PROJECT, ada, ref);
  await env.score(ref);
  await env.store.selectAttempt(PROJECT, cat, ref);
  return task.number;
}

describe("the queue", () => {
  it("is first in first out, landing one at a time from the front", async () => {
    const env = await setup();
    const { store } = env;
    const t2 = await queuedTask(env, "two");
    const t3 = await queuedTask(env, "three");
    const t4 = await queuedTask(env, "four");
    const queue = () => store.mergeQueue(PROJECT, cat).map((m) => [m.task, m.state, m.position]);
    expect(queue()).toEqual([
      [t2, "queued", 1],
      [t3, "queued", 2],
      [t4, "queued", 3],
    ]);
    expect(store.startLanding(PROJECT, null)).toMatchObject({ task: t2, state: "landing", position: 1 });
    expect(store.startLanding(PROJECT, null)).toBeNull();
    expect(store.getMergeRequest(PROJECT, cat, { task: t3 }).position).toBe(2);

    store.dequeueMergeRequest(PROJECT, null, { task: t2, reason: "errored", details: ERRORED });
    expect(queue()).toEqual([
      [t3, "queued", 1],
      [t4, "queued", 2],
    ]);
    await store.approveMergeRequest(PROJECT, cat, { task: t2 });
    expect(queue()).toEqual([
      [t3, "queued", 1],
      [t4, "queued", 2],
      [t2, "queued", 3],
    ]);
  });
});

describe("dequeue", () => {
  const causes: Extract<DequeueCause, { details: unknown }>[] = [
    { reason: "conflict", details: conflictDetails(["README.md"]) },
    { reason: "failedChecks", details: { checks: [{ name: "test", outcome: "failed", log: "test" }] } },
    { reason: "errored", details: ERRORED },
  ];
  it.each(causes)(
    "returns to pending after $reason, keeping the approval, and doesn't requeue on its own",
    async (cause) => {
      const { store, ref1, open, score, mr, mrEvents, base } = await setup();
      await open(ref1);
      await score(ref1);
      await store.selectAttempt(PROJECT, cat, ref1);
      store.startLanding(PROJECT, null);
      store.dequeueMergeRequest(PROJECT, null, { task: 1, ...cause });
      expect(mr()).toMatchObject({
        state: "pending",
        approved_head: base.hash,
        position: null,
        last_dequeue: { ...cause, at: expect.any(String) },
      });
      await store.rescore(PROJECT, cat, ref1);
      await score(ref1);
      expect(mr().state).toBe("pending");
      expect(mrEvents().slice(-1)).toEqual(["dequeued"]);
    },
  );

  it("requeues an errored one on approve", async () => {
    const { store, ref1, open, score, mr } = await setup();
    await open(ref1);
    await score(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    store.dequeueMergeRequest(PROJECT, null, { task: 1, reason: "errored", details: ERRORED });
    expect(await store.approveMergeRequest(PROJECT, cat, { task: 1 })).toMatchObject({ state: "queued" });
    expect(mr().last_dequeue).toMatchObject({ reason: "errored" });
  });

  it("needs a push and an approval to requeue after a conflict", async () => {
    const { store, ref1, open, score, push, mr } = await setup();
    await open(ref1);
    await score(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    store.dequeueMergeRequest(PROJECT, null, { task: 1, reason: "conflict", details: conflictDetails(["README.md"]) });
    push(ref1);
    expect(mr()).toMatchObject({ state: "needsReview", last_dequeue: { reason: "conflict" } });
    await store.approveMergeRequest(PROJECT, cat, { task: 1 });
    await score(ref1);
    expect(mr().state).toBe("queued");
  });

  it("only dequeues from the queue", async () => {
    const { store, ref1, open } = await setup();
    await open(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    const dequeue = () =>
      store.dequeueMergeRequest(PROJECT, null, {
        task: 1,
        reason: "conflict",
        details: conflictDetails(["README.md"]),
      });
    expect(await code(dequeue)).toBe("invalidState");
  });
});

describe("landing", () => {
  it("merges a landing merge request, marking its attempt merged and closing the task", async () => {
    const { store, ref1, open, score, mr, mrEvents } = await setup();
    const sha = "e".repeat(40);
    await open(ref1);
    await score(ref1);
    await store.selectAttempt(PROJECT, cat, ref1);
    expect(await code(store.landMergeRequest(PROJECT, null, { task: 1, sha }))).toBe("invalidState");
    store.startLanding(PROJECT, null);
    await store.landMergeRequest(PROJECT, null, { task: 1, sha });
    expect(mr()).toMatchObject({ state: "merged", merge_sha: sha, merged_at: expect.any(String), position: null });
    expect(store.getAttempt(PROJECT, cat, ref1)).toMatchObject({
      state: "merged",
      merged_sha: sha,
      merge_request: { state: "merged", last_dequeue: null },
    });
    expect(store.getTask(PROJECT, cat, { task: 1 }).state).toBe("closed");
    expect(mrEvents()).toEqual(["selected", "approved", "queued", "landing", "merged"]);
  });
});

describe("reads", () => {
  it("answers not_found for a task with no merge request, and shows none on its attempts", async () => {
    const { store, ref1 } = await setup();
    expect(await code(() => store.getMergeRequest(PROJECT, cat, { task: 1 }))).toBe("notFound");
    expect(store.getAttempt(PROJECT, cat, ref1).merge_request).toBeNull();
    expect(store.mergeQueue(PROJECT, cat)).toEqual([]);
  });
});
