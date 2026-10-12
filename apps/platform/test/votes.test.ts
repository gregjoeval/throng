// Vote selection in the project's Durable Object: opening a vote on the passing attempts, casting and
// replacing ballots, who may vote, withdrawing a pushed candidate, adding one that passes later, and
// closing the vote, which selects its winner.

import { describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../src/config.ts";
import { ServiceError } from "../src/errors.ts";
import type { Gate, ScoringResult } from "../src/results.ts";
import type { ScoringOutcome, ScoringParams, ScoringWorkflow } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptInput, ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { at } from "./support/defined.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ORIGIN = "abc123-main";

function actor(id: string, alias: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias };
}

const owner = actor("owner001");
const cat = actor("cat00001");
const ada = actor("ada00001");
const bob = actor("bob00001");
const dan = actor("dan00001");
const eve = actor("eve00001");
const eveClaude = actor("eve00001", "claude");
const fay = actor("fay00001");

class FakeWorkflow implements ScoringWorkflow {
  async create(_options: { id: string; params: ScoringParams }): Promise<unknown> {
    return {};
  }
  async get(_id: string): Promise<{ terminate: () => Promise<void> }> {
    return { terminate: async () => {} };
  }
}

function result(gate: Gate): ScoringResult {
  return { base: "b".repeat(40), config: { kind: "none" }, gate, checks: [], metrics: {}, logs: [] };
}

const done = (gate: Gate = "passed"): ScoringOutcome => ({ status: "done", result: result(gate) });

/**
 * A project whose config selects by `selection` (a vote among anyone, by default), and a task by
 * cat with three open attempts: t1a1 by ada, t1a2 by bob, t1a3 by dan. `score` finishes an attempt's
 * latest run; `push` lands a new commit on its fork through the proxy.
 */
async function setup(selection = "selection: { policy: vote }\n") {
  const repos = new FakeRepos();
  void repos.create(ORIGIN, { defaultBranch: "main" });
  repos.commit(ORIGIN, { files: { "README.md": "hi\n" }, message: "init" });
  repos.writeFile(ORIGIN, "main", CONFIG_PATH, selection);
  const sql = testSql();
  let clock = Date.parse("2026-10-10T12:00:00.000Z");
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock += ms;
  };
  const store = new TaskStore({
    sql,
    repos,
    now: () => new Date((clock += 1000)),
    scoring: { workflow: new FakeWorkflow(), teardown: async () => {} },
  });
  const journal = () =>
    (
      sql.db.prepare("SELECT kind, user_id, alias, detail FROM journal ORDER BY id").all() as {
        kind: string;
        user_id: string | null;
        alias: string | null;
        detail: string;
      }[]
    ).map((e) => ({ kind: e.kind, user: e.user_id, alias: e.alias, ...(JSON.parse(e.detail) as object) }));

  const task = store.createTask(PROJECT, cat, { title: "Fix it" });
  const authors = [ada, bob, dan];
  const refs: AttemptInput[] = [];
  for (const author of authors) {
    const [created] = await store.createAttempts(PROJECT, author, { task: task.number });
    refs.push({ task: task.number, number: at([created], 0).number });
  }
  const [t1a1, t1a2, t1a3] = refs as [AttemptInput, AttemptInput, AttemptInput];
  const author = (ref: AttemptInput) => at(authors, ref.number - 1);

  const score = async (ref: AttemptInput, outcome: ScoringOutcome = done()) => {
    await store.scoring.drain();
    const run = at(store.scoring.listRuns({ task: ref.task, attempt: ref.number }), -1);
    store.scoringFinished(run.id, outcome);
  };
  let n = 0;
  const push = (ref: AttemptInput) => {
    const before = store.getAttempt(PROJECT, owner, ref).scoring.sha ?? "0".repeat(40);
    const after = repos.commit(`abc123-t${ref.task}a${ref.number}`, { files: { "README.md": `push ${++n}\n` } }).hash;
    store.recordPush(PROJECT, author(ref), { ...ref, updates: [{ ref: "refs/heads/main", before, after }] });
    return after;
  };
  /** Opens every attempt and scores it with `gates[i]`, passed by default. */
  const scoreAll = async (...gates: Gate[]) => {
    for (const [i, ref] of refs.entries()) {
      await store.openAttempt(PROJECT, author(ref), ref);
      await score(ref, done(gates[i] ?? "passed"));
    }
  };
  const head = (ref: AttemptInput) => store.getAttempt(PROJECT, owner, ref).scoring.sha;
  const vote = (as: Actor = owner) => store.getVote(PROJECT, as, { task: task.number });
  const tally = (as: Actor = owner) => vote(as).candidates.map((c) => [c.attempt, c.votes, c.withdrawn]);
  return { repos, store, journal, now, advance, task, t1a1, t1a2, t1a3, score, push, scoreAll, head, vote, tally };
}

/** The setup's task with every attempt passing and a vote among `eligible` open. */
async function openAmong(eligible: string) {
  const opened = await setup(`selection: { policy: vote, eligible: ${eligible} }\n`);
  await opened.scoreAll();
  await opened.store.openVote(PROJECT, cat, { task: 1 });
  return opened;
}

async function code(work: Promise<unknown> | (() => unknown)): Promise<string> {
  const err = await (typeof work === "function" ? Promise.resolve().then(work) : work).then(
    () => null,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return (err as ServiceError).code;
}

describe("opening a vote", () => {
  it("makes the attempts passing now its candidates, pinned to their heads", async () => {
    const { store, task, t1a1, t1a3, scoreAll, head, journal } = await setup();
    await scoreAll("passed", "failed", "passed");

    const opened = await store.openVote(PROJECT, cat, { task: task.number });
    expect(opened).toMatchObject({
      task: 1,
      state: "open",
      eligible: "anyone",
      deadline: null,
      opened_by: { user: cat.user.id, alias: null },
      closed_at: null,
      winner: null,
      my_ballot: null,
    });
    expect(opened.candidates).toEqual([
      { attempt: 1, head: head(t1a1), added_at: expect.any(String), votes: 0, withdrawn: false },
      { attempt: 3, head: head(t1a3), added_at: expect.any(String), votes: 0, withdrawn: false },
    ]);
    expect(journal().at(-1)).toMatchObject({
      kind: "voteOpened",
      user: cat.user.id,
      ref: "t1",
      candidates: ["t1a1", "t1a3"],
    });
  });

  it("takes the eligibility of the project's policy, or the task's override", async () => {
    const humans = await setup("selection: { policy: vote, eligible: humans }\n");
    await humans.scoreAll();
    expect((await humans.store.openVote(PROJECT, cat, { task: 1 })).eligible).toBe("humans");

    const overridden = await setup("selection: { policy: creator }\n");
    await overridden.store.editTask(PROJECT, cat, { task: 1, selection: { policy: "vote", eligible: "agents" } });
    await overridden.scoreAll();
    expect((await overridden.store.openVote(PROJECT, cat, { task: 1 })).eligible).toBe("agents");
  });

  it("is refused when the task's policy is its creator's selection", async () => {
    const { store, scoreAll } = await setup("");
    await scoreAll();
    expect(await code(store.openVote(PROJECT, cat, { task: 1 }))).toBe("invalidState");
  });

  it("takes an optional deadline, which must be in the future", async () => {
    const { store, scoreAll, now } = await setup();
    await scoreAll();
    const past = new Date(now().getTime() - 1000).toISOString();
    expect(await code(store.openVote(PROJECT, cat, { task: 1, deadline: past }))).toBe("invalidRequest");
    const deadline = new Date(now().getTime() + 3_600_000).toISOString();
    expect((await store.openVote(PROJECT, cat, { task: 1, deadline })).deadline).toBe(deadline);
  });

  it("is for the task's creator or the project owner", async () => {
    const { store, scoreAll } = await setup();
    await scoreAll();
    expect(await code(store.openVote(PROJECT, ada, { task: 1 }))).toBe("forbidden");
    expect((await store.openVote(PROJECT, owner, { task: 1 })).state).toBe("open");
  });

  it("needs a passing attempt, no open vote and no open merge request", async () => {
    const { store, t1a1, scoreAll } = await setup();
    await scoreAll("failed", "failed", "failed");
    expect(await code(store.openVote(PROJECT, cat, { task: 1 }))).toBe("invalidState");

    const again = await setup();
    await again.scoreAll();
    await again.store.openVote(PROJECT, cat, { task: 1 });
    expect(await code(again.store.openVote(PROJECT, cat, { task: 1 }))).toBe("invalidState");

    const selected = await setup();
    await selected.scoreAll();
    await selected.store.selectAttempt(PROJECT, cat, t1a1);
    expect(await code(selected.store.openVote(PROJECT, cat, { task: 1 }))).toBe("invalidState");
  });
});

describe("casting a vote", () => {
  it("counts one ballot per user, the latest replacing the earlier", async () => {
    const { store, t1a1, t1a2, t1a3, scoreAll, tally, vote, journal } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });

    store.castVote(PROJECT, eve, { ...t1a1 });
    store.castVote(PROJECT, fay, { ...t1a1 });
    store.castVote(PROJECT, eve, { ...t1a3 });
    store.castVote(PROJECT, bob, { ...t1a3 });
    expect(tally()).toEqual([
      [1, 1, false],
      [2, 0, false],
      [3, 2, false],
    ]);
    expect(vote(eve).my_ballot).toMatchObject({ attempt: 3, alias: null });
    expect(vote(owner).my_ballot).toBeNull();
    expect(journal().at(-1)).toMatchObject({ kind: "voteCast", user: bob.user.id, ref: "t1a3" });
    expect(t1a2.number).toBe(2);
  });

  it("counts an alias's ballot as its user's", async () => {
    const { store, t1a1, t1a2, scoreAll, tally, vote } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    store.castVote(PROJECT, eve, { ...t1a1 });
    store.castVote(PROJECT, eveClaude, { ...t1a2 });
    expect(tally()).toEqual([
      [1, 0, false],
      [2, 1, false],
      [3, 0, false],
    ]);
    expect(vote(eve).my_ballot).toMatchObject({ attempt: 2, alias: "claude" });
  });

  it("is refused for your own attempt, even under an alias", async () => {
    const { store, t1a1, scoreAll } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    expect(await code(() => store.castVote(PROJECT, ada, t1a1))).toBe("forbidden");
    expect(await code(() => store.castVote(PROJECT, actor(ada.user.id, "claude"), t1a1))).toBe("forbidden");
  });

  it.each([
    ["humans", "a user as themselves", eve],
    ["agents", "an alias", eveClaude],
    ["anyone", "a user as themselves", eve],
    ["anyone", "an alias", eveClaude],
  ] as const)("among %s, takes a ballot from %s", async (eligible, _, voter) => {
    const { store, t1a1 } = await openAmong(eligible);
    expect(store.castVote(PROJECT, voter, t1a1).candidates[0]?.votes).toBe(1);
  });

  it.each([
    ["humans", "an alias", eveClaude],
    ["agents", "a user as themselves", eve],
  ] as const)("among %s, refuses a ballot from %s", async (eligible, _, voter) => {
    const { store, t1a1 } = await openAmong(eligible);
    expect(await code(() => store.castVote(PROJECT, voter, t1a1))).toBe("forbidden");
  });

  it("is only for a candidate, while the vote is open and before its deadline", async () => {
    const { store, t1a1, t1a2, scoreAll, now, advance } = await setup();
    await scoreAll("passed", "failed", "passed");
    expect(await code(() => store.castVote(PROJECT, eve, t1a1))).toBe("invalidState");
    const deadline = new Date(now().getTime() + 60_000).toISOString();
    await store.openVote(PROJECT, cat, { task: 1, deadline });
    expect(await code(() => store.castVote(PROJECT, eve, t1a2))).toBe("invalidState");
    store.castVote(PROJECT, eve, t1a1);
    advance(60_000);
    expect(await code(() => store.castVote(PROJECT, eve, t1a1))).toBe("invalidState");
  });
});

describe("candidates", () => {
  it("are withdrawn by a push during the vote, and their ballots stop counting", async () => {
    const { store, t1a1, t1a2, scoreAll, push, tally } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    store.castVote(PROJECT, eve, t1a2);
    push(t1a2);
    expect(tally()).toEqual([
      [1, 0, false],
      [2, 0, true],
      [3, 0, false],
    ]);
    expect(await code(() => store.castVote(PROJECT, fay, t1a2))).toBe("invalidState");
    store.castVote(PROJECT, fay, t1a1);
    expect(tally()[0]).toEqual([1, 1, false]);
  });

  it("can be added by the creator once they start passing, pinned to their new head", async () => {
    const { store, t1a2, scoreAll, score, push, tally, head, journal } = await setup();
    await scoreAll("passed", "failed", "passed");
    await store.openVote(PROJECT, cat, { task: 1 });
    expect(await code(() => store.addVoteCandidate(PROJECT, cat, t1a2))).toBe("invalidState");

    push(t1a2);
    await score(t1a2);
    expect(await code(() => store.addVoteCandidate(PROJECT, ada, t1a2))).toBe("forbidden");
    const added = store.addVoteCandidate(PROJECT, cat, t1a2);
    expect(added.candidates.map((c) => c.attempt)).toEqual([1, 3, 2]);
    expect(added.candidates.at(-1)?.head).toBe(head(t1a2));
    expect(journal().at(-1)).toMatchObject({ kind: "candidateAdded", ref: "t1a2", head: head(t1a2) });
    expect(await code(() => store.addVoteCandidate(PROJECT, cat, t1a2))).toBe("invalidState");
    expect(tally()).toHaveLength(3);
  });

  it("can be added again after a push withdrew them, without the old head's ballots", async () => {
    const { store, t1a1, scoreAll, score, push, tally } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    store.castVote(PROJECT, eve, t1a1);
    push(t1a1);
    await score(t1a1);
    store.addVoteCandidate(PROJECT, cat, t1a1);
    expect(tally()[0]).toEqual([1, 0, false]);
  });
});

describe("closing a vote", () => {
  it("selects the attempt with the most votes, closing the others", async () => {
    const { store, t1a1, t1a2, t1a3, scoreAll, head, journal } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    store.castVote(PROJECT, eve, t1a2);
    store.castVote(PROJECT, fay, t1a2);
    store.castVote(PROJECT, ada, t1a3);

    expect(await code(store.closeVote(PROJECT, ada, { task: 1 }))).toBe("forbidden");
    const closed = await store.closeVote(PROJECT, cat, { task: 1 });
    expect(closed.vote).toMatchObject({ state: "closed", winner: 2, closed_by: { user: cat.user.id, alias: null } });
    expect(closed.merge_request).toMatchObject({ attempt: 2, state: "queued", approved_head: head(t1a2) });
    expect(store.getAttempt(PROJECT, owner, t1a1).state).toBe("closed");
    expect(store.getAttempt(PROJECT, owner, t1a3).state).toBe("closed");
    expect(journal().map((e) => e.kind)).toContain("voteClosed");
    expect(journal().find((e) => e.kind === "voteClosed")).toMatchObject({ ref: "t1", winner: "t1a2" });
  });

  it("leaves a tie to the creator, who names one of the tied attempts", async () => {
    const { store, t1a1, t1a2, scoreAll } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    store.castVote(PROJECT, eve, t1a1);
    store.castVote(PROJECT, fay, t1a2);
    expect(await code(store.closeVote(PROJECT, cat, { task: 1 }))).toBe("invalidRequest");
    expect(await code(store.closeVote(PROJECT, cat, { task: 1, attempt: 3 }))).toBe("invalidRequest");
    const closed = await store.closeVote(PROJECT, cat, { task: 1, attempt: 2 });
    expect(closed.vote.winner).toBe(2);
  });

  it("leaves withdrawn candidates out of the count", async () => {
    const { store, t1a1, t1a2, scoreAll, push } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    store.castVote(PROJECT, eve, t1a1);
    store.castVote(PROJECT, fay, t1a1);
    store.castVote(PROJECT, dan, t1a2);
    push(t1a1);
    expect((await store.closeVote(PROJECT, cat, { task: 1 })).vote.winner).toBe(2);
  });

  it("closes without a selection when every candidate was withdrawn", async () => {
    const { store, t1a1, t1a2, t1a3, scoreAll, push } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    for (const ref of [t1a1, t1a2, t1a3]) push(ref);
    const closed = await store.closeVote(PROJECT, cat, { task: 1 });
    expect(closed).toMatchObject({ vote: { state: "closed", winner: null }, merge_request: null });
    expect(store.getAttempt(PROJECT, owner, t1a1).state).toBe("open");
  });

  it("is needed before the creator selects directly", async () => {
    const { store, t1a1, scoreAll } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    expect(await code(store.selectAttempt(PROJECT, cat, t1a1))).toBe("invalidState");
    await store.closeVote(PROJECT, cat, { task: 1, attempt: 1 });
    expect(store.getMergeRequest(PROJECT, owner, { task: 1 }).attempt).toBe(1);
  });

  it("happens with the task when the task is closed", async () => {
    const { store, scoreAll, vote } = await setup();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    await store.closeTask(PROJECT, cat, { task: 1 });
    expect(vote()).toMatchObject({ state: "closed", winner: null });
  });
});

describe("reading a vote", () => {
  it("is the task's latest vote, and notFound before any", async () => {
    const { store, scoreAll } = await setup();
    expect(await code(() => store.getVote(PROJECT, eve, { task: 1 }))).toBe("notFound");
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    expect(store.getVote(PROJECT, eve, { task: 1 }).state).toBe("open");
  });

  it("is in the task's arena while open", async () => {
    const { store, scoreAll } = await setup();
    expect(store.taskArena(PROJECT, eve, { task: 1 }).vote).toBeNull();
    await scoreAll();
    await store.openVote(PROJECT, cat, { task: 1 });
    expect(store.taskArena(PROJECT, eve, { task: 1 }).vote?.state).toBe("open");
  });
});
