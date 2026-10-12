import { describe, expect, it } from "vitest";
import { DIFF_CAPS, DIFF_VERSION, diffCommit, diffCommits, diffFile, unifiedPatch } from "../src/diff.ts";
import type { DiffCache, DiffCaps } from "../src/diff.ts";
import { FakeRepos } from "./fake-repos.ts";
import { at, defined } from "./support/defined.ts";

const REPO = "p1-main";
const FORK = "p1-t1a1";

/** Two commits on one repo, the second's diff read back. */
async function twoCommits(before: Parameters<FakeRepos["commit"]>[1]["files"], after: typeof before) {
  const repos = new FakeRepos();
  await repos.create(REPO);
  const parent = repos.commit(REPO, { files: before });
  const child = repos.commit(REPO, { files: after });
  const diff = await diffCommit(repos, REPO, child.hash);
  return { repos, parent, child, diff: defined(diff, "a diff") };
}

describe("diffCommit", () => {
  it("diffs a modified file against the first parent, with git headers", async () => {
    const { diff, parent, child } = await twoCommits(
      { "src/a.txt": "one\ntwo\nthree\n", "keep.txt": "same\n" },
      { "src/a.txt": "one\nTWO\nthree\n", "keep.txt": "same\n" },
    );
    expect(diff.sha).toBe(child.hash);
    expect(diff.parent).toBe(parent.hash);
    expect(diff.files).toHaveLength(1);
    const file = at(diff.files, 0);
    expect(file).toMatchObject({
      path: "src/a.txt",
      status: "modified",
      oldMode: "100644",
      newMode: "100644",
      additions: 1,
      deletions: 1,
      flags: [],
    });
    expect(file.patch).toBe(
      [
        "diff --git a/src/a.txt b/src/a.txt",
        `index ${file.oldHash}..${file.newHash} 100644`,
        "--- a/src/a.txt",
        "+++ b/src/a.txt",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        "",
      ].join("\n"),
    );
    expect(diff.totals).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(diff.truncated).toBeFalsy();
  });

  it("writes an added file against /dev/null, with no newline at its end marked", async () => {
    const { diff } = await twoCommits({ "a.txt": "a\n" }, { "a.txt": "a\n", "new.txt": "x\ny" });
    const file = at(diff.files, 0);
    expect(file).toMatchObject({ path: "new.txt", status: "added", oldMode: null, oldHash: null, additions: 2 });
    expect(file.patch).toBe(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        `index ${"0".repeat(40)}..${file.newHash}`,
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+x",
        "+y",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("writes a deleted file", async () => {
    const { diff } = await twoCommits({ "a.txt": "a\n", "gone.txt": "bye\n" }, { "a.txt": "a\n" });
    const file = at(diff.files, 0);
    expect(file).toMatchObject({ path: "gone.txt", status: "deleted", newMode: null, newHash: null, deletions: 1 });
    expect(file.patch).toBe(
      [
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        `index ${file.oldHash}..${"0".repeat(40)}`,
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "",
      ].join("\n"),
    );
  });

  it("writes a mode change with no content change as headers only", async () => {
    const { diff } = await twoCommits({ "run.sh": "echo hi\n" }, { "run.sh": { content: "echo hi\n", type: "exec" } });
    expect(diff.files).toEqual([
      expect.objectContaining({ path: "run.sh", status: "modified", oldMode: "100644", newMode: "100755", flags: [] }),
    ]);
    expect(at(diff.files, 0).patch).toBe("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n");
  });

  it("pairs an exact rename by blob hash and writes no hunks", async () => {
    const { diff } = await twoCommits({ "old/name.txt": "same\n" }, { "new/name.txt": "same\n" });
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "new/name.txt",
      oldPath: "old/name.txt",
      status: "renamed",
      additions: 0,
      deletions: 0,
    });
    expect(at(diff.files, 0).patch).toBe(
      [
        "diff --git a/old/name.txt b/new/name.txt",
        "similarity index 100%",
        "rename from old/name.txt",
        "rename to new/name.txt",
        "",
      ].join("\n"),
    );
  });

  it("flags a binary file and gives it no patch", async () => {
    const { diff } = await twoCommits(
      { "img.png": new Uint8Array([0x89, 0x50, 0, 1]) },
      { "img.png": new Uint8Array([0x89, 0x50, 0, 2]) },
    );
    expect(diff.files[0]).toMatchObject({ path: "img.png", status: "modified", flags: ["binary"] });
    expect(diff.files[0]).not.toHaveProperty("patch");
  });

  it("diffs a root commit against the empty tree", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const root = repos.commit(REPO, { files: { "b.txt": "b\n", "a/z.txt": "z\n" } });
    const diff = defined(await diffCommit(repos, REPO, root.hash));
    expect(diff.parent).toBeNull();
    expect(diff.oldTree).toBeNull();
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ["a/z.txt", "added"],
      ["b.txt", "added"],
    ]);
  });

  it("diffs a merge commit against its first parent only", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const base = repos.commit(REPO, { files: { "a.txt": "a\n" } });
    const first = repos.commit(REPO, { files: { "a.txt": "a\n", "main.txt": "m\n" } });
    const side = repos.commit(REPO, {
      branch: "side",
      parents: [base.hash],
      files: { "a.txt": "a\n", "side.txt": "s\n" },
    });
    const merge = repos.commit(REPO, {
      parents: [first.hash, side.hash],
      files: { "a.txt": "a\n", "main.txt": "m\n", "side.txt": "s\n" },
    });
    const diff = defined(await diffCommit(repos, REPO, merge.hash));
    expect(diff.parent).toBe(first.hash);
    expect(diff.files.map((f) => f.path)).toEqual(["side.txt"]);
  });

  it("sorts paths byte-wise across directories and skips unchanged subtrees", async () => {
    const { diff, repos, parent } = await twoCommits(
      { "a.b": "1\n", "a/c": "1\n", Z: "1\n", "same/deep/x": "1\n" },
      { "a.b": "2\n", "a/c": "2\n", Z: "2\n", "same/deep/x": "1\n" },
    );
    expect(diff.files.map((f) => f.path)).toEqual(["Z", "a.b", "a/c"]);
    const root = await repos.readTree(REPO, parent.treeHash);
    const same = defined(
      root?.find((e) => e.name === "same"),
      "the unchanged entry",
    ).hash;
    expect(repos.calls.filter((c) => c.method === "readTree" && c.args[1] === same)).toHaveLength(0);
  });

  it("writes a file turned into a symlink as a delete and an add, like git", async () => {
    const { diff } = await twoCommits({ link: "text\n" }, { link: { content: "target", type: "symlink" } });
    expect(diff.files.map((f) => [f.status, f.oldMode, f.newMode])).toEqual([
      ["deleted", "100644", null],
      ["added", null, "120000"],
    ]);
  });

  it("returns null for a commit the repo doesn't have", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    expect(await diffCommit(repos, REPO, "a".repeat(40))).toBeNull();
  });
});

/** The default caps, with the ones under test overridden. */
function caps(overrides: Partial<DiffCaps>): DiffCaps {
  return { ...DIFF_CAPS, ...overrides };
}

async function diffWith(before: Record<string, string>, after: Record<string, string>, limits: DiffCaps) {
  const repos = new FakeRepos();
  await repos.create(REPO);
  repos.commit(REPO, { files: before });
  const child = repos.commit(REPO, { files: after });
  return defined(await diffCommit(repos, REPO, child.hash, { caps: limits }));
}

const numbered = (n: number, value: string) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(2, "0")}.txt`, value]));

/** A lockfile-shaped text whose entries reorder with `seed`: hard for Myers, as in the research. */
const lockfile = (seed: number, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `"pkg-${(i * seed) % 9973}@^${i % 7}.${seed}.0":\n  version "${i}.${seed}"\n`,
  ).join("");

/** Two changed lines with ten unchanged between them: two hunks. */
const far = (a: string, b: string) => `${a}\n${"same\n".repeat(10)}${b}\n`;

describe("diffCommit caps", () => {
  it("stops listing at maxFiles and marks the diff truncated", async () => {
    const diff = await diffWith(numbered(5, "a\n"), numbered(5, "b\n"), caps({ maxFiles: 3 }));
    expect(diff.files.map((f) => f.path)).toEqual(["f00.txt", "f01.txt", "f02.txt"]);
    expect(diff.truncated).toBeTruthy();
    expect(diff.totals.files).toBe(3);
  });

  it("is not truncated when exactly maxFiles changed", async () => {
    const diff = await diffWith(numbered(3, "a\n"), numbered(3, "b\n"), caps({ maxFiles: 3 }));
    expect(diff.truncated).toBeFalsy();
  });

  it("lists files past maxPatchedFiles without a patch, flagged truncated", async () => {
    const diff = await diffWith(numbered(4, "a\n"), numbered(4, "b\n"), caps({ maxPatchedFiles: 2 }));
    expect(diff.files.map((f) => [f.flags, f.patch !== undefined])).toEqual([
      [[], true],
      [[], true],
      [["truncated"], false],
      [["truncated"], false],
    ]);
    expect(diff.truncated).toBeFalsy();
  });

  it("flags a file with either side over maxBlobBytes tooLarge, without a patch", async () => {
    const before = { "big.txt": `${"x".repeat(50)}\n` };
    const diff = await diffWith(before, { "big.txt": "small\n" }, caps({ maxBlobBytes: 40 }));
    expect(diff.files[0]).toMatchObject({ flags: ["tooLarge"], additions: 0, deletions: 0 });
    expect(diff.files[0]).not.toHaveProperty("patch");
  });

  it("flags a file over maxEditLength tooComplex, without a patch", async () => {
    const diff = await diffWith({ "a.txt": "1\n2\n3\n4\n" }, { "a.txt": "5\n6\n7\n8\n" }, caps({ maxEditLength: 2 }));
    expect(diff.files[0]).toMatchObject({ flags: ["tooComplex"] });
    expect(diff.files[0]).not.toHaveProperty("patch");
  });

  it("gives up quickly on a pathological lockfile rewrite", async () => {
    const started = performance.now();
    const diff = await diffWith({ "yarn.lock": lockfile(3, 3000) }, { "yarn.lock": lockfile(7, 4000) }, DIFF_CAPS);
    expect(diff.files[0]).toMatchObject({ path: "yarn.lock", flags: ["tooComplex"] });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stops adding hunks at maxPatchLines, truncating the file it cuts and dropping later ones", async () => {
    // Changes ten lines apart make two hunks of 6 lines each, after 4 header lines.
    const diff = await diffWith(
      { "a.txt": far("1", "2"), "b.txt": far("1", "2"), "c.txt": far("1", "2") },
      { "a.txt": far("x", "y"), "b.txt": far("x", "y"), "c.txt": far("x", "y") },
      // a.txt takes 16 lines; b.txt's headers and first hunk take the last 10.
      caps({ maxPatchLines: 26 }),
    );
    const [a, b, c] = [at(diff.files, 0), at(diff.files, 1), at(diff.files, 2)];
    expect(a.flags).toEqual([]);
    expect(b.flags).toEqual(["truncated"]);
    expect(defined(b.patch).match(/^@@/gmu)).toHaveLength(1);
    expect(b).toMatchObject({ additions: 2, deletions: 2 });
    expect(c.flags).toEqual(["truncated"]);
    expect(c).not.toHaveProperty("patch");
  });

  it("stops adding hunks at maxPatchBytes", async () => {
    // Each file's patch is 165 bytes.
    const diff = await diffWith(
      { "a.txt": "1\n", "b.txt": "1\n" },
      { "a.txt": "2\n", "b.txt": "2\n" },
      caps({ maxPatchBytes: 250 }),
    );
    expect(at(diff.files, 0).flags).toEqual([]);
    expect(diff.files[1]).toMatchObject({ flags: ["truncated"] });
    expect(diff.files[1]).not.toHaveProperty("patch");
    expect(unifiedPatch(diff)).toHaveLength(165);
  });
});

/** A Cache API stand-in: responses by URL, in memory. */
class MemoryCache implements DiffCache {
  readonly entries = new Map<string, Response>();
  async match(key: Request): Promise<Response | undefined> {
    return this.entries.get(key.url)?.clone();
  }
  async put(key: Request, res: Response): Promise<void> {
    this.entries.set(key.url, res.clone());
  }
}

describe("diffCommit cache", () => {
  it("reuses a cached tree pair, reading no blobs the second time", async () => {
    const { repos, child } = await twoCommits({ "a.txt": "1\n" }, { "a.txt": "2\n" });
    const cache = new MemoryCache();
    const first = await diffCommit(repos, REPO, child.hash, { cache });
    const reads = repos.calls.length;
    const second = await diffCommit(repos, REPO, child.hash, { cache });
    expect(second).toEqual(first);
    expect(repos.calls.slice(reads).map((c) => c.method)).not.toContain("readBlob");
    expect(repos.calls.slice(reads).map((c) => c.method)).not.toContain("readTree");
  });

  it("keys the cache by the caps and the diff version too", async () => {
    const { repos, child, parent } = await twoCommits({ "a.txt": "1\n" }, { "a.txt": "2\n" });
    const cache = new MemoryCache();
    await diffCommit(repos, REPO, child.hash, { cache });
    await diffCommit(repos, REPO, child.hash, { cache, caps: caps({ maxFiles: 10 }) });
    expect(cache.entries.size).toBe(2);
    for (const key of cache.entries.keys()) {
      expect(key).toContain(parent.treeHash);
      expect(key).toContain(child.treeHash);
      expect(key).toContain(`v${DIFF_VERSION}`);
    }
  });
});

describe("diffFile", () => {
  it("diffs one file from two blob hashes, on its own", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const base = repos.commit(REPO, { files: { "a.txt": "one\n" } });
    const side = repos.commit(REPO, { files: { "a.txt": "two\n" } });
    const hash = async (tree: string) => at(defined(await repos.readTree(REPO, tree)), 0).hash;
    const [oldHash, newHash] = [await hash(base.treeHash), await hash(side.treeHash)];

    const file = await diffFile(
      repos,
      REPO,
      { path: "a.txt", mode: "100644", hash: oldHash },
      { path: "a.txt", mode: "100644", hash: newHash },
    );
    expect(file.patch).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        `index ${oldHash}..${newHash} 100644`,
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-one",
        "+two",
        "",
      ].join("\n"),
    );

    const moved = await diffFile(
      repos,
      REPO,
      { path: "a.txt", mode: "100644", hash: oldHash },
      { path: "b.txt", mode: "100644", hash: newHash },
    );
    expect(moved.status).toBe("renamed");
    expect(moved.patch).toMatch(/^diff --git a\/a.txt b\/b.txt\nrename from a.txt\nrename to b.txt\nindex /u);
  });
});

describe("diffCommits", () => {
  it("diffs a base against a head several commits on, as one change", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const base = repos.commit(REPO, { files: { "a.txt": "1\n", "b.txt": "b\n" } });
    repos.commit(REPO, { files: { "a.txt": "2\n", "b.txt": "b\n" } });
    const head = repos.commit(REPO, { files: { "a.txt": "3\n", "c.txt": "c\n" } });

    const diff = defined(
      await diffCommits(repos, { repo: REPO, sha: base.hash }, { repo: REPO, sha: head.hash }),
      "a diff",
    );
    expect(diff).toMatchObject({
      from: base.hash,
      to: head.hash,
      oldTree: base.treeHash,
      newTree: head.treeHash,
      truncated: false,
      totals: { files: 3, additions: 2, deletions: 2 },
    });
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "deleted"],
      ["c.txt", "added"],
    ]);
    expect(at(diff.files, 0).patch).toContain("@@ -1 +1 @@\n-1\n+3\n");
  });

  it("diffs main against a fork's head, reading each side from its own repo", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    repos.commit(REPO, { files: { "a.txt": "a\n", "m.txt": "m\n" } });
    await repos.fork(REPO, FORK);
    const head = repos.commit(FORK, { files: { "a.txt": "attempt\n", "m.txt": "m\n" } });
    // Unrelated work lands on main after the fork, so the fork has none of its objects.
    const main = repos.commit(REPO, { files: { "a.txt": "a\n", "m.txt": "main moved\n" } });
    expect(await repos.readCommit(FORK, main.hash)).toBeNull();

    const diff = defined(await diffCommits(repos, { repo: REPO, sha: main.hash }, { repo: FORK, sha: head.hash }));
    // Two trees, compared as they are: main's own change shows up undone on the head's side.
    expect(diff.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["a.txt", 1, 1],
      ["m.txt", 1, 1],
    ]);
    expect(at(diff.files, 0).patch).toContain("-a\n+attempt\n");
    expect(at(diff.files, 1).patch).toContain("-main moved\n+m\n");
  });

  it("is empty for two commits with the same tree", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const one = repos.commit(REPO, { files: { "a.txt": "a\n" }, message: "one" });
    const two = repos.commit(REPO, { files: { "a.txt": "a\n" }, message: "two" });
    const diff = await diffCommits(repos, { repo: REPO, sha: one.hash }, { repo: REPO, sha: two.hash });
    expect(diff).toEqual({
      from: one.hash,
      to: two.hash,
      oldTree: one.treeHash,
      newTree: one.treeHash,
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      truncated: false,
    });
  });

  it("is null when either commit is missing", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const one = repos.commit(REPO, { files: { "a.txt": "a\n" } });
    const missing = { repo: REPO, sha: "a".repeat(40) };
    expect(await diffCommits(repos, missing, { repo: REPO, sha: one.hash })).toBeNull();
    expect(await diffCommits(repos, { repo: REPO, sha: one.hash }, missing)).toBeNull();
  });

  it("applies the caps", async () => {
    const repos = new FakeRepos();
    await repos.create(REPO);
    const from = repos.commit(REPO, { files: { ...numbered(4, "a\n"), "big.txt": `${"x".repeat(50)}\n` } });
    const to = repos.commit(REPO, { files: { ...numbered(4, "b\n"), "big.txt": "small\n" } });
    const limits = caps({ maxFiles: 4, maxPatchedFiles: 2, maxBlobBytes: 40 });
    const diff = defined(
      await diffCommits(repos, { repo: REPO, sha: from.hash }, { repo: REPO, sha: to.hash }, { caps: limits }),
    );
    expect(diff.truncated).toBeTruthy();
    expect(diff.files.map((f) => [f.path, f.flags, f.patch !== undefined])).toEqual([
      ["big.txt", ["tooLarge"], false],
      ["f00.txt", [], true],
      ["f01.txt", ["truncated"], false],
      ["f02.txt", ["truncated"], false],
    ]);
  });

  it("shares the commit diff's cache entry for the same tree pair", async () => {
    const { repos, parent, child } = await twoCommits({ "a.txt": "1\n" }, { "a.txt": "2\n" });
    const cache = new MemoryCache();
    const commit = defined(await diffCommit(repos, REPO, child.hash, { cache }));
    const reads = repos.calls.length;
    const compared = defined(
      await diffCommits(repos, { repo: REPO, sha: parent.hash }, { repo: REPO, sha: child.hash }, { cache }),
    );
    expect(compared.files).toEqual(commit.files);
    expect(cache.entries.size).toBe(1);
    expect(repos.calls.slice(reads).map((c) => c.method)).toEqual(["readCommit", "readCommit"]);
  });
});
