import { describe, expect, it } from "vitest";
import { deliver, projectionService } from "../src/projection.ts";
import { TaskStore } from "../src/task-store.ts";
import type { ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import type { Database } from "../src/users.ts";
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
  const listings = projectionService({ db });
  return { repos, sql, store, db, listings };
}

describe("the D1 projection of tasks and attempts", () => {
  it("shows a published task to its creator and a published attempt to its author", async () => {
    const { store, db, listings } = await setup();
    const task = store.createTask(PROJECT, ada, { title: "Fix login" });
    const [attempt] = await store.createAttempts(PROJECT, bob, { task: task.number });
    expect(attempt).toBeDefined();

    expect(await listings.tasks(ada, {})).toEqual([]);
    expect(store.projection.hasChanges()).toBeTruthy();
    await store.projection.publish(db, PROJECT.id);
    expect(store.projection.hasChanges()).toBeFalsy();

    const project = { id: PROJECT.id, handle: "throng", owner: { id: owner.user.id, handle: owner.user.handle } };
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
    await store.projection.publish(db, PROJECT.id);
    expect(store.projection.pending(PROJECT.id)).toBeNull();
    expect((await listings.attempts(ada, {})).map((a) => [a.ref, a.state])).toEqual([["t1a1", "closed"]]);
  });

  it("keeps changes pending when a delivery fails, and delivers them on the next publish", async () => {
    const { store, db, listings } = await setup();
    store.createTask(PROJECT, ada, { title: "Fix login" });
    const down: Database = {
      prepare: () => {
        throw new Error("D1 is down");
      },
    };
    await expect(store.projection.publish(down, PROJECT.id)).rejects.toThrow("D1 is down");

    expect(await store.projection.publish(db, PROJECT.id)).toBeTruthy();
    expect((await listings.tasks(ada, {})).map((t) => t.ref)).toEqual(["t1"]);
    expect(await store.projection.publish(db, PROJECT.id)).toBeFalsy();
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
});
