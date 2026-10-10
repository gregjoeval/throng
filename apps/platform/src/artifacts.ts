import type { Commit, RepoInfo, Repos, RepoToken, Tree, TokenScope } from "./repos";

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

  async mintToken(name: string, scope: TokenScope, ttl: number): Promise<RepoToken> {
    using repo = await this.#artifacts.get(name);
    const token = await repo.createToken(scope, ttl);
    return { token: token.plaintext, scope: token.scope, expiresAt: token.expiresAt };
  }

  async readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null> {
    using repo = await this.#artifacts.get(name);
    return repo.readFile(args);
  }

  async listCommits(name: string, args: { ref: string; limit: number }): Promise<Commit[]> {
    using repo = await this.#artifacts.get(name);
    return repo.log(args);
  }

  async readTree(name: string, { ref, path }: { ref: string; path: string }): Promise<Tree | null> {
    using repo = await this.#artifacts.get(name);
    const [head] = await repo.log({ ref, limit: 1 });
    if (head === undefined) return null;
    let tree = head.treeHash;
    for (const part of path.split("/").filter(Boolean)) {
      const next = (await repo.readTree(tree))?.find((e) => e.name === part && e.type === "tree");
      if (next === undefined) return null;
      tree = next.hash;
    }
    const entries = await repo.readTree(tree);
    return entries === null ? null : { commit: head.hash, tree, entries };
  }
}

/** A fork's `source` reads `artifacts:<namespace>/<repo>`; anything else (an import, or none) has no parent here. */
function parentOf(source: string | null): string | null {
  const match = /^artifacts:[^/]+\/(.+)$/.exec(source ?? "");
  return match?.[1] ?? null;
}
