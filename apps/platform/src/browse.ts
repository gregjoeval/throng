// Read-only browsing of a project's code: refs, directories, files and history, for the web UI's
// file and commit browser and for agents that don't want to clone. Everything goes through `Repos`
// reads (trees, blobs, commits and first-parent logs), never a clone.
//
// A ref is `main` (origin's main), an attempt (`t42a3`: its fork's main while active, its archived
// ref in origin once it ends) or a full commit sha (origin first, then the fork `?attempt=` names).
// Each read resolves the ref to a commit in one repo first, so a response can say which sha it read.

import { archiveRef } from "./archive.ts";
import { ServiceError } from "./errors.ts";
import { resolveProject } from "./projects.ts";
import { forkRepo, originRepo } from "./repos.ts";
import type { Commit, Repos, TreeEntry } from "./repos.ts";
import type { ProjectContext, StoredAttempt, TaskMethod } from "./task-store.ts";
import { attemptRef, parseAttemptRef } from "./task-refs.ts";
import type { TaskBackend } from "./tasks.ts";
import type { Actor } from "./tokens.ts";
import type { Database } from "./users.ts";

/** Text files larger than this come back without content, flagged `tooLarge`. */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Git's rule: a file is binary if a NUL byte appears in its first 8,000 bytes. */
export const BINARY_SNIFF_BYTES = 8000;
export const DEFAULT_COMMITS_PAGE = 50;
export const MAX_COMMITS_PAGE = 100;
/** Head lookups for `/refs` run at most this many at a time. */
const HEAD_CONCURRENCY = 6;

const SHA = /^[0-9a-f]{40}$/i;

export interface BrowseDeps {
  db: Database;
  repos: Repos;
  backend: (projectId: string) => TaskBackend;
}

interface ProjectPath {
  owner: string;
  project: string;
}

export interface RefInput extends ProjectPath {
  ref: string;
  /** For a sha that isn't in origin: the attempt whose fork to look in. */
  attempt?: string | undefined;
}

/** A ref resolved to a commit, and the repo to read it from. */
export interface Resolved {
  repo: string;
  sha: string;
  /** Whether the ref was a sha, so what it addresses can never change. */
  immutable: boolean;
}

export interface AttemptHead {
  ref: string;
  state: StoredAttempt["state"];
  /** Null when the attempt's head can't be found, e.g. its fork is still being made. */
  sha: string | null;
}

export interface Refs {
  main: { ref: "main"; sha: string | null };
  active: AttemptHead[];
  archived: AttemptHead[];
}

export interface Entry extends TreeEntry {
  /** The entry's repository-relative path. */
  path: string;
}

export interface FileContent extends Entry {
  /** Bytes. */
  size: number;
  binary: boolean;
  tooLarge: boolean;
  /** UTF-8 text, or null when the file is binary or too large. */
  content: string | null;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

export interface CommitPage {
  commits: CommitInfo[];
  /** The offset of the next page, or null on the last. */
  next: number | null;
}

/** The browse services. Any signed-in actor may read any project in P0. */
export function browseService({ db, repos, backend }: BrowseDeps) {
  async function project(path: ProjectPath): Promise<ProjectContext> {
    const found = await resolveProject(db, path.owner, path.project);
    if (found === null) throw new ServiceError("notFound", `no project ${path.owner}/${path.project}`);
    return { id: found.id, owner: found.owner.id };
  }

  async function store<T>(ctx: ProjectContext, method: TaskMethod, ...args: unknown[]): Promise<T> {
    const outcome = await backend(ctx.id).call(method, [ctx, ...args]);
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message);
    return outcome.value as T;
  }

  /** The commit `ref` names in `repo`, or null when the ref, or the repo, doesn't exist. */
  async function head(repo: string, ref: string): Promise<string | null> {
    const found = await missingAsNull(repos.listCommits(repo, { ref, limit: 1 }));
    return found?.[0]?.hash ?? null;
  }

  /**
   * Where an attempt's head is. An active attempt's is its fork's `main`. An ended one's is its
   * archived sha, or else its archive ref in origin; until #110 archives on close, a closed
   * attempt's fork survives, so its `main` is the last resort.
   */
  async function attemptHead(ctx: ProjectContext, attempt: StoredAttempt): Promise<Omit<Resolved, "immutable"> | null> {
    const origin = originRepo(ctx.id);
    const fork = forkRepo(ctx.id, attempt.fork);
    if (attempt.state === "draft" || attempt.state === "open") {
      const sha = await head(fork, "main");
      return sha === null ? null : { repo: fork, sha };
    }
    if (attempt.archived_sha !== null) return { repo: origin, sha: attempt.archived_sha };
    const archived = await head(origin, archiveRef(attempt.fork));
    if (archived !== null) return { repo: origin, sha: archived };
    const sha = await head(fork, "main");
    return sha === null ? null : { repo: fork, sha };
  }

  async function hasCommit(repo: string, sha: string): Promise<boolean> {
    return (await missingAsNull(repos.readCommit(repo, sha))) !== null;
  }

  async function resolve(ctx: ProjectContext, actor: Actor, { ref, attempt }: RefInput): Promise<Resolved> {
    const origin = originRepo(ctx.id);
    if (SHA.test(ref)) {
      const sha = ref.toLowerCase();
      if (await hasCommit(origin, sha)) return { repo: origin, sha, immutable: true };
      if (attempt !== undefined) {
        const parsed = parseAttemptRef(attempt);
        if (parsed === null) throw new ServiceError("invalidRequest", `not an attempt reference: ${attempt}`);
        const fork = forkRepo(ctx.id, attemptRef(parsed.task, parsed.number));
        if (await hasCommit(fork, sha)) return { repo: fork, sha, immutable: true };
      }
      throw new ServiceError("notFound", `no commit ${sha}`);
    }
    if (ref === "main") {
      const sha = await head(origin, "main");
      if (sha === null) throw new ServiceError("notFound", "main has no commits yet");
      return { repo: origin, sha, immutable: false };
    }
    const parsed = parseAttemptRef(ref);
    if (parsed === null) throw new ServiceError("notFound", `no ref ${ref}`);
    const found = await store<StoredAttempt>(ctx, "getAttempt", actor, parsed);
    const at = await attemptHead(ctx, found);
    if (at === null) throw new ServiceError("notFound", `${found.fork} has no commits`);
    return { ...at, immutable: false };
  }

  /** The tree entry at `path` (the root for an empty path) in a commit, or null. */
  async function entryAt(at: Resolved, path: string): Promise<Entry | null> {
    const commit = await repos.readCommit(at.repo, at.sha);
    if (commit === null) return null;
    return walk(repos, at.repo, commit.treeHash, path);
  }

  return {
    /** Resolves a ref to a commit; reads then take the result, so a cache check can come between. */
    async resolve(actor: Actor, input: RefInput): Promise<Resolved> {
      return resolve(await project(input), actor, input);
    },

    /** `main`, the active attempts and the archived (ended, not obsolete) ones, each with its head. */
    async refs(actor: Actor, input: ProjectPath): Promise<Refs> {
      const ctx = await project(input);
      const attempts = await store<StoredAttempt[]>(ctx, "listProjectAttempts", actor);
      const [main, ...heads] = await mapLimit(
        [null, ...attempts],
        HEAD_CONCURRENCY,
        async (a): Promise<string | null> =>
          a === null ? head(originRepo(ctx.id), "main") : ((await attemptHead(ctx, a))?.sha ?? null),
      );
      const listed = attempts.map((a, i) => ({ ref: a.fork, state: a.state, sha: heads[i] ?? null }));
      return {
        main: { ref: "main", sha: main ?? null },
        active: listed.filter((a) => a.state === "draft" || a.state === "open"),
        archived: listed.filter((a) => a.state === "closed" || a.state === "merged"),
      };
    },

    /** A directory's entries, folders first and then by name. */
    async tree(at: Resolved, path: string): Promise<Entry[]> {
      const dir = await entryAt(at, path);
      if (dir === null) throw new ServiceError("notFound", `no ${describe(path)} at ${at.sha}`);
      if (dir.type !== "tree") throw new ServiceError("notFound", `${dir.path} is not a directory`);
      const entries = (await repos.readTree(at.repo, dir.hash)) ?? [];
      return entries
        .map((e) => ({ ...e, path: join(dir.path, e.name) }))
        .toSorted((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || byteOrder(a.name, b.name));
    },

    /** A file's metadata, with its text when it's text and at most `MAX_TEXT_BYTES`. */
    async blob(at: Resolved, path: string): Promise<FileContent> {
      const { entry, blob } = await file(at, path);
      const binary = await isBinary(blob);
      const tooLarge = blob.size > MAX_TEXT_BYTES;
      const content = binary || tooLarge ? null : await blob.text();
      return { ...entry, size: blob.size, binary, tooLarge, content };
    },

    /** A file's bytes, and the content type its extension (or, failing that, its bytes) suggests. */
    async raw(at: Resolved, path: string): Promise<{ entry: Entry; blob: Blob; type: string }> {
      const { entry, blob } = await file(at, path);
      return { entry, blob, type: contentType(entry.name) ?? ((await isBinary(blob)) ? BINARY_TYPE : TEXT_TYPE) };
    },

    /** One page of the first-parent history from a resolved ref, newest first. */
    async commits(at: Resolved, { offset, limit }: { offset: number; limit: number }): Promise<CommitPage> {
      const found = await repos.listCommits(at.repo, { ref: at.sha, offset, limit: limit + 1 });
      return { commits: found.slice(0, limit).map(commitInfo), next: found.length > limit ? offset + limit : null };
    },

    async commit(at: Resolved): Promise<CommitInfo> {
      const found = await repos.readCommit(at.repo, at.sha);
      if (found === null) throw new ServiceError("notFound", `no commit ${at.sha}`);
      return commitInfo(found);
    },
  };

  async function file(at: Resolved, path: string): Promise<{ entry: Entry; blob: Blob }> {
    const entry = await entryAt(at, path);
    if (entry === null || entry.path === "") throw new ServiceError("notFound", `no ${describe(path)} at ${at.sha}`);
    if (entry.type === "tree") throw new ServiceError("notFound", `${entry.path} is a directory`);
    if (entry.type === "gitlink") throw new ServiceError("notFound", `${entry.path} is a submodule`);
    const blob = await repos.readBlob(at.repo, entry.hash);
    if (blob === null) throw new ServiceError("notFound", `no blob ${entry.hash}`);
    return { entry, blob };
  }
}

export type BrowseService = ReturnType<typeof browseService>;

/**
 * Walks from a root tree to the entry at `path`, one `readTree` per directory. The root itself is
 * an entry with an empty path. Null when any part of the path is missing or isn't a directory.
 */
export async function walk(repos: Repos, repo: string, rootTree: string, path: string): Promise<Entry | null> {
  let entry: Entry = { name: "", path: "", mode: "40000", hash: rootTree, type: "tree" };
  for (const part of segments(path)) {
    if (entry.type !== "tree") return null;
    const next = (await repos.readTree(repo, entry.hash))?.find((e) => e.name === part);
    if (next === undefined) return null;
    entry = { ...next, path: join(entry.path, part) };
  }
  return entry;
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function describe(path: string): string {
  const clean = segments(path).join("/");
  return clean === "" ? "root directory" : `path ${clean}`;
}

/** Git orders names by their bytes; for UTF-16 strings, code point order matches UTF-8 byte order. */
function byteOrder(a: string, b: string): number {
  const [x, y] = [[...a].map((c) => c.codePointAt(0) ?? 0), [...b].map((c) => c.codePointAt(0) ?? 0)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return x.length - y.length;
}

async function isBinary(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, BINARY_SNIFF_BYTES).arrayBuffer());
  return head.includes(0);
}

export function commitInfo(c: Commit): CommitInfo {
  return {
    sha: c.hash,
    tree: c.treeHash,
    parents: c.parents,
    message: c.message,
    author: { ...c.author, date: isoSeconds(c.authoredAt) },
    committer: { ...c.committer, date: isoSeconds(c.committedAt) },
  };
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const TEXT_TYPE = "text/plain; charset=utf-8";
const BINARY_TYPE = "application/octet-stream";

/**
 * Types for extensions a browser can show as they are. Anything else (HTML and scripts included)
 * is served as plain text or octet-stream, so `/raw` never hands a browser a page to run.
 */
const CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  zip: "application/zip",
  gz: "application/gzip",
};

function contentType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : (CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null);
}

/** Awaits a repo read, turning a missing repo (`NOT_FOUND`) into null. */
async function missingAsNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if ((err as { code?: unknown }).code === "NOT_FOUND") return null;
    throw err;
  }
}

/** Maps over `items` with at most `limit` calls in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
