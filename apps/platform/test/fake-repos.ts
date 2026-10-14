import { createHash } from "node:crypto";
import { concat, flushPkt, pktLine } from "../src/pkt-line.ts";
import type { Commit, CopyRef, RepoInfo, Repos, RepoToken, TokenScope, TreeEntry } from "../src/repos.ts";

/** One call made through the fake, in order. */
export interface RepoCall {
  method: keyof Repos;
  args: unknown[];
}

/** Artifacts' default token lifetime, used for the write token `create` returns. */
const CREATE_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Commit times in the fake start here and tick a minute per commit, so history is deterministic. */
const EPOCH_SECONDS = 1_790_000_000;

/** A file to commit: its content, or its content and how git should classify it. */
export type FakeFile = string | Uint8Array | { content: string | Uint8Array; type: "blob" | "exec" | "symlink" };

/** What `commit` writes: a whole snapshot, as paths to files. Directories come from the paths. */
export interface FakeCommit {
  files: Record<string, FakeFile>;
  /** The branch to commit on and advance; `main` by default. */
  branch?: string;
  message?: string;
  /** Defaults to the branch's head, or none for a root commit. */
  parents?: string[];
  author?: { name: string; email: string };
}

type FakeObject =
  | { kind: "commit"; commit: Commit }
  | { kind: "tree"; entries: TreeEntry[] }
  | { kind: "blob"; bytes: Uint8Array };

interface FakeRepo extends RepoInfo {
  tokens: RepoToken[];
  /** Full ref names (`refs/heads/main`) to commit shas. */
  refs: Map<string, string>;
  /** Git objects by sha. A fork starts with a copy of its source's. */
  objects: Map<string, FakeObject>;
}

const MODES: Record<TreeEntry["type"], string> = {
  blob: "100644",
  exec: "100755",
  symlink: "120000",
  tree: "40000",
  gitlink: "160000",
};

const SHA = /^[0-9a-f]{40}$/u;

/**
 * An in-memory `Repos` for tests. It records every call and holds each repo's metadata, minted
 * tokens, refs and git objects. Tests build history with `commit` (objects get real git shas) and
 * copy refs between repos with `push`; `writeFile` is a shortcut only `readFile` sees.
 */
export class FakeRepos implements Repos {
  readonly calls: RepoCall[] = [];
  readonly #repos = new Map<string, FakeRepo>();
  readonly #files = new Map<string, string>();
  /** Public git sources by URL: the fake repo each one serves, and the branch its HEAD points at. */
  readonly #sources = new Map<string, { name: string; head: string }>();
  #minted = 0;
  #commits = 0;

  constructor(readonly namespace = "throng-test") {}

  /** Every token minted for a repo, including the one `create` returned. */
  tokens(name: string): RepoToken[] {
    return [...(this.#repos.get(name)?.tokens ?? [])];
  }

  /** Makes `readFile(name, {ref, path})` return `content`, as if it were committed there. */
  writeFile(name: string, ref: string, path: string, content: string): void {
    this.#repo(name);
    this.#files.set(fileKey(name, ref, path), content);
  }

  /** Commits a snapshot of `files` to a branch of `name` and returns the commit. Not recorded as a call. */
  commit(name: string, { files, branch = "main", message, parents, author }: FakeCommit): Commit {
    const repo = this.#repo(name);
    const head = repo.refs.get(`refs/heads/${branch}`);
    const at = EPOCH_SECONDS + 60 * ++this.#commits;
    const who = author ?? { name: "Ada", email: "ada@example.com" };
    const commit: Omit<Commit, "hash"> = {
      treeHash: writeTree(repo, files),
      message: message ?? `commit ${this.#commits}`,
      author: who,
      committer: who,
      parents: parents ?? (head === undefined ? [] : [head]),
      authoredAt: at,
      committedAt: at,
    };
    const hash = put(repo, "commit", commitBody(commit), (sha) => ({
      kind: "commit",
      commit: { hash: sha, ...commit },
    }));
    repo.refs.set(`refs/heads/${branch}`, hash);
    return { hash, ...commit };
  }

  /** Copies every object of `from` into `to` and points `to`'s full `ref` at `sha`, as a push would. */
  push(from: string, to: string, ref: string, sha: string): void {
    const source = this.#repo(from);
    const target = this.#repo(to);
    for (const [hash, object] of source.objects) target.objects.set(hash, object);
    target.refs.set(ref, sha);
  }

  /**
   * Serves repo `name` as a public git source at `url`, its HEAD at `head`: `import` copies from it,
   * and `sourceFetch` advertises it as the source's host would.
   */
  serveSource(url: string, name: string, head = "main"): void {
    this.#repo(name);
    this.#sources.set(url, { name, head });
  }

  /**
   * The served sources' hosts over HTTP: `GET <url>.git/info/refs?service=git-upload-pack` answers
   * with an upload-pack advertisement naming HEAD's branch. Anything else is a 401, as GitHub answers
   * for a repo that is private or missing.
   */
  readonly sourceFetch: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const served = [...this.#sources].find(([source]) =>
      url.startsWith(`${source.replace(/\.git$/u, "")}.git/info/refs`),
    );
    if (served === undefined) return new Response("Authentication required", { status: 401 });
    const [, { name, head }] = served;
    const sha = this.#repo(name).refs.get(`refs/heads/${head}`) ?? "0".repeat(40);
    const body = concat([
      pktLine("# service=git-upload-pack\n"),
      flushPkt(),
      pktLine(`${sha} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/${head} agent=fake\n`),
      pktLine(`${sha} refs/heads/${head}\n`),
      flushPkt(),
    ]);
    return new Response(body, { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } });
  };

  async import(name: string, source: { url: string; branch: string }): Promise<void> {
    this.#record("import", name, source);
    const served = this.#sources.get(source.url);
    if (served === undefined) throw repoError("REMOTE_AUTH_REQUIRED", source.url);
    const from = this.#repo(served.name);
    const ref = `refs/heads/${source.branch}`;
    const head = from.refs.get(ref);
    if (head === undefined) throw repoError("NOT_FOUND", `${source.url} ${ref}`);
    // Artifacts reports `main` as the default branch whatever it imported (#223 §2).
    const repo = this.#add(name, "main", null);
    for (const [hash, object] of from.objects) repo.objects.set(hash, object);
    repo.refs.set(ref, head);
  }

  async create(name: string, opts: { defaultBranch?: string } = {}): Promise<RepoInfo & { token: string }> {
    this.#record("create", name, opts);
    const repo = this.#add(name, opts.defaultBranch ?? "main", null);
    const { token } = this.#mint(name, "write", CREATE_TOKEN_TTL_SECONDS);
    return { ...info(repo), token };
  }

  async get(name: string): Promise<RepoInfo> {
    this.#record("get", name);
    return info(this.#repo(name));
  }

  async fork(source: string, name: string): Promise<void> {
    this.#record("fork", source, name);
    const from = this.#repo(source);
    const fork = this.#add(name, from.defaultBranch, source);
    for (const [hash, object] of from.objects) fork.objects.set(hash, object);
    const branch = `refs/heads/${from.defaultBranch}`;
    const head = from.refs.get(branch);
    if (head !== undefined) fork.refs.set(branch, head);
  }

  async delete(name: string): Promise<boolean> {
    this.#record("delete", name);
    return this.#repos.delete(name);
  }

  async list(prefix: string): Promise<string[]> {
    this.#record("list", prefix);
    return [...this.#repos.keys()].filter((n) => n.startsWith(prefix)).toSorted();
  }

  async mintToken(name: string, scope: TokenScope, ttl: number): Promise<RepoToken> {
    this.#record("mintToken", name, scope, ttl);
    return this.#mint(name, scope, ttl);
  }

  async readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null> {
    this.#record("readFile", name, args);
    const repo = this.#repo(name);
    const content = this.#files.get(fileKey(name, args.ref, args.path));
    if (content !== undefined) return new Blob([content]);
    const commit = resolve(repo, args.ref);
    if (commit === null) return null;
    let hash: string | undefined = commit.treeHash;
    for (const part of args.path.split("/")) {
      const object: FakeObject | undefined = hash === undefined ? undefined : repo.objects.get(hash);
      hash = object?.kind === "tree" ? object.entries.find((e) => e.name === part)?.hash : undefined;
    }
    const blob = hash === undefined ? undefined : repo.objects.get(hash);
    return blob?.kind === "blob" ? new Blob([blob.bytes]) : null;
  }

  async listCommits(name: string, args: { ref: string; limit: number; offset?: number }): Promise<Commit[]> {
    this.#record("listCommits", name, args);
    const repo = this.#repo(name);
    const found: Commit[] = [];
    for (let commit = resolve(repo, args.ref); commit !== null;) {
      found.push(commit);
      const parent = commit.parents[0];
      const object = parent === undefined ? undefined : repo.objects.get(parent);
      commit = object?.kind === "commit" ? object.commit : null;
    }
    const offset = args.offset ?? 0;
    return found.slice(offset, offset + args.limit);
  }

  async readCommit(name: string, hash: string): Promise<Commit | null> {
    this.#record("readCommit", name, hash);
    const object = this.#object(name, hash);
    return object?.kind === "commit" ? object.commit : null;
  }

  async readTree(name: string, hash: string): Promise<TreeEntry[] | null> {
    this.#record("readTree", name, hash);
    const object = this.#object(name, hash);
    return object?.kind === "tree" ? object.entries.map((e) => ({ ...e })) : null;
  }

  async readBlob(name: string, hash: string): Promise<Blob | null> {
    this.#record("readBlob", name, hash);
    const object = this.#object(name, hash);
    return object?.kind === "blob" ? new Blob([object.bytes]) : null;
  }

  async copyRef(args: CopyRef): Promise<string | null> {
    this.#record("copyRef", args);
    const target = this.#repo(args.to);
    const sha = this.#repo(args.from).refs.get(args.fromRef) ?? null;
    if (sha === null) return null;
    if (args.expect !== undefined && sha !== args.expect) throw new Error(`${args.fromRef} is at ${sha}`);
    for (const [hash, object] of this.#repo(args.from).objects) target.objects.set(hash, object);
    target.refs.set(args.toRef, sha);
    return sha;
  }

  /** The sha a full ref name points at in a repo, or null. */
  ref(name: string, ref: string): string | null {
    return this.#repo(name).refs.get(ref) ?? null;
  }

  /** Points a full ref name in a repo at `sha`, as if it had been pushed there. */
  setRef(name: string, ref: string, sha: string): void {
    this.#repo(name).refs.set(ref, sha);
  }

  #record(method: keyof Repos, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  #add(name: string, defaultBranch: string, parent: string | null): FakeRepo {
    if (this.#repos.has(name)) throw repoError("ALREADY_EXISTS", name);
    const remote = `https://artifacts.test/git/${this.namespace}/${name}.git`;
    const repo: FakeRepo = { name, remote, defaultBranch, parent, tokens: [], refs: new Map(), objects: new Map() };
    this.#repos.set(name, repo);
    return repo;
  }

  #repo(name: string): FakeRepo {
    const repo = this.#repos.get(name);
    if (repo === undefined) throw repoError("NOT_FOUND", name);
    return repo;
  }

  /** An object by sha, read as the binding does: a malformed sha throws `INVALID_INPUT`. */
  #object(name: string, hash: string): FakeObject | undefined {
    const repo = this.#repo(name);
    if (!SHA.test(hash)) throw repoError("INVALID_INPUT", hash);
    return repo.objects.get(hash);
  }

  #mint(name: string, scope: TokenScope, ttl: number): RepoToken {
    const token = {
      token: `fake-${scope}-${++this.#minted}`,
      scope,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
    this.#repo(name).tokens.push(token);
    return token;
  }
}

/** A branch, tag, full ref name or commit sha, resolved as the binding's `log` and `readFile` do. */
function resolve(repo: FakeRepo, ref: string): Commit | null {
  const sha = SHA.test(ref)
    ? ref
    : (repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`));
  const object = sha === undefined ? undefined : repo.objects.get(sha);
  return object?.kind === "commit" ? object.commit : null;
}

/** Writes `files` as nested trees into `repo` and returns the root tree's sha. */
function writeTree(repo: FakeRepo, files: Record<string, FakeFile>): string {
  const here = new Map<string, FakeFile>();
  const below = new Map<string, Record<string, FakeFile>>();
  for (const [path, file] of Object.entries(files)) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      here.set(path, file);
    } else {
      const dir = path.slice(0, slash);
      below.set(dir, { ...below.get(dir), [path.slice(slash + 1)]: file });
    }
  }
  const entries: TreeEntry[] = [];
  for (const [name, file] of here) {
    const { content, type } =
      typeof file === "string" || file instanceof Uint8Array ? { content: file, type: "blob" as const } : file;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const hash = put(repo, "blob", bytes, () => ({ kind: "blob", bytes }));
    entries.push({ name, mode: MODES[type], hash, type });
  }
  for (const [name, sub] of below) {
    entries.push({ name, mode: MODES.tree, hash: writeTree(repo, sub), type: "tree" });
  }
  entries.sort((a, b) => Buffer.compare(treeOrderKey(a), treeOrderKey(b)));
  const body = Buffer.concat(
    entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.hash, "hex")])),
  );
  return put(repo, "tree", body, () => ({ kind: "tree", entries }));
}

/** Git orders a tree's entries by name, comparing a directory's name as if it ended in "/". */
function treeOrderKey(e: TreeEntry): Buffer {
  return Buffer.from(e.type === "tree" ? `${e.name}/` : e.name);
}

function commitBody(c: Omit<Commit, "hash">): Uint8Array {
  const lines = [
    `tree ${c.treeHash}`,
    ...c.parents.map((p) => `parent ${p}`),
    `author ${c.author.name} <${c.author.email}> ${c.authoredAt} +0000`,
    `committer ${c.committer.name} <${c.committer.email}> ${c.committedAt} +0000`,
    "",
    `${c.message}\n`,
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

/** Stores an object under its git sha (the SHA-1 of `<kind> <size>\0<body>`) and returns the sha. */
function put(repo: FakeRepo, kind: string, body: Uint8Array, make: (sha: string) => FakeObject): string {
  const sha = createHash("sha1").update(`${kind} ${body.length}\0`).update(body).digest("hex");
  repo.objects.set(sha, make(sha));
  return sha;
}

function fileKey(name: string, ref: string, path: string): string {
  return JSON.stringify([name, ref, path]);
}

function info({ name, remote, defaultBranch, parent }: RepoInfo): RepoInfo {
  return { name, remote, defaultBranch, parent };
}

/** Shaped like the binding's `ArtifactsError`, so callers can match on `code` either way. */
function repoError(
  code: "NOT_FOUND" | "ALREADY_EXISTS" | "INVALID_INPUT" | "REMOTE_AUTH_REQUIRED",
  name: string,
): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${name}`), { name: "ArtifactsError", code });
}
