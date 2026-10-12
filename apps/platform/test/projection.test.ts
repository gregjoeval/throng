import { describe, expect, it } from "vitest";
import { MAX_LISTING_PAGE, myListings } from "../src/my-listings.ts";
import { deliver, MAX_PROJECTION_RETRY_MS, PROJECTION_BATCH, PROJECTION_RETRY_MS } from "../src/projection.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptState, ProjectContext, TaskState } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import type { BatchDatabase, Database, Statement } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { defined } from "./support/defined.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };

function actor(id: string): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias: null };
}

const owner = actor("owner001");
const ada = actor("ada00001");
const bob = actor("bob00001");

async function seed(db: Database): Promise<void> {
  for (const user of [owner, ada, bob]) {
    await db
      .prepare("INSERT INTO users (id, handle, email) VALUES (?, ?, ?)")
      .bind(user.user.id, user.user.handle, user.user.email)
      .all();
  }
  await db
    .prepare("INSERT INTO projects (id, owner_id, handle) VALUES (?, ?, ?)")
    .bind(PROJECT.id, owner.user.id, "throng")
    .all();
}

async function setup() {
  const repos = new FakeRepos();
  await repos.create("abc123-main", { defaultBranch: "main" });
  const sql = testSql();
  const store = new TaskStore({ sql, repos, now: () => new Date("2026-10-10T12:00:00.000Z") });
  const db = testDatabase();
  await seed(db);
  const listings = firstPages(myListings({ db }));
  return { repos, sql, store, db, listings };
}

/** Each listing's first page, as one long enough for every test but the paging one. */
function firstPages(listings: ReturnType<typeof myListings>) {
  const page = { offset: 0, limit: MAX_LISTING_PAGE };
  return {
    pages: listings,
    tasks: async (caller: Actor, input: { state?: TaskState } = {}) =>
      (await listings.tasks(caller, { ...page, ...input })).tasks,
    attempts: async (caller: Actor, input: { state?: AttemptState } = {}) =>
      (await listings.attempts(caller, { ...page, ...input })).attempts,
  };
}

const down: BatchDatabase = {
  prepare: () => {
    throw new Error("D1 is down");
  },
  batch: async () => {
    throw new Error("D1 is down");
  },
};

describe("the D1 projection of tasks and attempts", () => {
  it("shows a published task to its creator and a published attempt to its author", async () => {
    const { store, db, listings } = await setup();
    const task = store.createTask(PROJECT, ada, { title: "Fix login" });
    const [attempt] = await store.createAttempts(PROJECT, bob, { task: task.number });
    expect(attempt).toBeDefined();

    expect(await listings.tasks(ada, {})).toEqual([]);
    expect(store.projection.hasChanges()).toBeTruthy();
    expect(await store.projection.publish(db, PROJECT.id)).toBeNull();
    expect(store.projection.hasChanges()).toBeFalsy();

    const project = {
      id: PROJECT.id,
      handle: "throng",
      owner: { id: owner.user.id, handle: owner.user.handle },
      createdAt: expect.any(String),
    };
    expect(await listings.tasks(ada, {})).toEqual([
      {
        project,
        ref: "t1",
        number: 1,
        title: "Fix login",
        state: "open",
        creator: { id: ada.user.id, handle: ada.user.handle },
        createdAt: "2026-10-10T12:00:00.000Z",
        closedAt: null,
      },
    ]);
    expect(await listings.attempts(bob, {})).toEqual([
      {
        project,
        ref: "t1a1",
        task: { ref: "t1", number: 1, title: "Fix login" },
        number: 1,
        state: "draft",
        author: { id: bob.user.id, handle: bob.user.handle },
        createdAt: "2026-10-10T12:00:00.000Z",
        closedAt: null,
      },
    ]);
    expect(await listings.tasks(bob, {})).toEqual([]);
    expect(await listings.attempts(ada, {})).toEqual([]);
  });

  it("catches up after out-of-order and duplicate deliveries", async () => {
    const { store, db, listings } = await setup();
    const task = store.createTask(PROJECT, ada, { title: "Fix login" });
    const [attempt] = await store.createAttempts(PROJECT, ada, { task: task.number });
    const ref = { task: task.number, number: defined(attempt).number };
    const created = defined(store.projection.pending(PROJECT.id));
    await store.openAttempt(PROJECT, ada, ref);
    const opened = defined(store.projection.pending(PROJECT.id));
    await store.closeTask(PROJECT, ada, { task: task.number });
    const closed = defined(store.projection.pending(PROJECT.id));

    // The newest delivery lands first; older ones arrive late, one of them twice.
    await deliver(db, closed);
    await deliver(db, created);
    await deliver(db, opened);
    await deliver(db, created);
    store.projection.acknowledge(created);

    expect((await listings.tasks(ada, {})).map((t) => [t.ref, t.state, t.closedAt])).toEqual([
      ["t1", "closed", "2026-10-10T12:00:00.000Z"],
    ]);
    expect((await listings.attempts(ada, {})).map((a) => [a.ref, a.state])).toEqual([["t1a1", "closed"]]);

    // The late acknowledgement of the first batch still leaves the later changes pending.
    expect(await store.projection.publish(db, PROJECT.id)).toBeNull();
    expect(store.projection.pending(PROJECT.id)).toBeNull();
    expect((await listings.attempts(ada, {})).map((a) => [a.ref, a.state])).toEqual([["t1a1", "closed"]]);
  });

  it("keeps changes pending when a delivery fails, backing off until one lands", async () => {
    const { store, db, listings } = await setup();
    store.createTask(PROJECT, ada, { title: "Fix login" });

    expect(await store.projection.publish(down, PROJECT.id)).toBe(PROJECTION_RETRY_MS);
    expect(await store.projection.publish(down, PROJECT.id)).toBe(2 * PROJECTION_RETRY_MS);
    for (let i = 0; i < 10; i++) await store.projection.publish(down, PROJECT.id);
    expect(await store.projection.publish(down, PROJECT.id)).toBe(MAX_PROJECTION_RETRY_MS);
    expect(store.projection.hasChanges()).toBeTruthy();

    expect(await store.projection.publish(db, PROJECT.id)).toBeNull();
    expect((await listings.tasks(ada, {})).map((t) => t.ref)).toEqual(["t1"]);
    // A success resets the back-off.
    store.createTask(PROJECT, ada, { title: "Second" });
    expect(await store.projection.publish(down, PROJECT.id)).toBe(PROJECTION_RETRY_MS);
  });

  it("delivers a large backlog in batches, each task before its attempts", async () => {
    const { store, db, listings } = await setup();
    const tasks = PROJECTION_BATCH;
    for (let i = 0; i < tasks; i++) {
      const task = store.createTask(PROJECT, ada, { title: `Task ${i + 1}` });
      await store.createAttempts(PROJECT, ada, { task: task.number });
    }

    expect(await store.projection.publish(db, PROJECT.id)).toBe(0);
    // Every attempt listed so far has its task: the listing joins them.
    const halfway = await listings.attempts(ada, {});
    expect(halfway.length).toBeGreaterThan(0);
    expect(halfway.length).toBeLessThan(tasks);
    expect(await store.projection.publish(db, PROJECT.id)).toBeNull();

    expect(await listings.tasks(ada, {})).toHaveLength(tasks);
    expect(await listings.attempts(ada, {})).toHaveLength(tasks);
  });

  it("leaves obsolete tasks and attempts out unless asked for", async () => {
    const { store, db, listings } = await setup();
    const kept = store.createTask(PROJECT, ada, { title: "Kept" });
    const dropped = store.createTask(PROJECT, ada, { title: "Dropped" });
    await store.createAttempts(PROJECT, ada, { task: kept.number });
    await store.createAttempts(PROJECT, ada, { task: dropped.number });
    await store.obsoleteTask(PROJECT, owner, { task: dropped.number });
    await store.projection.publish(db, PROJECT.id);

    expect((await listings.tasks(ada, {})).map((t) => t.ref)).toEqual(["t1"]);
    expect((await listings.tasks(ada, { state: "obsolete" })).map((t) => t.ref)).toEqual(["t2"]);
    expect((await listings.attempts(ada, {})).map((a) => a.ref)).toEqual(["t1a1"]);
    expect((await listings.attempts(ada, { state: "obsolete" })).map((a) => a.ref)).toEqual(["t2a1"]);
  });

  it("delivers each batch to D1 in one round trip", async () => {
    const { store, db, listings } = await setup();
    for (let i = 0; i < PROJECTION_BATCH / 2; i++) {
      const task = store.createTask(PROJECT, ada, { title: `Task ${i + 1}` });
      await store.createAttempts(PROJECT, ada, { task: task.number });
    }
    let roundTrips = 0;
    const unwrapped = new WeakMap<Statement, Statement>();
    const counted = (statement: Statement): Statement => {
      const wrapper: Statement = {
        bind: (...values) => counted(statement.bind(...values)),
        first: async () => {
          roundTrips++;
          return statement.first();
        },
        all: async () => {
          roundTrips++;
          return statement.all();
        },
      };
      unwrapped.set(wrapper, statement);
      return wrapper;
    };
    const countingDb: BatchDatabase = {
      prepare: (sql) => counted(db.prepare(sql)),
      batch: async (statements) => {
        roundTrips++;
        return db.batch(statements.map((s) => unwrapped.get(s) ?? s));
      },
    };

    expect(await store.projection.publish(countingDb, PROJECT.id)).toBeNull();

    expect(roundTrips).toBe(1);
    expect(await listings.attempts(ada)).toHaveLength(PROJECTION_BATCH / 2);
  });

  it("lets a store whose storage was reset replace the rows its earlier self published", async () => {
    const { repos, store, db, listings } = await setup();
    const old = store.createTask(PROJECT, ada, { title: "Old" });
    await store.createAttempts(PROJECT, ada, { task: old.number });
    await store.closeTask(PROJECT, ada, { task: old.number });
    expect(await store.projection.publish(db, PROJECT.id)).toBeNull();

    const reset = new TaskStore({ sql: testSql(), repos, now: () => new Date("2026-10-11T12:00:00.000Z") });
    reset.createTask(PROJECT, ada, { title: "New" });
    expect(await reset.projection.publish(db, PROJECT.id)).toBeNull();

    expect((await listings.tasks(ada)).map((t) => [t.ref, t.title, t.state])).toEqual([["t1", "New", "open"]]);
  });

  it("lands nothing for a project deleted from D1, keeping its changes pending", async () => {
    const { store, db, listings } = await setup();
    const task = store.createTask(PROJECT, ada, { title: "Fix login" });
    await store.createAttempts(PROJECT, ada, { task: task.number });
    await db.prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT.id).all();

    expect(await store.projection.publish(db, PROJECT.id)).toBe(PROJECTION_RETRY_MS);

    expect(store.projection.hasChanges()).toBeTruthy();
    expect(await db.prepare("SELECT * FROM projected_tasks").all()).toEqual({ results: [] });
    expect(await db.prepare("SELECT * FROM projected_attempts").all()).toEqual({ results: [] });
    expect(await listings.tasks(ada)).toEqual([]);
  });

  it("backfills the tasks and attempts a store had before the projection existed", async () => {
    const { repos, sql, store, db, listings } = await setup();
    const task = store.createTask(PROJECT, ada, { title: "Fix login" });
    await store.createAttempts(PROJECT, ada, { task: task.number });
    for (const trigger of ["task_inserted", "task_updated", "attempt_inserted", "attempt_updated"]) {
      sql.exec(`DROP TRIGGER projection_${trigger}`);
    }
    sql.exec("DROP TABLE projection_outbox");

    const restarted = new TaskStore({ sql, repos });
    await restarted.projection.publish(db, PROJECT.id);

    expect((await listings.tasks(ada, {})).map((t) => t.ref)).toEqual(["t1"]);
    expect((await listings.attempts(ada, {})).map((a) => a.ref)).toEqual(["t1a1"]);
  });

  it("lists across more projects than D1 binds parameters, a page at a time", async () => {
    const { db, listings } = await setup();
    const projects = 120;
    for (let i = 0; i < projects; i++) {
      const id = `p${String(i).padStart(5, "0")}`;
      await db
        .prepare("INSERT INTO projects (id, owner_id, handle) VALUES (?, ?, ?)")
        .bind(id, owner.user.id, `project-${i}`)
        .all();
      const repos = new FakeRepos();
      await repos.create(`${id}-main`, { defaultBranch: "main" });
      const store = new TaskStore({
        sql: testSql(),
        repos,
        now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, i)),
      });
      const task = store.createTask({ id, owner: owner.user.id }, ada, { title: `Task ${i}` });
      await store.createAttempts({ id, owner: owner.user.id }, ada, { task: task.number });
      expect(await store.projection.publish(db, id)).toBeNull();
    }

    const first = await listings.pages.tasks(ada, { offset: 0, limit: 100 });
    expect(first.tasks).toHaveLength(100);
    expect(first.tasks[0]?.project.handle).toBe("project-119");
    expect(first.next).toBe(100);
    const rest = await listings.pages.tasks(ada, { offset: 100, limit: 100 });
    expect(rest.tasks.map((t) => t.project.handle)).toEqual(Array.from({ length: 20 }, (_, i) => `project-${19 - i}`));
    expect(rest.next).toBeNull();

    const attempts = await listings.pages.attempts(ada, { offset: 110, limit: 100 });
    expect(attempts.attempts.map((a) => [a.project.handle, a.ref])).toEqual(
      Array.from({ length: 10 }, (_, i) => [`project-${9 - i}`, "t1a1"]),
    );
    expect(attempts.next).toBeNull();
  });
});
