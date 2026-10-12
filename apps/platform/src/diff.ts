// Commit diffs computed from `Repos` reads, never a clone: walk the two trees, diff each changed
// file with jsdiff and write git-style headers ourselves. See the Browser spec's "Commit diffs" and
// docs/research/commit-diffs.md.
//
// The output matches `git diff --no-renames --full-index` except that exact renames (same blob,
// one path deleted and one added) are paired. Every cap is a flag on the file it hit, so callers
// can tell a missing patch from an empty one.

import { structuredPatch, type StructuredPatchHunk } from "diff";
import { BINARY_SNIFF_BYTES, mapLimit, MAX_TEXT_BYTES } from "./browse.ts";
import type { Repos, TreeEntry } from "./repos.ts";

/** Bump whenever the output for the same two trees changes, so cached diffs are not reused. */
export const DIFF_VERSION = 1;

export interface DiffCaps {
  /** Changed files listed; past this the walk stops and the diff is `truncated`. */
  maxFiles: number;
  /** Files given a patch; the rest are listed without one, flagged `truncated`. */
  maxPatchedFiles: number;
  /** Either side larger than this many bytes: `tooLarge`, no patch. */
  maxBlobBytes: number;
  /** jsdiff gives up past this many edits: `tooComplex`, no patch. */
  maxEditLength: number;
  /** All patches together stop growing at this many UTF-8 bytes; cut files are `truncated`. */
  maxPatchBytes: number;
  /** …or at this many lines. */
  maxPatchLines: number;
}

export const DIFF_CAPS: DiffCaps = {
  maxFiles: 3000,
  maxPatchedFiles: 300,
  maxBlobBytes: MAX_TEXT_BYTES,
  maxEditLength: 2000,
  maxPatchBytes: 1024 * 1024,
  maxPatchLines: 20_000,
};

/** Blobs are read at most this many at a time. */
export const READ_CONCURRENCY = 6;
/** Lines of context around each change. */
export const CONTEXT_LINES = 3;

export type DiffFlag = "truncated" | "tooLarge" | "tooComplex" | "binary";
export type FileStatus = "added" | "deleted" | "modified" | "renamed";

/** One side of a file: where it is, its git mode (`100644`, `100755`, `120000`, `160000`) and its object sha. */
export interface FileSide {
  path: string;
  mode: string;
  hash: string;
}

export interface FileDiff {
  /** The new path, or the old one for a deleted file. */
  path: string;
  /** Only for a rename: where the file was. */
  oldPath?: string;
  status: FileStatus;
  oldMode: string | null;
  newMode: string | null;
  oldHash: string | null;
  newHash: string | null;
  additions: number;
  deletions: number;
  flags: DiffFlag[];
  /** The file's git-style unified patch, headers included; absent when a flag left it out. */
  patch?: string;
}

/** The diff between two trees: what is cached, keyed by the tree pair. */
export interface TreeDiff {
  files: FileDiff[];
  totals: { files: number; additions: number; deletions: number };
  /** More files changed than `maxFiles`; `files` lists the first ones by path. */
  truncated: boolean;
}

export interface CommitDiff extends TreeDiff {
  sha: string;
  /** The commit diffed against (`parents[0]`), or null for a root commit. */
  parent: string | null;
  oldTree: string | null;
  newTree: string;
}

/**
 * A commit's diff against its first parent (the empty tree for a root commit), or null when the
 * repo has no such commit. Merge commits diff against their first parent only.
 */
export async function diffCommit(
  repos: Repos,
  repo: string,
  sha: string,
  { caps = DIFF_CAPS, cache }: { caps?: DiffCaps; cache?: DiffCache | undefined } = {},
): Promise<CommitDiff | null> {
  const commit = await repos.readCommit(repo, sha);
  if (commit === null) return null;
  const parent = commit.parents[0] ?? null;
  const base = parent === null ? null : await repos.readCommit(repo, parent);
  if (parent !== null && base === null) throw new Error(`parent ${parent} of ${sha} is missing from ${repo}`);
  const oldTree = base?.treeHash ?? null;
  const newTree = commit.treeHash;
  const key = cache === undefined ? null : cacheKey(oldTree, newTree, caps);
  const hit = key === null ? undefined : await cache?.match(key);
  let diff: TreeDiff;
  if (hit !== undefined) {
    diff = (await hit.json()) as TreeDiff;
  } else {
    diff = await diffTrees(repos, repo, oldTree, newTree, caps);
    if (key !== null) await cache?.put(key, cacheable(diff));
  }
  return { sha, parent, oldTree, newTree, ...diff };
}

/**
 * Where tree diffs are kept: the Workers Cache API's shape. A tree pair's diff never changes, and
 * trees are content-addressed, so one entry serves every repo that has both trees.
 */
export interface DiffCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

/** How long a cached tree diff is kept; it never goes stale, so this only bounds the cache. */
const CACHE_SECONDS = 7 * 24 * 60 * 60;

/** Keyed by `(oldTree, newTree, DIFF_VERSION, caps)` under a host nothing else uses. */
function cacheKey(oldTree: string | null, newTree: string, caps: DiffCaps): Request {
  const url = `https://tree-diff.throng.invalid/v${DIFF_VERSION}/${oldTree ?? "empty"}/${newTree}?caps=${capsKey(caps)}`;
  return new Request(url);
}

function cacheable(diff: TreeDiff): Response {
  return new Response(JSON.stringify(diff), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
  });
}

/** The diff from `oldTree` (null for the empty tree) to `newTree`, with every cap applied. */
export async function diffTrees(
  repos: Repos,
  repo: string,
  oldTree: string | null,
  newTree: string,
  caps: DiffCaps = DIFF_CAPS,
): Promise<TreeDiff> {
  const changes: Change[] = [];
  // Renames pair a delete with an add, so the walk may need up to twice the listed files.
  const complete = await walkTrees(repos, repo, oldTree, newTree, "", changes, 2 * caps.maxFiles + 1);
  const paired = pairRenames(changes);
  const truncated = !complete || paired.length > caps.maxFiles;
  const listed = paired.slice(0, caps.maxFiles);

  const read = (hash: string) => readBlob(repos, repo, hash);
  const patched = await mapLimit(listed.slice(0, caps.maxPatchedFiles), READ_CONCURRENCY, (c) =>
    computeFile(read, c.old, c.new, caps),
  );

  const budget = { bytes: caps.maxPatchBytes, lines: caps.maxPatchLines };
  const files = listed.map((change, i) => {
    const computed = patched[i];
    if (computed === undefined) return { ...describe(change.old, change.new), flags: ["truncated" as const] };
    return render(computed, budget);
  });
  return {
    files,
    totals: {
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    truncated,
  };
}

/**
 * One file's diff from two sides, reading blobs through `repos`. Null for a side means the file
 * is added (no old side) or deleted (no new side). Size, binary and complexity caps apply; the
 * whole-diff caps don't.
 */
export async function diffFile(
  repos: Repos,
  repo: string,
  old: FileSide | null,
  next: FileSide | null,
  caps: DiffCaps = DIFF_CAPS,
): Promise<FileDiff> {
  const computed = await computeFile((hash) => readBlob(repos, repo, hash), old, next, caps);
  return render(computed, { bytes: Infinity, lines: Infinity });
}

/** The unified patch for every file that has one, concatenated: what `git apply` takes. */
export function unifiedPatch(diff: TreeDiff): string {
  return diff.files.map((f) => f.patch ?? "").join("");
}

/** A string that changes whenever the caps do, for cache keys. */
export function capsKey(caps: DiffCaps): string {
  return [
    caps.maxFiles,
    caps.maxPatchedFiles,
    caps.maxBlobBytes,
    caps.maxEditLength,
    caps.maxPatchBytes,
    caps.maxPatchLines,
  ].join("-");
}

// --- Tree walk -------------------------------------------------------------------------------

interface Change {
  old: FileSide | null;
  new: FileSide | null;
}

function isTree(e: TreeEntry): boolean {
  return e.type === "tree";
}

/** Git orders a tree's entries comparing a directory's name as if it ended in "/". */
function orderKey(e: TreeEntry): string {
  return isTree(e) ? `${e.name}/` : e.name;
}

/**
 * Walks two trees in step, appending every changed file to `out` in byte-wise path order and
 * skipping whatever has the same hash and mode on both sides. Returns false if it stopped at `limit`.
 */
async function walkTrees(
  repos: Repos,
  repo: string,
  oldTree: string | null,
  newTree: string | null,
  prefix: string,
  out: Change[],
  limit: number,
): Promise<boolean> {
  const [olds, news] = await Promise.all([entries(repos, repo, oldTree), entries(repos, repo, newTree)]);
  const byKey = new Map<string, { old?: TreeEntry; new?: TreeEntry }>();
  for (const e of olds) byKey.set(orderKey(e), { old: e });
  for (const e of news) byKey.set(orderKey(e), { ...byKey.get(orderKey(e)), new: e });
  const keys = [...byKey.keys()].toSorted(byteOrder);
  for (const key of keys) {
    const { old, new: next } = byKey.get(key)!;
    if (old !== undefined && next !== undefined && old.hash === next.hash && old.mode === next.mode) continue;
    const path = prefix + (old ?? next)!.name;
    if ((old !== undefined && isTree(old)) || (next !== undefined && isTree(next))) {
      const done = await walkTrees(repos, repo, old?.hash ?? null, next?.hash ?? null, `${path}/`, out, limit);
      if (!done) return false;
      continue;
    }
    if (out.length >= limit) return false;
    const [before, after] = [side(path, old), side(path, next)];
    // Git writes a change of kind (file, symlink, submodule) as a delete and an add.
    if (before !== null && after !== null && kind(before.mode) !== kind(after.mode)) {
      out.push({ old: before, new: null }, { old: null, new: after });
    } else {
      out.push({ old: before, new: after });
    }
  }
  return true;
}

async function entries(repos: Repos, repo: string, tree: string | null): Promise<TreeEntry[]> {
  if (tree === null) return [];
  const found = await repos.readTree(repo, tree);
  if (found === null) throw new Error(`tree ${tree} is missing from ${repo}`);
  return found;
}

function side(path: string, e: TreeEntry | undefined): FileSide | null {
  return e === undefined ? null : { path, mode: normalMode(e.mode), hash: e.hash };
}

function kind(mode: string): string {
  return mode.startsWith("100") ? "file" : mode;
}

/** Modes as git writes them in patches: six digits. */
function normalMode(mode: string): string {
  return mode.padStart(6, "0");
}

/**
 * Pairs each deleted file with an added file of the same blob as a rename, the first by path with
 * the first. Like git, empty files and submodules are never paired. Keeps path order.
 */
function pairRenames(changes: Change[]): Change[] {
  const added = new Map<string, Change[]>();
  for (const c of changes) {
    if (c.old === null && c.new !== null && renameable(c.new)) {
      added.set(c.new.hash, [...(added.get(c.new.hash) ?? []), c]);
    }
  }
  const taken = new Set<Change>();
  const result: Change[] = [];
  for (const c of changes) {
    if (c.old !== null && c.new === null && renameable(c.old)) {
      const match = added.get(c.old.hash)?.find((a) => !taken.has(a));
      if (match !== undefined) {
        taken.add(match);
        result.push({ old: c.old, new: match.new });
        continue;
      }
    }
    result.push(c);
  }
  return result.filter((c) => !taken.has(c)).toSorted((a, b) => byteOrder(pathOf(a), pathOf(b)));
}

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function renameable(s: FileSide): boolean {
  return s.mode !== GITLINK_MODE && s.hash !== EMPTY_BLOB;
}

function pathOf(c: Change): string {
  return (c.new ?? c.old)!.path;
}

/** Byte order of UTF-8: for strings, code point order. */
function byteOrder(a: string, b: string): number {
  const [x, y] = [[...a].map((c) => c.codePointAt(0) ?? 0), [...b].map((c) => c.codePointAt(0) ?? 0)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return x.length - y.length;
}

// --- One file --------------------------------------------------------------------------------

const GITLINK_MODE = "160000";
const ZERO_HASH = "0".repeat(40);

/** A file's diff before rendering: its headers, and its hunks each already formatted. */
interface Computed {
  file: Omit<FileDiff, "patch">;
  header: string[];
  /** Null when a flag means the file gets no patch at all. */
  hunks: string[][] | null;
}

type ReadBlob = (hash: string) => Promise<Blob>;

async function readBlob(repos: Repos, repo: string, hash: string): Promise<Blob> {
  const blob = await repos.readBlob(repo, hash);
  if (blob === null) throw new Error(`blob ${hash} is missing from ${repo}`);
  return blob;
}

function describe(old: FileSide | null, next: FileSide | null): Omit<FileDiff, "patch" | "flags"> {
  const either = (next ?? old)!;
  const renamed = old !== null && next !== null && old.path !== next.path;
  const status: FileStatus = old === null ? "added" : next === null ? "deleted" : renamed ? "renamed" : "modified";
  return {
    path: either.path,
    ...(renamed ? { oldPath: old.path } : {}),
    status,
    oldMode: old?.mode ?? null,
    newMode: next?.mode ?? null,
    oldHash: old?.hash ?? null,
    newHash: next?.hash ?? null,
    additions: 0,
    deletions: 0,
  };
}

async function computeFile(
  read: ReadBlob,
  old: FileSide | null,
  next: FileSide | null,
  caps: DiffCaps,
): Promise<Computed> {
  if (old === null && next === null) throw new Error("a file diff needs at least one side");
  const described = describe(old, next);
  const header = gitHeader(old, next);
  const flagged = (flag: DiffFlag): Computed => ({ file: { ...described, flags: [flag] }, header, hunks: null });

  const sameContent = old !== null && next !== null && old.hash === next.hash;
  if (sameContent) return { file: { ...described, flags: [] }, header, hunks: [] };

  // One side after the other, so files diffed READ_CONCURRENCY at a time keep that many reads in flight.
  const before = await content(read, old, caps);
  const after = await content(read, next, caps);
  if (before.size > caps.maxBlobBytes || after.size > caps.maxBlobBytes) return flagged("tooLarge");
  if (before.binary || after.binary) return flagged("binary");

  const patch = structuredPatch("", "", before.text, after.text, undefined, undefined, {
    context: CONTEXT_LINES,
    maxEditLength: caps.maxEditLength,
  });
  if (patch === undefined) return flagged("tooComplex");

  let additions = 0;
  let deletions = 0;
  const hunks = patch.hunks.map((h) => {
    for (const line of h.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return [hunkHeader(h), ...h.lines];
  });
  const fileHeaders = hunks.length === 0 ? [] : [`--- ${label("a", old)}`, `+++ ${label("b", next)}`];
  return {
    file: { ...described, additions, deletions, flags: [] },
    header: [...header, ...fileHeaders],
    hunks,
  };
}

interface Content {
  text: string;
  size: number;
  binary: boolean;
}

const NO_CONTENT: Content = { text: "", size: 0, binary: false };

/** A side's text, unless it is binary or too large to diff. */
async function content(read: ReadBlob, s: FileSide | null, caps: DiffCaps): Promise<Content> {
  if (s === null) return NO_CONTENT;
  // A submodule's "content" is the commit it points at, written as git does.
  if (s.mode === GITLINK_MODE) return { text: `Subproject commit ${s.hash}\n`, size: 0, binary: false };
  const blob = await read(s.hash);
  const head = new Uint8Array(await blob.slice(0, BINARY_SNIFF_BYTES).arrayBuffer());
  const binary = head.includes(0);
  const tooLarge = blob.size > caps.maxBlobBytes;
  return { text: binary || tooLarge ? "" : await blob.text(), size: blob.size, binary };
}

function label(prefix: "a" | "b", s: FileSide | null): string {
  return s === null ? "/dev/null" : `${prefix}/${s.path}`;
}

/** The `diff --git` line and git's extended headers, in the order git writes them. */
function gitHeader(old: FileSide | null, next: FileSide | null): string[] {
  const a = (old ?? next)!;
  const b = (next ?? old)!;
  const lines = [`diff --git a/${a.path} b/${b.path}`];
  if (old === null) lines.push(`new file mode ${b.mode}`);
  else if (next === null) lines.push(`deleted file mode ${a.mode}`);
  else if (old.mode !== next.mode) lines.push(`old mode ${old.mode}`, `new mode ${next.mode}`);
  if (old !== null && next !== null && old.path !== next.path) {
    lines.push("similarity index 100%", `rename from ${old.path}`, `rename to ${next.path}`);
  }
  const oldHash = old?.hash ?? ZERO_HASH;
  const newHash = next?.hash ?? ZERO_HASH;
  if (oldHash !== newHash) {
    const sameMode = old !== null && next !== null && old.mode === next.mode;
    lines.push(`index ${oldHash}..${newHash}${sameMode ? ` ${old.mode}` : ""}`);
  }
  return lines;
}

/** `@@ -a,b +c,d @@` as git writes it: a count of 1 is left out, and an empty range starts a line earlier. */
function hunkHeader(h: StructuredPatchHunk): string {
  return `@@ -${hunkRange(h.oldStart, h.oldLines)} +${hunkRange(h.newStart, h.newLines)} @@`;
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;
}

/**
 * Renders a computed file into a patch, spending from `budget`. Hunks stop once the next one
 * wouldn't fit, and none are added after that, to this file or any later one. A file that loses
 * any is flagged `truncated`; one that keeps no hunk gets no patch (headers alone say nothing).
 */
function render(c: Computed, budget: { bytes: number; lines: number }): FileDiff {
  if (c.hunks === null) return c.file;
  const chunks = [c.header, ...c.hunks].map((part) => {
    const text = part.map((l) => `${l}\n`).join("");
    return { text, bytes: utf8Length(text), lines: part.length };
  });
  let bytes = 0;
  let lines = 0;
  let kept = 0;
  for (const chunk of chunks) {
    if (bytes + chunk.bytes > budget.bytes || lines + chunk.lines > budget.lines) break;
    bytes += chunk.bytes;
    lines += chunk.lines;
    kept++;
  }
  if (kept === chunks.length) {
    budget.bytes -= bytes;
    budget.lines -= lines;
    return { ...c.file, patch: chunks.map((ch) => ch.text).join("") };
  }
  budget.bytes = 0;
  budget.lines = 0;
  const flags: DiffFlag[] = [...c.file.flags, "truncated"];
  if (kept <= 1) return { ...c.file, flags };
  return {
    ...c.file,
    flags,
    patch: chunks
      .slice(0, kept)
      .map((ch) => ch.text)
      .join(""),
  };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
