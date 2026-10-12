// Active attempts following their task branch (ADR 0003), from the project DO's side: a task branch
// push queues a follow per active attempt, each runs as a Follow Workflow, and its report moves the
// attempt on (a new head scored, its merge request back to review) or marks it needs update. Runs
// against the `Repos` fake and fake Workflow bindings; the Workflow's script is `follow-script.test.ts`.

import { describe, expect, it } from "vitest";
import type { FollowOutcome, FollowParams } from "../src/follows.ts";
import type { LandingParams } from "../src/landing.ts";
import type { ScoringResult } from "../src/results.ts";
import type { ScoringParams } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptInput, ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { at, defined } from "./support/defined.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ORIGIN = "abc123-main";

function actor(id: string): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias: null };
}
const owner = actor("owner001");
const cat = actor("cat00001");
const ada = actor("ada00001");
const bob = actor("bob00001");

/** A Workflow binding that records what it was asked to start. */
class FakeWorkflows<P> {
  created: { id: string; params: P }[] = [];
  async create(options: { id: string; params: P }): Promise<unknown> {
    this.created.push(options);
    return {};
  }
  async get(_id: string): Promise<{ terminate: () => Promise<void> }> {
    return { terminate: async () => {} };
  }
}

const passed: ScoringResult = {
  base: "b".repeat(40),
  config: { kind: "none" },
  gate: "passed",
  checks: [],
  builtin: { filesChanged: 1, additions: 1, deletions: 0, durationMs: 1 },
  preview: { status: "none" },
  logs: [],
};

/** An attempt's fork. */
const fork = (ref: AttemptInput) => `abc123-t${ref.task}a${ref.number}`;

/**
 * Task t1 by cat, with an open attempt by ada (t1a1) and a draft by bob (t1a2). Without a landing
 * runner nothing lands, so a queued merge request stays queued.
 */
async function setup({ landing = true } = {}) {
  const repos = new FakeRepos();
  void repos.create(ORIGIN, { defaultBranch: "main" });
  const base = repos.commit(ORIGIN, { files: { "README.md": "hi\n" }, message: "init" });
  const sql = testSql();
  let clock = Date.parse("2026-10-10T12:00:00.000Z");
  const scoringWorkflow = new FakeWorkflows<ScoringParams>();
  const landingWorkflow = new FakeWorkflows<LandingParams>();
  const followWorkflow = new FakeWorkflows<FollowParams>();
  const store = new TaskStore({
    sql,
    repos,
    now: () => new Date((clock += 1000)),
    scoring: { workflow: scoringWorkflow, teardown: async () => {} },
    landing: landing ? { workflow: landingWorkflow, teardown: async () => {} } : null,
    follow: { workflow: followWorkflow },
  });
  const drain = () => store.drain(PROJECT.id);
  const journal = () =>
    (
      sql.db.prepare("SELECT kind, user_id, attempt, detail FROM journal ORDER BY id").all() as {
        kind: string;
        user_id: string | null;
        attempt: number | null;
        detail: string;
      }[]
    ).map((e) => ({ ...e, detail: JSON.parse(e.detail) as Record<string, unknown> }));

  const task = store.createTask(PROJECT, cat, { title: "Fix login" });
  const [a1] = await store.createAttempts(PROJECT, ada, { task: task.number });
  const [a2] = await store.createAttempts(PROJECT, bob, { task: task.number });
  const t1a1 = { task: 1, number: defined(a1, "t1a1").number };
  const t1a2 = { task: 1, number: defined(a2, "t1a2").number };
  await store.openAttempt(PROJECT, ada, t1a1);
  const author = (ref: AttemptInput) => (ref.number === 1 ? ada : bob);
  const attempt = (ref: AttemptInput) => store.getAttempt(PROJECT, owner, ref);

  let n = 0;
  /** The task's creator pushes a new task head, as the git proxy records it. */
  const moveTaskBranch = () => {
    const head = repos.commit(ORIGIN, { files: { "test.txt": `test ${++n}\n` }, branch: "tasks-t1" }).hash;
    repos.setRef(ORIGIN, "refs/tasks/t1", head);
    return { head, following: store.recordTaskBranchPush(PROJECT, cat, { task: 1, head }) };
  };
  /** The author pushes a new commit to their fork through the proxy. */
  const push = async (ref: AttemptInput) => {
    const before = attempt(ref).scoring.sha ?? base.hash;
    const after = repos.commit(fork(ref), { files: { "README.md": `push ${++n}\n` } }).hash;
    await store.recordPush(PROJECT, author(ref), { ...ref, updates: [{ ref: "refs/heads/main", before, after }] });
    return after;
  };
  /** The latest Follow Workflow started for an attempt. */
  const started = (ref: AttemptInput) =>
    followWorkflow.created.findLast((c) => c.params.task === ref.task && c.params.attempt === ref.number);
  /** Runs the attempt's latest Follow Workflow to `outcome`, as its claim and report steps would. */
  const follow = async (ref: AttemptInput, outcome: (before: string) => FollowOutcome) => {
    const params = defined(started(ref), `a follow of ${fork(ref)}`).params;
    expect(store.claimFollowPush(params.follow)).toBeTruthy();
    const before = repos.ref(fork(ref), "refs/heads/main") ?? base.hash;
    const reported = await store.followFinished(params.follow, outcome(before));
    await drain();
    return reported;
  };
  /** A clean merge of the task head into the fork, as the follow script makes it. */
  const merged = (ref: AttemptInput, taskHead: string) => (before: string) => {
    const sha = repos.commit(fork(ref), { files: { "README.md": `merged ${++n}\n` }, parents: [before, taskHead] });
    return { kind: "merged" as const, before, head: sha.hash };
  };
  const scoreLatest = (ref: AttemptInput) => {
    const run = at(store.scoring.listRuns({ task: ref.task, attempt: ref.number }), -1);
    expect(store.scoringFinished(run.id, { status: "done", result: passed })).toBeTruthy();
  };
  const mr = () => store.getMergeRequest(PROJECT, owner, { task: 1 });

  return {
    repos,
    base,
    store,
    drain,
    journal,
    t1a1,
    t1a2,
    attempt,
    fork,
    moveTaskBranch,
    push,
    started,
    follow,
    merged,
    scoreLatest,
    mr,
    followWorkflow,
    landingWorkflow,
  };
}

describe("a task branch push", () => {
  it("starts a Follow Workflow for each active attempt, and names them", async () => {
    const { store, drain, t1a2, moveTaskBranch, followWorkflow } = await setup();
    await store.closeAttempt(PROJECT, bob, t1a2);
    const t1a3 = at(await store.createAttempts(PROJECT, bob, { task: 1 }), 0).number;
    const { head, following } = moveTaskBranch();
    expect(following).toEqual(["t1a1", "t1a3"]);
    await drain();

    expect(followWorkflow.created).toEqual([
      {
        id: "abc123-t1a1-follow-1",
        params: { project: PROJECT.id, follow: 1, task: 1, attempt: 1, taskHead: head, startedAt: expect.any(Number) },
      },
      {
        id: "abc123-t1a3-follow-2",
        params: {
          project: PROJECT.id,
          follow: 2,
          task: 1,
          attempt: t1a3,
          taskHead: head,
          startedAt: expect.any(Number),
        },
      },
    ]);
    await drain();
    expect(followWorkflow.created).toHaveLength(2);
  });

  it("follows one task head at a time per attempt: a newer head waits for the running follow", async () => {
    const { drain, t1a1, moveTaskBranch, started, follow, merged, followWorkflow } = await setup();
    const first = moveTaskBranch().head;
    await drain();
    moveTaskBranch();
    const third = moveTaskBranch().head;
    await drain();
    expect(followWorkflow.created.filter((c) => c.params.attempt === 1).map((c) => c.params.taskHead)).toEqual([first]);

    await follow(t1a1, merged(t1a1, first));
    expect(started(t1a1)?.params.taskHead).toBe(third);
  });
});

describe("the Sandbox cap", () => {
  it("counts running follows toward the cap, and starts them ahead of waiting scoring runs", async () => {
    const { store, drain, t1a1, moveTaskBranch, follow, followWorkflow } = await setup();
    await store.createAttempts(PROJECT, bob, { task: 1, count: 2 });
    await drain();
    // t1a1's first run holds one of the three slots.
    expect(store.scoring.running()).toBe(1);
    moveTaskBranch();
    await drain();
    expect(followWorkflow.created.map((c) => c.params.attempt)).toEqual([1, 2]);

    await follow(t1a1, (current) => ({ kind: "current", head: current }));
    expect(followWorkflow.created.map((c) => c.params.attempt)).toEqual([1, 2, 3]);
  });
});

describe("a clean update", () => {
  it("records the merge as a platform push, scores an open attempt's new head and leaves a draft unscored", async () => {
    const { store, drain, journal, t1a1, t1a2, attempt, moveTaskBranch, follow, merged } = await setup();
    const { head } = moveTaskBranch();
    await drain();
    await follow(t1a1, merged(t1a1, head));
    await follow(t1a2, (before) => ({ kind: "merged", before, head }));

    const open = attempt(t1a1);
    expect(open).toMatchObject({ needs_update: false, scoring: { status: "running" } });
    expect(at(store.scoring.listRuns({ task: 1, attempt: 1 }), -1)).toMatchObject({ sha: open.scoring.sha });
    expect(attempt(t1a2)).toMatchObject({ needs_update: false, scoring: { status: "none", sha: head } });
    expect(journal().filter((e) => e.kind === "pushed" && e.attempt === 1)).toEqual([
      {
        kind: "pushed",
        user_id: null,
        attempt: 1,
        detail: {
          ref: "t1a1",
          gitRef: "refs/heads/main",
          before: expect.any(String),
          after: open.scoring.sha,
          taskBranch: head,
        },
      },
    ]);
  });

  it("records nothing for an attempt that already contains the task head", async () => {
    const { drain, journal, t1a1, attempt, moveTaskBranch, follow } = await setup();
    moveTaskBranch();
    await drain();
    const before = attempt(t1a1).scoring;
    await follow(t1a1, (head) => ({ kind: "current", head }));
    expect(attempt(t1a1)).toMatchObject({ needs_update: false, scoring: before });
    expect(journal().some((e) => e.kind === "pushed")).toBeFalsy();
  });

  it("follows again when an author's push beat the lease", async () => {
    const { drain, t1a1, moveTaskBranch, follow, started, followWorkflow } = await setup();
    const { head } = moveTaskBranch();
    await drain();
    await follow(t1a1, () => ({ kind: "moved" }));
    expect(followWorkflow.created.filter((c) => c.params.attempt === 1)).toHaveLength(2);
    expect(started(t1a1)?.params.taskHead).toBe(head);
  });

  it("discards a report from a follow that already reported", async () => {
    const { store, drain, t1a1, moveTaskBranch, follow, merged, started } = await setup();
    const { head } = moveTaskBranch();
    await drain();
    expect(await follow(t1a1, merged(t1a1, head))).toBeTruthy();
    const id = defined(started(t1a1), "follow").params.follow;
    expect(store.claimFollowPush(id)).toBeFalsy();
    expect(await store.followFinished(id, { kind: "moved" })).toBeFalsy();
  });
});

describe("a conflict", () => {
  it("marks the attempt needs update, writes nothing, and clears once the author's push contains the task head", async () => {
    const { drain, journal, t1a1, attempt, moveTaskBranch, follow, push, started, followWorkflow } = await setup();
    const { head } = moveTaskBranch();
    await drain();
    const scoring = attempt(t1a1).scoring;
    await follow(t1a1, (before) => ({ kind: "conflict", head: before }));
    expect(attempt(t1a1)).toMatchObject({ needs_update: true, scoring });
    expect(journal().at(-1)).toMatchObject({ kind: "needsUpdate", attempt: 1, detail: { taskBranch: head } });

    // The author merges the task branch and pushes; a follow checks the push and finds it current.
    await push(t1a1);
    await drain();
    expect(followWorkflow.created.filter((c) => c.params.attempt === 1)).toHaveLength(2);
    expect(started(t1a1)?.params.taskHead).toBe(head);
    expect(attempt(t1a1).needs_update).toBeTruthy();
    await follow(t1a1, (current) => ({ kind: "current", head: current }));
    expect(attempt(t1a1).needs_update).toBeFalsy();
  });

  it("stays marked when the author's push still doesn't merge cleanly", async () => {
    const { drain, t1a1, attempt, moveTaskBranch, follow, push } = await setup();
    moveTaskBranch();
    await drain();
    await follow(t1a1, (before) => ({ kind: "conflict", head: before }));
    await push(t1a1);
    await drain();
    await follow(t1a1, (before) => ({ kind: "conflict", head: before }));
    expect(attempt(t1a1).needs_update).toBeTruthy();
  });
});

/** `setup` with t1a1 selected: its merge request is pending until its head's run passes, then queued. */
async function selected({ passed: pass = false, landing = true } = {}) {
  const s = await setup({ landing });
  if (pass) {
    await s.store.scoring.drain();
    s.scoreLatest(s.t1a1);
  }
  await s.store.selectAttempt(PROJECT, cat, s.t1a1);
  return s;
}

describe("a merge request's source", () => {
  it("moves a pending merge request to needsReview, the follow being a new head", async () => {
    const { store, drain, t1a1, mr, moveTaskBranch, follow, merged } = await selected();
    expect(mr().state).toBe("pending");
    // Selection closed t1a2, so only the source follows.
    const { head, following } = moveTaskBranch();
    expect(following).toEqual(["t1a1"]);
    await drain();
    await follow(t1a1, merged(t1a1, head));
    expect(mr().state).toBe("needsReview");
    expect(store.getAttempt(PROJECT, owner, t1a1).merge_request?.state).toBe("needsReview");
  });

  it("dequeues a queued merge request with newPush, to needsReview", async () => {
    const { drain, t1a1, mr, moveTaskBranch, follow, merged } = await selected({ passed: true, landing: false });
    expect(mr().state).toBe("queued");
    const { head } = moveTaskBranch();
    await drain();
    await follow(t1a1, merged(t1a1, head));
    expect(mr()).toMatchObject({ state: "needsReview", last_dequeue: { reason: "newPush" } });
  });

  it("dequeues a landing merge request whose landing hasn't claimed its push", async () => {
    const { drain, t1a1, mr, moveTaskBranch, follow, merged } = await selected({ passed: true });
    await drain();
    expect(mr().state).toBe("landing");
    const { head } = moveTaskBranch();
    await drain();
    await follow(t1a1, merged(t1a1, head));
    expect(mr()).toMatchObject({ state: "needsReview", last_dequeue: { reason: "newPush" } });
  });

  it("leaves the source alone while its landing has claimed the push to main, and drops the follow once it lands", async () => {
    const { store, drain, mr, attempt, t1a1, moveTaskBranch, followWorkflow } = await selected({ passed: true });
    await drain();
    expect(store.claimLandingPush(1)).toBeTruthy();
    moveTaskBranch();
    await drain();
    expect(followWorkflow.created).toHaveLength(0);

    await store.landingFinished(1, { kind: "landed", sha: "e".repeat(40) });
    await drain();
    expect(mr().state).toBe("merged");
    expect(attempt(t1a1).state).toBe("merged");
    expect(followWorkflow.created).toHaveLength(0);
  });

  it("refuses a follow's claim once the landing claimed its push, and follows after the landing is dequeued", async () => {
    const { store, drain, t1a1, mr, moveTaskBranch, started, follow, merged, followWorkflow } = await selected({
      passed: true,
    });
    await drain();
    const { head } = moveTaskBranch();
    await drain();
    expect(store.claimLandingPush(1)).toBeTruthy();
    expect(store.claimFollowPush(defined(started(t1a1), "follow").params.follow)).toBeFalsy();
    await drain();
    expect(followWorkflow.created).toHaveLength(1);

    await store.landingFinished(1, { kind: "errored", details: { step: "land", error: "lost" } });
    await drain();
    expect(mr().state).toBe("pending");
    expect(followWorkflow.created).toHaveLength(2);
    await follow(t1a1, merged(t1a1, head));
    expect(mr().state).toBe("needsReview");
  });

  it("leaves a needsReview merge request in needsReview", async () => {
    const { drain, t1a1, mr, moveTaskBranch, follow, merged, push } = await selected();
    await push(t1a1);
    expect(mr().state).toBe("needsReview");
    const { head } = moveTaskBranch();
    await drain();
    await follow(t1a1, merged(t1a1, head));
    expect(mr().state).toBe("needsReview");
  });
});

describe("ended attempts", () => {
  it("doesn't follow a closed attempt, and catches it up when it reopens", async () => {
    const { store, drain, t1a2, moveTaskBranch, started, follow, merged, attempt } = await setup();
    await store.closeAttempt(PROJECT, bob, t1a2);
    const { head, following } = moveTaskBranch();
    expect(following).toEqual(["t1a1"]);
    await drain();
    expect(started(t1a2)).toBeUndefined();

    await store.reopenAttempt(PROJECT, bob, t1a2);
    await drain();
    expect(started(t1a2)?.params.taskHead).toBe(head);
    await follow(t1a2, merged(t1a2, head));
    expect(attempt(t1a2).scoring.sha).not.toBeNull();
  });

  it("drops a follow whose attempt ended before it ran", async () => {
    const { store, drain, t1a2, moveTaskBranch, started } = await setup();
    moveTaskBranch();
    await drain();
    await store.closeAttempt(PROJECT, bob, t1a2);
    const id = defined(started(t1a2), "follow").params.follow;
    expect(store.claimFollowPush(id)).toBeFalsy();
    expect(await store.followFinished(id, { kind: "moved" })).toBeFalsy();
  });

  it("catches up an attempt started from another, which may be behind the task branch", async () => {
    const { store, drain, t1a1, t1a2, moveTaskBranch, started, follow } = await setup();
    const { head } = moveTaskBranch();
    await drain();
    for (const ref of [t1a1, t1a2]) await follow(ref, (current) => ({ kind: "current", head: current }));
    const copy = at(await store.createAttempts(PROJECT, bob, { task: 1, from: t1a1 }), 0);
    await drain();
    expect(started(copy)?.params.taskHead).toBe(head);
  });

  it("reopens without a follow when the task has no task branch", async () => {
    const { store, drain, t1a2, started } = await setup();
    await store.closeAttempt(PROJECT, bob, t1a2);
    await store.reopenAttempt(PROJECT, bob, t1a2);
    await drain();
    expect(started(t1a2)).toBeUndefined();
  });
});
