// The project DO's side of the merge queue's landings: one Landing Workflow at a time for the front
// of the queue, its place under the Sandbox cap ahead of waiting scoring runs, the next landing after
// each outcome, and stopping a landing whose merge request left the queue. Runs against the `Repos`
// fake and fake Workflow bindings.

import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import type { LandingOutcome, LandingParams, LandingWorkflowBinding } from "../src/landing.ts";
import type { ScoringResult } from "../src/results.ts";
import type { ScoringParams, ScoringWorkflow } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptInput, ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { conflictFile } from "./support/conflicts.ts";
import { at } from "./support/defined.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };

function actor(id: string, agent: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, agent };
}
const owner = actor("owner001");
const ada = actor("ada00001");
const adaAgent = actor("ada00001", "claude");

/** A Workflow binding that records what it was asked to start and stop. */
class FakeWorkflows<P> {
  created: { id: string; params: P }[] = [];
  terminated: string[] = [];
  async create(options: { id: string; params: P }): Promise<unknown> {
    this.created.push(options);
    return {};
  }
  async get(id: string): Promise<{ terminate: () => Promise<void> }> {
    return { terminate: async () => void this.terminated.push(id) };
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

async function setup() {
  const repos = new FakeRepos();
  void repos.create("abc123-main", { defaultBranch: "main" });
  const base = repos.commit("abc123-main", { files: { "README.md": "hi\n" }, message: "init" });
  let clock = Date.parse("2026-10-10T12:00:00.000Z");
  const scoringWorkflow = new FakeWorkflows<ScoringParams>();
  const landingWorkflow = new FakeWorkflows<LandingParams>();
  const tornDown: string[] = [];
  const sql = testSql();
  const store = new TaskStore({
    sql,
    repos,
    now: () => new Date((clock += 1000)),
    scoring: { workflow: scoringWorkflow satisfies ScoringWorkflow, teardown: async () => {} },
    landing: {
      workflow: landingWorkflow satisfies LandingWorkflowBinding,
      teardown: async (id) => void tornDown.push(id),
    },
  });
  const drain = () => store.drain(PROJECT.id);

  /** An open attempt by ada on a new task, with its first scoring run queued. */
  const attempt = async (title: string): Promise<AttemptInput> => {
    const task = store.createTask(PROJECT, owner, { title });
    const a = at(await store.createAttempts(PROJECT, ada, { task: task.number }), 0);
    const ref = { task: a.task, number: a.number };
    await store.openAttempt(PROJECT, ada, ref);
    return ref;
  };
  /** Finishes the attempt's latest scoring run with a passing gate; the run must be running. */
  const score = (ref: AttemptInput) => {
    const run = at(store.scoring.listRuns({ task: ref.task, attempt: ref.number }), -1);
    expect(store.scoringFinished(run.id, { status: "done", result: passed })).toBeTruthy();
  };
  /** An attempt whose head passed, selected: its merge request is queued. */
  const queued = async (title: string): Promise<AttemptInput> => {
    const ref = await attempt(title);
    await drain();
    score(ref);
    await store.selectAttempt(PROJECT, owner, ref);
    return ref;
  };
  const runStates = (refs: AttemptInput[]) =>
    refs.map((r) => at(store.scoring.listRuns({ task: r.task, attempt: r.number }), -1).status);
  const mr = (task: number) => store.getMergeRequest(PROJECT, owner, { task });
  let n = 0;
  const push = (ref: AttemptInput, as: Actor = ada) => {
    const before = store.getAttempt(PROJECT, owner, ref).scoring.sha ?? base.hash;
    const after = repos.commit(`abc123-t${ref.task}a${ref.number}`, { files: { "README.md": `push ${++n}\n` } }).hash;
    store.recordPush(PROJECT, as, { ...ref, updates: [{ ref: "refs/heads/main", before, after }] });
    return after;
  };
  const journalKinds = () =>
    (sql.db.prepare("SELECT kind FROM journal ORDER BY id").all() as { kind: string }[]).map((e) => e.kind);
  return {
    store,
    journalKinds,
    repos,
    base,
    drain,
    attempt,
    score,
    queued,
    runStates,
    mr,
    push,
    landingWorkflow,
    scoringWorkflow,
    tornDown,
  };
}

const landed = (sha = "e".repeat(40)) => ({ kind: "landed" as const, sha });

describe("starting landings", () => {
  it("starts one Landing Workflow for the front of the queue when nothing is landing", async () => {
    const { store, drain, queued, mr, landingWorkflow, base } = await setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();

    expect(landingWorkflow.created).toHaveLength(1);
    expect(landingWorkflow.created[0]).toEqual({
      id: "abc123-t1a1-landing-1",
      params: {
        project: PROJECT.id,
        landing: 1,
        task: t1.task,
        attempt: t1.number,
        title: "First",
        head: base.hash,
        approver: { user: owner.user.id, agent: null },
        coAuthors: [],
        startedAt: expect.any(Number),
      },
    });
    expect(mr(t1.task).state).toBe("landing");
    expect(mr(t2.task).state).toBe("queued");
    await drain();
    expect(landingWorkflow.created).toHaveLength(1);
    expect(store.claimLandingPush(1)).toBeTruthy();
    // A retried claim step claims again.
    expect(store.claimLandingPush(1)).toBeTruthy();
  });

  it("names each agent alias that pushed to the attempt as a co-author", async () => {
    const { store, drain, attempt, score, push, landingWorkflow } = await setup();
    const ref = await attempt("Agents");
    push(ref, adaAgent);
    push(ref, ada);
    push(ref, adaAgent);
    await drain();
    score(ref);
    await store.selectAttempt(PROJECT, owner, ref);
    await drain();
    expect(landingWorkflow.created[0]?.params.coAuthors).toEqual([{ user: ada.user.id, agent: "claude" }]);
  });
});

describe("the Sandbox cap", () => {
  it("counts a landing toward the cap, and starts it ahead of waiting scoring runs", async () => {
    const { store, drain, attempt, score, runStates, mr, landingWorkflow } = await setup();
    const source = await attempt("Source");
    const others = [await attempt("o1"), await attempt("o2"), await attempt("o3"), await attempt("o4")];
    await drain();
    expect(runStates([source, ...others])).toEqual(["running", "running", "running", "queued", "queued"]);

    score(source);
    await drain();
    expect(runStates(others)).toEqual(["running", "running", "running", "queued"]);
    await store.selectAttempt(PROJECT, owner, source);
    await drain();
    expect(mr(source.task).state).toBe("queued");
    expect(landingWorkflow.created).toHaveLength(0);

    score(at(others, 0));
    await drain();
    expect(landingWorkflow.created).toHaveLength(1);
    expect(runStates(others)).toEqual(["done", "running", "running", "queued"]);

    score(at(others, 1));
    await drain();
    expect(runStates(others)).toEqual(["done", "done", "running", "running"]);
  });
});

describe("after each outcome", () => {
  it("lands, merging the source, then starts the next landing", async () => {
    const { store, drain, queued, mr, landingWorkflow } = await setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    expect(store.claimLandingPush(1)).toBeTruthy();
    expect(await store.landingFinished(1, landed())).toBeTruthy();
    await drain();

    expect(mr(t1.task)).toMatchObject({ state: "merged", merge_sha: "e".repeat(40) });
    expect(store.getAttempt(PROJECT, owner, t1).state).toBe("merged");
    expect(store.getTask(PROJECT, owner, { task: t1.task }).state).toBe("closed");
    expect(mr(t2.task).state).toBe("landing");
    expect(landingWorkflow.created.map((c) => c.params.task)).toEqual([t1.task, t2.task]);
  });

  it("dequeues a conflict with its details, then starts the next landing", async () => {
    const { store, drain, queued, mr, landingWorkflow, base } = await setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    const details = {
      attempt: "t1a1",
      head: base.hash,
      main: "m".repeat(40),
      base: base.hash,
      files: [conflictFile("a", "content")],
    };
    await store.landingFinished(1, { kind: "conflict", details });
    await drain();

    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "conflict", details } });
    expect(mr(t2.task).state).toBe("landing");
    expect(landingWorkflow.created).toHaveLength(2);
  });

  it("counts the conflicting files in the notice on the next push to the source", async () => {
    const { store, drain, queued, repos, base } = await setup();
    const t1 = await queued("First");
    await drain();
    const files = [conflictFile("a", "content"), conflictFile("b", "addAdd")];
    await store.landingFinished(1, {
      kind: "conflict",
      details: { attempt: "t1a1", head: base.hash, main: base.hash, base: base.hash, files },
    });
    const after = repos.commit("abc123-t1a1", { files: { "README.md": "fixed\n" } }).hash;
    const pushed = store.recordPush(PROJECT, ada, {
      ...t1,
      updates: [{ ref: "refs/heads/main", before: base.hash, after }],
    });
    expect(pushed.mergeRequest?.dequeue).toEqual({ reason: "conflict", files: 2 });
  });

  const outcomes: Extract<LandingOutcome, { kind: "failedChecks" | "errored" }>[] = [
    { kind: "failedChecks", details: { checks: [{ name: "test", outcome: "failed", log: "test" }] } },
    { kind: "errored", details: { error: "land script exited 13", step: "land" } },
  ];
  it.each(outcomes.map((outcome) => [outcome.kind, outcome] as const))(
    "dequeues %s, then starts the next landing",
    async (_kind, outcome) => {
      const { store, drain, queued, mr, landingWorkflow } = await setup();
      const t1 = await queued("First");
      await queued("Second");
      await drain();
      await store.landingFinished(1, outcome);
      await drain();
      expect(mr(t1.task)).toMatchObject({
        state: "pending",
        last_dequeue: { reason: outcome.kind, details: outcome.details },
      });
      expect(landingWorkflow.created).toHaveLength(2);
    },
  );

  it("records a report in snake_case, from a Workflow started before ADR 0002, in camelCase", async () => {
    const { store, drain, queued, mr } = await setup();
    const t1 = await queued("First");
    await drain();
    const old = { kind: "failed_checks", details: { checks: [{ name: "test", outcome: "timed_out", log: null }] } };
    await store.landingFinished(1, old as unknown as LandingOutcome);
    expect(mr(t1.task)).toMatchObject({
      state: "pending",
      last_dequeue: { reason: "failedChecks", details: { checks: [{ name: "test", outcome: "timedOut", log: null }] } },
    });
  });

  it("starts a landing when a merge request is queued with nothing landing", async () => {
    const { drain, queued, mr, landingWorkflow } = await setup();
    const t1 = await queued("First");
    await drain();
    expect(mr(t1.task).state).toBe("landing");
    expect(landingWorkflow.created).toHaveLength(1);
  });

  it("dequeues errored when its Workflow can't be started", async () => {
    const { drain, queued, mr, landingWorkflow } = await setup();
    landingWorkflow.create = async () => {
      throw new Error("workflows down");
    };
    const t1 = await queued("First");
    await drain();
    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "errored" } });
  });
});

describe("a merge request leaving the queue while landing", () => {
  it("stops the Landing Workflow on a new push, and discards its late report", async () => {
    const { store, drain, queued, mr, push, landingWorkflow, tornDown } = await setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    push(t1);
    await drain();

    expect(mr(t1.task)).toMatchObject({ state: "needsReview", last_dequeue: { reason: "newPush" } });
    expect(landingWorkflow.terminated).toEqual(["abc123-t1a1-landing-1"]);
    expect(tornDown).toEqual(["abc123-t1a1-landing-1"]);
    expect(store.claimLandingPush(1)).toBeFalsy();
    expect(await store.landingFinished(1, landed())).toBeFalsy();
    expect(mr(t1.task).state).toBe("needsReview");
    expect(mr(t2.task).state).toBe("landing");
  });

  it("stops the Landing Workflow on cancel", async () => {
    const { store, drain, queued, mr, landingWorkflow } = await setup();
    const t1 = await queued("First");
    await drain();
    store.cancelMergeRequest(PROJECT, owner, { task: t1.task });
    await drain();
    expect(mr(t1.task).state).toBe("cancelled");
    expect(landingWorkflow.terminated).toEqual(["abc123-t1a1-landing-1"]);
    expect(await store.landingFinished(1, landed())).toBeFalsy();
  });

  it("lets a landing that is pushing to main finish: a push doesn't dequeue it and a cancel is refused", async () => {
    const { store, drain, queued, mr, push, landingWorkflow } = await setup();
    const t1 = await queued("First");
    await drain();
    expect(store.claimLandingPush(1)).toBeTruthy();
    push(t1);
    const err = await Promise.resolve()
      .then(() => store.cancelMergeRequest(PROJECT, owner, { task: t1.task }))
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("invalidState");
    await drain();
    expect(landingWorkflow.terminated).toEqual([]);

    expect(await store.landingFinished(1, landed())).toBeTruthy();
    expect(mr(t1.task).state).toBe("merged");
  });

  it("records an errored landing as merged when main already holds its merge commit", async () => {
    const { store, drain, attempt, score, push, repos, base, mr } = await setup();
    const ref = await attempt("First");
    const head = push(ref);
    await drain();
    score(ref);
    await store.selectAttempt(PROJECT, owner, ref);
    await drain();
    expect(store.claimLandingPush(1)).toBeTruthy();
    // The push went through, but the land step's result was lost and its retries ran out.
    const merge = repos.commit("abc123-main", { files: { "README.md": "merged\n" }, parents: [base.hash, head] });

    const errored = { kind: "errored" as const, details: { step: "land", error: "land gave no result" } };
    expect(await store.landingFinished(1, errored)).toBeTruthy();
    expect(mr(ref.task)).toMatchObject({ state: "merged", merge_sha: merge.hash, last_dequeue: null });
    expect(store.getAttempt(PROJECT, owner, ref).state).toBe("merged");
    expect(store.landings.get(1)?.status).toBe("landed");
  });

  it("still dequeues an errored landing that never claimed its push, whatever main holds", async () => {
    const { store, drain, queued, repos, base, mr } = await setup();
    const t1 = await queued("First");
    await drain();
    repos.commit("abc123-main", { files: { "README.md": "other\n" }, parents: [base.hash, base.hash] });
    const errored = { kind: "errored" as const, details: { step: "retest", error: "boom" } };
    await store.landingFinished(1, errored);
    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "errored" } });
  });

  it("records a landing and its main_advanced before archiving, so a report retried mid-archive loses neither", async () => {
    const { store, drain, queued, repos, mr, journalKinds } = await setup();
    const t1 = await queued("First");
    await drain();
    expect(store.claimLandingPush(1)).toBeTruthy();
    // The archive never finishes, as if the Durable Object were reset during it.
    const copyRef = repos.copyRef.bind(repos);
    repos.copyRef = () => new Promise(() => {});
    void store.landingFinished(1, landed());
    await new Promise((r) => setTimeout(r, 0));
    repos.copyRef = copyRef;

    expect(await store.landingFinished(1, landed())).toBeFalsy();
    expect(mr(t1.task).state).toBe("merged");
    expect(store.landings.get(1)?.status).toBe("landed");
    expect(journalKinds().filter((k) => k === "mainAdvanced")).toHaveLength(1);
  });

  it("sends a failed landing whose source moved while pushing to needs_review", async () => {
    const { store, drain, queued, mr, push } = await setup();
    const t1 = await queued("First");
    await drain();
    store.claimLandingPush(1);
    push(t1);
    await store.landingFinished(1, { kind: "errored", details: { error: "main moved", step: "land" } });
    expect(mr(t1.task)).toMatchObject({ state: "needsReview", last_dequeue: { reason: "errored" } });
  });
});
