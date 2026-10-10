import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import {
  attemptLimitFromConfig,
  CONFIG_PATH,
  DEFAULT_ATTEMPT_LIMIT,
  migrate,
  parseAttemptRef,
  parseTaskRef,
  reservedTask,
  TaskStore,
  type AttemptState,
  type ProjectContext,
  type StoredAttempt,
} from "../src/task-store.ts";
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
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

const code = async (promise: Promise<unknown> | (() => unknown)) => (await failure(promise)).code;

/** A task by ada with one attempt by ada, in `state`. */
async function attemptIn(store: TaskStore, state: AttemptState): Promise<StoredAttempt> {
  const task = store.createTask(PROJECT, ada, { title: "Fix it" });
  const [a] = await store.createAttempts(PROJECT, ada, { task: task.number });
  if (a === undefined) throw new Error("no attempt");
  const ref = { task: a.task, number: a.number };
  if (state === "open" || state === "merged") store.openAttempt(PROJECT, ada, ref);
  if (state === "merged") store.markMerged(PROJECT, owner, { ...ref, sha: "abc" });
  if (state === "closed") store.closeAttempt(PROJECT, ada, ref);
  if (state === "obsolete") store.obsoleteAttempt(PROJECT, owner, ref);
  return store.getAttempt(PROJECT, ada, ref);
}

describe("references", () => {
  it("parses t42, 42 and t42a3", () => {
    expect(parseTaskRef("t42")).toBe(42);
    expect(parseTaskRef("42")).toBe(42);
    expect(parseAttemptRef("t42a3")).toEqual({ task: 42, number: 3 });
    for (const bad of ["t0", "0", "t", "t042", "t42a3", "x42", "-1", "t1.5", ""])
      expect(parseTaskRef(bad), bad).toBeNull();
    for (const bad of ["t42", "t42a0", "t0a1", "t42a", "t42b3", "t42a3x"]) expect(parseAttemptRef(bad), bad).toBeNull();
    expect(parseTaskRef("9".repeat(20))).toBeNull();
  });

  it("reserves t<n>/ branches for task t<n>", () => {
    expect(reservedTask("t42/fix-login")).toBe(42);
    expect(reservedTask("t42/")).toBe(42);
    for (const branch of ["t42", "fix/t42", "t0/x", "T42/x", "main"]) expect(reservedTask(branch), branch).toBeNull();
  });
});

describe("attemptLimitFromConfig", () => {
  it("reads attempts.limit and ignores anything else", () => {
    expect(attemptLimitFromConfig("attempts:\n  limit: 3\n")).toBe(3);
    for (const text of [
      "",
      "attempts: {}",
      "attempts:\n  limit: 0",
      "attempts:\n  limit: two",
      "attempts: [",
      "x: 1",
    ]) {
      expect(attemptLimitFromConfig(text), text).toBeNull();
    }
  });
});

describe("tasks", () => {
  it("numbers tasks from 1 per project and never reuses numbers", async () => {
    const { store } = setup();
    const t1 = store.createTask(PROJECT, ada, { title: "One" });
    const t2 = store.createTask(PROJECT, bob, { title: "Two", body: "**md**", attempt_limit: 2 });
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
    store.obsoleteTask(PROJECT, owner, { task: 2 });
    store.closeTask(PROJECT, ada, { task: 1 });
    expect(store.createTask(PROJECT, ada, { title: "Three" }).number).toBe(3);
  });

  it("keeps numbering in a project's own store", () => {
    expect(setup().store.createTask(PROJECT, ada, { title: "a" }).number).toBe(1);
    expect(setup().store.createTask(PROJECT, ada, { title: "b" }).number).toBe(1);
  });

  it("is not found for an unknown task", async () => {
    const { store } = setup();
    expect(await code(() => store.getTask(PROJECT, ada, { task: 1 }))).toBe("not_found");
    expect(await code(() => store.closeTask(PROJECT, owner, { task: 1 }))).toBe("not_found");
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("not_found");
  });

  it("lists tasks by number, leaving out obsolete ones unless asked", () => {
    const { store } = setup();
    for (const title of ["a", "b", "c"]) store.createTask(PROJECT, ada, { title });
    store.obsoleteTask(PROJECT, owner, { task: 2 });
    store.closeTask(PROJECT, ada, { task: 3 });
    expect(store.listTasks(PROJECT, bob, {}).map((t) => t.number)).toEqual([1, 3]);
    expect(store.listTasks(PROJECT, bob, { state: "obsolete" }).map((t) => t.number)).toEqual([2]);
    expect(store.listTasks(PROJECT, bob, { state: "closed" }).map((t) => t.number)).toEqual([3]);
  });

  it("edits title, body and attempt limit, keeping what isn't given", () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a", body: "b", attempt_limit: 3 });
    expect(store.editTask(PROJECT, ada, { task: 1, title: "A" })).toMatchObject({
      title: "A",
      body: "b",
      attempt_limit: 3,
    });
    expect(store.editTask(PROJECT, owner, { task: 1, attempt_limit: null })).toMatchObject({ attempt_limit: null });
  });

  it("lets the owner or the creator edit, close and reopen, and nobody else", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(() => store.editTask(PROJECT, bob, { task: 1, title: "x" }))).toBe("forbidden");
    expect(await code(() => store.closeTask(PROJECT, bob, { task: 1 }))).toBe("forbidden");
    expect(store.closeTask(PROJECT, adaAgent, { task: 1 })).toMatchObject({ state: "closed", closed_by: ada.user.id });
    expect(await code(() => store.reopenTask(PROJECT, bob, { task: 1 }))).toBe("forbidden");
    expect(store.reopenTask(PROJECT, owner, { task: 1 })).toMatchObject({
      state: "open",
      closed_at: null,
      closed_by: null,
    });
    expect(store.closeTask(PROJECT, owner, { task: 1 })).toMatchObject({ closed_by: owner.user.id });
  });

  it("lets only the owner make a task obsolete or restore it", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(() => store.obsoleteTask(PROJECT, ada, { task: 1 }))).toBe("forbidden");
    store.obsoleteTask(PROJECT, owner, { task: 1 });
    expect(await code(() => store.restoreTask(PROJECT, ada, { task: 1 }))).toBe("forbidden");
    expect(store.restoreTask(PROJECT, owner, { task: 1 }).state).toBe("closed");
  });

  it("allows only the spec's task transitions", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(() => store.reopenTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    expect(await code(() => store.restoreTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    store.closeTask(PROJECT, owner, { task: 1 });
    expect(await code(() => store.closeTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    expect(await code(() => store.restoreTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    store.obsoleteTask(PROJECT, owner, { task: 1 });
    expect(await code(() => store.obsoleteTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    expect(await code(() => store.closeTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    expect(await code(() => store.reopenTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
    expect(await code(() => store.editTask(PROJECT, owner, { task: 1, title: "x" }))).toBe("invalid_state");
    store.restoreTask(PROJECT, owner, { task: 1 });
    expect(store.reopenTask(PROJECT, owner, { task: 1 }).state).toBe("open");
  });

  it("closes and obsoletes a task's active attempts with it, leaving ended ones alone", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 3 });
    store.openAttempt(PROJECT, ada, { task: 1, number: 2 });
    store.closeAttempt(PROJECT, ada, { task: 1, number: 3 });
    store.closeTask(PROJECT, owner, { task: 1 });
    expect(store.listAttempts(PROJECT, ada, { task: 1 }).map((a) => a.state)).toEqual(["closed", "closed", "closed"]);

    store.createTask(PROJECT, ada, { title: "b" });
    await store.createAttempts(PROJECT, ada, { task: 2, count: 2 });
    store.closeAttempt(PROJECT, ada, { task: 2, number: 2 });
    store.obsoleteTask(PROJECT, owner, { task: 2 });
    expect(store.listAttempts(PROJECT, ada, { task: 2, state: "obsolete" }).map((a) => a.number)).toEqual([1]);
    expect(store.getAttempt(PROJECT, ada, { task: 2, number: 2 }).state).toBe("closed");
  });

  it("keeps a task with a merged attempt closed", async () => {
    const { store } = setup();
    await attemptIn(store, "merged");
    expect(await code(() => store.reopenTask(PROJECT, owner, { task: 1 }))).toBe("invalid_state");
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
    store.closeAttempt(PROJECT, ada, { task: 1, number: 2 });
    store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 2 });
    expect((await store.createAttempts(PROJECT, bob, { task: 1 }))[0]?.fork).toBe("t1a3");
  });

  it("only adds attempts to open tasks", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    store.closeTask(PROJECT, ada, { task: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("invalid_state");
  });

  it("rejects a count below 1", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 0 }))).toBe("invalid_request");
  });

  it("lists a task's attempts, leaving out obsolete ones unless asked", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 3 });
    store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 2 });
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

    for (const [from, allowed] of Object.entries(valid) as [AttemptState, Partial<Record<Move, AttemptState>>][]) {
      for (const move of Object.keys(moves) as Move[]) {
        const to = allowed[move];
        it(`${from} --${move}--> ${to ?? "invalid_state"}`, async () => {
          const { store } = setup();
          await attemptIn(store, from);
          if (to === undefined) {
            expect(await code(async () => moves[move](store))).toBe("invalid_state");
            expect(store.getAttempt(PROJECT, ada, ref).state).toBe(from);
          } else {
            await moves[move](store);
            expect(store.getAttempt(PROJECT, ada, ref).state).toBe(to);
          }
        });
      }
    }
  });

  it("journals every transition with the acting user and agent", async () => {
    const { store, journal } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, adaAgent, { task: 1 });
    const ref = { task: 1, number: 1 };
    store.openAttempt(PROJECT, adaAgent, ref);
    store.draftAttempt(PROJECT, ada, ref);
    store.closeAttempt(PROJECT, ada, ref);
    store.obsoleteAttempt(PROJECT, owner, ref);
    store.restoreAttempt(PROJECT, owner, ref);
    await store.reopenAttempt(PROJECT, ada, ref);
    store.openAttempt(PROJECT, ada, ref);
    store.markMerged(PROJECT, owner, { ...ref, sha: "f00" });
    expect(journal().map((e) => [e.kind, e.user_id, e.agent, e.attempt])).toEqual([
      ["created", ada.user.id, null, null],
      ["created", ada.user.id, "claude", 1],
      ["opened", ada.user.id, "claude", 1],
      ["returned_to_draft", ada.user.id, null, 1],
      ["closed", ada.user.id, null, 1],
      ["made_obsolete", owner.user.id, null, 1],
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
    expect(store.openAttempt(PROJECT, adaAgent, ref).state).toBe("open");
    expect(await code(() => store.draftAttempt(PROJECT, bob, ref))).toBe("forbidden");
    store.closeAttempt(PROJECT, ada, ref);
    expect(await code(store.reopenAttempt(PROJECT, bob, ref))).toBe("forbidden");
  });

  it("lets only the owner make an attempt obsolete or restore it", async () => {
    const { store } = setup();
    await attemptIn(store, "draft");
    const ref = { task: 1, number: 1 };
    expect(await code(() => store.obsoleteAttempt(PROJECT, ada, ref))).toBe("forbidden");
    store.obsoleteAttempt(PROJECT, owner, ref);
    expect(await code(() => store.restoreAttempt(PROJECT, ada, ref))).toBe("forbidden");
    expect(await code(() => store.editAttempt(PROJECT, ada, { ...ref, note: "x" }))).toBe("invalid_state");
  });

  it("reopens an attempt only on an open task", async () => {
    const { store } = setup();
    await attemptIn(store, "closed");
    store.closeTask(PROJECT, ada, { task: 1 });
    expect(await code(store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 }))).toBe("invalid_state");
  });

  it("merging records the sha, closes the task and its other active attempts", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 2 });
    await store.createAttempts(PROJECT, bob, { task: 1 });
    store.openAttempt(PROJECT, ada, { task: 1, number: 1 });
    store.openAttempt(PROJECT, bob, { task: 1, number: 3 });
    const merged = store.markMerged(PROJECT, bob, { task: 1, number: 3, sha: "f00d" });
    expect(merged).toMatchObject({ state: "merged", merged_sha: "f00d", closed_at: "2026-10-10T12:00:00.000Z" });
    expect(store.listAttempts(PROJECT, ada, { task: 1 }).map((a) => a.state)).toEqual(["closed", "closed", "merged"]);
    expect(store.getTask(PROJECT, ada, { task: 1 })).toMatchObject({ state: "closed", closed_by: bob.user.id });
  });
});

describe("attempt cap", () => {
  it(`defaults to ${DEFAULT_ATTEMPT_LIMIT} active attempts per task, failing the whole batch`, async () => {
    const { store, repos } = setup();
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 9 });
    const forks = (await repos.list("abc123-t")).length;
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 2 }))).toBe("attempt_limit");
    expect(await repos.list("abc123-t")).toHaveLength(forks);
    expect(store.listAttempts(PROJECT, ada, { task: 1 })).toHaveLength(9);
    await store.createAttempts(PROJECT, ada, { task: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1 }))).toBe("attempt_limit");
  });

  it("counts only active attempts", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a", attempt_limit: 2 });
    await store.createAttempts(PROJECT, ada, { task: 1, count: 2 });
    store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
    await store.createAttempts(PROJECT, ada, { task: 1 });
    expect(await code(store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 }))).toBe("attempt_limit");
    store.obsoleteAttempt(PROJECT, owner, { task: 1, number: 2 });
    expect((await store.reopenAttempt(PROJECT, ada, { task: 1, number: 1 })).state).toBe("draft");
  });

  it("takes attempts.limit from .throng/config.yml on origin main", async () => {
    const { store, repos } = setup();
    repos.writeFile("abc123-main", "main", CONFIG_PATH, "attempts:\n  limit: 2\n");
    store.createTask(PROJECT, ada, { title: "a" });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 3 }))).toBe("attempt_limit");
    expect(await store.createAttempts(PROJECT, ada, { task: 1, count: 2 })).toHaveLength(2);
  });

  it("lets the task's attempt_limit override the project's", async () => {
    const { store, repos } = setup();
    repos.writeFile("abc123-main", "main", CONFIG_PATH, "attempts:\n  limit: 2\n");
    store.createTask(PROJECT, ada, { title: "a", attempt_limit: 12 });
    expect(await store.createAttempts(PROJECT, ada, { task: 1, count: 12 })).toHaveLength(12);
    store.createTask(PROJECT, ada, { title: "b", attempt_limit: 1 });
    expect(await code(store.createAttempts(PROJECT, ada, { task: 2, count: 2 }))).toBe("attempt_limit");
  });

  it("holds the cap across concurrent batches", async () => {
    const { store } = setup();
    store.createTask(PROJECT, ada, { title: "a", attempt_limit: 3 });
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
      if (store.getTask(PROJECT, ada, { task: 1 }).state === "open") store.closeTask(PROJECT, ada, { task: 1 });
    };
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 2 }))).toBe("invalid_state");
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
    store.closeAttempt(PROJECT, ada, { task: 1, number: 1 });
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
    expect(await code(store.createAttempts(PROJECT, ada, { task: 1, count: 2, branch: "x" }))).toBe("invalid_request");
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
});
