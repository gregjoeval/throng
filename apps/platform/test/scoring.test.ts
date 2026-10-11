import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import { SCORING_CAP, type ScoringParams, type ScoringRequest, type ScoringWorkflow } from "../src/scoring.ts";
import { TaskStore, type AttemptInput, type ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ORIGIN = "abc123-main";

function actor(id: string, agent: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, agent };
}

const owner = actor("owner001");
const ada = actor("ada00001");
const adaAgent = actor("ada00001", "claude");
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

  async get(id: string): Promise<{ terminate(): Promise<void> }> {
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
  const runs = (ref: AttemptInput) => store.scoring.listRuns(ref.task, ref.number);

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

  return { repos, base, store, workflow, tornDown, journal, runs, commit, pushed, drafts };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return (err as ServiceError).code;
}

function queued(request: ScoringRequest | null): ScoringRequest & { queued: true } {
  expect(request?.queued).toBe(true);
  return request as ScoringRequest & { queued: true };
}

describe("scoring triggers", () => {
  it("scores the head when an attempt is opened", async () => {
    const { store, workflow, runs, base, drafts } = setup();
    const [ref] = await drafts();
    await store.openAttempt(PROJECT, adaAgent, ref!);

    expect(runs(ref!)).toMatchObject([
      { sha: base.hash, trigger: "open", status: "queued", user_id: ada.user.id, agent: "claude" },
    ]);
    await store.scoring.drain();
    expect(runs(ref!)).toMatchObject([{ status: "running" }]);
    expect(workflow.created).toEqual([
      {
        id: `abc123-t1a1-${base.hash.slice(0, 12)}-1`,
        params: { project: "abc123", attempt: "t1a1", sha: base.hash, run: 1 },
      },
    ]);
  });

  it("scores a push while open, but not a push to a draft", async () => {
    const { runs, commit, pushed, drafts, store } = setup();
    const [ref] = await drafts();
    const draftHead = commit(ref!, "draft work\n");
    expect(pushed(ref!, draftHead)).toBeNull();
    expect(runs(ref!)).toEqual([]);

    await store.openAttempt(PROJECT, ada, ref!);
    const openHead = commit(ref!, "open work\n");
    const request = queued(pushed(ref!, openHead));
    expect(request.run).toMatchObject({ sha: openHead, trigger: "push" });
    expect(runs(ref!).map((r) => [r.sha, r.trigger, r.status])).toEqual([
      [draftHead, "open", "cancelled"],
      [openHead, "push", "queued"],
    ]);
  });

  it("ignores pushes that don't move the fork's main", async () => {
    const { store, runs, commit, drafts } = setup();
    const [ref] = await drafts();
    await store.openAttempt(PROJECT, ada, ref!);
    const before = runs(ref!).length;
    const other = commit(ref!, "elsewhere\n");
    const zero = "0".repeat(40);
    store.recordPush(PROJECT, ada, {
      ...ref!,
      updates: [
        { ref: "refs/heads/wip", before: zero, after: other },
        { ref: "refs/heads/main", before: other, after: zero },
      ],
    });
    expect(runs(ref!)).toHaveLength(before);
  });

  it("scores now on the author's request, for drafts only", async () => {
    const { store, runs, base, drafts } = setup();
    const [ref] = await drafts();
    expect(await code(store.scoreNow(PROJECT, bob, ref!))).toBe("forbidden");

    const request = queued(await store.scoreNow(PROJECT, adaAgent, ref!));
    expect(request.run).toMatchObject({ sha: base.hash, trigger: "score_now", agent: "claude" });

    await store.openAttempt(PROJECT, ada, ref!);
    expect(await code(store.scoreNow(PROJECT, ada, ref!))).toBe("invalid_state");
    expect(runs(ref!)).toHaveLength(1);
  });

  it("rescores for the author, the task creator or the project owner, on open attempts only", async () => {
    const { store, runs } = setup();
    const task = store.createTask(PROJECT, cat, { title: "Cat's task" });
    const [made] = await store.createAttempts(PROJECT, ada, { task: task.number });
    const ref = { task: made!.task, number: made!.number };
    expect(await code(store.rescore(PROJECT, ada, ref))).toBe("invalid_state");

    await store.openAttempt(PROJECT, ada, ref);
    expect(await code(store.rescore(PROJECT, bob, ref))).toBe("forbidden");
    for (const who of [ada, cat, owner]) {
      await store.scoring.drain();
      store.scoring.finish(runs(ref).at(-1)!.id, "done");
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
    const [made] = await store.createAttempts(PROJECT, ada, { task: task.number });
    const ref = { task: made!.task, number: made!.number };
    expect(await code(store.scoreNow(PROJECT, ada, ref))).toBe("invalid_state");
    expect((await store.openAttempt(PROJECT, ada, ref)).state).toBe("open");
    expect(store.scoring.listRuns(ref.task, ref.number)).toEqual([]);
  });
});

describe("the scoring queue", () => {
  it("journals every push, force-pushes back to an earlier commit included, and scores each head once", async () => {
    const { store, runs, commit, pushed, drafts, journal } = setup();
    const [ref] = await drafts();
    await store.openAttempt(PROJECT, ada, ref!);
    await store.scoring.drain();
    const a = commit(ref!, "a\n");
    const b = commit(ref!, "b\n");
    queued(pushed(ref!, a));
    expect(pushed(ref!, a)).toMatchObject({ queued: false, reason: "already queued" });
    await store.scoring.drain();
    store.scoring.finish(runs(ref!).at(-1)!.id, "done");

    queued(pushed(ref!, b));
    // Back to a, which already has a finished run: b's run is superseded and a isn't scored again.
    expect(pushed(ref!, a)).toMatchObject({ queued: false, reason: "already scored" });
    expect(
      journal()
        .filter((e) => e.kind === "pushed")
        .map((e) => e.after),
    ).toEqual([a, a, b, a]);
    expect(runs(ref!).map((r) => [r.sha, r.status])).toEqual([
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
    const waiting = refs.at(-1)!;
    expect(runs(waiting)).toMatchObject([{ status: "queued" }]);

    const first = commit(waiting, "one\n");
    const second = commit(waiting, "two\n");
    pushed(waiting, first);
    pushed(waiting, second);
    expect(runs(waiting).map((r) => r.status)).toEqual(["cancelled", "cancelled", "queued"]);
    expect(runs(waiting).at(-1)!.sha).toBe(second);
  });

  it("cancels a running run, its Workflow and its Sandboxes, when a newer head arrives", async () => {
    const { store, workflow, tornDown, runs, commit, pushed, drafts, journal } = setup();
    const [ref] = await drafts();
    await store.openAttempt(PROJECT, ada, ref!);
    await store.scoring.drain();
    const [running] = runs(ref!);

    const head = commit(ref!, "newer\n");
    pushed(ref!, head);
    await store.scoring.drain();
    expect(workflow.terminated).toEqual([running!.instance_id]);
    expect(tornDown).toEqual([running!.instance_id]);
    expect(runs(ref!).map((r) => [r.sha, r.status])).toEqual([
      [running!.sha, "cancelled"],
      [head, "running"],
    ]);
    expect(journal().find((e) => e.kind === "scoring_cancelled")).toMatchObject({ run: 1, superseded_by: head });

    // A late report from the cancelled run is discarded, and a second drain stops nothing more.
    expect(store.scoring.finish(running!.id, "done")).toBe(false);
    expect(store.scoring.getRun(running!.id)?.status).toBe("cancelled");
    await store.scoring.drain();
    expect(workflow.terminated).toHaveLength(1);
  });

  it(`runs at most ${SCORING_CAP} at once and starts the oldest waiting run as one finishes`, async () => {
    const { store, workflow, runs, drafts, journal } = setup();
    const refs = await drafts(SCORING_CAP + 2);
    for (const ref of refs) await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    expect(workflow.created.map((c) => c.params.attempt)).toEqual(["t1a1", "t1a2", "t1a3"]);
    expect(refs.map((r) => runs(r)[0]!.status)).toEqual(["running", "running", "running", "queued", "queued"]);

    expect(store.scoring.finish(runs(refs[1]!)[0]!.id, "done", { gate: "passed" })).toBe(true);
    await store.scoring.drain();
    expect(workflow.created.map((c) => c.params.attempt)).toEqual(["t1a1", "t1a2", "t1a3", "t1a4"]);
    expect(journal().find((e) => e.kind === "scored")).toMatchObject({ ref: "t1a2", status: "done", gate: "passed" });

    store.scoring.finish(runs(refs[0]!)[0]!.id, "errored");
    await store.scoring.drain();
    expect(refs.map((r) => runs(r)[0]!.status)).toEqual(["errored", "done", "running", "running", "running"]);
  });

  it("skips a head that already has a done run, unless it's a rescore", async () => {
    const { store, workflow, runs, base, drafts } = setup();
    const [ref] = await drafts();
    await store.openAttempt(PROJECT, ada, ref!);
    await store.scoring.drain();
    store.scoring.finish(runs(ref!)[0]!.id, "done");

    store.draftAttempt(PROJECT, ada, ref!);
    await store.openAttempt(PROJECT, ada, ref!);
    expect(runs(ref!)).toHaveLength(1);
    expect(await store.rescore(PROJECT, ada, ref!)).toMatchObject({ queued: true, run: { sha: base.hash } });
    await store.scoring.drain();
    expect(workflow.created.map((c) => c.id)).toEqual([
      `abc123-t1a1-${base.hash.slice(0, 12)}-1`,
      `abc123-t1a1-${base.hash.slice(0, 12)}-2`,
    ]);
  });

  it("scores an errored head again when it's requested again", async () => {
    const { store, runs, drafts } = setup();
    const [ref] = await drafts();
    await store.scoreNow(PROJECT, ada, ref!);
    await store.scoring.drain();
    store.scoring.finish(runs(ref!)[0]!.id, "errored");
    expect(await store.scoreNow(PROJECT, ada, ref!)).toMatchObject({ queued: true });
  });

  it("ends a run errored when its Workflow can't be created", async () => {
    const { store, workflow, runs, drafts, journal } = setup();
    const [ref] = await drafts();
    await store.openAttempt(PROJECT, ada, ref!);
    workflow.failNext = true;
    await store.scoring.drain();
    expect(runs(ref!)).toMatchObject([{ status: "errored" }]);
    expect(journal().find((e) => e.kind === "scoring_errored")).toMatchObject({
      error: expect.stringMatching(/unavailable/),
    });
  });

  it("doesn't let a head read before a push replace the head that push queued", async () => {
    const { store, repos, runs, base, commit, drafts } = setup();
    const [ref] = await drafts();
    const newer = commit(ref!, "pushed while opening\n");
    // Opening reads the fork's head; a push lands while that read is in flight.
    const listCommits = repos.listCommits.bind(repos);
    repos.listCommits = async (name, opts) => {
      const [head, ...rest] = await listCommits(name, opts);
      store.recordPush(PROJECT, ada, {
        ...ref!,
        updates: [{ ref: "refs/heads/main", before: base.hash, after: newer }],
      });
      return [{ ...head!, hash: base.hash }, ...rest];
    };
    // The attempt is open by the time the push is recorded, so it queues the newer head.
    await store.openAttempt(PROJECT, ada, ref!);
    expect(runs(ref!).map((r) => [r.sha, r.trigger, r.status])).toEqual([[newer, "push", "queued"]]);
  });

  it("cancels an attempt's runs when it returns to draft, closes, merges or is made obsolete", async () => {
    const { store, workflow, runs, drafts, journal } = setup();
    const refs = await drafts(4);
    for (const ref of refs) await store.openAttempt(PROJECT, ada, ref);
    await store.scoring.drain();
    expect(refs.map((r) => runs(r)[0]!.status)).toEqual(["running", "running", "running", "queued"]);

    store.draftAttempt(PROJECT, ada, refs[0]!);
    await store.closeAttempt(PROJECT, ada, refs[1]!);
    await store.obsoleteAttempt(PROJECT, owner, refs[3]!);
    await store.markMerged(PROJECT, owner, { ...refs[2]!, sha: "f00" });
    await store.scoring.drain();
    expect(refs.map((r) => runs(r)[0]!.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(workflow.terminated).toHaveLength(3);
    expect(
      journal()
        .filter((e) => e.kind === "scoring_cancelled")
        .map((e) => e.reason),
    ).toEqual(["returned to draft", "attempt closed", "attempt obsolete", "attempt merged"]);
  });

  it("keeps runs queued when no runner is configured", async () => {
    const repos = new FakeRepos();
    void repos.create(ORIGIN);
    repos.commit(ORIGIN, { files: { a: "a" } });
    const store = new TaskStore({ sql: testSql(), repos });
    const task = store.createTask(PROJECT, ada, { title: "t" });
    const [a] = await store.createAttempts(PROJECT, ada, { task: task.number });
    await store.openAttempt(PROJECT, ada, { task: a!.task, number: a!.number });
    await store.scoring.drain();
    expect(store.scoring.listRuns(a!.task, a!.number)).toMatchObject([{ status: "queued" }]);
  });
});
