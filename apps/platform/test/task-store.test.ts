import { describe, expect, it, vi } from "vitest";
import { archiveRef } from "../src/archive.ts";
import { CONFIG_PATH, parseConfig } from "../src/config.ts";
import { ServiceError } from "../src/errors.ts";
import {
  attemptLimitFromConfig,
  BRANCH_PUSH_TTL_MS,
  DEFAULT_ATTEMPT_LIMIT,
  MAX_TITLE,
  migrate,
  taskFromCommit,
  TaskStore,
} from "../src/task-store.ts";
import type { AttemptState, ProjectContext, StoredAttempt } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };

function actor(id: string, agent: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, agent };
}

const owner = actor("owner001");
const ada = actor("ada00001");
const adaAgent = actor("ada00001", "claude");
const bob = actor("bob00001");

function setup() {
  const repos = new FakeRepos();
  void repos.create("abc123-main", { defaultBranch: "main" });
  const sql = testSql();
  const store = new TaskStore({ sql, repos, now: () => new Date("2026-10-10T12:00:00.000Z") });
  const journal = () =>
    sql.db.prepare("SELECT kind, user_id, agent, task, attempt, detail FROM journal ORDER BY id").all() as {
      kind: string;
      user_id: string;
      agent: string | null;
      task: number;
      attempt: number | null;
    }[];
  return { repos, sql, store, journal };
}

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<ServiceError> {
  const err = await (typeof promise === "function" ? Promise.resolve().then(promise) : promise).then(
    () => null,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

const code = async (promise: Promise<unknown> | (() => unknown)) => (await failure(promise)).code;

/** The ServiceError code `fn` fails with, or null when it succeeds. */
async function errorCode(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
}

/** A task by ada with one attempt by ada, in `state`. */
async function attemptIn(store: TaskStore, state: AttemptState): Promise<StoredAttempt> {
  const task = store.createTask(PROJECT, ada, { title: "Fix it" });
  const [a] = await store.createAttempts(PROJECT, ada, { task: task.number });
  if (a === undefined) throw new Error("no attempt");
  const ref = { task: a.task, number: a.number };
  if (state === "open" || state === "merged") await store.openAttempt(PROJECT, ada, ref);
  if (state === "merged") await store.markMerged(PROJECT, owner, { ...ref, sha: "abc" });
  if (state === "closed") await store.closeAttempt(PROJECT, ada, ref);
  if (state === "obsolete") await store.obsoleteAttempt(PROJECT, owner, ref);
  return store.getAttempt(PROJECT, ada, ref);
}

describe("attemptLimitFromConfig", () => {
  it("reads attempts.limit from a valid config, else the default", () => {
    expect(attemptLimitFromConfig(parseConfig("attempts:\n  limit: 3\n"))).toBe(3);
    expect(attemptLimitFromConfig(parseConfig(null))).toBe(DEFAULT_ATTEMPT_LIMIT);
    for (const text of ["", "attempts: {}", "checks: []"]) {
      expect(attemptLimitFromConfig(parseConfig(text)), text).toBe(DEFAULT_ATTEMPT_LIMIT);
    }
  });

  it("falls back to the default when the config is invalid, even if it sets a limit", () => {
    for (const text of [
      "attempts:\n  limit: 0",
      "attempts:\n  limit: two",
      "attempts: [",
      "x: 1\nattempts:\n  limit: 3",
    ]) {
      expect(attemptLimitFromConfig(parseConfig(text)), text).toBe(DEFAULT_ATTEMPT_LIMIT);
    }
  });
});

describe("tasks", () => {
  it("numbers tasks from 1 per project and never reuses numbers", async () => {
    const { store } = setup();
    const t1 = store.createTask(PROJECT, ada, { title: "One" });
    const t2 = store.createTask(PROJECT, bob, { title: "Two", body: "**md**", attemptLimit: 2 });
    expect(t1).toEqual({
      number: 1,
      title: "One",
      body: "",
      creator: ada.user.id,
      state: "open",
      created_at: "2026-10-10T12:00:00.000Z",
      closed_at: null,
      closed_by: null,
      attempt_limit: null,
    });
    expect(t2).toMatchObject({ number: 2, body: "**md**", attempt_limit: 2 });
    await store.obsoleteTask(PROJECT, owner, { task: 2 });
    await store.closeTask(PROJECT, ada, { task: 1 });
    expect(store.createTask(PROJECT, ada, { title: "Three" }).number).toBe(3);
  });

  it("keeps numbering in a project's own store", () => {
    expect(setup().store.createTask(PROJECT, ada, { title: "a" }).number).toBe(1);
    expect(setup().store.createTask(PROJECT, ada, { title: "b" }).number).toBe(1);
  });

  it("is not found for an unknown task", async () => {
    const { store } = setup();
    expect(await code(() => store.getTask(PROJECT, ada, { task: 1 }))).toBe("notFound");
    expect(await code(() => store.closeTask(PROJECT, owner, { task: 1 }))).toBe("notFound");
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("notFound");
  });

  it("lists tasks by number, leaving out obsolete ones unless asked", async () => {
    const { store } = setup();
    for (const title of ["a", "b", "c"]) store.createTask(PROJECT, ada, { title });
    await store.obsoleteTask(PROJECT, owner, { task: 2 });
    await store.closeTask(PROJECT, ada, { task: 3 });
    expect(store.listTasks(PROJECT, bob, {}).map((t) => t.number)).toEqual([1, 3]);
    expect(store.listTasks(PROJECT, bob, { state: "obsolete" }).map((t) => t.number)).toEqual([2]);
    expect(store.listTasks(PROJECT, bob, { state: "closed" }).map((t) => t.number)).toEqual([3]);
  });

  it("edits title, body and attempt limit, keeping what isn't given", () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a", body: "b", attemptLimit: 3 });
    expect(store.editTask(PROJECT, ada, { task: 1, title: "A" })).toMatchObject({
      title: "A",
      body: "b",
      attempt_limit: 3,
    });
    expect(store.editTask(PROJECT, owner, { task: 1, attemptLimit: null })).toMatchObject({ attempt_limit: null });
  });

  it("lets the owner or the creator edit, close and reopen, and nobody else", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(() => store.editTask(PROJECT, bob, { task: 1, title: "x" }))).toBe("forbidden");
    expect(await code(() => store.closeTask(PROJECT, bob, { task: 1 }))).toBe("forbidden");
    expect(await store.closeTask(PROJECT, adaAgent, { task: 1 })).toMatchObject({
      state: "closed",
      closed_by: ada.user.id,
    });
    expect(await code(() => store.reopenTask(PROJECT, bob, { task: 1 }))).toBe("forbidden");
    expect(store.reopenTask(PROJECT, owner, { task: 1 })).toMatchObject({
      state: "open",
      closed_at: null,
      closed_by: null,
    });
    expect(await store.closeTask(PROJECT, owner, { task: 1 })).toMatchObject({ closed_by: owner.user.id });
  });

  it("lets only the owner make a task obsolete or restore it", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(() => store.obsoleteTask(PROJECT, ada, { task: 1 }))).toBe("forbidden");
    await store.obsoleteTask(PROJECT, owner, { task: 1 });
    expect(await code(() => store.restoreTask(PROJECT, ada, { task: 1 }))).toBe("forbidden");
    expect(store.restoreTask(PROJECT, owner, { task: 1 }).state).toBe("closed");
  });

  it("allows only the spec's task transitions", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(() => store.reopenTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    expect(await code(() => store.restoreTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    await store.closeTask(PROJECT, owner, { task: 1 });
    expect(await code(() => store.closeTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    expect(await code(() => store.restoreTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    await store.obsoleteTask(PROJECT, owner, { task: 1 });
    expect(await code(() => store.obsoleteTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    expect(await code(() => store.closeTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    expect(await code(() => store.reopenTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
    expect(await code(() => store.editTask(PROJECT, owner, { task: 1, title: "x" }))).toBe("invalidState");
    store.restoreTask(PROJECT, owner, { task: 1 });
    expect(store.reopenTask(PROJECT, owner, { task: 1 }).state).toBe("open");
  });

  it("closes and obsoletes a task's active attempts with it, leaving ended ones alone", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 3 });
    await store.openAttempt(PROJECT, ada, { task: 1, number: 2 });
    await store.closeAttempt(PROJECT, ada, { task: 1, number: 3 });
    await store.closeTask(PROJECT, owner, { task: 1 });
    expect(store.listAttempts(PROJECT, ada, { task: 1 }).map((a) => a.state)).toEqual(["closed", "closed", "closed"]);

    store.createTask(PROJECT, ada, { title: "b" });
    await store.createAttempts(PROJECT, ada, { task: 2, count: 2 });
    await store.closeAttempt(PROJECT, ada, { task: 2, number: 2 });
    await store.obsoleteTask(PROJECT, owner, { task: 2 });
    expect(store.listAttempts(PROJECT, ada, { task: 2, state: "obsolete" }).map((a) => a.number)).toEqual([1]);
    expect(store.getAttempt(PROJECT, ada, { task: 2, number: 2 }).state).toBe("closed");
  });

  it("keeps a task with a merged attempt closed", async () => {
    const { store } = setup();
    await attemptIn(store, "merged");
    expect(await code(() => store.reopenTask(PROJECT, owner, { task: 1 }))).toBe("invalidState");
  });
});

describe("attempts", () => {
  it("creates a batch of draft attempts by the caller's human, each with a fork of the origin", async () => {
    const { store, repos, journal } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    const created = await store.createAttempts(PROJECT, adaAgent, { task: 1, count: 2, note: "try" });
    expect(created).toEqual(
      [1, 2].map((number) => ({
        task: 1,
        number,
        author: ada.user.id,
        state: "draft",
        fork: `t1a${number}`,
        branch: null,
        note: "try",
        created_at: "2026-10-10T12:00:00.000Z",
        closed_at: null,
        merged_sha: null,
        archived_sha: null,
        forked_from: null,
        needs_update: false,
        scoring: { status: "none", sha: null },
        merge_request: null,
        verdicts: { head: null, merge: 0, revise: 0, reject: 0 },
      })),
    );
    expect(await repos.get("abc123-t1a1")).toMatchObject({ parent: "abc123-main" });
    expect(await repos.get("abc123-t1a2")).toMatchObject({ parent: "abc123-main" });
    expect(journal().filter((e) => e.attempt !== null)).toEqual([
      expect.objectContaining({ kind: "created", user_id: ada.user.id, agent: "claude", task: 1, attempt: 1 }),
      expect.objectContaining({ kind: "created", user_id: ada.user.id, agent: "claude", task: 1, attempt: 2 }),
    ]);
  });

  it("numbers attempts from 1 per task and never reuses numbers", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    store.createTask(PROJECT, ada, { title: "b" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 2 });
    expect((await store.createAttempts(PROJECT, ada, { task: 2 }))[0]?.fork).toBe("t2a1");
    await store.closeAttempt(PROJECT, ada, { task: 1, number: 2 });
    await store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 2 });
    expect((await store.createAttempts(PROJECT, bob, { task: 1 }))[0]?.fork).toBe("t1a3");
  });

  it("only adds attempts to open tasks", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.closeTask(PROJECT, ada, { task: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("invalidState");
  });

  it("rejects a count below 1", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 0 }))).toBe("invalidRequest");
  });

  it("lists a task's attempts, leaving out obsolete ones unless asked", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 3 });
    await store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 2 });
    expect(store.listAttempts(PROJECT, bob, { task: 1 }).map((a) => a.number)).toEqual([1, 3]);
    expect(store.listAttempts(PROJECT, bob, { task: 1, state: "obsolete" }).map((a) => a.number)).toEqual([2]);
  });

  describe("transitions", () => {
    const ref = { task: 1, number: 1 };
    type Move = "open" | "draft" | "close" | "reopen" | "obsolete" | "restore" | "merge";
    const moves: Record<Move, (store: TaskStore) => unknown> = {
      open: (s) => s.openAttempt(PROJECT, ada, ref),
      draft: (s) => s.draftAttempt(PROJECT, ada, ref),
      close: (s) => s.closeAttempt(PROJECT, ada, ref),
      reopen: (s) => s.reopenAttempt(PROJECT, ada, ref),
      obsolete: (s) => s.obsoleteAttempt(PROJECT, owner, ref),
      restore: (s) => s.restoreAttempt(PROJECT, owner, ref),
      merge: (s) => s.markMerged(PROJECT, owner, { ...ref, sha: "f00" }),
    };
    // The spec's attempt transitions: every other (state, move) pair is invalid_state.
    const valid: Record<AttemptState, Partial<Record<Move, AttemptState>>> = {
      draft: { open: "open", close: "closed", obsolete: "obsolete" },
      open: { draft: "draft", close: "closed", merge: "merged", obsolete: "obsolete" },
      closed: { reopen: "draft", obsolete: "obsolete" },
      merged: {},
      obsolete: { restore: "closed" },
    };

    const pairs = (Object.entries(valid) as [AttemptState, Partial<Record<Move, AttemptState>>][]).flatMap(
      ([from, allowed]) => (Object.keys(moves) as Move[]).map((move) => ({ from, move, to: allowed[move] })),
    );
    const allowedMoves = pairs.flatMap(({ from, move, to }) => (to === undefined ? [] : [{ from, move, to }]));
    const refusedMoves = pairs.filter(({ to }) => to === undefined);

    it.each(allowedMoves)("$from --$move--> $to", async ({ from, move, to }) => {
      const { store } = setup();
      await attemptIn(store, from);
      expect(await errorCode(async () => moves[move](store))).toBeNull();
      expect(store.getAttempt(PROJECT, ada, ref).state).toBe(to);
    });

    it.each(refusedMoves)("$from refuses $move", async ({ from, move }) => {
      const { store } = setup();
      await attemptIn(store, from);
      expect(await errorCode(async () => moves[move](store))).toBe("invalidState");
      expect(store.getAttempt(PROJECT, ada, ref).state).toBe(from);
    });
  });

  it("journals every transition with the acting user and agent", async () => {
    const { store, journal } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, adaAgent, { task: 1 });
    const ref = { task: 1, number: 1 };
    await store.openAttempt(PROJECT, adaAgent, ref);
    store.draftAttempt(PROJECT, ada, ref);
    await store.closeAttempt(PROJECT, ada, ref);
    await store.obsoleteAttempt(PROJECT, owner, ref);
    store.restoreAttempt(PROJECT, owner, ref);
    await store.reopenAttempt(PROJECT, ada, ref);
    await store.openAttempt(PROJECT, ada, ref);
    await store.markMerged(PROJECT, owner, { ...ref, sha: "f00" });
    expect(journal().map((e) => [e.kind, e.user_id, e.agent, e.attempt])).toEqual([
      ["created", ada.user.id, null, null],
      ["created", ada.user.id, "claude", 1],
      ["opened", ada.user.id, "claude", 1],
      ["returnedToDraft", ada.user.id, null, 1],
      ["closed", ada.user.id, null, 1],
      ["madeObsolete", owner.user.id, null, 1],
      ["restored", owner.user.id, null, 1],
      ["reopened", ada.user.id, null, 1],
      ["opened", ada.user.id, null, 1],
      ["merged", owner.user.id, null, 1],
      ["closed", owner.user.id, null, null],
    ]);
  });

  it("lets only the author, or their agents, change an attempt", async () => {
    const { store } = setup();
    await attemptIn(store, "draft");
    const ref = { task: 1, number: 1 };
    // Not even the project owner or the task's creator.
    store.createTask(PROJECT, bob, { title: "b" });
    for (const who of [bob, owner]) {
      expect(await code(() => store.openAttempt(PROJECT, who, ref))).toBe("forbidden");
      expect(await code(() => store.closeAttempt(PROJECT, who, ref))).toBe("forbidden");
      expect(await code(() => store.editAttempt(PROJECT, who, { ...ref, note: "x" }))).toBe("forbidden");
    }
    expect(store.editAttempt(PROJECT, adaAgent, { ...ref, note: "mine" }).note).toBe("mine");
    expect((await store.openAttempt(PROJECT, adaAgent, ref)).state).toBe("open");
    expect(await code(() => store.draftAttempt(PROJECT, bob, ref))).toBe("forbidden");
    await store.closeAttempt(PROJECT, ada, ref);
    expect(await code(store.reopenAttempt(PROJECT, bob, ref))).toBe("forbidden");
  });

  it("lets only the owner make an attempt obsolete or restore it", async () => {
    const { store } = setup();
    await attemptIn(store, "draft");
    const ref = { task: 1, number: 1 };
    expect(await code(() => store.obsoleteAttempt(PROJECT, ada, ref))).toBe("forbidden");
    await store.obsoleteAttempt(PROJECT, owner, ref);
    expect(await code(() => store.restoreAttempt(PROJECT, ada, ref))).toBe("forbidden");
    expect(await code(() => store.editAttempt(PROJECT, ada, { ...ref, note: "x" }))).toBe("invalidState");
  });

  it("reopens an attempt only on an open task", async () => {
    const { store } = setup();
    await attemptIn(store, "closed");
    await store.closeTask(PROJECT, ada, { task: 1 });
    expect(await code(store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 }))).toBe("invalidState");
  });

  it("merging records the sha and closes the task, leaving siblings to the selection", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 2 });
    await store.createAttempts(PROJECT, bob, { task: 1 });
    await store.openAttempt(PROJECT, ada, { task: 1, number: 1 });
    await store.openAttempt(PROJECT, bob, { task: 1, number: 3 });
    const merged = await store.markMerged(PROJECT, bob, { task: 1, number: 3, sha: "f00d" });
    expect(merged).toMatchObject({ state: "merged", merged_sha: "f00d", closed_at: "2026-10-10T12:00:00.000Z" });
    expect(store.listAttempts(PROJECT, ada, { task: 1 }).map((a) => a.state)).toEqual(["open", "draft", "merged"]);
    expect(store.getTask(PROJECT, ada, { task: 1 })).toMatchObject({ state: "closed", closed_by: bob.user.id });
  });
});

describe("attempt cap", () => {
  it(`defaults to ${DEFAULT_ATTEMPT_LIMIT} active attempts per task, failing the whole batch`, async () => {
    const { store, repos } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 9 });
    const forks = (await repos.list("abc123-t")).length;
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 2 }))).toBe("attemptLimit");
    expect(await repos.list("abc123-t")).toHaveLength(forks);
    expect(store.listAttempts(PROJECT, ada, { task: 1 })).toHaveLength(9);
    await store.createAttempts(PROJECT, ada, { task: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("attemptLimit");
  });

  it("counts only active attempts", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a", attemptLimit: 2 });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 2 });
    await store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
    await store.createAttempts(PROJECT, ada, { task: 1 });
    expect(await code(store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 }))).toBe("attemptLimit");
    await store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 2 });
    expect((await store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 })).state).toBe("draft");
  });

  it("takes attempts.limit from .throng/config.yml on origin main", async () => {
    const { store, repos } = setup();
    repos.writeFile("abc123-main", "main", CONFIG_PATH, "attempts:\n  limit: 2\n");
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 3 }))).toBe("attemptLimit");
    expect(await store.createAttempts(PROJECT, ada, { task: 1, count: 2 })).toHaveLength(2);
  });

  it("lets the task's attempt_limit override the project's", async () => {
    const { store, repos } = setup();
    repos.writeFile("abc123-main", "main", CONFIG_PATH, "attempts:\n  limit: 2\n");
    store.createTask(PROJECT, ada, { title: "a", attemptLimit: 12 });
    expect(await store.createAttempts(PROJECT, ada, { task: 1, count: 12 })).toHaveLength(12);
    store.createTask(PROJECT, ada, { title: "b", attemptLimit: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 2, count: 2 }))).toBe("attemptLimit");
  });

  it("holds the cap across concurrent batches", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a", attemptLimit: 3 });
    const results = await Promise.allSettled([
      store.createAttempts(PROJECT, ada, { task: 1, count: 2 }),
      store.createAttempts(PROJECT, bob, { task: 1, count: 2 }),
    ]);
    expect(results.map((r) => r.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(store.listAttempts(PROJECT, ada, { task: 1 })).toHaveLength(2);
  });
});

describe("batch atomicity", () => {
  it("deletes the batch's forks and records nothing when one fork fails", async () => {
    const { store, repos, journal } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    const fork = repos.fork.bind(repos);
    repos.fork = async (source, name) => {
      if (name.endsWith("t1a2")) throw new Error("artifacts unavailable");
      return fork(source, name);
    };
    await expect(store.createAttempts(PROJECT, ada, { task: 1, count: 3 })).rejects.toThrow("artifacts unavailable");
    expect(await repos.list("abc123-t")).toEqual([]);
    expect(store.listAttempts(PROJECT, ada, { task: 1 })).toEqual([]);
    expect(journal().filter((e) => e.attempt !== null)).toEqual([]);

    // The failed batch's numbers are spent, so no number ever names two forks.
    repos.fork = fork;
    expect((await store.createAttempts(PROJECT, ada, { task: 1 }))[0]?.fork).toBe("t1a4");
  });

  it("deletes the forks when the task closes while they are made", async () => {
    const { store, repos } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    const fork = repos.fork.bind(repos);
    repos.fork = async (source, name) => {
      await fork(source, name);
      if (store.getTask(PROJECT, ada, { task: 1 }).state === "open") await store.closeTask(PROJECT, ada, { task: 1 });
    };
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 2 }))).toBe("invalidState");
    expect(await repos.list("abc123-t")).toEqual([]);
  });
});

describe("branches", () => {
  it("keeps branch names unique among active attempts", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    store.createTask(PROJECT, bob, { title: "b" });
    const [a] = await store.createAttempts(PROJECT, ada, { task: 1, branch: "fix-login" });
    expect(a?.branch).toBe("fix-login");
    expect(store.attemptForBranch(PROJECT, ada, { branch: "fix-login" })?.fork).toBe("t1a1");
    expect(await code(store.createAttempts(PROJECT, bob, { task: 2, branch: "fix-login" }))).toBe("conflict");
    await store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
    expect(store.attemptForBranch(PROJECT, ada, { branch: "fix-login" })).toBeNull();
    await store.createAttempts(PROJECT, bob, { task: 2, branch: "fix-login" });
    expect(await code(store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 }))).toBe("conflict");
  });

  it("reserves a t<n>/ branch for task t<n>", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    store.createTask(PROJECT, ada, { title: "b" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 2, branch: "t1/fix" }))).toBe("conflict");
    expect((await store.createAttempts(PROJECT, ada, { task: 1, branch: "t1/fix" }))[0]?.branch).toBe("t1/fix");
  });

  it("puts a branch on exactly one attempt", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 2, branch: "x" }))).toBe("invalidRequest");
  });
});

/** The calls that archive, restore or remove forks, in order. */
const archiveCalls = (repos: FakeRepos) =>
  repos.calls.filter((c) => c.method === "copyRef" || c.method === "delete" || c.method === "fork");

describe("archive", () => {
  const ORIGIN = "abc123-main";
  const MAIN = "refs/heads/main";
  const t1a1 = { task: 1, number: 1 };

  /** A task with one draft attempt whose fork has moved on from origin `main`. */
  async function withWork() {
    const s = setup();
    s.repos.setRef(ORIGIN, MAIN, "base");
    s.store.createTask(PROJECT, ada, { title: "a" });
    await s.store.createAttempts(PROJECT, ada, { task: 1 });
    s.repos.setRef("abc123-t1a1", MAIN, "work");
    s.repos.calls.length = 0;
    return s;
  }

  it("on close pushes the head to the origin, records archived_sha, then deletes the fork", async () => {
    const { store, repos } = await withWork();
    // What the store has recorded at the moment the fork goes.
    let recordedAtDelete: string | null | undefined;
    const del = repos.delete.bind(repos);
    repos.delete = async (name) => {
      recordedAtDelete = store.getAttempt(PROJECT, ada, t1a1).archived_sha;
      return del(name);
    };

    const closed = await store.closeAttempt(PROJECT, ada, t1a1);
    expect(closed).toMatchObject({ state: "closed", archived_sha: "work" });
    expect(archiveCalls(repos)).toEqual([
      {
        method: "copyRef",
        args: [{ from: "abc123-t1a1", fromRef: MAIN, to: ORIGIN, toRef: archiveRef("t1a1") }],
      },
      { method: "delete", args: ["abc123-t1a1"] },
    ]);
    expect(recordedAtDelete).toBe("work");
    expect(repos.ref(ORIGIN, "refs/attempts/t1a1")).toBe("work");
    expect(await repos.list("abc123-t")).toEqual([]);
  });

  it("keeps the fork, and still closes, when the archive push fails", async () => {
    const { store, repos } = await withWork();
    repos.copyRef = async () => {
      throw new Error("receive-pack refused");
    };
    const closed = await store.closeAttempt(PROJECT, ada, t1a1);
    expect(closed).toMatchObject({ state: "closed", archived_sha: null });
    expect(await repos.list("abc123-t")).toEqual(["abc123-t1a1"]);
    expect(repos.calls.some((c) => c.method === "delete")).toBeFalsy();
  });

  it("archives every active attempt when the task closes, is made obsolete, or merges", async () => {
    const { store, repos } = await withWork();
    await store.createAttempts(PROJECT, ada, { task: 1, count: 2 });
    await store.closeTask(PROJECT, ada, { task: 1 });
    expect(store.listAttempts(PROJECT, ada, { task: 1 }).map((a) => a.archived_sha)).toEqual(["work", "base", "base"]);
    expect(await repos.list("abc123-t")).toEqual([]);

    store.createTask(PROJECT, ada, { title: "b" });
    await store.createAttempts(PROJECT, ada, { task: 2 });
    await store.obsoleteTask(PROJECT, owner, { task: 2 });
    expect(store.getAttempt(PROJECT, ada, { task: 2, number: 1 }).archived_sha).toBe("base");

    store.createTask(PROJECT, ada, { title: "c" });
    await store.createAttempts(PROJECT, ada, { task: 3, count: 2 });
    await store.openAttempt(PROJECT, ada, { task: 3, number: 1 });
    await store.markMerged(PROJECT, owner, { task: 3, number: 1, sha: "landed" });
    // The selection closes the merged attempt's siblings; merging archives only the merged one.
    expect(store.listAttempts(PROJECT, ada, { task: 3 }).map((a) => [a.state, a.archived_sha])).toEqual([
      ["merged", "base"],
      ["draft", null],
    ]);
    expect(await repos.list("abc123-t")).toEqual(["abc123-t3a2"]);
  });

  it("archives nothing when a closed attempt is made obsolete", async () => {
    const { store, repos } = await withWork();
    await store.closeAttempt(PROJECT, ada, t1a1);
    repos.calls.length = 0;
    await store.obsoleteAttempt(PROJECT, owner, t1a1);
    expect(archiveCalls(repos)).toEqual([]);
  });

  it("on reopen forks the origin again and restores main from the archive", async () => {
    const { store, repos } = await withWork();
    await store.closeAttempt(PROJECT, ada, t1a1);
    repos.setRef(ORIGIN, MAIN, "advanced");
    repos.calls.length = 0;

    const reopened = await store.reopenAttempt(PROJECT, ada, t1a1);
    expect(reopened).toMatchObject({ state: "draft", closed_at: null, archived_sha: "work" });
    expect(archiveCalls(repos)).toEqual([
      { method: "fork", args: [ORIGIN, "abc123-t1a1"] },
      {
        method: "copyRef",
        args: [{ from: ORIGIN, fromRef: archiveRef("t1a1"), to: "abc123-t1a1", toRef: MAIN, expect: "work" }],
      },
    ]);
    expect(repos.ref("abc123-t1a1", MAIN)).toBe("work");

    // Closing again archives the newer head over the old one.
    repos.setRef("abc123-t1a1", MAIN, "more work");
    expect((await store.closeAttempt(PROJECT, ada, t1a1)).archived_sha).toBe("more work");
    expect(repos.ref(ORIGIN, archiveRef("t1a1"))).toBe("more work");
  });

  it("reuses the fork a failed archive kept", async () => {
    const { store, repos } = await withWork();
    const copyRef = repos.copyRef.bind(repos);
    repos.copyRef = async () => {
      throw new Error("receive-pack refused");
    };
    await store.closeAttempt(PROJECT, ada, t1a1);
    repos.copyRef = copyRef;
    repos.calls.length = 0;
    expect((await store.reopenAttempt(PROJECT, ada, t1a1)).state).toBe("draft");
    expect(archiveCalls(repos)).toEqual([{ method: "fork", args: [ORIGIN, "abc123-t1a1"] }]);
    expect(repos.ref("abc123-t1a1", MAIN)).toBe("work");
  });

  it("leaves the attempt closed and deletes the new fork when the restore fails", async () => {
    const { store, repos } = await withWork();
    await store.closeAttempt(PROJECT, ada, t1a1);
    repos.copyRef = async () => {
      throw new Error("upload-pack refused");
    };
    const err = await failure(store.reopenAttempt(PROJECT, ada, t1a1));
    expect(err.code).toBe("internal");
    expect(store.getAttempt(PROJECT, ada, t1a1).state).toBe("closed");
    expect(await repos.list("abc123-t")).toEqual([]);
  });

  it("deletes the new fork when the attempt changes while it is made", async () => {
    const { store, repos } = await withWork();
    await store.closeAttempt(PROJECT, ada, t1a1);
    const fork = repos.fork.bind(repos);
    repos.fork = async (source, name) => {
      await fork(source, name);
      await store.obsoleteAttempt(PROJECT, owner, t1a1);
    };
    expect(await code(store.reopenAttempt(PROJECT, ada, t1a1))).toBe("invalidState");
    expect(store.getAttempt(PROJECT, ada, t1a1).state).toBe("obsolete");
    expect(await repos.list("abc123-t")).toEqual([]);
  });

  it("holds the cap while a reopen's fork is made", async () => {
    const { store, repos } = await withWork();
    store.editTask(PROJECT, ada, { task: 1, attemptLimit: 1 });
    await store.closeAttempt(PROJECT, ada, t1a1);
    const fork = repos.fork.bind(repos);
    let racing: Promise<unknown> | undefined;
    repos.fork = async (source, name) => {
      racing ??= store.createAttempts(PROJECT, bob, { task: 1 }).catch((error: unknown) => error);
      return fork(source, name);
    };
    expect((await store.reopenAttempt(PROJECT, ada, t1a1)).state).toBe("draft");
    expect(((await racing) as ServiceError).code).toBe("attemptLimit");
  });
});

describe("forking", () => {
  const ORIGIN = "abc123-main";
  const MAIN = "refs/heads/main";

  /** A task whose attempt t1a1 has moved on from origin `main`. */
  async function withSource() {
    const s = setup();
    s.repos.setRef(ORIGIN, MAIN, "base");
    s.store.createTask(PROJECT, ada, { title: "a" });
    await s.store.createAttempts(PROJECT, ada, { task: 1 });
    s.repos.setRef("abc123-t1a1", MAIN, "work");
    return s;
  }

  it("starts a new attempt at a current attempt's head and records where it came from", async () => {
    const { store, repos } = await withSource();
    const [forked] = await store.createAttempts(PROJECT, bob, { task: 1, from: { task: 1, number: 1 } });
    expect(forked).toMatchObject({ fork: "t1a2", author: bob.user.id, state: "draft", forked_from: "t1a1" });
    expect(repos.ref("abc123-t1a2", MAIN)).toBe("work");
    // The source goes on alone: it doesn't follow its copy, and the copy doesn't follow it.
    repos.setRef("abc123-t1a1", MAIN, "more work");
    expect(repos.ref("abc123-t1a2", MAIN)).toBe("work");
    expect(store.getAttempt(PROJECT, ada, { task: 1, number: 1 }).forked_from).toBeNull();
  });

  it("starts a new attempt at an archived attempt's head", async () => {
    const { store, repos } = await withSource();
    await store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
    await store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 1 });
    const created = await store.createAttempts(PROJECT, ada, { task: 1, count: 2, from: { task: 1, number: 1 } });
    expect(created.map((a) => [a.fork, a.forked_from])).toEqual([
      ["t1a2", "t1a1"],
      ["t1a3", "t1a1"],
    ]);
    expect(repos.ref("abc123-t1a2", MAIN)).toBe("work");
    expect(repos.ref("abc123-t1a3", MAIN)).toBe("work");
  });

  it("refuses a source from another task, or one with no head left, and makes no fork", async () => {
    const { store, repos } = await withSource();
    store.createTask(PROJECT, ada, { title: "b" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 2, from: { task: 1, number: 1 } }))).toBe(
      "invalidRequest",
    );
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, from: { task: 1, number: 9 } }))).toBe("notFound");
    repos.copyRef = async () => {
      throw new Error("receive-pack refused");
    };
    // Its archive failed, so its head is nowhere a fork could be made from.
    await store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, from: { task: 1, number: 1 } }))).toBe(
      "invalidState",
    );
    expect(await repos.list("abc123-t")).toEqual(["abc123-t1a1"]);
  });

  it("deletes the new forks and records nothing when the copy fails", async () => {
    const { store, repos } = await withSource();
    repos.copyRef = async () => {
      throw new Error("upload-pack refused");
    };
    await expect(store.createAttempts(PROJECT, ada, { task: 1, from: { task: 1, number: 1 } })).rejects.toThrow(
      "upload-pack refused",
    );
    expect(store.listAttempts(PROJECT, ada, { task: 1 }).map((a) => a.fork)).toEqual(["t1a1"]);
    expect(await repos.list("abc123-t")).toEqual(["abc123-t1a1"]);
  });
});

describe("migrate", () => {
  it("adds the actor columns to a journal from before tasks", () => {
    const sql = testSql();
    sql.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, detail TEXT)");
    sql.exec("INSERT INTO journal (at, kind, detail) VALUES (1, 'duplicate', '{}')");
    migrate(sql);
    migrate(sql);
    const columns = sql.exec<{ name: string }>("PRAGMA table_info(journal)").map((c) => c.name);
    expect(columns).toEqual(["id", "at", "kind", "detail", "user_id", "agent", "task", "attempt"]);
    expect(sql.exec("SELECT kind FROM journal")).toEqual([{ kind: "duplicate" }]);
  });

  it("adds forked_from to an attempts table from before forking, leaving its attempts unforked", () => {
    const sql = testSql();
    sql.exec(`CREATE TABLE tasks (number INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      creator TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT,
      attempt_limit INTEGER)`);
    sql.exec(`CREATE TABLE attempts (task INTEGER NOT NULL REFERENCES tasks (number), number INTEGER NOT NULL,
      author TEXT NOT NULL, state TEXT NOT NULL, branch TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL,
      closed_at TEXT, merged_sha TEXT, archived_sha TEXT, PRIMARY KEY (task, number))`);
    sql.exec("INSERT INTO tasks VALUES (1, 'a', '', 'ada00001', 'open', '', NULL, NULL, NULL)");
    sql.exec("INSERT INTO attempts VALUES (1, 1, 'ada00001', 'draft', NULL, '', '', NULL, NULL, NULL)");
    migrate(sql);
    migrate(sql);
    const store = new TaskStore({ sql, repos: new FakeRepos() });
    expect(store.getAttempt(PROJECT, ada, { task: 1, number: 1 }).forked_from).toBeNull();
  });

  it("moves values stored in snake_case to camelCase, and reads old JSON in camelCase", () => {
    const sql = testSql();
    const repos = new FakeRepos();
    const at = "2026-10-10T12:00:00.000Z";
    // A store opened before any value moved, so the tables exist to hold old rows.
    expect(new TaskStore({ sql, repos })).toBeDefined();
    sql.exec(
      `INSERT INTO tasks (number, title, body, creator, state, created_at) VALUES (1, 't', '', 'ada', 'open', ?)`,
      at,
    );
    sql.exec(
      `INSERT INTO tasks (number, title, body, creator, state, created_at) VALUES (2, 't', '', 'ada', 'open', ?)`,
      at,
    );
    const conflict = {
      reason: "conflict",
      at,
      details: {
        attempt: "t1a1",
        head: "a",
        main: "b",
        base: null,
        files: [{ path: "x", type: "modify_delete", blobs: {}, modes: {}, truncated: false }],
      },
    };
    const failed = {
      reason: "failed_checks",
      at,
      details: { checks: [{ name: "test", outcome: "timed_out", log: "test" }] },
    };
    for (const [task, state, dequeue] of [
      [1, "needs_review", conflict],
      [2, "pending", failed],
    ] as const) {
      sql.exec(
        `INSERT INTO merge_requests (task, attempt, state, approved_head, approved_by_user, approved_at, last_dequeue,
           created_at, created_by_user) VALUES (?, 1, ?, 'a', 'ada', ?, ?, ?, 'ada')`,
        task,
        state,
        at,
        JSON.stringify(dequeue),
        at,
      );
    }
    const result = {
      base: null,
      config: { kind: "valid" },
      gate: "failed",
      checks: [{ name: "test", required: true, outcome: "timed_out", durationMs: 1, metrics: {}, notes: [] }],
      builtin: { filesChanged: 0, additions: 0, deletions: 0, durationMs: 0 },
      preview: { status: "none" },
      logs: [],
    };
    sql.exec(
      `INSERT INTO scoring_runs (project, task, attempt, sha, trigger, status, instance_id, created_at, result)
       VALUES ('abc123', 1, 1, 'a', 'score_now', 'done', 'i', 0, ?)`,
      JSON.stringify(result),
    );
    for (const kind of [
      "returned_to_draft",
      "handed_off",
      "made_obsolete",
      "main_advanced",
      "needs_review",
      "scoring_queued",
      "fork-ready",
    ]) {
      sql.exec("INSERT INTO journal (at, kind, detail) VALUES (1, ?, '{}')", kind);
    }

    const store = new TaskStore({ sql, repos });
    // Opening again migrates nothing more.
    expect(new TaskStore({ sql, repos })).toBeDefined();

    const first = store.getMergeRequest(PROJECT, ada, { task: 1 });
    expect(first.state).toBe("needsReview");
    expect(first.last_dequeue).toMatchObject({ reason: "conflict", details: { files: [{ type: "modifyDelete" }] } });
    const second = store.getMergeRequest(PROJECT, ada, { task: 2 });
    expect(second.last_dequeue).toMatchObject({
      reason: "failedChecks",
      details: { checks: [{ name: "test", outcome: "timedOut", log: "test" }] },
    });
    const run = store.getScoringRun(PROJECT, ada, { run: 1 });
    expect(run.trigger).toBe("scoreNow");
    expect(run.result?.checks[0]?.outcome).toBe("timedOut");
    expect(sql.exec("SELECT kind FROM journal ORDER BY id")).toEqual(
      ["returnedToDraft", "handedOff", "madeObsolete", "mainAdvanced", "needsReview", "scoringQueued", "forkReady"].map(
        (kind) => ({ kind }),
      ),
    );
    // One open merge request per task still holds for the migrated state.
    expect(() =>
      sql.exec(
        `INSERT INTO merge_requests (task, attempt, state, approved_head, approved_by_user, approved_at, created_at,
           created_by_user) VALUES (1, 2, 'pending', 'a', 'ada', ?, ?, 'ada')`,
        at,
        at,
      ),
    ).toThrow(/UNIQUE/u);
  });

  it("drops the spike's push inbox tables", () => {
    const sql = testSql();
    sql.exec("CREATE TABLE deliveries (repo TEXT, sha TEXT, at INTEGER, PRIMARY KEY (repo, sha))");
    sql.exec(
      "CREATE TABLE checks (instance_id TEXT PRIMARY KEY, attempt TEXT, sha TEXT, status TEXT, created_at INTEGER)",
    );
    sql.exec("CREATE TABLE pending (attempt TEXT PRIMARY KEY, sha TEXT, at INTEGER)");
    migrate(sql);
    const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).not.toContain("deliveries");
    expect(tables).not.toContain("checks");
    expect(tables).not.toContain("pending");
    expect(tables).toContain("tasks");
  });
});

/** A store whose clock a test can move, over a FakeRepos that has the origin. */
function clocked() {
  let clock = Date.parse("2026-10-10T12:00:00.000Z");
  const repos = new FakeRepos();
  void repos.create("abc123-main", { defaultBranch: "main" });
  const sql = testSql();
  const store = new TaskStore({ sql, repos, now: () => new Date(clock) });
  const forks = () => repos.calls.filter((c) => c.method === "fork").map((c) => c.args[1]);
  const exists = async (name: string) => (await repos.list(name)).includes(name);
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, repos, sql, forks, exists, advance };
}

describe("push-to-create", () => {
  it("titles a task from the head commit's subject and bodies it from the rest", () => {
    expect(taskFromCommit("Add search\n\nIndex titles.\nAnd bodies.\n", "b")).toEqual({
      title: "Add search",
      body: "Index titles.\nAnd bodies.",
    });
    expect(taskFromCommit("Wrapped\nsubject line\n\nBody", "b")).toEqual({
      title: "Wrapped subject line",
      body: "Body",
    });
    expect(taskFromCommit("\n", "my-branch")).toEqual({ title: "my-branch", body: "" });
    expect(taskFromCommit("x".repeat(300), "b").title).toHaveLength(MAX_TITLE);
  });

  it("routes a new branch to a new task's first attempt, forked before the task exists", async () => {
    const { store, forks, exists } = clocked();
    const route = await store.routeBranchPush(PROJECT, ada, { branch: "search" });
    expect(route).toEqual({ kind: "create", task: 1, number: 1, newTask: true });
    expect(forks()).toEqual(["abc123-t1a1"]);
    expect(await code(() => store.getTask(PROJECT, ada, { task: 1 }))).toBe("notFound");

    // A second push of the branch while the first is in flight is refused, by anyone.
    expect((await failure(store.routeBranchPush(PROJECT, ada, { branch: "search" }))).message).toMatch(
      /another push of branch search is creating its attempt/u,
    );
    // Only the pusher may complete or abandon it.
    await store.abandonBranchPush(PROJECT, bob, { task: 1, number: 1 });
    expect(await exists("abc123-t1a1")).toBeTruthy();
    expect(await code(store.completeBranchPush(PROJECT, bob, { task: 1, number: 1, head: "x", updates: [] }))).toBe(
      "invalidState",
    );

    await store.abandonBranchPush(PROJECT, ada, { task: 1, number: 1 });
    expect(await exists("abc123-t1a1")).toBeFalsy();
    // Numbers are never reused: the next push takes t2.
    expect(await store.routeBranchPush(PROJECT, ada, { branch: "search" })).toMatchObject({ task: 2, number: 1 });
  });

  it("refuses to complete a new task when the fork's head isn't the pushed commit", async () => {
    const { store } = clocked();
    await store.routeBranchPush(PROJECT, ada, { branch: "search" });
    // FakeRepos has no history, so the head can't be read back.
    expect(await code(store.completeBranchPush(PROJECT, ada, { task: 1, number: 1, head: "abc", updates: [] }))).toBe(
      "conflict",
    );
  });

  it("joins a t<n>/ branch to its task, counting the push toward the cap until it completes", async () => {
    const { store } = clocked();
    const task = store.createTask(PROJECT, ada, { title: "Fix it", attemptLimit: 2 });
    await store.createAttempts(PROJECT, ada, { task: task.number });

    const route = await store.routeBranchPush(PROJECT, bob, { branch: "t1/bob" });
    expect(route).toEqual({ kind: "create", task: 1, number: 2, newTask: false });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("attemptLimit");

    const done = await store.completeBranchPush(PROJECT, bob, {
      task: 1,
      number: 2,
      head: "b".repeat(40),
      updates: [{ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) }],
    });
    expect(done.attempt).toMatchObject({ author: bob.user.id, state: "open", branch: "t1/bob", fork: "t1a2" });
    expect(done.task.title).toBe("Fix it");
    expect(await store.routeBranchPush(PROJECT, bob, { branch: "t1/bob" })).toEqual({
      kind: "attempt",
      attempt: done.attempt,
    });
    expect((await failure(store.routeBranchPush(PROJECT, ada, { branch: "t1/bob" }))).message).toMatch(
      /branch t1\/bob belongs to t1a2, another user's attempt on t1/u,
    );
  });

  it("refuses to complete a join when the task closed while the push was forwarded", async () => {
    const { store, exists } = clocked();
    store.createTask(PROJECT, ada, { title: "Fix it" });
    await store.routeBranchPush(PROJECT, bob, { branch: "t1/bob" });
    store.closeTask(PROJECT, ada, { task: 1 });
    expect(await code(store.completeBranchPush(PROJECT, bob, { task: 1, number: 1, head: "b", updates: [] }))).toBe(
      "invalidState",
    );
    await store.abandonBranchPush(PROJECT, bob, { task: 1, number: 1 });
    expect(await exists("abc123-t1a1")).toBeFalsy();
    expect(store.listAttempts(PROJECT, bob, { task: 1 })).toEqual([]);
  });

  it("frees the branch when the fork can't be made", async () => {
    const { store, repos, sql } = clocked();
    const fork = vi.spyOn(repos, "fork").mockRejectedValueOnce(new Error("FORK_IN_PROGRESS"));
    await expect(store.routeBranchPush(PROJECT, ada, { branch: "search" })).rejects.toThrow("FORK_IN_PROGRESS");
    fork.mockRestore();
    expect(sql.exec("SELECT * FROM branch_pushes")).toEqual([]);
    expect(await store.routeBranchPush(PROJECT, ada, { branch: "search" })).toMatchObject({ kind: "create" });
  });

  it("sweeps a push that died part way, deleting its fork", async () => {
    const { store, exists, advance } = clocked();
    await store.routeBranchPush(PROJECT, ada, { branch: "search" });
    advance(BRANCH_PUSH_TTL_MS + 1);
    expect(await store.routeBranchPush(PROJECT, bob, { branch: "search" })).toMatchObject({ task: 2 });
    expect(await exists("abc123-t1a1")).toBeFalsy();
    expect(await exists("abc123-t2a1")).toBeTruthy();
  });

  it("keeps a closed attempt from reopening onto a branch a push is creating", async () => {
    const { store } = clocked();
    store.createTask(PROJECT, ada, { title: "Fix it" });
    await store.routeBranchPush(PROJECT, ada, { branch: "t1/x" });
    await store.completeBranchPush(PROJECT, ada, { task: 1, number: 1, head: "b", updates: [] });
    store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
    await store.routeBranchPush(PROJECT, ada, { branch: "t1/x" });
    expect(await code(store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 }))).toBe("conflict");
  });

  it("has no open merge requests until merge requests exist (#139)", () => {
    const { store } = clocked();
    store.createTask(PROJECT, ada, { title: "Fix it" });
    expect(store.hasOpenMergeRequest(PROJECT, ada, { task: 1 })).toBeFalsy();
  });
});
