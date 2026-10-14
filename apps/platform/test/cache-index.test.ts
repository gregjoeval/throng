// The project's cache index over in-memory SQLite: which entry a lookup restores, that the first
// save of a key wins, that only one run saves a key's object, and which entries eviction deletes as
// time passes.

import { describe, expect, it } from "vitest";
import { CacheIndex } from "../src/cache-index.ts";
import { CACHE_RESERVATION_MS, CACHE_UNUSED_MS, PROJECT_CACHE_BYTES } from "../src/caches.ts";
import { testSql } from "./support/task-backend.ts";

const DAY = 24 * 60 * 60 * 1000;
/** Every run that holds a reservation still saves. */
const saving = () => true;
const GB = 1000 ** 3;

function setup() {
  let now = Date.parse("2026-10-14T00:00:00.000Z");
  const index = new CacheIndex({ sql: testSql(), now: () => new Date(now) });
  const later = (ms: number) => {
    now += ms;
  };
  const evicted = () => index.evictable().map((e) => `${e.scope}/${e.name}/${e.keyHash}`);
  return { index, later, evicted, now: () => now };
}

describe("CacheIndex", () => {
  it("restores from the first scope with an entry for the key, and marks it used", () => {
    const { index, later, now } = setup();
    index.record({ scope: "main", name: "pnpm", keyHash: "k1", size: 10 });
    index.record({ scope: "t42", name: "pnpm", keyHash: "k1", size: 10 });
    later(DAY);
    expect(index.find(["t42", "main"], "pnpm", "k1")).toBe("t42");
    expect(index.find(["main"], "pnpm", "k1")).toBe("main");
    expect(index.find(["t42", "main"], "pnpm", "k2")).toBeNull();
    expect(index.find(["t42", "main"], "npm", "k1")).toBeNull();
    expect(index.list().map((e) => [e.scope, e.lastUsedAt === now()])).toEqual([
      ["main", true],
      ["t42", true],
    ]);
  });

  it("keeps the first save of a key: entries are immutable", () => {
    const { index } = setup();
    expect(index.record({ scope: "main", name: "pnpm", keyHash: "k1", size: 10 })).toBeTruthy();
    expect(index.record({ scope: "main", name: "pnpm", keyHash: "k1", size: 99 })).toBeFalsy();
    expect(index.reserve({ scope: "main", name: "pnpm", keyHash: "k1" }, 1, () => false)).toBeFalsy();
    expect(index.list().map((e) => e.size)).toEqual([10]);
  });

  it("lets one run at a time save a key: the first to reserve it, whose save then becomes the entry", () => {
    const { index } = setup();
    const key = { scope: "main", name: "pnpm", keyHash: "k1" };
    expect(index.reserve(key, 1, saving)).toBeTruthy();
    // Another run racing it neither reserves nor records the key, so it never writes its object.
    expect(index.reserve(key, 2, saving)).toBeFalsy();
    expect(index.record({ ...key, size: 99 }, 2)).toBeFalsy();
    // The run holding it may take it again, as its retried step does.
    expect(index.reserve(key, 1, saving)).toBeTruthy();
    // A reserved key isn't an entry yet: it isn't restored or listed.
    expect(index.find(["main"], "pnpm", "k1")).toBeNull();
    expect(index.list()).toEqual([]);
    expect(index.record({ ...key, size: 10 }, 1)).toBeTruthy();
    expect(index.find(["main"], "pnpm", "k1")).toBe("main");
    expect(index.list().map((e) => e.size)).toEqual([10]);
    expect(index.reserve(key, 1, saving)).toBeFalsy();
    expect(index.record({ ...key, size: 11 }, 1)).toBeFalsy();
  });

  it("lets a key go once its save failed, its run ended, or its reservation went stale", () => {
    const { index, later, evicted, now } = setup();
    const key = { scope: "main", name: "pnpm", keyHash: "k1" };
    const running = new Set([1, 2, 3]);
    const stillSaving = (run: number) => running.has(run);
    index.reserve(key, 1, stillSaving);
    index.release(key, 2);
    expect(index.reserve(key, 2, stillSaving)).toBeFalsy();
    index.release(key, 1);
    expect(index.reserve(key, 2, stillSaving)).toBeTruthy();
    // Run 2 was cancelled by a newer head: the newer run takes the key over.
    running.delete(2);
    expect(index.reserve(key, 3, stillSaving)).toBeTruthy();
    expect(index.record({ ...key, size: 1 }, 2)).toBeFalsy();
    expect(index.nextUnused()).toBe(now() + CACHE_RESERVATION_MS);
    later(CACHE_RESERVATION_MS - 1);
    expect(evicted()).toEqual([]);
    later(1);
    // Its save never finished: the reservation goes, with any object it left.
    expect(evicted()).toEqual(["main/pnpm/k1"]);
    index.remove(index.evictable());
    expect(index.reserve(key, 4, stillSaving)).toBeTruthy();
  });

  it("deletes an entry unused for 7 days, except main's latest of each cache", () => {
    const { index, later, evicted } = setup();
    index.record({ scope: "main", name: "pnpm", keyHash: "old", size: 1 });
    index.record({ scope: "t42", name: "pnpm", keyHash: "branch", size: 1 });
    later(DAY);
    index.record({ scope: "main", name: "pnpm", keyHash: "new", size: 1 });
    index.record({ scope: "main", name: "pip", keyHash: "only", size: 1 });
    expect(evicted()).toEqual([]);
    later(CACHE_UNUSED_MS - DAY);
    expect(evicted()).toEqual(["main/pnpm/old", "t42/pnpm/branch"]);
    later(CACHE_UNUSED_MS);
    // main's latest of each cache stays, however long it goes unused.
    expect(evicted().toSorted()).toEqual(["main/pnpm/old", "t42/pnpm/branch"]);
  });

  it("keeps an entry restored within 7 days", () => {
    const { index, later, evicted } = setup();
    index.record({ scope: "t42", name: "pnpm", keyHash: "k1", size: 1 });
    later(CACHE_UNUSED_MS - DAY);
    index.find(["t42"], "pnpm", "k1");
    later(CACHE_UNUSED_MS - DAY);
    expect(evicted()).toEqual([]);
    later(DAY);
    expect(evicted()).toEqual(["t42/pnpm/k1"]);
  });

  it("keeps the project under 10 GB, deleting task branches' entries before main's, least recently used first", () => {
    const { index, later, evicted } = setup();
    index.record({ scope: "main", name: "a", keyHash: "m1", size: 3 * GB });
    later(1000);
    index.record({ scope: "t1", name: "a", keyHash: "b1", size: 3 * GB });
    later(1000);
    index.record({ scope: "t2", name: "a", keyHash: "b2", size: 3 * GB });
    later(1000);
    index.record({ scope: "main", name: "b", keyHash: "m2", size: 2 * GB });
    expect(evicted()).toEqual(["t1/a/b1"]);
    // Used since, t1's entry is newer than t2's, which goes instead.
    later(1000);
    index.find(["t1"], "a", "b1");
    expect(evicted()).toEqual(["t2/a/b2"]);
    index.remove(index.evictable());
    index.record({ scope: "main", name: "c", keyHash: "m3", size: 3 * GB });
    // Over again: the branch entry goes first, then main's least recently used.
    expect(evicted()).toEqual(["t1/a/b1"]);
    index.record({ scope: "main", name: "d", keyHash: "m4", size: PROJECT_CACHE_BYTES - 8 * GB + 1 });
    expect(evicted()).toEqual(["t1/a/b1", "main/a/m1"]);
  });

  it("deletes every entry of a line that ended, and restores none of them meanwhile", () => {
    const { index, evicted } = setup();
    index.record({ scope: "t42", name: "pnpm", keyHash: "k1", size: 1 });
    index.record({ scope: "t43", name: "pnpm", keyHash: "k1", size: 1 });
    index.endLine("t42");
    expect(evicted()).toEqual(["t42/pnpm/k1"]);
    expect(index.find(["t42", "main"], "pnpm", "k1")).toBeNull();
    index.remove(index.evictable());
    expect(index.list().map((e) => e.scope)).toEqual(["t43"]);
  });

  it("says when the next entry falls unused, and never for main's latest", () => {
    const { index, later, now } = setup();
    expect(index.nextUnused()).toBeNull();
    index.record({ scope: "main", name: "pnpm", keyHash: "k1", size: 1 });
    expect(index.nextUnused()).toBeNull();
    const saved = now();
    later(DAY);
    index.record({ scope: "t42", name: "pnpm", keyHash: "k1", size: 1 });
    expect(index.nextUnused()).toBe(saved + DAY + CACHE_UNUSED_MS);
  });
});
