// Pipeline caches: named paths a run's containers keep between runs, such as a dependency store. Each
// cache's key hash is computed from the head's git tree before the run starts (`cacheKeyHashes`), so
// a run restores an entry only on an exact match of what keys it. An entry is a `tar | zstd` of the
// cache's paths in the `CACHES` R2 bucket (`cacheObjectKey`), streamed from and into the container
// by its `RunSandbox`, and indexed in the project Durable Object (`cache-index.ts`).
//
// Which entries a line reads, and where it may save, follow from the line (see "Caches" in #257):
// an attempt reads `main`'s and never saves; a task branch reads its own then `main`'s; `main` reads
// its own. Only a trusted run saves, and only where no entry it reads matches the key, so nobody
// else's code can place a file a trusted run later restores. A cache problem is never a run's
// failure: a restore problem is a miss, and a save problem a note.

import type { CacheConfig } from "./config.ts";
import type { TreeEntry } from "./repos.ts";
import { MAIN_LINE } from "./scoring.ts";
import { quote } from "./shell.ts";
import { isAttemptRef } from "./task-refs.ts";

/** The key prefix every cache entry is stored under. */
export const CACHE_PREFIX = "caches/";
/** Entries over this many bytes, compressed, aren't saved. */
export const MAX_CACHE_ENTRY_BYTES = 2 * 1000 ** 3;
/** A project's entries are evicted, least recently used first, while together they're over this many bytes. */
export const PROJECT_CACHE_BYTES = 10 * 1000 ** 3;
/** An entry nobody restored for this long is deleted, unless it's `main`'s latest of its cache. */
export const CACHE_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
/** The most of a cache problem's message a note keeps. */
export const CACHE_ERROR_CHARS = 300;
/** How long restoring or saving one cache may take. */
export const CACHE_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
/** A key reserved for a save that hasn't finished in this long is let go: its run is gone. */
export const CACHE_RESERVATION_MS = 6 * CACHE_TRANSFER_TIMEOUT_MS;
/** The zstd level entries are compressed at: #261 found -3 the best trade of save time and size. */
export const CACHE_ZSTD_LEVEL = 3;
/** Most trees one run reads to resolve its caches' keys, so a broad glob can't walk a huge repo. */
export const MAX_KEY_TREE_READS = 500;
/** What a key entry that matches no file in the tree hashes as. */
const ABSENT = "absent";

/** An entry in the index: one save of one cache, in one scope, under one key hash. */
export interface CacheEntry {
  /** The line it was saved by, and that reads it: `main` or a task branch (`t42`). */
  scope: string;
  name: string;
  keyHash: string;
  /** Its archive's size in bytes. */
  size: number;
  createdAt: number;
  lastUsedAt: number;
}

/** A cache's key hash for one run, by the cache's name. */
export interface CacheKey {
  name: string;
  keyHash: string;
}

/**
 * What the project answers for one of a run's caches: the scope whose entry it restores (null on a
 * miss), and the scope a save goes to (null when the run doesn't save it), with `unsaved` saying why
 * when the run might have expected to.
 */
export interface CacheLookup extends CacheKey {
  restore: string | null;
  save: string | null;
  unsaved?: string;
}

/** The scopes a line restores from, in order: an attempt reads `main`'s, a task branch its own then `main`'s. */
export function restoreScopes(line: string): string[] {
  if (line === MAIN_LINE || isAttemptRef(line)) return [MAIN_LINE];
  return [line, MAIN_LINE];
}

/** The scope a trusted run on `line` saves to: its own line's, and none for an attempt, which never saves. */
export function saveScope(line: string): string | null {
  return isAttemptRef(line) ? null : line;
}

/** Where an entry is stored: `caches/<project>/<scope>/<name>/<keyHash>.tar.zst`. */
export function cacheObjectKey(project: string, entry: Pick<CacheEntry, "scope" | "name" | "keyHash">): string {
  return `${CACHE_PREFIX}${project}/${entry.scope}/${entry.name}/${entry.keyHash}.tar.zst`;
}

/** The part of `Repos` key hashing reads a head's tree through. */
export interface TreeReader {
  readTree: (hash: string) => Promise<TreeEntry[] | null>;
}

/**
 * Each cache's key hash for the tree `root`: a SHA-256 over its name, its paths, what each of its key
 * entries matches in the tree (each file's path and blob id, a glob's matches in sorted order, or
 * `absent` when nothing matches) and the Sandbox image `image`, so a new image never restores an
 * entry an older one saved. Throws when the tree can't be read, or the globs reach too many trees.
 */
export async function cacheKeyHashes(
  reader: TreeReader,
  root: string,
  caches: readonly CacheConfig[],
  image: string,
): Promise<CacheKey[]> {
  const trees = new Map<string, Promise<TreeEntry[]>>();
  const read = (hash: string): Promise<TreeEntry[]> => {
    const known = trees.get(hash);
    if (known !== undefined) return known;
    if (trees.size >= MAX_KEY_TREE_READS) {
      throw new Error(`its key globs reach more than ${MAX_KEY_TREE_READS} directories`);
    }
    const reading = reader.readTree(hash).then((entries) => {
      if (entries === null) throw new Error(`tree ${hash} is missing`);
      return entries;
    });
    trees.set(hash, reading);
    return reading;
  };
  return Promise.all(
    caches.map(async (cache) => {
      const key: [string, File[] | typeof ABSENT][] = [];
      for (const entry of cache.key) {
        const matches = await matchFiles(read, root, entry.split("/"), "");
        key.push([entry, matches.length === 0 ? ABSENT : matches.toSorted(([a], [b]) => (a < b ? -1 : 1))]);
      }
      const input = JSON.stringify({ name: cache.name, path: cache.path, key, image });
      return { name: cache.name, keyHash: await sha256Hex(input) };
    }),
  );
}

/** A file a key entry matched: its path in the tree, and its blob id. */
type File = readonly [path: string, blob: string];

/** The files under tree `hash` that the pattern `segments` matches. */
async function matchFiles(
  read: (hash: string) => Promise<TreeEntry[]>,
  hash: string,
  segments: readonly string[],
  prefix: string,
): Promise<File[]> {
  const [segment, ...rest] = segments;
  if (segment === undefined) return [];
  const entries = await read(hash);
  if (segment === "**") {
    // Zero directories, then one more and `**` again. A trailing `**` matches every file below.
    const here = await matchFiles(read, hash, rest.length === 0 ? ["*"] : rest, prefix);
    const below = await Promise.all(
      entries
        .filter((entry) => entry.type === "tree")
        .map((entry) => matchFiles(read, entry.hash, segments, `${prefix}${entry.name}/`)),
    );
    return [...here, ...below.flat()];
  }
  const matches = globSegment(segment);
  const matched = entries.filter((entry) => matches(entry.name));
  if (rest.length === 0) {
    return matched
      .filter((entry) => entry.type !== "tree" && entry.type !== "gitlink")
      .map((entry): File => [`${prefix}${entry.name}`, entry.hash]);
  }
  const below = await Promise.all(
    matched
      .filter((entry) => entry.type === "tree")
      .map((entry) => matchFiles(read, entry.hash, rest, `${prefix}${entry.name}/`)),
  );
  return below.flat();
}

/** What each glob wildcard matches within one path segment, as a regular expression. */
const GLOB_CHARS: Readonly<Record<string, string>> = { "*": ".*", "?": "." };

/** Whether a name matches one path segment of a glob: `*` is any run of characters, `?` any one. */
function globSegment(segment: string): (name: string) => boolean {
  if (!/[*?]/u.test(segment)) return (name) => name === segment;
  const source = [...segment].map((char) => GLOB_CHARS[char] ?? char.replace(/[\\^$.|+()[\]{}]/u, "\\$&")).join("");
  const pattern = new RegExp(`^${source}$`, "u");
  return (name) => pattern.test(name);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bash that sets `$home` to the home directory relative to `/`, for `fromRoot`. */
const HOME = 'home="${HOME:-/root}" && home="${home#/}"';

/** A cache path relative to `/`, as bash: `~/x` under `$home`, so tar keeps it relative and extracts it at `/`. */
function fromRoot(path: string): string {
  return path.startsWith("~/") ? `"$home"/${quote(path.slice(2))}` : quote(path.slice(1));
}

/** The exit code of a save with nothing to save: none of the cache's paths exist. */
export const NOTHING_TO_SAVE_EXIT = 3;

/**
 * Bash that writes a `tar | zstd` of the cache's paths that exist to stdout, run from `/`, for the
 * Sandbox to stream into R2. With none of them there it exits `NOTHING_TO_SAVE_EXIT`, writing nothing.
 */
export function cacheSaveScript(paths: readonly string[]): string {
  return `set -o pipefail
cd / && ${HOME}
saved=()
for path in ${paths.map(fromRoot).join(" ")}; do [ -e "$path" ] && saved+=("$path"); done
[ \${#saved[@]} -gt 0 ] || exit ${NOTHING_TO_SAVE_EXIT}
tar -cf - -- "\${saved[@]}" | zstd -q -${CACHE_ZSTD_LEVEL} -T0 -c
`;
}

/**
 * Bash that extracts an entry streamed into its stdin at `/`. A failed extract removes the cache's
 * paths again, so the run goes on as though nothing was restored rather than from half a cache.
 */
export function cacheRestoreScript(paths: readonly string[]): string {
  return `set -o pipefail
cd / && ${HOME}
zstd -q -d -T0 -c | tar -xf - && exit 0
code=$?
rm -rf -- ${paths.map(fromRoot).join(" ")}
exit "$code"
`;
}

/** How restoring one cache into a container went. */
export type CacheRestore =
  | { kind: "restored"; bytes: number; ms: number }
  /** The index had an entry, but its object is gone: evicted since the run looked it up. */
  | { kind: "missing" }
  | { kind: "failed"; error: string };

/** How saving one cache from a container went. */
export type CacheSave =
  | { kind: "saved"; bytes: number; ms: number }
  /** None of its paths exist. */
  | { kind: "empty" }
  | { kind: "tooLarge" }
  | { kind: "failed"; error: string };

/** One cache as a run uses it: what keys it, where it's restored from and saved to (see `CacheLookup`). */
export type RunCache = CacheConfig &
  (
    | ({ kind: "keyed" } & Omit<CacheLookup, "name">)
    /** Its key couldn't be computed, or looked up: the run neither restores nor saves it. */
    | { kind: "unkeyed"; error: string }
  );

/** The run's `caches` as the project answered `lookups` for them; one it didn't answer for is unkeyed. */
export function runCachesFrom(caches: readonly CacheConfig[], lookups: readonly CacheLookup[]): RunCache[] {
  return caches.map((cache): RunCache => {
    const lookup = lookups.find((found) => found.name === cache.name);
    if (lookup === undefined) return { ...cache, kind: "unkeyed", error: "the project didn't look it up" };
    const { name: _name, ...found } = lookup;
    return { ...cache, kind: "keyed", ...found };
  });
}

/** The run's `caches` when their keys couldn't be had: every one unkeyed, saying why. */
export function unkeyedCaches(caches: readonly CacheConfig[], error: unknown): RunCache[] {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, CACHE_ERROR_CHARS);
  return caches.map((cache) => ({ ...cache, kind: "unkeyed", error: message }));
}

/** The note on a step about restoring `cache`. */
export function restoreNote(cache: RunCache, restored: CacheRestore | null): string {
  if (cache.kind === "unkeyed") return `cache ${cache.name}: miss: its key couldn't be read (${cache.error})`;
  if (cache.restore === null || restored === null) return `cache ${cache.name}: miss`;
  switch (restored.kind) {
    case "restored": {
      return `cache ${cache.name}: hit, ${cache.restore}'s entry restored (${megabytes(restored.bytes)}) in ${secondsOf(restored.ms)}`;
    }
    case "missing": {
      return `cache ${cache.name}: miss: ${cache.restore}'s entry was evicted`;
    }
    case "failed": {
      return `cache ${cache.name}: miss: the restore failed, so this ran without it (${restored.error})`;
    }
  }
}

/** The note on a step about saving `cache`, or null when there's nothing to say: the run never saves it. */
export function saveNote(cache: RunCache, saved: CacheSave | null): string | null {
  if (cache.kind === "unkeyed") return null;
  if (saved === null) return cache.unsaved === undefined ? null : `cache ${cache.name}: not saved: ${cache.unsaved}`;
  switch (saved.kind) {
    case "saved": {
      return `cache ${cache.name}: saved for ${cache.save ?? ""} (${megabytes(saved.bytes)}) in ${secondsOf(saved.ms)}`;
    }
    case "empty": {
      return `cache ${cache.name}: not saved: none of its paths exist`;
    }
    case "tooLarge": {
      return `cache ${cache.name}: not saved: over ${MAX_CACHE_ENTRY_BYTES / 1000 ** 3} GB`;
    }
    case "failed": {
      return `cache ${cache.name}: not saved: ${saved.error}`;
    }
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1000 ** 2).toFixed(1)} MB`;
}

function secondsOf(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
