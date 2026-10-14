import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import type { CheckResult, LegacyResult, ScoringResult } from "../src/results.ts";
import { SCORING_CAP } from "../src/scoring.ts";
import type { ScoringOutcome, ScoringParams, ScoringRequest, ScoringWorkflow } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptInput, ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { at, defined } from "./support/defined.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ORIGIN = "abc123-main";

function actor(id: string, alias: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias };
}

const owner = actor("owner001");
const ada = actor("ada00001");
const adaAlias = actor("ada00001", "claude");
const bob = actor("bob00001");
const cat = actor("cat00001");

/** A Workflow binding that records what it was asked to do. */
class FakeWorkflow implements ScoringWorkflow {
  readonly created: { id: string; params: ScoringParams }[] = [];
  readonly terminated: string[] = [];
  failNext = false;

  async create(options: { id: string; params: ScoringParams }): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("workflow service unavailable");
    }
    this.created.push(options);
    return {};
  }

  async get(id: string): Promise<{ terminate: () => Promise<void> }> {
    return { terminate: async () => void this.terminated.push(id) };
  }
}

function setup() {
  const repos = new FakeRepos();
  void repos.create(ORIGIN, { defaultBranch: "main" });
  const base = repos.commit(ORIGIN, { files: { "README.md": "hi\n" }, message: "init" });
  const sql = testSql();
  const workflow = new FakeWorkflow();
  const tornDown: string[] = [];
  const store = new TaskStore({
    sql,
    repos,
    now: () => new Date("2026-10-10T12:00:00.000Z"),
    scoring: { workflow, teardown: async (id) => void tornDown.push(id) },
  });
  const journal = () =>
    (sql.db.prepare("SELECT kind, detail FROM journal ORDER BY id").all() as { kind: string; detail: string }[]).map(
      (e): Record<string, unknown> => ({ kind: e.kind, ...(JSON.parse(e.detail) as Record<string, unknown>) }),
    );
  const runs = (ref: AttemptInput) => store.scoring.listRuns({ task: ref.task, attempt: ref.number });

  /** Commits on an attempt's fork `main`, as a push would, and returns the new head. */
  const commit = (ref: AttemptInput, content: string) =>
    repos.commit(`abc123-t${ref.task}a${ref.number}`, { files: { "README.md": content } }).hash;

  /** Records a push of `after` to the attempt's fork `main`, as the git proxy does once it lands. */
  const pushed = (ref: AttemptInput, after: string, who: Actor = ada) =>
    store.recordPush(PROJECT, who, { ...ref, updates: [{ ref: "refs/heads/main", before: base.hash, after }] }).scoring;

  /** A task by ada with `count` draft attempts by ada. */
  const drafts = async (count = 1): Promise<AttemptInput[]> => {
    const task = store.createTask(PROJECT, ada, { title: "Fix it" });
    const made = await store.createAttempts(PROJECT, ada, { task: task.number, count });
    return made.map((a) => ({ task: a.task, number: a.number }));
  };

  /** A task by ada with one draft attempt by ada. */
  const draft = async (): Promise<AttemptInput> => at(await drafts(), 0);

  return { repos, base, store, workflow, tornDown, journal, runs, commit, pushed, drafts, draft };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const rejection = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(ServiceError);
  return (rejection as ServiceError).code;
}

function result(overrides: Partial<ScoringResult> = {}): ScoringResult {
  return {
    base: "b".repeat(40),
    config: { kind: "none" },
    gate: "passed",
    checks: [],
    metrics: {},
    logs: [],
    ...overrides,
  };
}

const done = (overrides: Partial<ScoringResult> = {}): ScoringOutcome => ({
  status: "done",
  result: result(overrides),
});
const errored = (): ScoringOutcome => ({ status: "errored", error: "sandbox lost" });

function queued(request: ScoringRequest | null): ScoringRequest & { queued: true } {
  expect(request?.queued).toBeTruthy();
  return request as ScoringRequest & { queued: true };
}

describe("scoring triggers", () => {
  it("scores the head when an attempt is opened", async () => {
    const { store, workflow, runs, base, draft } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, adaAlias, ref);

    expect(runs(ref)).toMatchObject([
      { sha: base.hash, trigger: "open", status: "queued", user_id: ada.user.id, alias: "claude" },
    ]);
    await store.scoring.drain();
    expect(runs(ref)).toMatchObject([{ status: "running" }]);
    expect(workflow.created).toEqual([
      {
        id: `abc123-t1a1-${base.hash.slice(0, 12)}-1`,
        params: { project: "abc123", attempt: "t1a1", sha: base.hash, run: 1 },
      },
    ]);
  });

  it("scores a push while open, but not a push to a draft", async () => {
    const { runs, commit, pushed, draft, store } = setup();
    const ref = await draft();
    const draftHead = commit(ref, "draft work\n");
    expect(pushed(ref, draftHead)).toBeNull();
    expect(runs(ref)).toEqual([]);

    await store.openAttempt(PROJECT, ada, ref);
    const openHead = commit(ref, "open work\n");
    const request = queued(pushed(ref, openHead));
    expect(request.run).toMatchObject({ sha: openHead, trigger: "push" });
    expect(runs(ref).map((r) => [r.sha, r.trigger, r.status])).toEqual([
      [draftHead, "open", "cancelled"],
      [openHead, "push", "queued"],
    ]);
  });

  it("ignores pushes that don't move the fork's main", async () => {
    const { store, runs, commit, draft } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    const before = runs(ref).length;
    const other = commit(ref, "elsewhere\n");
    const zero = "0".repeat(40);
    store.recordPush(PROJECT, ada, {
      ...ref,
      updates: [
        { ref: "refs/heads/wip", before: zero, after: other },
        { ref: "refs/heads/main", before: other, after: zero },
      ],
    });
    expect(runs(ref)).toHaveLength(before);
  });

  it("scores now on the author's request, for drafts only", async () => {
    const { store, runs, base, draft } = setup();
    const ref = await draft();
    expect(await code(store.scoreNow(PROJECT, bob, ref))).toBe("forbidden");

    const request = queued(await store.scoreNow(PROJECT, adaAlias, ref));
    expect(request.run).toMatchObject({ sha: base.hash, trigger: "scoreNow", alias: "claude" });

    await store.openAttempt(PROJECT, ada, ref);
    expect(await code(store.scoreNow(PROJECT, ada, ref))).toBe("invalidState");
    expect(runs(ref)).toHaveLength(1);
  });

  it("rescores for the author, the task creator or the project owner, on open attempts only", async () => {
    const { store, runs } = setup();
    const task = store.createTask(PROJECT, cat, { title: "Cat's task" });
    const made = at(await store.createAttempts(PROJECT, ada, { task: task.number }), 0);
    const ref = { task: made.task, number: made.number };
    expect(await code(store.rescore(PROJECT, ada, ref))).toBe("invalidState");

    await store.openAttempt(PROJECT, ada, ref);
    expect(await code(store.rescore(PROJECT, bob, ref))).toBe("forbidden");
    for (const who of [ada, cat, owner]) {
      await store.scoring.drain();
      store.scoring.finish(at(runs(ref), -1).id, done());
      const request = queued(await store.rescore(PROJECT, who, ref));
      expect(request.run).toMatchObject({ trigger: "rescore", user_id: who.user.id });
    }
    expect(runs(ref).map((r) => r.trigger)).toEqual(["open", "rescore", "rescore", "rescore"]);
  });

  it("refuses score now when the fork has no commits, and opens without scoring", async () => {
    const repos = new FakeRepos();
    void repos.create(ORIGIN);
    const store = new TaskStore({ sql: testSql(), repos });
    const task = store.createTask(PROJECT, ada, { title: "Empty" });
    const made = at(await store.createAttempts(PROJECT, ada, { task: task.number }), 0);
    const ref = { task: made.task, number: made.number };
    expect(await code(store.scoreNow(PROJECT, ada, ref))).toBe("invalidState");
    expect((await store.openAttempt(PROJECT, ada, ref)).state).toBe("open");
    expect(store.scoring.listRuns({ task: ref.task, attempt: ref.number })).toEqual([]);
  });
});

describe("the scoring queue", () => {
  it("journals every push, force-pushes back to an earlier commit included, and scores each head once", async () => {
    const { store, runs, commit, pushed, draft, journal } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    const a = commit(ref, "a\n");
    const b = commit(ref, "b\n");
    queued(pushed(ref, a));
    expect(pushed(ref, a)).toMatchObject({ queued: false, reason: "already queued" });
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), -1).id, done());

    queued(pushed(ref, b));
    // Back to a, which already has a finished run: b's run is superseded and a isn't scored again.
    expect(pushed(ref, a)).toMatchObject({ queued: false, reason: "already scored" });
    expect(
      journal()
        .filter((e) => e.kind === "pushed")
        .map((e) => e.after),
    ).toEqual([a, a, b, a]);
    expect(runs(ref).map((r) => [r.sha, r.status])).toEqual([
      [expect.any(String), "cancelled"],
      [a, "done"],
      [b, "cancelled"],
    ]);
  });

  it("keeps one pending run per attempt: the newest head wins", async () => {
    const { store, runs, commit, pushed, drafts } = setup();
    const refs = await drafts(SCORING_CAP + 1);
    for (const ref of refs) await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    const waiting = at(refs, -1);
    expect(runs(waiting)).toMatchObject([{ status: "queued" }]);

    const first = commit(waiting, "one\n");
    const second = commit(waiting, "two\n");
    pushed(waiting, first);
    pushed(waiting, second);
    expect(runs(waiting).map((r) => r.status)).toEqual(["cancelled", "cancelled", "queued"]);
    expect(at(runs(waiting), -1).sha).toBe(second);
  });

  it("cancels a running run, its Workflow and its Sandboxes, when a newer head arrives", async () => {
    const { store, workflow, tornDown, runs, commit, pushed, draft, journal } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    const running = at(runs(ref), 0);

    const head = commit(ref, "newer\n");
    pushed(ref, head);
    await store.scoring.drain();
    expect(workflow.terminated).toEqual([running.instance_id]);
    expect(tornDown).toEqual([running.instance_id]);
    expect(runs(ref).map((r) => [r.sha, r.status])).toEqual([
      [running.sha, "cancelled"],
      [head, "running"],
    ]);
    expect(journal().find((e) => e.kind === "scoringCancelled")).toMatchObject({ run: 1, superseded_by: head });

    // A late report from the cancelled run is discarded, and a second drain stops nothing more.
    expect(store.scoring.finish(running.id, done())).toBeFalsy();
    expect(store.scoring.getRun(running.id)?.status).toBe("cancelled");
    await store.scoring.drain();
    expect(workflow.terminated).toHaveLength(1);
  });

  it(`runs at most ${SCORING_CAP} at once and starts the oldest waiting run as one finishes`, async () => {
    const { store, workflow, runs, drafts, journal } = setup();
    const refs = await drafts(SCORING_CAP + 2);
    for (const ref of refs) await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    expect(workflow.created.map((c) => c.params.attempt)).toEqual(["t1a1", "t1a2", "t1a3"]);
    expect(refs.map((r) => at(runs(r), 0).status)).toEqual(["running", "running", "running", "queued", "queued"]);

    expect(store.scoring.finish(at(runs(at(refs, 1)), 0).id, done())).toBeTruthy();
    await store.scoring.drain();
    expect(workflow.created.map((c) => c.params.attempt)).toEqual(["t1a1", "t1a2", "t1a3", "t1a4"]);
    expect(journal().find((e) => e.kind === "scored")).toMatchObject({
      ref: "t1a2",
      gate: "passed",
      summary: "no checks configured",
    });

    store.scoring.finish(at(runs(at(refs, 0)), 0).id, errored());
    await store.scoring.drain();
    expect(refs.map((r) => at(runs(r), 0).status)).toEqual(["errored", "done", "running", "running", "running"]);
  });

  it("skips a head that already has a done run, unless it's a rescore", async () => {
    const { store, workflow, runs, base, draft } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), 0).id, done());

    store.draftAttempt(PROJECT, ada, ref);
    await store.openAttempt(PROJECT, ada, ref);
    expect(runs(ref)).toHaveLength(1);
    expect(await store.rescore(PROJECT, ada, ref)).toMatchObject({ queued: true, run: { sha: base.hash } });
    await store.scoring.drain();
    expect(workflow.created.map((c) => c.id)).toEqual([
      `abc123-t1a1-${base.hash.slice(0, 12)}-1`,
      `abc123-t1a1-${base.hash.slice(0, 12)}-2`,
    ]);
  });

  it("scores an errored head again when it's requested again", async () => {
    const { store, runs, draft } = setup();
    const ref = await draft();
    await store.scoreNow(PROJECT, ada, ref);
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), 0).id, errored());
    expect(await store.scoreNow(PROJECT, ada, ref)).toMatchObject({ queued: true });
  });

  it("ends a run errored when its Workflow can't be created", async () => {
    const { store, workflow, runs, draft, journal } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    workflow.failNext = true;
    await store.scoring.drain();
    expect(runs(ref)).toMatchObject([{ status: "errored" }]);
    expect(journal().find((e) => e.kind === "scoringErrored")).toMatchObject({
      error: expect.stringMatching(/unavailable/u),
    });
  });

  it("doesn't let a head read before a push replace the head that push queued", async () => {
    const { store, repos, runs, base, commit, draft } = setup();
    const ref = await draft();
    const newer = commit(ref, "pushed while opening\n");
    // Opening reads the fork's head; a push lands while that read is in flight.
    const listCommits = repos.listCommits.bind(repos);
    repos.listCommits = async (name, opts) => {
      const [head, ...rest] = await listCommits(name, opts);
      store.recordPush(PROJECT, ada, {
        ...ref,
        updates: [{ ref: "refs/heads/main", before: base.hash, after: newer }],
      });
      return [{ ...defined(head, "a head commit"), hash: base.hash }, ...rest];
    };
    // The attempt is open by the time the push is recorded, so it queues the newer head.
    await store.openAttempt(PROJECT, ada, ref);
    expect(runs(ref).map((r) => [r.sha, r.trigger, r.status])).toEqual([[newer, "push", "queued"]]);
  });

  it("cancels an attempt's runs when it returns to draft, closes, merges or is made obsolete", async () => {
    const { store, workflow, runs, drafts, journal } = setup();
    const refs = await drafts(4);
    for (const ref of refs) await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    expect(refs.map((r) => at(runs(r), 0).status)).toEqual(["running", "running", "running", "queued"]);

    store.draftAttempt(PROJECT, ada, at(refs, 0));
    await store.closeAttempt(PROJECT, ada, at(refs, 1));
    await store.obsoleteAttempt(PROJECT, owner, at(refs, 3));
    await store.markMerged(PROJECT, owner, { ...at(refs, 2), sha: "f00" });
    await store.scoring.drain();
    expect(refs.map((r) => at(runs(r), 0).status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(workflow.terminated).toHaveLength(3);
    expect(
      journal()
        .filter((e) => e.kind === "scoringCancelled")
        .map((e) => e.reason),
    ).toEqual(["returned to draft", "attempt closed", "attempt obsolete", "attempt merged"]);
  });

  it("keeps runs queued when no runner is configured", async () => {
    const repos = new FakeRepos();
    void repos.create(ORIGIN);
    repos.commit(ORIGIN, { files: { a: "a" } });
    const store = new TaskStore({ sql: testSql(), repos });
    const task = store.createTask(PROJECT, ada, { title: "t" });
    const a = at(await store.createAttempts(PROJECT, ada, { task: task.number }), 0);
    await store.openAttempt(PROJECT, ada, { task: a.task, number: a.number });
    await store.scoring.drain();
    expect(store.scoring.listRuns({ task: a.task, attempt: a.number })).toMatchObject([{ status: "queued" }]);
  });
});

/** A task metric named `lines`, as a request gives it. */
const lines = (from = "test.coverage.lines") => ({ name: "lines", from, type: "number" });

describe("rescoring on a task edit", () => {
  const CONFIG = ["checks:", "  - name: test", "    command: pnpm test", ""].join("\n");

  /** A task by ada over a config with a `test` check: its first attempt open and scored, its second a draft. */
  async function scored() {
    const env = setup();
    env.repos.writeFile(ORIGIN, "main", ".throng/config.yml", CONFIG);
    const [open, draft] = await env.drafts(2);
    if (open === undefined || draft === undefined) throw new Error("two drafts expected");
    await env.store.openAttempt(PROJECT, ada, open);
    await env.store.scoring.drain();
    env.store.scoring.finish(at(env.runs(open), 0).id, done());
    return { ...env, open, draft };
  }

  it("rescores each open attempt's head when the task's metrics change, and leaves drafts alone", async () => {
    const { store, runs, base, open, draft } = await scored();
    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines()] });

    expect(runs(open)).toMatchObject([
      { trigger: "open", status: "done" },
      { trigger: "rescore", status: "queued", sha: base.hash, user_id: ada.user.id },
    ]);
    expect(runs(draft)).toEqual([]);
  });

  it("rescores each open attempt's head when the task's checks change", async () => {
    const { store, runs, open } = await scored();
    const smoke = { name: "smoke", command: "./smoke.sh" };
    await store.editTask(PROJECT, ada, { task: 1, checks: [smoke], metrics: [lines("smoke.report.lines")] });
    await store.scoring.drain();
    store.scoring.finish(at(runs(open), -1).id, done());
    await store.editTask(PROJECT, ada, { task: 1, checks: [{ ...smoke, required: false }] });

    expect(runs(open).map((r) => r.trigger)).toEqual(["open", "rescore", "rescore"]);
    expect(await code(store.editTask(PROJECT, ada, { task: 1, checks: [] }))).toBe("invalidRequest");
    expect(runs(open)).toHaveLength(3);
  });

  it("queues nothing when a save leaves the metrics as they were", async () => {
    const { store, runs, open } = await scored();
    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines()] });
    await store.scoring.drain();
    store.scoring.finish(at(runs(open), -1).id, done());

    await store.editTask(PROJECT, ada, { task: 1, title: "Renamed" });
    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines()] });
    expect(runs(open)).toHaveLength(2);
  });

  it("coalesces repeated edits with the rescore already queued", async () => {
    const { store, runs, open } = await scored();
    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines()] });
    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines("test.coverage.total")] });
    await store.editTask(PROJECT, ada, { task: 1, metrics: [] });

    expect(runs(open).map((r) => [r.trigger, r.status])).toEqual([
      ["open", "done"],
      ["rescore", "queued"],
    ]);
  });

  it("queues one rescore behind a run that's running, which may have read the old definitions", async () => {
    const { store, workflow, runs, open } = await scored();
    const sha = at(runs(open), 0).sha;
    store.scoring.request({ project: PROJECT.id, task: 1, attempt: 1, sha, trigger: "rescore", actor: ada });
    await store.scoring.drain();
    expect(runs(open).map((r) => [r.trigger, r.status])).toEqual([
      ["open", "done"],
      ["rescore", "running"],
    ]);

    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines()] });
    await store.editTask(PROJECT, ada, { task: 1, metrics: [lines("test.coverage.total")] });
    await store.scoring.drain();
    expect(runs(open).map((r) => [r.trigger, r.status])).toEqual([
      ["open", "done"],
      ["rescore", "running"],
      ["rescore", "queued"],
    ]);

    // The follow-up starts once the run ahead of it ends.
    store.scoring.finish(at(runs(open), 1).id, done());
    await store.scoring.drain();
    expect(at(runs(open), 2).status).toBe("running");
    expect(workflow.created).toHaveLength(3);
  });

  it("still answers a push or score now for a head that's running with the run, queuing nothing", async () => {
    const { store, runs, open } = await scored();
    const sha = at(runs(open), 0).sha;
    const head = { project: PROJECT.id, task: 1, attempt: 1, sha, actor: ada };
    store.scoring.request({ ...head, trigger: "rescore" });
    await store.scoring.drain();
    const running = at(runs(open), 1);

    for (const trigger of ["push", "scoreNow"] as const) {
      expect(store.scoring.request({ ...head, trigger })).toMatchObject({
        queued: false,
        reason: "already running",
        run: { id: running.id },
      });
    }
    expect(runs(open)).toHaveLength(2);
  });

  it("refuses someone who may not manage the task before checking their metrics", async () => {
    const { store, runs, open } = await scored();
    expect(await code(store.editTask(PROJECT, bob, { task: 1, metrics: [lines("lint.errors")] }))).toBe("forbidden");
    expect(await code(store.editTask(PROJECT, ada, { task: 1, metrics: [lines("lint.errors")] }))).toBe(
      "invalidRequest",
    );
    expect(runs(open)).toHaveLength(1);
  });
});

describe("results", () => {
  it("stores a done run's result and journals scored with its gate and a summary of the config's checks", async () => {
    const { store, runs, draft, journal } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    const checks: CheckResult[] = [
      { name: "_diff", source: "platform", required: false, outcome: "passed", durationMs: 2, notes: [] },
      { name: "test", source: "project", required: true, outcome: "passed", durationMs: 9, notes: [] },
      { name: "lint", source: "project", required: false, outcome: "failed", durationMs: 1, notes: [] },
    ];
    expect(store.scoring.finish(at(runs(ref), 0).id, done({ config: { kind: "valid" }, checks }))).toBeTruthy();

    const run = at(runs(ref), 0);
    expect(run).toMatchObject({ status: "done", superseded: false, error: null });
    expect(run.result).toEqual(result({ config: { kind: "valid" }, checks }));
    expect(store.getAttempt(PROJECT, ada, ref).scoring).toEqual({ status: "done", sha: run.sha });
    expect(journal().find((e) => e.kind === "scored")).toMatchObject({ gate: "passed", summary: "1 passed, 1 failed" });
  });

  it("reads a result stored before runs kept logs as having none", async () => {
    const { store, runs, draft } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    const { logs: _logs, ...older } = result();
    store.scoring.finish(at(runs(ref), 0).id, { status: "done", result: older as ScoringResult });

    expect(at(runs(ref), 0).result).toEqual(result({ logs: [] }));
  });

  it("reads a result stored with builtin and preview in the current shape, without the preview", async () => {
    const { store, runs, draft } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    const legacy: LegacyResult = {
      base: null,
      config: { kind: "valid" },
      gate: "passed",
      checks: [
        { name: "test", required: true, outcome: "passed", durationMs: 9, metrics: { coverage: 80 }, notes: [] },
      ],
      builtin: { filesChanged: 2, additions: 5, deletions: 1, durationMs: 3 },
      preview: { status: "ready", url: "https://x.workers.dev" },
      logs: ["test"],
    };
    store.scoring.finish(at(runs(ref), 0).id, { status: "done", result: legacy as unknown as ScoringResult });

    const read = at(runs(ref), 0).result;
    expect(read?.checks.map((c) => [c.name, c.source, c.outcome])).toEqual([
      ["_diff", "platform", "passed"],
      ["test", "project", "passed"],
    ]);
    expect(read?.metrics).toMatchObject({
      "_diff.filesChanged": { value: 2 },
      coverage: { source: "project", type: "number", value: 80 },
    });
    expect(Object.keys(read?.metrics ?? {})).not.toContain("_preview.url");
    expect(read).not.toHaveProperty("builtin");
    expect(read).not.toHaveProperty("preview");
  });

  it("keeps an errored run's error, with no result", async () => {
    const { store, runs, draft, journal } = setup();
    const ref = await draft();
    await store.scoreNow(PROJECT, ada, ref);
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), 0).id, errored());
    expect(runs(ref)[0]).toMatchObject({ status: "errored", error: "sandbox lost", result: null });
    expect(store.getAttempt(PROJECT, ada, ref).scoring.status).toBe("errored");
    expect(journal().find((e) => e.kind === "scoringErrored")).toMatchObject({ error: "sandbox lost" });
  });

  it("marks results for older heads superseded, and keeps them for history", async () => {
    const { store, runs, commit, pushed, draft } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), 0).id, done());
    const newer = commit(ref, "newer\n");
    pushed(ref, newer);

    expect(runs(ref).map((r) => [r.status, r.superseded])).toEqual([
      ["done", true],
      ["queued", false],
    ]);
    expect(at(runs(ref), 0).result).not.toBeNull();
    expect(store.getAttempt(PROJECT, ada, ref).scoring).toEqual({ status: "queued", sha: newer });
  });

  it("supersedes a draft's result when it's pushed, though the push isn't scored", async () => {
    const { store, runs, commit, pushed, draft } = setup();
    const ref = await draft();
    await store.scoreNow(PROJECT, ada, ref);
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), 0).id, done());
    const newer = commit(ref, "draft work\n");
    expect(pushed(ref, newer)).toBeNull();
    expect(runs(ref)).toMatchObject([{ status: "done", superseded: true }]);
    expect(store.getAttempt(PROJECT, ada, ref).scoring).toEqual({ status: "none", sha: newer });
  });

  it("makes an older head current again when a force-push returns to it", async () => {
    const { store, runs, commit, pushed, draft, base } = setup();
    const ref = await draft();
    await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    store.scoring.finish(at(runs(ref), 0).id, done());
    pushed(ref, commit(ref, "b\n"));
    pushed(ref, base.hash);
    expect(runs(ref).map((r) => [r.sha, r.status, r.superseded])).toEqual([
      [base.hash, "done", false],
      [expect.any(String), "cancelled", true],
    ]);
    expect(store.getAttempt(PROJECT, ada, ref).scoring).toEqual({ status: "done", sha: base.hash });
  });

  it("exposes scoring on the attempt: none, queued, running, then done for its head", async () => {
    const { store, runs, draft, base } = setup();
    const ref = await draft();
    const status = () => store.getAttempt(PROJECT, ada, ref).scoring;
    expect(status()).toEqual({ status: "none", sha: null });
    await store.openAttempt(PROJECT, ada, ref);
    expect(status()).toEqual({ status: "queued", sha: base.hash });
    await store.scoring.drain();
    expect(status()).toEqual({ status: "running", sha: base.hash });
    store.scoring.finish(at(runs(ref), 0).id, done());
    expect(status()).toEqual({ status: "done", sha: base.hash });
    store.draftAttempt(PROJECT, ada, ref);
    expect(status()).toEqual({ status: "done", sha: base.hash });
  });

  it("adds the result columns to a scoring_runs table from before results", () => {
    const sql = testSql();
    sql.exec(`CREATE TABLE scoring_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, task INTEGER NOT NULL, attempt INTEGER NOT NULL,
      sha TEXT NOT NULL, trigger TEXT NOT NULL, user_id TEXT, agent TEXT, status TEXT NOT NULL,
      instance_id TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      torn_down INTEGER NOT NULL DEFAULT 0
    )`);
    expect(new TaskStore({ sql, repos: new FakeRepos() }).scoring).toBeDefined();
    const columns = sql.exec<{ name: string }>("PRAGMA table_info(scoring_runs)").map((c) => c.name);
    expect(columns.slice(-3)).toEqual(["result", "error", "superseded"]);
  });
});
