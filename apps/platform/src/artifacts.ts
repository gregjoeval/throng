import { copyRepoRef } from "./git-client.ts";
import type { Commit, CopyRef, RepoInfo, Repos, RepoToken, TokenScope, TreeEntry } from "./repos";

/** The most repos Artifacts returns per `list` page. */
const LIST_PAGE_SIZE = 200;

/** The environment's repos. The only place that touches the Artifacts binding. */
export function reposFor(env: Pick<Env, "ARTIFACTS">): Repos {
  return new ArtifactsRepos(env.ARTIFACTS);
}

/** `Repos` over the Artifacts binding. The namespace is the binding's, set per environment. */
class ArtifactsRepos implements Repos {
  readonly #artifacts: Artifacts;

  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }

  async create(name: string, opts: { defaultBranch?: string } = {}): Promise<RepoInfo & { token: string }> {
    const repo = await this.#artifacts.create(name, { setDefaultBranch: opts.defaultBranch ?? "main" });
    return { name: repo.name, remote: repo.remote, defaultBranch: repo.defaultBranch, parent: null, token: repo.token };
  }

  async get(name: string): Promise<RepoInfo> {
    using repo = await this.#artifacts.get(name);
    const info = await repo.info();
    return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch, parent: parentOf(info.source) };
  }

  async fork(source: string, name: string): Promise<void> {
    using repo = await this.#artifacts.get(source);
    await repo.fork(name, { defaultBranchOnly: true });
  }

  async delete(name: string): Promise<boolean> {
    return this.#artifacts.delete(name);
  }

  async list(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#artifacts.list(
        cursor === undefined ? { limit: LIST_PAGE_SIZE } : { limit: LIST_PAGE_SIZE, cursor },
      );
      names.push(...page.repos.map((r) => r.name).filter((n) => n.startsWith(prefix)));
      cursor = page.cursor;
    } while (cursor !== undefined);
    return names.toSorted();
  }

  async mintToken(name: string, scope: TokenScope, ttl: number): Promise<RepoToken> {
    using repo = await this.#artifacts.get(name);
    const token = await repo.createToken(scope, ttl);
    return { token: token.plaintext, scope: token.scope, expiresAt: token.expiresAt };
  }

  async readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null> {
    using repo = await this.#artifacts.get(name);
    return repo.readFile(args);
  }

  async listCommits(name: string, args: { ref: string; limit: number; offset?: number }): Promise<Commit[]> {
    using repo = await this.#artifacts.get(name);
    return repo.log(args);
  }

  async readCommit(name: string, hash: string): Promise<Commit | null> {
    using repo = await this.#artifacts.get(name);
    return repo.readCommit(hash);
  }

  async readTree(name: string, hash: string): Promise<TreeEntry[] | null> {
    using repo = await this.#artifacts.get(name);
    return repo.readTree(hash);
  }

  async readBlob(name: string, hash: string): Promise<Blob | null> {
    using repo = await this.#artifacts.get(name);
    return repo.readBlob(hash);
  }

  /**
   * The binding can't write refs, so this speaks git to the two remotes from the Worker (see
   * `git-client.ts`) with tokens minted here. It never passes through the public `/git` proxy.
   */
  async copyRef(args: CopyRef): Promise<string | null> {
    return copyRepoRef(this, (input, init) => fetch(input, init), args);
  }
}

/** A fork's `source` reads `artifacts:<namespace>/<repo>`; anything else (an import, or none) has no parent here. */
function parentOf(source: string | null): string | null {
  const match = /^artifacts:[^/]+\/(.+)$/.exec(source ?? "");
  return match?.[1] ?? null;
}
