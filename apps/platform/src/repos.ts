// The Repos seam: every Artifacts call goes through this interface. Production wraps the binding
// (`artifacts.ts`); tests use the in-memory fake (`test/fake-repos.ts`).

import { isAttemptRef } from "./task-refs.ts";

/** Artifacts caps repo names at 63 characters. */
export const MAX_REPO_NAME = 63;

const PROJECT_ID = /^[a-z0-9]+$/u;
const ORIGIN_SUFFIX = "main";
const STAGING_SUFFIX = "import";

/**
 * What a repo name says: a project's origin, the fork of one of its attempts, or the staging repo an
 * import passes through.
 */
export type RepoName =
  | { kind: "origin"; project: string }
  | { kind: "fork"; project: string; attempt: string }
  | { kind: "staging"; project: string };

/** The origin's repo: `<projectId>-main`. */
export function originRepo(project: string): string {
  return repoName(project, ORIGIN_SUFFIX);
}

/**
 * The repo an import whose default branch isn't `main` lands in before its branch is copied to the
 * origin's `main`: `<projectId>-import`. It lives only while the project is being created.
 */
export function stagingRepo(project: string): string {
  return repoName(project, STAGING_SUFFIX);
}

/** An attempt fork's repo, named after the attempt: `<projectId>-t42a3`. */
export function forkRepo(project: string, attempt: string): string {
  if (!isAttemptRef(attempt)) throw new Error(`not an attempt: ${attempt}`);
  return repoName(project, attempt);
}

/** Reads a repo name back; null for anything that isn't an origin, attempt fork or staging name. */
export function parseRepoName(name: string): RepoName | null {
  const at = name.lastIndexOf("-");
  const project = name.slice(0, at);
  const suffix = name.slice(at + 1);
  if (at === -1 || !PROJECT_ID.test(project)) return null;
  if (suffix === ORIGIN_SUFFIX) return { kind: "origin", project };
  if (suffix === STAGING_SUFFIX) return { kind: "staging", project };
  if (isAttemptRef(suffix)) return { kind: "fork", project, attempt: suffix };
  return null;
}

function repoName(project: string, suffix: string): string {
  if (!PROJECT_ID.test(project)) throw new Error(`not a project id: ${project}`);
  const name = `${project}-${suffix}`;
  if (name.length > MAX_REPO_NAME) throw new Error(`repo name over ${MAX_REPO_NAME} characters: ${name}`);
  return name;
}

/**
 * A file's text on the project's origin at `ref`, `main` by default, or null when it isn't there.
 * Files that decide what an attempt runs or reaches (`.throng/config.yml`, `.npmrc`) are only ever
 * read here, so an attempt can't change them for itself. A failed read throws.
 */
export async function readOriginFile(
  repos: Repos,
  project: string,
  path: string,
  ref = "main",
): Promise<string | null> {
  const file = await repos.readFile(originRepo(project), { ref, path });
  return file === null ? null : file.text();
}

/**
 * The ref to read the origin's `main` at so that several reads all see one commit: its sha, or
 * `main` itself while it has no commits, where every read finds nothing.
 */
export async function originMainRef(repos: Repos, project: string): Promise<string> {
  const [head] = await repos.listCommits(originRepo(project), { ref: "main", limit: 1 });
  return head?.hash ?? "main";
}

/** Awaits a repo read, turning a missing repo (`NOT_FOUND`) into null. */
export async function missingAsNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if ((error as { code?: unknown }).code === "NOT_FOUND") return null;
    throw error;
  }
}

export interface RepoInfo {
  name: string;
  /** HTTPS git remote. Pushes and fetches need a token from `mintToken`. */
  remote: string;
  defaultBranch: string;
  /** The repo this one was forked from, or null. */
  parent: string | null;
}

export type TokenScope = "read" | "write";

export interface RepoToken {
  token: string;
  scope: TokenScope;
  /** ISO 8601. */
  expiresAt: string;
}

export interface Commit {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  /** Unix seconds. */
  authoredAt: number;
  committedAt: number;
}

export const TREE_ENTRY_TYPES = ["tree", "blob", "symlink", "gitlink", "exec"] as const;
export type TreeEntryType = (typeof TREE_ENTRY_TYPES)[number];

export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: TreeEntryType;
}

/** One ref copied from one repo to another: see `Repos.copyRef`. */
export interface CopyRef {
  from: string;
  /** A full ref name in `from`, such as `refs/heads/main`. */
  fromRef: string;
  to: string;
  /** The full ref name to create or force-update in `to`. */
  toRef: string;
  /** When set, the copy fails unless `fromRef` points at this sha. */
  expect?: string | undefined;
}

/**
 * Repos in this environment's namespace. Methods on a repo that doesn't exist throw an error whose
 * `code` is `NOT_FOUND`; creating or forking onto a name that's taken throws `ALREADY_EXISTS`.
 */
export interface Repos {
  /** Creates an empty repo and returns it with a write token for its first push. */
  create: (name: string, opts?: { defaultBranch?: string }) => Promise<RepoInfo & { token: string }>;
  /**
   * Creates `name` as a copy of `branch` of the public git repository at `url`, with its full
   * history and under its own name, `refs/heads/<branch>`, which `HEAD` points at. Resolves once the
   * copy is done. Fails with the binding's import codes (`REMOTE_AUTH_REQUIRED`, `INVALID_URL`,
   * `MEMORY_LIMIT`, …), which `importError` turns into the service's.
   */
  import: (name: string, source: { url: string; branch: string }) => Promise<void>;
  get: (name: string) => Promise<RepoInfo>;
  /** Forks `source`'s default branch into `name`. The fork can take a moment before `get` finds it. */
  fork: (source: string, name: string) => Promise<void>;
  /** Returns whether the repo existed. */
  delete: (name: string) => Promise<boolean>;
  /** Names of the namespace's repos that start with `prefix`, sorted. */
  list: (prefix: string) => Promise<string[]>;
  /** A token for the repo's git remote, valid for `ttl` seconds. */
  mintToken: (name: string, scope: TokenScope, ttl: number) => Promise<RepoToken>;
  /** A file's bytes at `ref`, or null if the ref or path doesn't resolve to a file. */
  readFile: (name: string, args: { ref: string; path: string }) => Promise<Blob | null>;
  /**
   * First-parent history from `ref` (a branch, tag or commit sha), newest first, skipping `offset`
   * commits; empty if the ref doesn't resolve.
   */
  listCommits: (name: string, args: { ref: string; limit: number; offset?: number }) => Promise<Commit[]>;
  /** A commit by its 40-character lowercase sha, or null if the repo has no such commit. */
  readCommit: (name: string, hash: string) => Promise<Commit | null>;
  /** A tree's immediate children by the tree's sha, or null if the repo has no such object. */
  readTree: (name: string, hash: string) => Promise<TreeEntry[] | null>;
  /** A blob's raw bytes by its sha (the `Blob` is untyped), or null if the repo has no such blob. */
  readBlob: (name: string, hash: string) => Promise<Blob | null>;
  /**
   * Points `toRef` in `to` at the commit `fromRef` points at in `from`, copying whatever objects
   * `to` lacks, and returns that commit's sha. Null, with nothing changed, when `fromRef` doesn't
   * exist. `toRef` is force-updated, so it may move to a commit that doesn't descend from it.
   */
  copyRef: (args: CopyRef) => Promise<string | null>;
}
