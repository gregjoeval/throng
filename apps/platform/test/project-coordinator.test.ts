// The project Durable Object's alarm: when it is set, what it publishes to the D1 projection, and the
// cache entries it evicts. `cloudflare:workers` and the Artifacts binding are stubbed, and its storage is
// in-memory SQLite.

import { describe, expect, it, vi } from "vitest";
import { MAX_LISTING_PAGE, myListings } from "../src/my-listings.ts";
import type { ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import type { BatchDatabase } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { testSql } from "./support/task-backend.ts";
import { importWorkerModule } from "./support/worker-module.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

vi.mock("../src/artifacts", () => ({ reposFor: () => new FakeRepos() }));

/** The calls these tests make. */
interface Coordinator {
  tasks: (method: string, args: unknown[]) => Promise<unknown>;
  scoringFinished: (run: number, outcome: unknown) => Promise<void>;
  alarm: () => Promise<void>;
}

const { ProjectCoordinator } = await importWorkerModule<{
  ProjectCoordinator: new (ctx: unknown, env: unknown) => Coordinator;
}>("project");

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
  const deleted: string[] = [];
  const CACHES = { delete: async (keys: string[]) => void deleted.push(...keys) };
  /** A fresh instance over the same storage, as after an eviction. */
  const start = () => new ProjectCoordinator({ storage }, { DB: db, CACHES });
  const titles = async () =>
    (await myListings({ db }).tasks(ada, { offset: 0, limit: MAX_LISTING_PAGE })).tasks.map((t) => t.title);
  return { storage, start, titles, deleted };
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

const DAY = 24 * 60 * 60 * 1000;

/** Puts an entry of cache `pnpm` in the index, last used `ago` ms ago, as a run's save would. */
function cacheEntry(storage: ReturnType<typeof testStorage>, scope: string, key: string, ago: number): void {
  const at = Date.now() - ago;
  storage.sql
    .exec(
      "INSERT INTO cache_entries (scope, name, key_hash, size, created_at, last_used_at) VALUES (?, 'pnpm', ?, 1, ?, ?)",
      scope,
      key,
      at,
      at,
    )
    .toArray();
}

describe("the project Durable Object's cache eviction", () => {
  it("deletes entries unused for 7 days when its alarm runs, and sets itself for the next to fall unused", async () => {
    const { storage, start, deleted } = await setup();
    const coordinator = start();
    await coordinator.tasks("createTask", [PROJECT, ada, { title: "Fix login" }]);
    cacheEntry(storage, "t1", "old", 8 * DAY);
    cacheEntry(storage, "t1", "new", DAY);
    cacheEntry(storage, "main", "latest", 30 * DAY);

    await coordinator.alarm();
    expect(deleted).toEqual(["caches/abc123/t1/pnpm/old.tar.zst"]);
    const alarm = (await storage.getAlarm()) ?? 0;
    expect(alarm).toBeGreaterThan(Date.now() + 5 * DAY);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 6 * DAY);
  });

  it("sets its alarm for the next entry to fall unused after a call, when none is set sooner", async () => {
    const { storage, start } = await setup();
    const coordinator = start();
    await coordinator.tasks("createTask", [PROJECT, ada, { title: "Fix login" }]);
    await coordinator.alarm();
    await storage.deleteAlarm();
    cacheEntry(storage, "t1", "new", DAY);
    await coordinator.scoringFinished(999, { status: "errored", error: "gone" });
    const alarm = (await storage.getAlarm()) ?? 0;
    expect(alarm).toBeGreaterThan(Date.now() + 5 * DAY);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 6 * DAY);
  });
});
