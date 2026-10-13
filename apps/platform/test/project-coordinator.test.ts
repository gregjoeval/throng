// The project Durable Object's publishing to the D1 projection: when its alarm is set, and what the
// alarm publishes. `cloudflare:workers` and the Artifacts binding are stubbed, and its storage is
// in-memory SQLite.

import { describe, expect, it, vi } from "vitest";
import { MAX_LISTING_PAGE, myListings } from "../src/my-listings.ts";
import type { ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import type { BatchDatabase } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { testSql } from "./support/task-backend.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/artifacts", () => ({ reposFor: () => new FakeRepos() }));

/** The calls these tests make. */
interface Coordinator {
  tasks: (method: string, args: unknown[]) => Promise<unknown>;
  scoringFinished: (run: number, outcome: unknown) => Promise<void>;
  alarm: () => Promise<void>;
}

// Imported by a computed path: the module is Worker code, which this project's Node typecheck can't
// follow (`cloudflare:workers`), so it is typed here by what the test calls.
const PROJECT_MODULE = "../src/project.ts";
const { ProjectCoordinator } = (await import(PROJECT_MODULE)) as {
  ProjectCoordinator: new (ctx: unknown, env: unknown) => Coordinator;
};

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ada: Actor = { user: { id: "ada00001", handle: "ada", email: "ada@example.com", created_at: "" }, alias: null };

/** A Durable Object's storage over in-memory SQLite, kept across instances as the runtime keeps it. */
function testStorage() {
  const sql = testSql();
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    sql: { exec: (query: string, ...bindings: unknown[]) => ({ toArray: () => sql.exec(query, ...bindings) }) },
    transactionSync: <T>(fn: () => T): T => sql.transaction(fn),
    kv: { get: (key: string) => kv.get(key), put: (key: string, value: unknown) => void kv.set(key, value) },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
    deleteAlarm: async () => void (alarm = null),
  };
}

async function setup() {
  const db: BatchDatabase = testDatabase();
  await db.prepare("INSERT INTO users (id, handle, email) VALUES (?, ?, ?)").bind("owner001", "greg", "g@x").all();
  await db.prepare("INSERT INTO users (id, handle, email) VALUES (?, ?, ?)").bind(ada.user.id, "ada", "a@x").all();
  await db
    .prepare("INSERT INTO projects (id, owner_id, handle) VALUES (?, ?, ?)")
    .bind(PROJECT.id, "owner001", "throng")
    .all();
  const storage = testStorage();
  /** A fresh instance over the same storage, as after an eviction. */
  const start = () => new ProjectCoordinator({ storage }, { DB: db });
  const titles = async () =>
    (await myListings({ db }).tasks(ada, { offset: 0, limit: MAX_LISTING_PAGE })).tasks.map((t) => t.title);
  return { storage, start, titles };
}

describe("the project Durable Object's projection alarm", () => {
  it("publishes a change once its alarm runs", async () => {
    const { storage, start, titles } = await setup();
    const coordinator = start();
    await coordinator.tasks("createTask", [PROJECT, ada, { title: "Fix login" }]);

    expect(await storage.getAlarm()).not.toBeNull();
    expect(await titles()).toEqual([]);
    await coordinator.alarm();
    expect(await titles()).toEqual(["Fix login"]);
  });

  it("is set by a call that can't name its project, after an eviction lost what was pending", async () => {
    const { storage, start, titles } = await setup();
    await start().tasks("createTask", [PROJECT, ada, { title: "Fix login" }]);
    await storage.deleteAlarm();

    const restarted = start();
    await restarted.scoringFinished(999, { status: "errored", error: "gone" });

    expect(await storage.getAlarm()).not.toBeNull();
    await restarted.alarm();
    expect(await titles()).toEqual(["Fix login"]);
  });
});
