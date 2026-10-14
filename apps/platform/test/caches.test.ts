// Cache keys, scopes and notes: what keys an entry, which scopes a line reads and saves to, where an
// entry is stored, and what a step's notes say about it. Key hashing reads a head's tree through a
// fake tree reader made from a map of paths to blob ids.

import { describe, expect, it } from "vitest";
import {
  cacheKeyHashes,
  cacheObjectKey,
  MAX_KEY_TREE_READS,
  restoreNote,
  restoreScopes,
  saveNote,
  saveScope,
} from "../src/caches.ts";
import type { RunCache } from "../src/caches.ts";
import type { CacheConfig } from "../src/config.ts";
import type { TreeEntry } from "../src/repos.ts";

/** A tree reader over `files` (path → blob id), each directory's tree id being `tree:<path>`. */
function treeOf(files: Record<string, string>) {
  const reads: string[] = [];
  const readTree = async (hash: string): Promise<TreeEntry[] | null> => {
    reads.push(hash);
    if (!hash.startsWith("tree:")) return null;
    const dir = hash.slice("tree:".length);
    const prefix = dir === "" ? "" : `${dir}/`;
    const entries = new Map<string, TreeEntry>();
    for (const [path, blob] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const [name = "", ...rest] = path.slice(prefix.length).split("/");
      entries.set(
        name,
        rest.length === 0
          ? { name, mode: "100644", hash: blob, type: "blob" }
          : { name, mode: "040000", hash: `tree:${prefix}${name}`, type: "tree" },
      );
    }
    return [...entries.values()];
  };
  return { reader: { readTree }, reads, root: "tree:" };
}

const PNPM: CacheConfig = {
  name: "pnpm",
  path: ["~/.local/share/pnpm/store", "~/.cache/pnpm"],
  key: ["pnpm-lock.yaml"],
};
const IMAGE = "registry.cloudflare.com/acct/throng:abc";

async function hashOf(files: Record<string, string>, cache: CacheConfig = PNPM, image = IMAGE): Promise<string> {
  const { reader, root } = treeOf(files);
  const [key] = await cacheKeyHashes(reader, root, [cache], image);
  return key?.keyHash ?? "";
}

describe("cacheKeyHashes", () => {
  it("is the same for the same lockfile, whatever else in the tree changed", async () => {
    const before = await hashOf({ "pnpm-lock.yaml": "b1", "src/a.ts": "s1" });
    expect(await hashOf({ "pnpm-lock.yaml": "b1", "src/a.ts": "s2", "README.md": "r" })).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes with the key file's blob, the cache's name or paths, and the Sandbox image", async () => {
    const files = { "pnpm-lock.yaml": "b1" };
    const base = await hashOf(files);
    const others = [
      await hashOf({ "pnpm-lock.yaml": "b2" }),
      await hashOf(files, { ...PNPM, name: "pnpm2" }),
      await hashOf(files, { ...PNPM, path: ["~/.local/share/pnpm/store"] }),
      await hashOf(files, PNPM, `${IMAGE}2`),
    ];
    expect(new Set([base, ...others]).size).toBe(5);
  });

  it("hashes a key file that's missing as absent, apart from any file there", async () => {
    const absent = await hashOf({ "src/a.ts": "s1" });
    expect(await hashOf({ "README.md": "r" })).toBe(absent);
    expect(await hashOf({ "pnpm-lock.yaml": "b1" })).not.toBe(absent);
  });

  it("matches globs, in sorted order, across directories with * and **", async () => {
    const glob = { ...PNPM, key: ["packages/*/package.json", "**/*.lock"] };
    const files = {
      "packages/b/package.json": "pb",
      "packages/a/package.json": "pa",
      "x/y/z.lock": "l1",
      "a.lock": "l2",
    };
    const hash = await hashOf(files, glob);
    // The same files listed in another order give the same hash.
    const reordered = Object.fromEntries(Object.entries(files).toReversed());
    expect(await hashOf(reordered, glob)).toBe(hash);
    expect(await hashOf({ ...files, "x/y/z.lock": "l3" }, glob)).not.toBe(hash);
    expect(await hashOf({ ...files, "packages/a/README.md": "r" }, glob)).toBe(hash);
    expect(await hashOf({ ...files, "packages/c/package.json": "pc" }, glob)).not.toBe(hash);
  });

  it("throws when the tree can't be read, or the globs walk too many directories", async () => {
    await expect(cacheKeyHashes(treeOf({}).reader, "gone", [PNPM], IMAGE)).rejects.toThrow(/tree gone is missing/u);
    const many = Object.fromEntries(Array.from({ length: MAX_KEY_TREE_READS + 1 }, (_, i) => [`d${i}/f`, `b${i}`]));
    const { reader, root } = treeOf(many);
    await expect(cacheKeyHashes(reader, root, [{ ...PNPM, key: ["**/x"] }], IMAGE)).rejects.toThrow(/more than/u);
  });

  it("reads each tree once for every cache", async () => {
    const { reader, reads, root } = treeOf({ "pnpm-lock.yaml": "b1", "a/b.txt": "x" });
    await cacheKeyHashes(reader, root, [PNPM, { ...PNPM, name: "other", key: ["a/*"] }], IMAGE);
    expect(reads.toSorted()).toEqual(["tree:", "tree:a"]);
  });
});

describe("cache scopes", () => {
  it.each([
    ["an attempt reads main's", "t42a3", ["main"], null],
    ["a task branch reads its own then main's, and saves to its own", "t42", ["t42", "main"], "t42"],
    ["main reads and saves its own", "main", ["main"], "main"],
  ])("%s", (_, line, reads, saves) => {
    expect(restoreScopes(line)).toEqual(reads);
    expect(saveScope(line)).toBe(saves);
  });

  it("stores an entry under caches/<project>/<scope>/<name>/<keyhash>.tar.zst", () => {
    expect(cacheObjectKey("abc123", { scope: "t42", name: "pnpm", keyHash: "f00" })).toBe(
      "caches/abc123/t42/pnpm/f00.tar.zst",
    );
  });
});

/** `pnpm` as a run uses it: keyed, restored from main's entry and never saved, unless `fields` say otherwise. */
const cache = (fields: Partial<Extract<RunCache, { keyHash: string }>> = {}): RunCache => ({
  ...PNPM,
  keyHash: "f00",
  restore: "main",
  save: null,
  ...fields,
});

describe("a step's cache notes", () => {
  it("say hit with the size and time, or miss and why", () => {
    expect(restoreNote(cache(), { kind: "restored", bytes: 205_400_000, ms: 31_250 })).toBe(
      "cache pnpm: hit, main's entry restored (205.4 MB) in 31.3 s",
    );
    expect(restoreNote(cache({ restore: null }), null)).toBe("cache pnpm: miss");
    expect(restoreNote(cache(), { kind: "missing" })).toBe("cache pnpm: miss: main's entry was evicted");
    expect(restoreNote(cache(), { kind: "failed", error: "exit 2: zstd: corrupted" })).toBe(
      "cache pnpm: miss: the restore failed, so this ran without it (exit 2: zstd: corrupted)",
    );
    expect(restoreNote({ ...PNPM, error: "tree t is missing" }, null)).toBe(
      "cache pnpm: miss: its key couldn't be read (tree t is missing)",
    );
  });

  it("say saved with the size and time, or why not; nothing when the run never saves it", () => {
    const saving = cache({ restore: null, save: "t42" });
    expect(saveNote(saving, { kind: "saved", bytes: 107_000_000, ms: 12_000 })).toBe(
      "cache pnpm: saved for t42 (107.0 MB) in 12.0 s",
    );
    expect(saveNote(saving, { kind: "tooLarge" })).toBe("cache pnpm: not saved: over 2 GB");
    expect(saveNote(saving, { kind: "empty" })).toBe("cache pnpm: not saved: none of its paths exist");
    expect(saveNote(saving, { kind: "failed", error: "exit 1" })).toBe("cache pnpm: not saved: exit 1");
    expect(saveNote(cache(), null)).toBeNull();
    expect(saveNote(cache({ restore: null, unsaved: "this run isn't trusted" }), null)).toBe(
      "cache pnpm: not saved: this run isn't trusted",
    );
  });
});
