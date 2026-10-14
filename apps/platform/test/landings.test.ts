// The project DO's side of the merge queue's landings, each a `main` run (spec #257, "Landing"): one
// for the front of the queue, `main` runs ahead of other runs under the cap, the merge request
// merged as soon as `land` pushes and dequeued with its run otherwise, cancelling a landing only
// before `land` and only by its merge request leaving the queue, and the `landings` table folded
// into `pipeline_runs`. Runs against the `Repos` fake and a fake Workflow binding.

import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import { conflictOutcome, landedOutcome, landingOutcome } from "../src/landing.ts";
import type { LegacyLandingOutcome } from "../src/landing.ts";
import type { ScoringResult } from "../src/results.ts";
import type { RunOutcome } from "../src/run-outcome.ts";
import type { LandingRunParams, PipelineParams, PipelineWorkflowBinding, RunReport } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptInput, ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { conflictFile } from "./support/conflicts.ts";
import { at, defined } from "./support/defined.ts";
import { TEST_KEYRING, testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };

function actor(id: string, alias: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias };
}
const owner = actor("owner001");
const ada = actor("ada00001");
const adaAlias = actor("ada00001", "claude");

type Params = PipelineParams | LandingRunParams;

/** A Workflow binding that records what it was asked to start and stop. */
class FakeWorkflows implements PipelineWorkflowBinding {
  created: { id: string; params: Params }[] = [];
  terminated: string[] = [];
  async create(options: { id: string; params: Params }): Promise<unknown> {
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
  metrics: {},
  logs: [],
};

const SHA = "e".repeat(40);

/** A landing's outcome whose gate failed on `test`. */
const failedGate: RunOutcome = landingOutcome(
  {
    base: null,
    config: { kind: "valid" },
    gate: "failed",
    steps: [
      {
        name: "test",
        kind: "check",
        source: "project",
        group: null,
        outcome: "failed",
        durationMs: 1,
        notes: [],
        log: "test",
      },
    ],
    metrics: {},
  },
  null,
);

/** What a project's store keeps across a deploy: its SQLite, and its repos. */
interface Kept {
  sql: ReturnType<typeof testSql>;
  repos: FakeRepos;
  base: { hash: string };
}

/**
 * A project with one commit on `main`, and a runner, so its merge queue lands on its own unless
 * `lands` is false. `from` opens the store again over another's SQLite and repos, as a deploy does.
 */
function setup({ lands = true, from }: { lands?: boolean; from?: Kept } = {}) {
  const sql = from?.sql ?? testSql();
  const repos = from?.repos ?? new FakeRepos();
  if (from === undefined) void repos.create("abc123-main", { defaultBranch: "main" });
  const base = from?.base ?? repos.commit("abc123-main", { files: { "README.md": "hi\n" }, message: "init" });
  let clock = Date.parse("2026-10-10T12:00:00.000Z");
  const workflow = new FakeWorkflows();
  const tornDown: [string, readonly string[]][] = [];
  const store = new TaskStore({
    sql,
    repos,
    now: () => new Date((clock += 1000)),
    scoring: { workflow, teardown: async (id, containers) => void tornDown.push([id, containers]) },
    lands,
    keyring: TEST_KEYRING,
  });
  const drain = () => store.drain(PROJECT.id);

  /** An open attempt by ada on a new task, with its first run queued. */
  const attempt = async (title: string, creator: Actor = owner): Promise<AttemptInput> => {
    const task = store.createTask(PROJECT, creator, { title });
    const a = at(await store.createAttempts(PROJECT, ada, { task: task.number }), 0);
    const ref = { task: a.task, number: a.number };
    await store.openAttempt(PROJECT, ada, ref);
    return ref;
  };
  /** Finishes the attempt's latest run with a passing gate; the run must be running. */
  const score = (ref: AttemptInput) => {
    const run = at(store.scoring.listRuns(`t${ref.task}a${ref.number}`), -1);
    expect(store.scoringFinished(run.id, { status: "done", result: passed })).toBeTruthy();
  };
  /** An attempt whose head passed, selected by `by`: its merge request is queued. */
  const queued = async (title: string, by: Actor = owner): Promise<AttemptInput> => {
    const ref = await attempt(title, by);
    await drain();
    score(ref);
    await store.selectAttempt(PROJECT, by, ref);
    return ref;
  };
  const runStates = (refs: AttemptInput[]) =>
    refs.map((r) => at(store.scoring.listRuns(`t${r.task}a${r.number}`), -1).status);
  const mr = (task: number) => store.getMergeRequest(PROJECT, owner, { task });
  /** The `main` runs, oldest first. */
  const mainRuns = () => store.scoring.listRuns("main");
  /** The latest landing's run. */
  const landing = () => {
    const runs = mainRuns().filter((r) => r.merge_request !== null);
    return defined(runs.at(-1), "a landing");
  };
  let n = 0;
  const push = (ref: AttemptInput, as: Actor = ada) => {
    const before = store.getAttempt(PROJECT, owner, ref).scoring.sha ?? base.hash;
    const after = repos.commit(`abc123-t${ref.task}a${ref.number}`, { files: { "README.md": `push ${++n}\n` } }).hash;
    store.recordPush(PROJECT, as, { ...ref, updates: [{ ref: "refs/heads/main", before, after }] });
    return after;
  };
  /** Lands the running landing at `sha` as its `land` step would, then reports `outcome`. */
  const land = async (sha = SHA, outcome: RunOutcome = landedOutcome(sha)) => {
    const run = landing().id;
    expect(store.claimLandingPush(run)).toBeTruthy();
    expect(await store.pipelineLanded(run, sha)).toBeTruthy();
    expect(await store.pipelineReported(run, { status: "done", outcome })).toBeTruthy();
    return run;
  };
  const report = (r: RunReport) => store.pipelineReported(landing().id, r);
  const journalKinds = () =>
    (sql.db.prepare("SELECT kind FROM journal ORDER BY id").all() as { kind: string }[]).map((e) => e.kind);
  return {
    store,
    sql,
    repos,
    base,
    drain,
    attempt,
    score,
    queued,
    runStates,
    mr,
    mainRuns,
    landing,
    push,
    land,
    report,
    workflow,
    tornDown,
    journalKinds,
  };
}

describe("starting a landing", () => {
  it("runs `main` for the front of the queue, one at a time, with no head until it lands", async () => {
    const { drain, queued, mr, mainRuns, workflow, base } = setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();

    expect(mr(t1.task).state).toBe("landing");
    expect(mr(t2.task).state).toBe("queued");
    expect(mainRuns()).toMatchObject([
      {
        line: "main",
        sha: null,
        pipeline: "main",
        trigger: "merge",
        merge_request: mr(t1.task).id,
        user_id: owner.user.id,
        alias: null,
        trusted: true,
        status: "running",
      },
    ]);
    const [run] = mainRuns();
    expect(workflow.created.find((c) => c.params.line === "main")).toEqual({
      id: `abc123-main-landing-${run?.id}`,
      params: {
        project: PROJECT.id,
        line: "main",
        sha: null,
        run: run?.id,
        landing: {
          task: t1.task,
          attempt: t1.number,
          title: "First",
          head: base.hash,
          approver: { user: owner.user.id, alias: null },
          coAuthors: [],
          startedAt: run?.created_at,
        },
      },
    });
    await drain();
    expect(mainRuns()).toHaveLength(1);
  });

  it("names each alias that pushed to the attempt as a co-author", async () => {
    const { store, drain, attempt, score, push, workflow } = setup();
    const ref = await attempt("Aliases");
    push(ref, adaAlias);
    push(ref, ada);
    push(ref, adaAlias);
    await drain();
    score(ref);
    await store.selectAttempt(PROJECT, owner, ref);
    await drain();
    const params = workflow.created.at(-1)?.params;
    expect(params !== undefined && "landing" in params && params.landing.coAuthors).toEqual([
      { user: ada.user.id, alias: "claude" },
    ]);
  });

  it("trusts a landing the owner approved, and no one else's", async () => {
    const { drain, queued, landing } = setup();
    // ada creates the task, so she selects (and approves) its merge request.
    await queued("Ada's", ada);
    await drain();
    expect(landing()).toMatchObject({ trusted: false, user_id: ada.user.id });
  });

  it("takes a free slot ahead of older queued runs, as every `main` run does", async () => {
    const { store, drain, attempt, score, runStates, mr, landing } = setup();
    const source = await attempt("Source");
    const others = [await attempt("o1"), await attempt("o2"), await attempt("o3"), await attempt("o4")];
    await drain();
    expect(runStates([source, ...others])).toEqual(["running", "running", "running", "queued", "queued"]);

    score(source);
    await store.selectAttempt(PROJECT, owner, source);
    await drain();
    expect(mr(source.task).state).toBe("landing");
    expect(landing().status).toBe("running");
    expect(runStates(others)).toEqual(["running", "running", "queued", "queued"]);
  });

  it("dequeues errored when its Workflow can't be started, then lands the next", async () => {
    const { drain, queued, mr, workflow, landing } = setup();
    const create = workflow.create.bind(workflow);
    let down = true;
    workflow.create = async (options) => {
      if (down && "landing" in options.params) throw new Error("workflows down");
      return create(options);
    };
    const t1 = await queued("First");
    await drain();
    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "errored", run: landing().id } });
    expect(landing()).toMatchObject({ status: "errored", error: expect.stringContaining("workflows down") });
    down = false;
    const t2 = await queued("Second");
    await drain();
    expect(mr(t2.task).state).toBe("landing");
    expect(landing()).toMatchObject({ status: "running", merge_request: mr(t2.task).id });
  });

  it("refuses the plan of a landing no owner approved that names a secret, which dequeues it", async () => {
    const { store, drain, queued, mr, landing } = setup();
    await store.putSecret(PROJECT, owner, { name: "DEPLOY", value: "deploy-token-0123", pipelines: ["main"] });
    const t1 = await queued("Ada's", ada);
    await drain();
    const verdict = store.pipelinePlanned(landing().id, [], [{ step: "check deploy", secrets: ["DEPLOY"] }]);
    expect(verdict).toMatchObject({ kind: "refused" });
    store.pipelineFinished(landing().id, { status: "errored", error: verdict.kind === "refused" ? verdict.error : "" });
    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "errored" } });
  });

  it("lets a landing the owner approved hand its post-gate steps a secret allowed in main, and only there", async () => {
    const { store, drain, queued, landing } = setup();
    const named = [{ step: "step deploy", secrets: ["PROD"], pipeline: "main" as const }];
    await store.putSecret(PROJECT, owner, { name: "PROD", value: "prod-token-0123", pipelines: ["default"] });
    await queued("Owner's");
    await drain();
    expect(store.pipelinePlanned(landing().id, [], named)).toEqual({
      kind: "refused",
      error: "step deploy: secret PROD isn't allowed in the main pipeline by the project settings",
    });
    await store.putSecret(PROJECT, owner, { name: "PROD", pipelines: ["main"] });
    expect(store.pipelinePlanned(landing().id, [], named)).toEqual({ kind: "start" });
    expect(store.pipelineSecrets(landing().id, ["PROD"])).toMatchObject({ sealed: [{ name: "PROD" }] });
  });

  it("refuses the plan of a landing no owner approved whose post-gate step names a secret", async () => {
    const { store, drain, queued, landing } = setup();
    await store.putSecret(PROJECT, owner, { name: "PROD", value: "prod-token-0123", pipelines: ["main"] });
    await queued("Ada's", ada);
    await drain();
    const verdict = store.pipelinePlanned(landing().id, [], [{ step: "step deploy", secrets: ["PROD"] }]);
    expect(verdict).toEqual({
      kind: "refused",
      error: "a landing only the project owner approved may hold secrets, and this one names PROD",
    });
    expect(() => store.pipelineSecrets(landing().id, ["PROD"])).toThrow(/may hold no secrets/u);
  });
});

describe("a landing that lands", () => {
  it("merges its merge request once `land` pushes, its head the landed sha, before its post-gate steps end", async () => {
    const { store, drain, queued, mr, landing, journalKinds } = setup();
    const t1 = await queued("First");
    await drain();
    const run = landing().id;
    expect(store.claimLandingPush(run)).toBeTruthy();
    expect(await store.pipelineLanded(run, SHA)).toBeTruthy();

    expect(mr(t1.task)).toMatchObject({ state: "merged", merge_sha: SHA });
    expect(store.getAttempt(PROJECT, owner, t1).state).toBe("merged");
    expect(store.getTask(PROJECT, owner, { task: t1.task }).state).toBe("closed");
    expect(landing()).toMatchObject({ sha: SHA, status: "running" });
    expect(store.scoring.statusFor("main")).toEqual({ status: "running", sha: SHA });
    expect(journalKinds().filter((k) => k === "mainAdvanced")).toHaveLength(1);
    // A retried step records nothing again.
    expect(await store.pipelineLanded(run, SHA)).toBeFalsy();
  });

  it("is the `main` run of what landed: the ref move its push made asks for no other", async () => {
    const { store, drain, queued, mainRuns, landing, land } = setup();
    await queued("First");
    await drain();
    const run = await land();
    expect(mainRuns().map((r) => r.id)).toEqual([run]);
    expect(landing()).toMatchObject({ status: "done", sha: SHA, outcome: { landed: { sha: SHA } } });
    const again = store.scoring.request({
      project: PROJECT.id,
      line: "main",
      sha: SHA,
      trigger: "push",
      actor: null,
      ownersPush: true,
    });
    expect(again).toMatchObject({ queued: false, run: { id: run } });
  });

  it("starts the next landing once the `main` line is free", async () => {
    const { store, drain, queued, mr, mainRuns, landing } = setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    const first = landing().id;
    expect(store.claimLandingPush(first)).toBeTruthy();
    await store.pipelineLanded(first, SHA);
    await drain();
    // The first is still running its post-gate steps: the next is queued behind it.
    expect(mr(t2.task).state).toBe("landing");
    expect(landing()).toMatchObject({ status: "queued", merge_request: mr(t2.task).id });
    store.pipelineFinished(first, { status: "done", outcome: landedOutcome(SHA) });
    await drain();
    expect(landing().status).toBe("running");
    expect(mr(t1.task).state).toBe("merged");
    expect(mainRuns().map((r) => r.status)).toEqual(["done", "running"]);
  });

  it("records an errored landing as landed when main already holds its merge commit", async () => {
    const { store, drain, attempt, score, push, repos, base, mr, landing } = setup();
    const ref = await attempt("First");
    const head = push(ref);
    await drain();
    score(ref);
    await store.selectAttempt(PROJECT, owner, ref);
    await drain();
    expect(store.claimLandingPush(landing().id)).toBeTruthy();
    // The push went through, but the land step's result was lost and its retries ran out.
    const merge = repos.commit("abc123-main", { files: { "README.md": "merged\n" }, parents: [base.hash, head] });

    expect(
      await store.pipelineReported(landing().id, { status: "errored", error: "land gave no result" }),
    ).toBeTruthy();
    expect(mr(ref.task)).toMatchObject({ state: "merged", merge_sha: merge.hash, last_dequeue: null });
    expect(landing()).toMatchObject({ status: "errored", sha: merge.hash });
  });

  it("records a landing before archiving, so a step retried mid-archive records it once", async () => {
    const { store, drain, queued, repos, mr, landing, journalKinds } = setup();
    const t1 = await queued("First");
    await drain();
    expect(store.claimLandingPush(landing().id)).toBeTruthy();
    // The archive never finishes, as if the Durable Object were reset during it.
    const copyRef = repos.copyRef.bind(repos);
    repos.copyRef = () => new Promise(() => {});
    void store.pipelineLanded(landing().id, SHA);
    await new Promise((r) => setTimeout(r, 0));
    repos.copyRef = copyRef;

    expect(await store.pipelineLanded(landing().id, SHA)).toBeFalsy();
    expect(mr(t1.task).state).toBe("merged");
    expect(journalKinds().filter((k) => k === "mainAdvanced")).toHaveLength(1);
  });
});

const conflict = () => ({
  attempt: "t1a1",
  head: "a".repeat(40),
  main: "m".repeat(40),
  base: null,
  files: [conflictFile("a", "content"), conflictFile("b", "addAdd")],
});

describe("a landing that doesn't land", () => {
  it("dequeues a conflict naming its run, which keeps the conflict, then lands the next", async () => {
    const { store, drain, queued, mr, landing } = setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    const run = landing().id;
    await store.pipelineReported(run, { status: "done", outcome: conflictOutcome(conflict()) });
    await drain();

    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "conflict", run } });
    expect(store.getDequeue(PROJECT, owner, { task: t1.task })).toMatchObject({
      reason: "conflict",
      run,
      details: conflict(),
    });
    expect(mr(t2.task).state).toBe("landing");
    expect(landing().id).not.toBe(run);
  });

  it("tells the next push to the source of the dequeue, with its file count", async () => {
    const { store, drain, queued, repos, base, landing } = setup();
    const t1 = await queued("First");
    await drain();
    await store.pipelineReported(landing().id, { status: "done", outcome: conflictOutcome(conflict()) });
    const after = repos.commit("abc123-t1a1", { files: { "README.md": "fixed\n" } }).hash;
    const pushed = store.recordPush(PROJECT, ada, {
      ...t1,
      updates: [{ ref: "refs/heads/main", before: base.hash, after }],
    });
    expect(pushed.mergeRequest?.dequeue).toEqual({ reason: "conflict", files: 2 });
  });

  it("dequeues a failed gate with its failed steps, and an error with its error", async () => {
    const { store, drain, queued, mr, landing } = setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    const first = landing().id;
    await store.pipelineReported(first, { status: "done", outcome: failedGate });
    await drain();
    expect(store.getDequeue(PROJECT, owner, { task: t1.task })).toMatchObject({
      reason: "failedChecks",
      run: first,
      details: { steps: [{ name: "test", kind: "check", outcome: "failed" }] },
    });
    const second = landing().id;
    await store.pipelineReported(second, { status: "errored", error: "land: main moved from m; the lease failed" });
    expect(mr(t2.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "errored", run: second } });
    expect(store.getDequeue(PROJECT, owner, { task: t2.task }).details).toEqual({
      error: "land: main moved from m; the lease failed",
    });
  });

  it("still dequeues an errored landing that never claimed its push, whatever main holds", async () => {
    const { repos, base, drain, queued, mr, report } = setup();
    const t1 = await queued("First");
    await drain();
    repos.commit("abc123-main", { files: { "README.md": "other\n" }, parents: [base.hash, base.hash] });
    await report({ status: "errored", error: "setup: boom" });
    expect(mr(t1.task)).toMatchObject({ state: "pending", last_dequeue: { reason: "errored" } });
  });

  it("sends one whose source moved while it was pushing to needsReview", async () => {
    const { store, drain, queued, mr, push, landing, report } = setup();
    const t1 = await queued("First");
    await drain();
    store.claimLandingPush(landing().id);
    push(t1);
    await report({ status: "errored", error: "land: main moved" });
    expect(mr(t1.task)).toMatchObject({ state: "needsReview", last_dequeue: { reason: "errored" } });
  });
});

describe("cancelling a landing", () => {
  it("cancels it when a new push takes its merge request out of the queue, before `land`", async () => {
    const { store, drain, queued, mr, push, landing, workflow, tornDown } = setup();
    const t1 = await queued("First");
    const t2 = await queued("Second");
    await drain();
    const run = landing();
    store.pipelinePlanned(run.id, [`${run.instance_id}/setup`], []);
    push(t1);
    await drain();

    expect(mr(t1.task)).toMatchObject({ state: "needsReview", last_dequeue: { reason: "newPush" } });
    expect(store.scoring.getRun(run.id)?.status).toBe("cancelled");
    expect(workflow.terminated).toEqual([run.instance_id]);
    expect(tornDown).toEqual([
      [
        run.instance_id,
        [`${run.instance_id}/merge`, `${run.instance_id}/land`, `${run.instance_id}/check`, `${run.instance_id}/setup`],
      ],
    ]);
    expect(store.claimLandingPush(run.id)).toBeFalsy();
    expect(await store.pipelineReported(run.id, { status: "done", outcome: landedOutcome(SHA) })).toBeFalsy();
    expect(mr(t1.task).state).toBe("needsReview");
    expect(mr(t2.task).state).toBe("landing");
  });

  it("cancels it on a cancel of its merge request", async () => {
    const { store, drain, queued, mr, landing, workflow } = setup();
    const t1 = await queued("First");
    await drain();
    const run = landing();
    store.cancelMergeRequest(PROJECT, owner, { task: t1.task });
    await drain();
    expect(mr(t1.task).state).toBe("cancelled");
    expect(workflow.terminated).toEqual([run.instance_id]);
  });

  it("never once `land` claimed its push: a push doesn't dequeue it, a cancel is refused, and it lands", async () => {
    const { store, drain, queued, mr, push, landing, workflow, land } = setup();
    const t1 = await queued("First");
    await drain();
    expect(store.claimLandingPush(landing().id)).toBeTruthy();
    // A retried claim step claims again.
    expect(store.claimLandingPush(landing().id)).toBeTruthy();
    push(t1);
    const err = await Promise.resolve()
      .then(() => store.cancelMergeRequest(PROJECT, owner, { task: t1.task }))
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("invalidState");
    await drain();
    expect(workflow.terminated).toEqual([]);
    await land();
    expect(mr(t1.task).state).toBe("merged");
  });

  it("never by the owner, nor by a newer head on main", async () => {
    const { store, drain, queued, landing } = setup();
    await queued("First");
    await drain();
    const run = landing();
    expect(run).toMatchObject({ status: "running" });
    const err = await Promise.resolve()
      .then(() => store.cancelRun(PROJECT, owner, { run: run.id }))
      .catch((error: unknown) => error);
    expect((err as ServiceError).code).toBe("invalidState");
    store.scoring.request({
      project: PROJECT.id,
      line: "main",
      sha: "f".repeat(40),
      trigger: "push",
      actor: null,
      ownersPush: true,
    });
    expect(store.scoring.getRun(run.id)?.status).toBe("running");
  });
});

/**
 * Writes the old `landings` table and rows after `prepare` (whose store doesn't land), then opens
 * the store again over the same SQLite and repos, as the deploy does.
 */
async function migrated(
  rows: { status: string; mr: number }[],
  prepare: (t: ReturnType<typeof setup>) => Promise<void>,
) {
  const before = setup({ lands: false });
  const { sql } = before;
  await prepare(before);
  sql.exec(`CREATE TABLE landings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, task INTEGER NOT NULL, attempt INTEGER NOT NULL,
    merge_request INTEGER NOT NULL, head TEXT NOT NULL, instance_id TEXT NOT NULL, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER, torn_down INTEGER NOT NULL DEFAULT 0)`);
  rows.forEach(({ status, mr }, i) => {
    sql.exec(
      `INSERT INTO landings (project, task, attempt, merge_request, head, instance_id, status, started_at, finished_at)
       VALUES ('abc123', ?, 1, ?, 'h', ?, ?, ?, ?)`,
      mr,
      mr,
      `abc123-t${mr}a1-landing-${i + 1}`,
      status,
      1000 + i,
      status === "running" || status === "pushing" ? null : 2000 + i,
    );
  });
  return { sql, before, after: setup({ from: before }) };
}

describe("landings from before landings were runs", () => {
  it("moves each landing into pipeline_runs as a landing's run, its dequeue naming it", async () => {
    const { sql, after } = await migrated(
      [
        { status: "landed", mr: 1 },
        { status: "dequeued", mr: 2 },
        { status: "stopped", mr: 3 },
      ],
      async (t) => {
        for (const title of ["One", "Two", "Three"]) {
          await t.queued(title);
          t.store.startLanding(PROJECT, null);
        }
        await t.store.landMergeRequest(PROJECT, null, { task: 1, sha: SHA });
        t.store.dequeueMergeRequest(PROJECT, null, { task: 2, reason: "errored", run: 0 });
        // As a Landing Workflow's dequeue stored it: details, and no run.
        t.sql.exec(
          "UPDATE merge_requests SET last_dequeue = ? WHERE id = 2",
          JSON.stringify({
            reason: "failed_checks",
            at: "2026-10-10T12:00:00.000Z",
            details: { checks: [{ name: "test", outcome: "timed_out", log: "test" }] },
          }),
        );
        t.store.cancelMergeRequest(PROJECT, owner, { task: 3 });
      },
    );
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'landings'")).toEqual([]);
    const runs = after.mainRuns();
    expect(runs.map((r) => [r.merge_request, r.trigger, r.status, r.sha, r.instance_id])).toEqual([
      [1, "merge", "done", SHA, "abc123-t1a1-landing-1"],
      [2, "merge", "done", null, "abc123-t2a1-landing-2"],
      [3, "merge", "cancelled", null, "abc123-t3a1-landing-3"],
    ]);
    expect(runs[0]?.outcome).toMatchObject({ landed: { sha: SHA } });
    expect(runs[1]?.outcome?.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["merge", "passed"],
      ["test", "failed"],
      ["land", "skipped"],
    ]);
    expect(after.mr(2).last_dequeue).toMatchObject({ reason: "failedChecks", run: runs[1]?.id });
    expect(after.store.getDequeue(PROJECT, owner, { task: 2 }).details).toEqual({
      steps: [{ name: "test", kind: "check", outcome: "failed" }],
    });
    expect(after.store.listRuns(PROJECT, owner, { line: "main", limit: 10 }).runs).toHaveLength(3);
  });

  it("keeps a landing in flight running, so its Landing Workflow's reports still land it", async () => {
    const { after } = await migrated([{ status: "pushing", mr: 1 }], async (t) => {
      await t.queued("One");
      t.store.startLanding(PROJECT, null);
    });
    expect(after.landing()).toMatchObject({ status: "running", land_claimed: true, sha: null });
    // Draining doesn't cancel or replace it: it holds the `main` line.
    await after.drain();
    expect(after.mainRuns()).toHaveLength(1);
    expect(after.store.claimLegacyLandingPush(1)).toBeTruthy();
    const landed: LegacyLandingOutcome = { kind: "landed", sha: SHA };
    expect(await after.store.legacyLandingFinished(1, landed)).toBeTruthy();
    expect(after.mr(1)).toMatchObject({ state: "merged", merge_sha: SHA });
    expect(after.landing()).toMatchObject({ status: "done", sha: SHA });
  });

  it("records a Landing Workflow's other outcomes on its run, in its old shape", async () => {
    const { after } = await migrated([{ status: "running", mr: 1 }], async (t) => {
      await t.queued("One");
      t.store.startLanding(PROJECT, null);
    });
    const old = { kind: "failed_checks", details: { checks: [{ name: "test", outcome: "timed_out", log: null }] } };
    expect(await after.store.legacyLandingFinished(1, old as unknown as LegacyLandingOutcome)).toBeTruthy();
    expect(after.mr(1)).toMatchObject({
      state: "pending",
      last_dequeue: { reason: "failedChecks", run: after.landing().id },
    });
  });

  it("lands one again as a run when its Workflow resumes on the new code, unless main holds its merge", async () => {
    const { after } = await migrated([{ status: "running", mr: 1 }], async (t) => {
      await t.queued("One");
      t.store.startLanding(PROJECT, null);
    });
    const old = after.landing();
    await after.store.legacyLandingResumed(1);
    expect(after.store.scoring.getRun(old.id)?.status).toBe("cancelled");
    await after.drain();
    expect(after.mr(1).state).toBe("landing");
    expect(after.landing()).toMatchObject({ status: "running", sha: null, trigger: "merge" });
    expect(after.landing().id).not.toBe(old.id);
  });

  it("records one that claimed its push as landed when it resumes and main holds its merge", async () => {
    const { after } = await migrated([{ status: "pushing", mr: 1 }], async (t) => {
      await t.queued("One");
      t.store.startLanding(PROJECT, null);
    });
    const approved = after.mr(1).approved_head;
    const merge = after.repos.commit("abc123-main", {
      files: { "README.md": "merged\n" },
      parents: [after.base.hash, approved],
    });
    await after.store.legacyLandingResumed(1);
    expect(after.mr(1)).toMatchObject({ state: "merged", merge_sha: merge.hash });
  });
});
