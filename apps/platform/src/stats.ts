// A commit's stats for the project home's About sidebar, computed from `Repos` reads, never a clone:
// who authored the commits in its history, the share of its code in each language, and a description taken
// from its README's first paragraph. A commit's stats never change, so they are cached by its sha.

import { blobSizer, SIZE_CONCURRENCY } from "./blob-size.ts";
import { mapLimit, MAX_TEXT_BYTES } from "./browse.ts";
import type { DiffCache, InRepo } from "./diff.ts";
import { ServiceError } from "./errors.ts";
import { isReadme } from "./readme.ts";
import type { Commit, Repos, TreeEntry } from "./repos.ts";

/** Bump whenever the stats for the same commit change, so cached stats are not reused. */
const STATS_VERSION = 1;

export interface StatsCaps {
  /** Commits tallied for authors; past this `commitsTruncated` is set. */
  maxCommits: number;
  /** Files sized for languages, in breadth-first order; past this `filesTruncated` is set. */
  maxFiles: number;
  /** Directories read for languages, in breadth-first order, whatever they hold; past this `filesTruncated` is set. */
  maxTrees: number;
}

export const STATS_CAPS: StatsCaps = { maxCommits: 1000, maxFiles: 1000, maxTrees: 500 };

/** A description longer than this is cut at a word and ends with `…`. */
export const MAX_DESCRIPTION = 300;

/** Commits read per `listCommits` call while walking history. */
const COMMIT_PAGE = 100;
/** Tree reads run at most this many at a time. */
const TREE_CONCURRENCY = 6;
/** How long cached stats are kept; they never go stale, so this only bounds the cache. */
const CACHE_SECONDS = 7 * 24 * 60 * 60;

/** Directories of other people's code or build output, left out of the languages as GitHub does. */
const VENDORED_DIRS = new Set(["node_modules", "vendor", "dist", "build", "out", "coverage"]);

/**
 * The languages counted, by lowercase extension. Data and prose (JSON, YAML, Markdown) are left out,
 * as GitHub leaves them out of a repository's language bar.
 */
const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  htm: "HTML",
  vue: "Vue",
  svelte: "Svelte",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  cs: "C#",
  fs: "F#",
  php: "PHP",
  pl: "Perl",
  lua: "Lua",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  ml: "OCaml",
  clj: "Clojure",
  r: "R",
  jl: "Julia",
  zig: "Zig",
  nix: "Nix",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  tf: "HCL",
};

/** Files whose name, not extension, says their language. */
const NAMED_LANGUAGES: Record<string, string> = { Dockerfile: "Dockerfile", Makefile: "Makefile" };

export interface CommitAuthor {
  /** The name on their newest commit. */
  name: string;
  /** Lowercased: commits are counted by it, so one person with two emails is two authors. */
  email: string;
  commits: number;
  /** Unix seconds of their newest commit. */
  newestAt: number;
}

export interface LanguageShare {
  name: string;
  bytes: number;
  /** This language's bytes over all the counted languages' bytes, from 0 to 1. */
  share: number;
}

export interface CommitStats {
  /** README's first paragraph as plain text, or null when there's no README or it has no paragraph. */
  description: string | null;
  /** Most commits first. */
  commitAuthors: CommitAuthor[];
  /** Most bytes first. */
  languages: LanguageShare[];
  /** Whether `maxCommits` left commits out of `commitAuthors`. */
  commitsTruncated: boolean;
  /** Whether `maxFiles` or `maxTrees` left files out of `languages`. */
  filesTruncated: boolean;
}

export interface StatsOptions {
  caps?: StatsCaps;
  cache?: DiffCache | undefined;
}

/** The stats of the commit `at`. Served from `cache` when it has them, and stored there when not. */
export async function commitStats(
  repos: Repos,
  at: InRepo,
  { caps = STATS_CAPS, cache }: StatsOptions = {},
): Promise<CommitStats> {
  const key = cache === undefined ? null : cacheKey(at.sha, caps);
  const hit = key === null ? undefined : await cache?.match(key);
  if (hit !== undefined) return (await hit.json()) as CommitStats;
  const commit = await repos.readCommit(at.repo, at.sha);
  if (commit === null) throw new ServiceError("notFound", `no commit ${at.sha}`);
  const [history, code] = await Promise.all([
    commitAuthors(repos, at, caps.maxCommits),
    languages(repos, cache, at.repo, commit.treeHash, caps),
  ]);
  const stats: CommitStats = {
    description: await description(repos, at.repo, code.root),
    commitAuthors: history.authors,
    languages: code.languages,
    commitsTruncated: history.truncated,
    filesTruncated: code.truncated,
  };
  if (key !== null) await cache?.put(key, cacheable(stats));
  return stats;
}

function cacheKey(sha: string, caps: StatsCaps): Request {
  return new Request(
    `https://commit-stats.throng.invalid/v${STATS_VERSION}/${sha}?caps=${caps.maxCommits}.${caps.maxFiles}.${caps.maxTrees}`,
  );
}

function cacheable(stats: CommitStats): Response {
  return new Response(JSON.stringify(stats), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
  });
}

/**
 * Every commit reachable from `at`, up to `max`, tallied by author email. `listCommits` follows first
 * parents only, so each merge's other parents start a walk of their own, which stops at a commit
 * already seen. A walk pages on from the last commit's first parent, never re-reading from its start.
 */
async function commitAuthors(
  repos: Repos,
  at: InRepo,
  max: number,
): Promise<{ authors: CommitAuthor[]; truncated: boolean }> {
  const seen = new Set<string>();
  const byEmail = new Map<string, CommitAuthor>();
  const starts = [at.sha];
  for (let start = starts.shift(); start !== undefined; start = starts.shift()) {
    for (let ref: string | undefined = start; ref !== undefined && !seen.has(ref);) {
      const page = await repos.listCommits(at.repo, { ref, limit: COMMIT_PAGE });
      const fresh = page.findIndex((c) => seen.has(c.hash));
      const read = fresh === -1 ? page : page.slice(0, fresh);
      for (const c of read) {
        if (seen.size === max) return { authors: ranked(byEmail), truncated: true };
        seen.add(c.hash);
        starts.push(...c.parents.slice(1));
        tally(byEmail, c);
      }
      ref = fresh === -1 && page.length === COMMIT_PAGE ? read.at(-1)?.parents[0] : undefined;
    }
  }
  return { authors: ranked(byEmail), truncated: false };
}

/** Counts `commit` for its author, taking the name on whichever of their commits is newest. */
function tally(byEmail: Map<string, CommitAuthor>, commit: Commit): void {
  const email = commit.author.email.toLowerCase();
  const found = byEmail.get(email);
  const newer = found === undefined || commit.authoredAt > found.newestAt;
  byEmail.set(email, {
    name: newer ? commit.author.name : found.name,
    email,
    commits: (found?.commits ?? 0) + 1,
    newestAt: newer ? commit.authoredAt : found.newestAt,
  });
}

/** Most commits first, then by name. */
function ranked(byEmail: Map<string, CommitAuthor>): CommitAuthor[] {
  return [...byEmail.values()].toSorted((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

/**
 * The bytes in each language under the root tree, read breadth first, with the root's own entries
 * for finding the README. At most `maxTrees` directories are read and `maxFiles` files of a known
 * language sized, so on a large tree the files nearest the root decide the shares.
 */
async function languages(
  repos: Repos,
  cache: DiffCache | undefined,
  repo: string,
  rootTree: string,
  { maxFiles, maxTrees }: StatsCaps,
): Promise<{ languages: LanguageShare[]; root: TreeEntry[]; truncated: boolean }> {
  const files: { language: string; hash: string }[] = [];
  let root: TreeEntry[] | undefined;
  let truncated = false;
  let treesRead = 0;
  for (let dirs = [rootTree]; dirs.length > 0 && !truncated;) {
    if (treesRead + dirs.length > maxTrees) {
      dirs = dirs.slice(0, maxTrees - treesRead);
      truncated = true;
    }
    treesRead += dirs.length;
    const listed = await mapLimit(dirs, TREE_CONCURRENCY, async (hash) => (await repos.readTree(repo, hash)) ?? []);
    root ??= listed[0] ?? [];
    dirs = [];
    for (const entry of listed.flat()) {
      if (entry.type === "tree") {
        if (!VENDORED_DIRS.has(entry.name)) dirs.push(entry.hash);
        continue;
      }
      const language = entry.type === "blob" || entry.type === "exec" ? languageOf(entry.name) : null;
      if (language === null) continue;
      if (files.length === maxFiles) {
        truncated = true;
        break;
      }
      files.push({ language, hash: entry.hash });
    }
  }
  const sizeOf = blobSizer(repos, cache);
  const sizes = await mapLimit(files, SIZE_CONCURRENCY, (f) => sizeOf(repo, f.hash));
  const bytes = new Map<string, number>();
  files.forEach((f, i) => bytes.set(f.language, (bytes.get(f.language) ?? 0) + (sizes[i] ?? 0)));
  const total = [...bytes.values()].reduce((sum, n) => sum + n, 0);
  const shares = [...bytes]
    .filter(([, n]) => n > 0)
    .map(([name, n]) => ({ name, bytes: n, share: n / total }))
    .toSorted((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { languages: shares, root: root ?? [], truncated };
}

/** A file's language by its name or extension, or null when it isn't counted. */
export function languageOf(name: string): string | null {
  const named = NAMED_LANGUAGES[name];
  if (named !== undefined) return named;
  if (/\.min\.(?:js|css)$/u.test(name)) return null;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : (LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null);
}

/** The root README's first paragraph, or null. A binary or oversized README has none. */
async function description(repos: Repos, repo: string, root: TreeEntry[]): Promise<string | null> {
  const readme = root.find((e) => (e.type === "blob" || e.type === "exec") && isReadme(e.name));
  if (readme === undefined) return null;
  const blob = await repos.readBlob(repo, readme.hash);
  if (blob === null || blob.size > MAX_TEXT_BYTES) return null;
  const text = await blob.text();
  return text.includes("\0") ? null : readmeDescription(text);
}

/** Lines that are never prose: headings, HTML, tables, rules, quotes, list items and indented code. */
const NOT_PROSE = /^(?:#|<|\||>|[-*+]\s|\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,})\s*$| {4}|\t)/u;
const FENCE = /^\s*(?:```|~~~)/u;
/** A setext heading's underline: the paragraph above it was a heading. */
const UNDERLINE = /^\s*(?:=+|-+)\s*$/u;
const IMAGE = /!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]/gu;

/**
 * The first paragraph of a Markdown README as plain text: headings, badges, HTML, code and lists
 * skipped, links reduced to their text, emphasis and code marks dropped, cut to `MAX_DESCRIPTION`.
 */
export function readmeDescription(markdown: string): string | null {
  const lines = markdown.replace(/^﻿/u, "").split(/\r?\n/u);
  let paragraph: string[] = [];
  let fenced = false;
  let comment = false;
  for (const line of frontMatterSkipped(lines)) {
    if (comment) {
      comment = !line.includes("-->");
      continue;
    }
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trimStart().startsWith("<!--")) {
      comment = !line.includes("-->");
      continue;
    }
    if (paragraph.length > 0 && UNDERLINE.test(line)) {
      paragraph = [];
      continue;
    }
    const prose = line.replace(IMAGE, "").replace(/\[\s*\]\([^)]*\)/gu, "");
    if (prose.trim() === "" || (paragraph.length === 0 && NOT_PROSE.test(line))) {
      if (paragraph.length > 0) return plain(paragraph.join(" "));
      continue;
    }
    paragraph.push(prose.trim());
  }
  return paragraph.length > 0 ? plain(paragraph.join(" ")) : null;
}

function frontMatterSkipped(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines;
  const end = lines.indexOf("---", 1);
  return end === -1 ? lines : lines.slice(end + 1);
}

/** Inline Markdown reduced to its text, whitespace collapsed, cut to `MAX_DESCRIPTION`. */
function plain(text: string): string {
  const flat = text
    .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/gu, "$1")
    .replace(/<(https?:[^>\s]+)>/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?![\w*])/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
  if (flat.length <= MAX_DESCRIPTION) return flat;
  const cut = flat.slice(0, MAX_DESCRIPTION);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/u, "")}…`;
}
