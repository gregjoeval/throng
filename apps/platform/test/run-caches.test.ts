// A run's caches against fake containers and a fake cache index: which container saves each cache,
// what a restore or save asks for and notes, that a key is reserved before its object is written and
// let go when the save fails, and which setup each note lands on.

import { describe, expect, it } from "vitest";
import type { CacheRestore, CacheSave, RunCache } from "../src/caches.ts";
import { cacheSavers, RunCaches, withCacheNotes } from "../src/run-caches.ts";
import type { CacheStart } from "../src/run-caches.ts";

/** Masks the one secret these tests hold. */
const mask = (text: string) => text.replaceAll("sekrit", "***");

const START = { access: { grants: [], registries: [], allow: [] }, size: "lite" } satisfies CacheStart;

const keyed = (name: string, fields: Partial<Extract<RunCache, { kind: "keyed" }>> = {}): RunCache => ({
  name,
  path: [`~/.${name}`],
  key: ["lock"],
  kind: "keyed",
  keyHash: `${name}-hash`,
  restore: null,
  save: "main",
  ...fields,
});

const PLAN = {
  setup: [{ caches: ["pnpm"] }],
  checks: [
    { name: "lint", caches: ["eslint", "pnpm"] },
    { name: "test", caches: ["eslint", "vitest"] },
  ],
  steps: [{ name: "deploy", caches: ["wrangler", "vitest"] }],
};

function fakes(
  caches: RunCache[],
  { saves = {}, entries = [] }: { saves?: Record<string, CacheSave>; entries?: string[] } = {},
) {
  const calls: string[] = [];
  const runCaches = new RunCaches({
    containers: {
      getByName: (sandbox) => ({
        restoreCache: async (key): Promise<CacheRestore> => {
          calls.push(`restore ${sandbox} ${key}`);
          return { kind: "restored", bytes: 1_000_000, ms: 1000 };
        },
        saveCache: async (key): Promise<CacheSave> => {
          calls.push(`save ${sandbox} ${key}`);
          return saves[key.split("/")[3] ?? ""] ?? { kind: "saved", bytes: 2_000_000, ms: 2000 };
        },
      }),
    },
    index: {
      pipelineCacheSaving: async (run, entry) => {
        calls.push(`reserve ${run} ${entry.scope}/${entry.name}`);
        return !entries.includes(entry.name);
      },
      pipelineCacheSaved: async (run, entry) => {
        calls.push(`saved ${run} ${entry.scope}/${entry.name} ${entry.size}`);
        return true;
      },
      pipelineCacheUnsaved: async (run, entry) => void calls.push(`unsaved ${run} ${entry.scope}/${entry.name}`),
    },
    project: "abc123",
    run: 7,
    caches,
    inSnapshot: ["pnpm"],
    savers: cacheSavers("i", PLAN),
  });
  return { runCaches, calls };
}

describe("cacheSavers", () => {
  it("saves each cache from one container: the setups', else the first check's, else the first step's", () => {
    expect(cacheSavers("i", PLAN)).toEqual(
      new Map([
        ["pnpm", "i/setup"],
        ["eslint", "i/check:lint"],
        ["vitest", "i/check:test"],
        ["wrangler", "i/step:deploy"],
      ]),
    );
  });
});

describe("RunCaches", () => {
  it("restores only a container's own caches when it came from the snapshot, and the setups' too when not", async () => {
    const { runCaches, calls } = fakes([keyed("pnpm", { restore: "main" }), keyed("eslint", { restore: "main" })]);
    const restored = await runCaches.prepare("i/check:lint", ["eslint", "pnpm"], START, true);
    expect(restored.map((note) => note.text)).toEqual([
      "cache pnpm: in the setups' snapshot",
      "cache eslint: hit, main's entry restored (1.0 MB) in 1.0 s",
    ]);
    expect(calls).toEqual(["restore i/check:lint caches/abc123/main/eslint/eslint-hash.tar.zst"]);
    calls.length = 0;
    await runCaches.prepare("i/check:lint", ["eslint"], START, false);
    expect(calls).toHaveLength(2);
  });

  it("saves only the caches the container saves, reserving each key before writing its object", async () => {
    const { runCaches, calls } = fakes([keyed("pnpm"), keyed("eslint"), keyed("vitest")]);
    const notes = await runCaches.save("i/check:lint", ["eslint", "pnpm"]);
    expect(calls).toEqual([
      "reserve 7 main/eslint",
      "save i/check:lint caches/abc123/main/eslint/eslint-hash.tar.zst",
      "saved 7 main/eslint 2000000",
    ]);
    expect(notes).toEqual([{ cache: "eslint", text: "cache eslint: saved for main (2.0 MB) in 2.0 s" }]);
  });

  it("writes nothing for a key another run holds, and lets go of one whose save failed", async () => {
    const { runCaches, calls } = fakes([keyed("eslint"), keyed("vitest")], {
      entries: ["eslint"],
      saves: { vitest: { kind: "failed", error: "exit 1" } },
    });
    expect(await runCaches.save("i/check:lint", ["eslint"])).toEqual([
      {
        cache: "eslint",
        text: "cache eslint: not saved: main already has an entry for its key, or another run is saving one",
      },
    ]);
    expect(await runCaches.save("i/check:test", ["vitest"])).toEqual([
      { cache: "vitest", text: "cache vitest: not saved: exit 1" },
    ]);
    expect(calls.filter((call) => !call.startsWith("reserve"))).toEqual([
      "save i/check:test caches/abc123/main/vitest/vitest-hash.tar.zst",
      "unsaved 7 main/vitest",
    ]);
  });

  it("notes nothing for a cache the run never saves, and why for one it may not", async () => {
    const { runCaches, calls } = fakes([
      keyed("eslint", { save: null }),
      keyed("vitest", { save: null, unsaved: "this run isn't trusted" }),
    ]);
    expect(await runCaches.save("i/check:test", ["eslint", "vitest"])).toEqual([
      { cache: "vitest", text: "cache vitest: not saved: this run isn't trusted" },
    ]);
    expect(calls).toEqual([]);
  });
});

describe("withCacheNotes", () => {
  it("puts each note on the first setup using its cache by name, never by its text, masking it", () => {
    const setups = [{ caches: ["a"] }, { caches: ["a", "a: b"] }];
    const runs = [
      { exit: 0, durationMs: 1 },
      { exit: 0, durationMs: 1 },
    ];
    const notes = [
      { cache: "a: b", text: "cache a: b: miss" },
      { cache: "a", text: "cache a: miss: its key couldn't be read (sekrit)" },
    ];
    expect(withCacheNotes(setups, runs, notes, mask)).toEqual([
      { exit: 0, durationMs: 1, notes: ["cache a: miss: its key couldn't be read (***)"] },
      { exit: 0, durationMs: 1, notes: ["cache a: b: miss"] },
    ]);
  });
});
