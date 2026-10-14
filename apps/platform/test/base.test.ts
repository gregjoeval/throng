import { describe, expect, it } from "vitest";
import { attemptBase, lineBase, readTaskBranch } from "../src/base.ts";
import { taskBranchRef } from "../src/task-refs.ts";
import { FakeRepos } from "./fake-repos.ts";

const PROJECT = "abc123";
const ORIGIN = `${PROJECT}-main`;
const FORK = `${PROJECT}-t1a1`;

/** An origin with one commit on main, and t1a1's fork of it. */
async function setup() {
  const repos = new FakeRepos();
  await repos.create(ORIGIN);
  const root = repos.commit(ORIGIN, { files: { "README.md": "hi\n" } });
  await repos.fork(ORIGIN, FORK);
  const base = (attempt = "t1a1", head: string) => attemptBase(repos, PROJECT, { attempt, head });
  return { repos, root, base };
}

describe("attemptBase", () => {
  it("is main's commit an attempt built on, when the task has no task branch", async () => {
    const { repos, root, base } = await setup();
    const head = repos.commit(FORK, { files: { "README.md": "hi\n", "a.txt": "a\n" } });
    expect(await base("t1a1", head.hash)).toEqual({ sha: root.hash, on: "main" });
  });

  it("stays where the attempt left main after main moves on", async () => {
    const { repos, root, base } = await setup();
    const head = repos.commit(FORK, { files: { "README.md": "hi\n", "a.txt": "a\n" } });
    repos.commit(ORIGIN, { files: { "README.md": "later\n" } });
    repos.commit(ORIGIN, { files: { "README.md": "later still\n" } });
    expect(await base("t1a1", head.hash)).toEqual({ sha: root.hash, on: "main" });
  });

  it("moves up to main's newer commit once the attempt merges main in", async () => {
    const { repos, base } = await setup();
    const own = repos.commit(FORK, { files: { "README.md": "hi\n", "a.txt": "a\n" } });
    const later = repos.commit(ORIGIN, { files: { "README.md": "later\n" } });
    repos.push(ORIGIN, FORK, "refs/heads/later", later.hash);
    const merge = repos.commit(FORK, {
      files: { "README.md": "later\n", "a.txt": "a\n" },
      parents: [own.hash, later.hash],
    });
    expect(await base("t1a1", merge.hash)).toEqual({ sha: later.hash, on: "main" });
  });

  it("is on the task branch when the task has one", async () => {
    const { repos, root, base } = await setup();
    const tests = repos.commit(ORIGIN, {
      files: { "README.md": "hi\n", "t.test": "x\n" },
      branch: "task",
      parents: [root.hash],
    });
    repos.setRef(ORIGIN, taskBranchRef(1), tests.hash);
    repos.commit(ORIGIN, { files: { "README.md": "main moved\n" } });
    repos.push(ORIGIN, FORK, "refs/heads/main", tests.hash);
    const head = repos.commit(FORK, { files: { "README.md": "hi\n", "t.test": "x\n", "a.txt": "a\n" } });
    expect(await base("t1a1", head.hash)).toEqual({ sha: tests.hash, on: "task" });
  });

  it("is null when the head shares no history with main", async () => {
    const { repos, base } = await setup();
    const lone = repos.commit(FORK, { files: { "only.txt": "x\n" }, branch: "lone", parents: [] });
    expect(await base("t1a1", lone.hash)).toBeNull();
  });

  it("is null while main has no commits", async () => {
    const repos = new FakeRepos();
    await repos.create(ORIGIN);
    await repos.create(FORK);
    const head = repos.commit(FORK, { files: { "a.txt": "a\n" } });
    expect(await attemptBase(repos, PROJECT, { attempt: "t1a1", head: head.hash })).toBeNull();
  });

  it("never takes the attempt a fork was copied from as its base", async () => {
    const { repos, root, base } = await setup();
    const source = repos.commit(FORK, { files: { "README.md": "hi\n", "a.txt": "a\n" } });
    const copy = `${PROJECT}-t1a2`;
    await repos.create(copy);
    repos.push(FORK, copy, "refs/heads/main", source.hash);
    const head = repos.commit(copy, { files: { "README.md": "hi\n", "a.txt": "a\nb\n" } });
    expect(await base("t1a2", head.hash)).toEqual({ sha: root.hash, on: "main" });

    const tests = repos.commit(ORIGIN, {
      files: { "README.md": "hi\n", "t.test": "x\n" },
      branch: "task",
      parents: [root.hash],
    });
    repos.setRef(ORIGIN, taskBranchRef(1), tests.hash);
    repos.push(ORIGIN, copy, "refs/heads/task", tests.hash);
    const merged = repos.commit(copy, {
      files: { "README.md": "hi\n", "a.txt": "a\nb\n", "t.test": "x\n" },
      parents: [head.hash, tests.hash],
    });
    expect(await base("t1a2", merged.hash)).toEqual({ sha: tests.hash, on: "task" });
  });
});

describe("lineBase", () => {
  it("is an attempt's base on an attempt's line", async () => {
    const { repos, root } = await setup();
    const head = repos.commit(FORK, { files: { "README.md": "hi\n", "a.txt": "a\n" } });
    expect(await lineBase(repos, PROJECT, { line: "t1a1", head: head.hash })).toEqual({ sha: root.hash, on: "main" });
  });

  it("is where a task branch meets main on the task branch's line", async () => {
    const { repos, root } = await setup();
    const tests = repos.commit(ORIGIN, { files: { "t.test": "x\n" }, branch: "task", parents: [root.hash] });
    repos.setRef(ORIGIN, taskBranchRef(1), tests.hash);
    repos.commit(ORIGIN, { files: { "README.md": "main moved\n" } });
    expect(await lineBase(repos, PROJECT, { line: "t1", head: tests.hash })).toEqual({ sha: root.hash, on: "main" });
  });

  it("is null on main", async () => {
    const { repos, root } = await setup();
    expect(await lineBase(repos, PROJECT, { line: "main", head: root.hash })).toBeNull();
  });
});

describe("readTaskBranch", () => {
  it("is null when the task has no task branch", async () => {
    const { repos } = await setup();
    expect(await readTaskBranch(repos, PROJECT, 1)).toBeNull();
  });

  it("counts the task branch's commits that main doesn't have, which land with the selected attempt", async () => {
    const { repos, root } = await setup();
    repos.commit(ORIGIN, { files: { "t.test": "1\n" }, branch: "task", parents: [root.hash] });
    const two = repos.commit(ORIGIN, { files: { "t.test": "2\n" }, branch: "task" });
    repos.commit(ORIGIN, { files: { "README.md": "main moved\n" } });
    repos.setRef(ORIGIN, taskBranchRef(1), two.hash);
    expect(await readTaskBranch(repos, PROJECT, 1)).toEqual({ sha: two.hash, commits: 2 });

    // Merging main in counts the merge, and none of main's commits.
    const later = repos.commit(ORIGIN, { files: { "README.md": "later\n" } });
    const merge = repos.commit(ORIGIN, { files: { "t.test": "2\n" }, branch: "task", parents: [two.hash, later.hash] });
    repos.setRef(ORIGIN, taskBranchRef(1), merge.hash);
    expect(await readTaskBranch(repos, PROJECT, 1)).toEqual({ sha: merge.hash, commits: 3 });
  });

  it("counts none once main has the task branch's head", async () => {
    const { repos, root } = await setup();
    repos.commit(ORIGIN, { files: { "README.md": "main moved\n" } });
    repos.setRef(ORIGIN, taskBranchRef(1), root.hash);
    expect(await readTaskBranch(repos, PROJECT, 1)).toEqual({ sha: root.hash, commits: 0 });
  });
});
