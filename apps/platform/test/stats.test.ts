import { describe, expect, it } from "vitest";
import { commitStats, languageOf, MAX_DESCRIPTION, readmeDescription } from "../src/stats.ts";
import { FakeRepos } from "./fake-repos.ts";

const ADA = { name: "Ada", email: "ada@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };
const CY = { name: "Cy", email: "cy@example.com" };

async function repo() {
  const repos = new FakeRepos();
  await repos.create("p-main");
  return repos;
}

describe("commitStats", () => {
  it("counts each author's commits, most first, by email whatever its case", async () => {
    const repos = await repo();
    repos.commit("p-main", { files: { "a.ts": "a" }, author: BOB });
    repos.commit("p-main", { files: { "a.ts": "b" }, author: ADA });
    repos.commit("p-main", { files: { "a.ts": "c" }, author: { name: "Ada L.", email: "ADA@example.com" } });
    const head = repos.commit("p-main", { files: { "a.ts": "d" }, author: CY });
    const stats = await commitStats(repos, { repo: "p-main", sha: head.hash });
    expect(stats.commitAuthors.map(({ name, email, commits }) => ({ name, email, commits }))).toEqual([
      { name: "Ada L.", email: "ada@example.com", commits: 2 },
      { name: "Bob", email: "bob@example.com", commits: 1 },
      { name: "Cy", email: "cy@example.com", commits: 1 },
    ]);
    expect(stats.commitsTruncated).toBeFalsy();
  });

  it("counts the commits a merge brought in, once each", async () => {
    const repos = await repo();
    const base = repos.commit("p-main", { files: { "a.ts": "a" }, author: ADA });
    const side1 = repos.commit("p-main", { branch: "side", parents: [base.hash], files: { "b.ts": "b" }, author: BOB });
    const side2 = repos.commit("p-main", { branch: "side", files: { "b.ts": "bb" }, author: BOB });
    const main = repos.commit("p-main", { parents: [base.hash], files: { "a.ts": "aa" }, author: ADA });
    const merge = repos.commit("p-main", { parents: [main.hash, side2.hash], files: { "a.ts": "aa", "b.ts": "bb" } });
    // A second merge of the same side brings in nothing new.
    const again = repos.commit("p-main", { parents: [merge.hash, side1.hash], files: { "a.ts": "aa" }, author: CY });
    const stats = await commitStats(repos, { repo: "p-main", sha: again.hash });
    expect(stats.commitAuthors.map((c) => [c.name, c.commits])).toEqual([
      ["Ada", 3],
      ["Bob", 2],
      ["Cy", 1],
    ]);
  });

  it("names each author by their newest commit, even one a merge brought in", async () => {
    const repos = await repo();
    const base = repos.commit("p-main", { files: { "a.ts": "a" }, author: BOB });
    const main = repos.commit("p-main", { files: { "a.ts": "aa" }, author: ADA });
    const side = repos.commit("p-main", {
      branch: "side",
      parents: [base.hash],
      files: { "b.ts": "b" },
      author: { name: "Robert", email: "bob@example.com" },
    });
    const merge = repos.commit("p-main", { parents: [main.hash, side.hash], files: { "a.ts": "aa", "b.ts": "b" } });
    const stats = await commitStats(repos, { repo: "p-main", sha: merge.hash });
    expect(stats.commitAuthors.find((a) => a.email === "bob@example.com")).toMatchObject({
      name: "Robert",
      commits: 2,
      newestAt: side.authoredAt,
    });
  });

  it("walks history a page at a time from the last commit read, and stops at the commit cap, saying so", async () => {
    const repos = await repo();
    let head = "";
    for (let i = 0; i < 250; i++) head = repos.commit("p-main", { files: { "a.ts": String(i) } }).hash;
    const all = await commitStats(repos, { repo: "p-main", sha: head });
    expect(all.commitAuthors.map((a) => a.commits)).toEqual([250]);
    expect(all.commitsTruncated).toBeFalsy();
    const pages = repos.calls.filter((call) => call.method === "listCommits");
    expect(pages).toHaveLength(3);
    expect(pages.every((call) => !("offset" in (call.args[1] as object)))).toBeTruthy();
    const capped = await commitStats(
      repos,
      { repo: "p-main", sha: head },
      { caps: { maxCommits: 120, maxFiles: 10, maxTrees: 10 } },
    );
    expect(capped.commitAuthors.map((a) => a.commits)).toEqual([120]);
    expect(capped.commitsTruncated).toBeTruthy();
    expect(capped.filesTruncated).toBeFalsy();
  });

  it("shares the code's bytes among its languages, leaving out data, prose and vendored code", async () => {
    const repos = await repo();
    const head = repos.commit("p-main", {
      files: {
        "src/app.ts": "x".repeat(60),
        "src/view.tsx": "x".repeat(20),
        "scripts/run.sh": { content: "x".repeat(10), type: "exec" },
        "styles/site.css": "x".repeat(10),
        "package.json": "x".repeat(500),
        "README.md": "x".repeat(500),
        "node_modules/dep/index.js": "x".repeat(500),
        "build/out.js": "x".repeat(500),
        "public/app.min.js": "x".repeat(500),
        "link.ts": { content: "src/app.ts", type: "symlink" },
        "empty.py": "",
      },
    });
    const stats = await commitStats(repos, { repo: "p-main", sha: head.hash });
    expect(stats.languages).toEqual([
      { name: "TypeScript", bytes: 60, share: 0.6 },
      { name: "TSX", bytes: 20, share: 0.2 },
      { name: "CSS", bytes: 10, share: 0.1 },
      { name: "Shell", bytes: 10, share: 0.1 },
    ]);
  });

  it("sizes at most the file cap's files, nearest the root first, saying so", async () => {
    const repos = await repo();
    const head = repos.commit("p-main", {
      files: { "a.ts": "aaaa", "b.py": "bb", "deep/c.go": "c".repeat(100) },
    });
    const stats = await commitStats(
      repos,
      { repo: "p-main", sha: head.hash },
      { caps: { maxCommits: 10, maxFiles: 2, maxTrees: 10 } },
    );
    expect(stats.languages.map((l) => l.name)).toEqual(["TypeScript", "Python"]);
    expect(stats.filesTruncated).toBeTruthy();
    expect(stats.commitsTruncated).toBeFalsy();
  });

  it("reads at most the tree cap's directories, whatever they hold, saying so", async () => {
    const repos = await repo();
    const head = repos.commit("p-main", {
      files: { "a.ts": "aaaa", "data/x.json": "{}", "data/deep/y.json": "{}", "src/b.go": "bb" },
    });
    const stats = await commitStats(
      repos,
      { repo: "p-main", sha: head.hash },
      { caps: { maxCommits: 10, maxFiles: 100, maxTrees: 2 } },
    );
    expect(stats.languages.map((l) => l.name)).toEqual(["TypeScript"]);
    expect(stats.filesTruncated).toBeTruthy();
    expect(repos.calls.filter((call) => call.method === "readTree")).toHaveLength(2);
  });

  it("describes the commit by its root README's first paragraph", async () => {
    const repos = await repo();
    const head = repos.commit("p-main", {
      files: { "readme.md": "# Alpha\n\nA tool for **things**.\n\nMore.\n", "docs/README.md": "# Not this\n\nNope.\n" },
    });
    expect((await commitStats(repos, { repo: "p-main", sha: head.hash })).description).toBe("A tool for things.");
  });

  it("has no description or languages for a commit with no README text or code", async () => {
    const repos = await repo();
    const head = repos.commit("p-main", { files: { "notes.txt": "hi\n", README: "\0binary" } });
    const stats = await commitStats(repos, { repo: "p-main", sha: head.hash });
    expect(stats).toEqual({
      description: null,
      commitAuthors: [{ name: "Ada", email: "ada@example.com", commits: 1, newestAt: head.authoredAt }],
      languages: [],
      commitsTruncated: false,
      filesTruncated: false,
    });
  });

  it("serves a commit's stats from the cache, reading nothing from the repo", async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (key: Request) => store.get(key.url)?.clone(),
      put: async (key: Request, res: Response) => void store.set(key.url, res.clone()),
    };
    const repos = await repo();
    const head = repos.commit("p-main", { files: { "a.ts": "a", "README.md": "Hi.\n" } });
    const first = await commitStats(repos, { repo: "p-main", sha: head.hash }, { cache });
    const reads = repos.calls.length;
    expect(await commitStats(repos, { repo: "p-main", sha: head.hash }, { cache })).toEqual(first);
    expect(repos.calls.length).toBe(reads);
  });
});

describe("readmeDescription", () => {
  it("takes the first paragraph after the title and badges, as plain text", () => {
    const readme = [
      "<!-- generated -->",
      '<p align="center"><img src="logo.png"></p>',
      "",
      "# Throng",
      "",
      "[![CI](https://ci/badge.svg)](https://ci) ![npm](https://npm/badge.svg)",
      "",
      "Throng is a *git platform* where [agents](docs/agents.md) and `humans`",
      "make parallel attempts at a task.",
      "",
      "## Install",
    ].join("\n");
    expect(readmeDescription(readme)).toBe(
      "Throng is a git platform where agents and humans make parallel attempts at a task.",
    );
  });

  it("skips front matter, code, lists, quotes, tables and setext headings", () => {
    const readme = [
      "---",
      "title: x",
      "---",
      "Alpha",
      "=====",
      "",
      "```sh",
      "npm install alpha",
      "```",
      "",
      "- a list",
      "> a quote",
      "| a | table |",
      "    indented code",
      "",
      "Alpha does __one__ thing_well.",
    ].join("\n");
    expect(readmeDescription(readme)).toBe("Alpha does one thing_well.");
  });

  it("is null when there's no paragraph", () => {
    expect(readmeDescription("# Title\n\n## Usage\n\n- one\n")).toBeNull();
    expect(readmeDescription("")).toBeNull();
  });

  it("cuts a long paragraph at a word", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const description = readmeDescription(words) ?? "";
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION + 1);
    expect(description).toMatch(/word\d+…$/u);
    expect(words.startsWith(description.slice(0, -1))).toBeTruthy();
  });
});

describe("languageOf", () => {
  it("names a file's language by its extension or name, or null", () => {
    expect(
      ["a.ts", "B.TSX", "x.mjs", "Dockerfile", "Makefile", "a.min.js", "data.json", "README.md", ".ts", "LICENSE"].map(
        languageOf,
      ),
    ).toEqual(["TypeScript", "TSX", "JavaScript", "Dockerfile", "Makefile", null, null, null, null, null]);
  });
});
