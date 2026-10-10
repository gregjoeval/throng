import type { Commit, RepoInfo, Repos, RepoToken, Tree, TokenScope } from "../src/repos.ts";

/** One call made through the fake, in order. */
export interface RepoCall {
  method: keyof Repos;
  args: unknown[];
}

/** Artifacts' default token lifetime, used for the write token `create` returns. */
const CREATE_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * An in-memory `Repos` for tests. It records every call and holds each repo's metadata and minted
 * tokens. It has no history: commit and tree reads come back empty, and `readFile` returns only
 * what a test put there with `writeFile`.
 */
export class FakeRepos implements Repos {
  readonly calls: RepoCall[] = [];
  readonly #repos = new Map<string, RepoInfo & { tokens: RepoToken[] }>();
  readonly #files = new Map<string, string>();
  #minted = 0;

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
    this.#add(name, this.#repo(source).defaultBranch, source);
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
    this.#repo(name);
    const content = this.#files.get(fileKey(name, args.ref, args.path));
    return content === undefined ? null : new Blob([content]);
  }

  async listCommits(name: string, args: { ref: string; limit: number }): Promise<Commit[]> {
    this.#record("listCommits", name, args);
    this.#repo(name);
    return [];
  }

  async readTree(name: string, args: { ref: string; path: string }): Promise<Tree | null> {
    this.#record("readTree", name, args);
    this.#repo(name);
    return null;
  }

  #record(method: keyof Repos, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  #add(name: string, defaultBranch: string, parent: string | null): RepoInfo & { tokens: RepoToken[] } {
    if (this.#repos.has(name)) throw repoError("ALREADY_EXISTS", name);
    const remote = `https://artifacts.test/git/${this.namespace}/${name}.git`;
    const repo = { name, remote, defaultBranch, parent, tokens: [] };
    this.#repos.set(name, repo);
    return repo;
  }

  #repo(name: string): RepoInfo & { tokens: RepoToken[] } {
    const repo = this.#repos.get(name);
    if (repo === undefined) throw repoError("NOT_FOUND", name);
    return repo;
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

function fileKey(name: string, ref: string, path: string): string {
  return JSON.stringify([name, ref, path]);
}

function info({ name, remote, defaultBranch, parent }: RepoInfo): RepoInfo {
  return { name, remote, defaultBranch, parent };
}

/** Shaped like the binding's `ArtifactsError`, so callers can match on `code` either way. */
function repoError(code: "NOT_FOUND" | "ALREADY_EXISTS", name: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${name}`), { name: "ArtifactsError", code });
}
