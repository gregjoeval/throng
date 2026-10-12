// Runs the follow script (an attempt following its task branch) against local bare repos standing in
// for Artifacts remotes: the origin holding `refs/tasks/t1`, and the attempt's fork.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followScript, parseResult } from "../src/scripts.ts";
import type { FollowPlan, FollowResult } from "../src/scripts.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
};

let root: string;
let origin: string;
let fork: string;
let work: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

function commit(file: string, content: string, message: string): string {
  mkdirSync(dirname(join(work, file)), { recursive: true });
  writeFileSync(join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

function run(plan: FollowPlan): FollowResult {
  const sandbox = mkdtempSync(join(root, "sandbox-"));
  const stdout = execFileSync("bash", ["-c", followScript(origin, fork, plan)], {
    cwd: sandbox,
    env: ENV,
    encoding: "utf8",
  });
  const result = parseResult<FollowResult>(stdout);
  if (result === null) throw new Error(`no result in: ${stdout}`);
  return result;
}

let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "throng-follow-"));
  origin = join(root, "origin.git");
  fork = join(root, "fork.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", work);
  base = commit("a.txt", "one\ntwo\nthree\n", "base");
  git(work, "push", "-q", origin, "main", "HEAD:refs/tasks/t1");
  git(root, "clone", "-q", "--bare", origin, fork);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const forkHead = () => git(fork, "rev-parse", "main");

const plan = (taskHead: string): FollowPlan => ({
  task: 1,
  taskHead,
  message: "Merge t1's task branch into t1a1\n\nThrong-Task: t1\nThrong-Attempt: t1a1\n",
  committedAt: 1_700_000_000,
});

/** The attempt commits `file` on the fork; the task branch then moves on with `taskFile`. */
function diverged(file = "b.txt", content = "attempt\n", taskFile = "test.txt", taskContent = "a test\n") {
  const head = commit(file, content, "attempt");
  git(work, "push", "-q", fork, "main");
  git(work, "reset", "-q", "--hard", base);
  const task = commit(taskFile, taskContent, "task branch moved");
  git(work, "push", "-q", origin, "HEAD:refs/tasks/t1");
  return { head, task };
}

describe("followScript", () => {
  it("merges the new task head into the attempt as a two-parent merge, pushed to the fork's main", () => {
    const { head, task } = diverged();
    const result = run(plan(task));

    const merged = forkHead();
    expect(result).toEqual({ kind: "merged", before: head, head: merged });
    expect(git(fork, "log", "-1", "--format=%P", "main")).toBe(`${head} ${task}`);
    expect(git(fork, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%B", "main")).toBe(
      "Throng <noreply@users.noreply.throng>|Throng <noreply@users.noreply.throng>|" +
        "Merge t1's task branch into t1a1\n\nThrong-Task: t1\nThrong-Attempt: t1a1",
    );
    expect(git(fork, "show", "main:test.txt")).toBe("a test");
    expect(git(fork, "show", "main:b.txt")).toBe("attempt");
  });

  it("fast-forwards an attempt with no commits of its own to the task head", () => {
    const task = commit("test.txt", "a test\n", "task branch moved");
    git(work, "push", "-q", origin, "HEAD:refs/tasks/t1");

    expect(run(plan(task))).toEqual({ kind: "merged", before: base, head: task });
    expect(forkHead()).toBe(task);
  });

  it("reports an attempt that already contains the task head as current, and pushes nothing", () => {
    const { task } = diverged();
    git(work, "merge", "-q", "--no-edit", git(fork, "rev-parse", "main"));
    const merged = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "-f", fork, "HEAD:main");

    expect(run(plan(task))).toEqual({ kind: "current", head: merged });
    expect(forkHead()).toBe(merged);
  });

  it("reports the same merge when rerun after it pushed", () => {
    const { task } = diverged();
    const first = run(plan(task));
    expect(first.kind).toBe("merged");
    expect(run(plan(task))).toEqual({ kind: "current", head: forkHead() });
  });

  it("writes nothing on a conflict", () => {
    const { head, task } = diverged("a.txt", "attempt\n", "a.txt", "task\n");

    expect(run(plan(task))).toEqual({ kind: "conflict", head });
    expect(forkHead()).toBe(head);
  });

  it("reports a task head the task branch no longer holds as stale, and writes nothing", () => {
    const { head, task } = diverged();
    git(work, "reset", "-q", "--hard", base);
    commit("other.txt", "rewound\n", "task branch rewound");
    git(work, "push", "-q", "-f", origin, "HEAD:refs/tasks/t1");

    expect(run(plan(task))).toEqual({ kind: "stale" });
    expect(forkHead()).toBe(head);
  });

  it("runs no repository code: no npm or node, hooks off, no repo or global config", () => {
    const script = followScript("https://example.invalid/c.git", "https://example.invalid/f.git", plan("a".repeat(40)));
    expect(script).not.toMatch(/\bnpm\b|\bnode\b|\bcheckout\b/u);
    expect(script).toContain("core.hooksPath /dev/null");
    expect(script).toContain("GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null");
  });
});
