// The Repos seam: every Artifacts call goes through this interface. Production wraps the binding
// (`artifacts.ts`); tests use the in-memory fake (`test/fake-repos.ts`).

/** Artifacts caps repo names at 63 characters. */
export const MAX_REPO_NAME = 63;

const PROJECT_ID = /^[a-z0-9]+$/;
const ATTEMPT = /^t[1-9]\d*a[1-9]\d*$/;
const ORIGIN_SUFFIX = "main";

/** What a repo name says: a project's origin, or the fork of one of its attempts. */
export type RepoName = { kind: "origin"; project: string } | { kind: "fork"; project: string; attempt: string };

/** The origin's repo: `<projectId>-main`. */
export function originRepo(project: string): string {
  return repoName(project, ORIGIN_SUFFIX);
}

/** An attempt fork's repo, named after the attempt: `<projectId>-t42a3`. */
export function forkRepo(project: string, attempt: string): string {
  if (!ATTEMPT.test(attempt)) throw new Error(`not an attempt: ${attempt}`);
  return repoName(project, attempt);
}

/** Reads a repo name back; null for anything that isn't an origin or attempt fork name. */
export function parseRepoName(name: string): RepoName | null {
  const at = name.lastIndexOf("-");
  const project = name.slice(0, at);
  const suffix = name.slice(at + 1);
  if (at === -1 || !PROJECT_ID.test(project)) return null;
  if (suffix === ORIGIN_SUFFIX) return { kind: "origin", project };
  if (ATTEMPT.test(suffix)) return { kind: "fork", project, attempt: suffix };
  return null;
}

function repoName(project: string, suffix: string): string {
  if (!PROJECT_ID.test(project)) throw new Error(`not a project id: ${project}`);
  const name = `${project}-${suffix}`;
  if (name.length > MAX_REPO_NAME) throw new Error(`repo name over ${MAX_REPO_NAME} characters: ${name}`);
  return name;
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

export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/** A directory listing: the commit `ref` resolved to, the directory's tree, and its entries. */
export interface Tree {
  commit: string;
  tree: string;
  entries: TreeEntry[];
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
  create(name: string, opts?: { defaultBranch?: string }): Promise<RepoInfo & { token: string }>;
  get(name: string): Promise<RepoInfo>;
  /** Forks `source`'s default branch into `name`. The fork can take a moment before `get` finds it. */
  fork(source: string, name: string): Promise<void>;
  /** Returns whether the repo existed. */
  delete(name: string): Promise<boolean>;
  /** Names of the namespace's repos that start with `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  /** A token for the repo's git remote, valid for `ttl` seconds. */
  mintToken(name: string, scope: TokenScope, ttl: number): Promise<RepoToken>;
  /** A file's bytes at `ref`, or null if the ref or path doesn't resolve to a file. */
  readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null>;
  /** First-parent history from `ref`, newest first; empty if the ref doesn't resolve. */
  listCommits(name: string, args: { ref: string; limit: number }): Promise<Commit[]>;
  /** The directory at `path` (the root when empty) at `ref`, or null if either doesn't resolve. */
  readTree(name: string, args: { ref: string; path: string }): Promise<Tree | null>;
  /**
   * Points `toRef` in `to` at the commit `fromRef` points at in `from`, copying whatever objects
   * `to` lacks, and returns that commit's sha. Null, with nothing changed, when `fromRef` doesn't
   * exist. `toRef` is force-updated, so it may move to a commit that doesn't descend from it.
   */
  copyRef(args: CopyRef): Promise<string | null>;
}
