import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  landScript,
  parseResult,
  retestScript,
  testScript,
  type LandResult,
  type RetestResult,
  type TestResult,
} from "../src/scripts.ts";

// Runs the Sandbox scripts against local bare repos standing in for Artifacts remotes.

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
};

let root: string;
let canonical: string;
let fork: string;
let work: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

function runScript<T>(script: string): T {
  const sandbox = mkdtempSync(join(root, "sandbox-"));
  const stdout = execFileSync("bash", ["-c", script], { cwd: sandbox, env: ENV, encoding: "utf8" });
  const result = parseResult<T>(stdout);
  if (result === null) throw new Error(`no result in: ${stdout}`);
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "throng-scripts-"));
  canonical = join(root, "canonical.git");
  fork = join(root, "fork.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", canonical);
  git(root, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
  writeFileSync(
    join(work, "check.js"),
    `if (require("fs").readFileSync("a.txt", "utf8").includes("bad")) process.exit(1);`,
  );
  commit("a.txt", "one\ntwo\nthree\n", "base");
  git(work, "push", "-q", canonical, "main");
  git(root, "clone", "-q", "--bare", canonical, fork);
});

describe("testScript", () => {
  it("passes a good commit and reports a failing one", () => {
    const good = commit("a.txt", "one\ntwo!\nthree\n", "good");
    const bad = commit("a.txt", "one\nbad\nthree\n", "bad");
    git(work, "push", "-q", fork, "main");
    expect(runScript<TestResult>(testScript(fork, good))).toEqual({ ok: true });
    expect(runScript<TestResult>(testScript(fork, bad))).toMatchObject({ ok: false });
  });
});

/** The attempt adds b.txt on top of base; meanwhile main gains c.txt. */
function divergedAttempt(): string {
  const attempt = commit("b.txt", "attempt\n", "attempt");
  git(work, "push", "-q", fork, "main");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  commit("c.txt", "someone else\n", "main moved");
  git(work, "push", "-q", canonical, "main");
  return attempt;
}

describe("retestScript", () => {
  it("rebases onto the current main and reports the base and the tested tree", () => {
    const attempt = divergedAttempt();
    const result = runScript<RetestResult>(retestScript(canonical, fork, attempt));
    expect(result).toMatchObject({ kind: "tested", base: git(canonical, "rev-parse", "main") });
    expect(result.kind === "tested" && result.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("bounces a conflicting attempt with the conflicted files and hunks", () => {
    const attempt = commit("a.txt", "one\nmine\nthree\n", "attempt");
    git(work, "push", "-q", fork, "main");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    commit("a.txt", "one\ntheirs\nthree\n", "main moved");
    git(work, "push", "-q", canonical, "main");

    const result = runScript<RetestResult>(retestScript(canonical, fork, attempt));
    expect(result).toMatchObject({ kind: "bounced", files: ["a.txt"] });
    expect(result.kind === "bounced" && result.diff).toMatch(/<<<<<<<[\s\S]*theirs[\s\S]*=======[\s\S]*mine/);
  });

  it("fails when tests break after the rebase", () => {
    const attempt = commit("b.txt", "attempt\n", "attempt");
    git(work, "push", "-q", fork, "main");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    commit("a.txt", "one\nbad\nthree\n", "main broke");
    git(work, "push", "-q", canonical, "main");

    expect(runScript<RetestResult>(retestScript(canonical, fork, attempt))).toMatchObject({ kind: "failed" });
  });
});

function retested(attempt: string): { base: string; tree: string } {
  const result = runScript<RetestResult>(retestScript(canonical, fork, attempt));
  if (result.kind !== "tested") throw new Error(`retest did not pass: ${JSON.stringify(result)}`);
  return result;
}

describe("landScript", () => {
  it("lands exactly the tree the retest step tested", () => {
    const attempt = divergedAttempt();
    const tested = retested(attempt);

    const result = runScript<LandResult>(landScript(canonical, fork, attempt, tested));
    expect(result).toEqual({ kind: "landed", mainSha: git(canonical, "rev-parse", "main") });
    expect(git(canonical, "rev-parse", "main^{tree}")).toBe(tested.tree);
    expect(git(canonical, "log", "--format=%s", "main")).toBe("attempt\nmain moved\nbase");
  });

  it("reports main moved, without pushing, when main changed after the retest", () => {
    const attempt = divergedAttempt();
    const tested = retested(attempt);
    commit("d.txt", "later\n", "main moved again");
    git(work, "push", "-q", canonical, "main");
    const before = git(canonical, "rev-parse", "main");

    expect(runScript<LandResult>(landScript(canonical, fork, attempt, tested))).toEqual({ kind: "moved" });
    expect(git(canonical, "rev-parse", "main")).toBe(before);
  });

  it("refuses to push a tree other than the one tested", () => {
    const attempt = divergedAttempt();
    const tested = retested(attempt);
    const before = git(canonical, "rev-parse", "main");

    const forged = { ...tested, tree: git(work, "rev-parse", "HEAD^{tree}") };
    expect(runScript<LandResult>(landScript(canonical, fork, attempt, forged))).toMatchObject({ kind: "mismatch" });
    expect(git(canonical, "rev-parse", "main")).toBe(before);
  });

  it("runs no repository code: no npm, node or hooks", () => {
    const script = landScript("https://example.invalid/c.git", "https://example.invalid/f.git", "a".repeat(40), {
      base: "b".repeat(40),
      tree: "c".repeat(40),
    });
    expect(script).not.toMatch(/\bnpm\b|\bnode\b/);
    expect(script).toContain("core.hooksPath /dev/null");
  });
});
