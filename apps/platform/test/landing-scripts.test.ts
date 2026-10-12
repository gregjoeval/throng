// Runs the Landing Workflow's scripts against local bare repos standing in for Artifacts remotes:
// the conflict check, the retest of the merged tree and the trusted land step.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conflictFiles, parseMergeTree } from "../src/conflicts.ts";
import type { RawScore, ScorePlan } from "../src/results.ts";
import {
  conflictCheckScript,
  landScript,
  parseResult,
  retestScript,
  type ConflictCheckResult,
  type LandResult,
} from "../src/scripts.ts";

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
  writeFileSync(join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

function run<T>(script: string): T {
  const sandbox = mkdtempSync(join(root, "sandbox-"));
  const stdout = execFileSync("bash", ["-c", script], { cwd: sandbox, env: ENV, encoding: "utf8" });
  const result = parseResult<T>(stdout);
  if (result === null) throw new Error(`no result in: ${stdout}`);
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "throng-landing-"));
  origin = join(root, "origin.git");
  fork = join(root, "fork.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", work);
  commit("a.txt", "one\ntwo\nthree\n", "base");
  git(work, "push", "-q", origin, "main");
  git(root, "clone", "-q", "--bare", origin, fork);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The attempt changes `file` on top of base and is pushed to the fork; meanwhile main changes `mainFile`. */
function diverged(file = "b.txt", content = "attempt\n", mainFile = "c.txt", mainContent = "someone else\n") {
  const head = commit(file, content, "attempt");
  git(work, "push", "-q", fork, "main");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  const main = commit(mainFile, mainContent, "main moved");
  git(work, "push", "-q", origin, "main");
  return { head, main };
}

function checked(head: string): { head: string; main: string; tree: string } {
  const result = run<ConflictCheckResult>(conflictCheckScript(origin, fork, head));
  if (!result.clean) throw new Error(`conflicted: ${result.output}`);
  return { head, main: result.main, tree: parseMergeTree(result.output).tree };
}

const plan = (checks: ScorePlan["checks"], setup: string[] = []): ScorePlan => ({ setup, checks, allow: [] });

const landing = (merge: { head: string; main: string; tree: string }) => ({
  ...merge,
  message: "Merge t1a1: Do it\n\nThrong-Task: t1\n",
  author: { name: "ada", email: "ada00001+ada@users.noreply.throng" },
  committedAt: 1_700_000_000,
});

/** The fixture worker's `src/greeting.js` (the spike's conflict), its greeting set to `word`. */
const greeting = (word: string) =>
  `export const GREETING = "${word}";\n\nexport function greet(name) {\n  return \`\${GREETING}, \${name}\`;\n}\n`;

describe("conflictCheckScript", () => {
  it("reports main's sha and the merged tree of a clean merge", () => {
    const { head, main } = diverged();
    const result = run<ConflictCheckResult>(conflictCheckScript(origin, fork, head));
    expect(result).toMatchObject({ main, clean: true });
    expect(parseMergeTree(result.output)).toEqual({
      tree: git(work, "merge-tree", "--write-tree", main, head),
      files: [],
    });
  });

  it("detects a conflict and lists the conflicting paths", () => {
    const { head, main } = diverged("a.txt", "one\nmine\nthree\n", "a.txt", "one\ntheirs\nthree\n");
    const result = run<ConflictCheckResult>(conflictCheckScript(origin, fork, head));
    expect(result).toMatchObject({ main, clean: false });
    expect(parseMergeTree(result.output).files).toMatchObject([{ path: "a.txt", type: "content" }]);
  });

  it("gives the spike's GREETING conflict with its blobs and the exact hunk", () => {
    const base = commit("greeting.js", greeting("hello"), "greeting");
    git(work, "push", "-q", origin, "main");
    git(work, "push", "-q", fork, "main");
    const { head, main } = diverged("greeting.js", greeting("hello from a2"), "greeting.js", greeting("hello from a1"));
    const result = run<ConflictCheckResult>(conflictCheckScript(origin, fork, head));
    expect(result).toMatchObject({ main, clean: false, base });

    const blob = (rev: string) => git(work, "rev-parse", `${rev}:greeting.js`);
    expect(conflictFiles(parseMergeTree(result.output).files, result.remerges)).toEqual([
      {
        path: "greeting.js",
        type: "content",
        blobs: { base: blob(base), main: blob(main), attempt: blob(head) },
        modes: { base: "100644", main: "100644", attempt: "100644" },
        truncated: false,
        hunks: [
          {
            startLine: 1,
            base: ['export const GREETING = "hello";'],
            main: ['export const GREETING = "hello from a1";'],
            attempt: ['export const GREETING = "hello from a2";'],
          },
        ],
      },
    ]);
  });

  it("re-merges only content conflicts, blanking the lines outside their hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const long = (at20: string) => lines.map((l, i) => (i === 19 ? at20 : l)).join("\n") + "\n";
    writeFileSync(join(work, "gone.txt"), "kept?\n");
    const base = commit("long.txt", long("line 20"), "base");
    git(work, "push", "-q", origin, "main");
    writeFileSync(join(work, "gone.txt"), "changed\n");
    const head = commit("long.txt", long("attempt"), "attempt");
    git(work, "push", "-q", fork, "main");
    git(work, "reset", "-q", "--hard", base);
    git(work, "rm", "-q", "gone.txt");
    commit("long.txt", long("main"), "main");
    git(work, "push", "-q", origin, "main");

    const result = run<ConflictCheckResult>(conflictCheckScript(origin, fork, head));
    expect(parseMergeTree(result.output).files.map((f) => f.type)).toEqual(["modify_delete", "content"]);
    expect(result.remerges).toEqual([
      {
        path: "long.txt",
        status: "merged",
        output: `${"\n".repeat(19)}<<<<<<< main\nmain\n||||||| base\nline 20\n=======\nattempt\n>>>>>>> attempt\n${"\n".repeat(10)}`,
      },
    ]);
  });

  it("reports a re-merge over twice a cap as too large", () => {
    const { head } = diverged("a.txt", "one\nmine\nthree\n", "a.txt", "one\ntheirs\nthree\n");
    const tiny = (fileBytes: number, totalBytes: number) =>
      run<ConflictCheckResult>(conflictCheckScript(origin, fork, head, { fileBytes, totalBytes })).remerges;
    expect(tiny(10, 1000)).toEqual([{ path: "a.txt", status: "too_large" }]);
    expect(tiny(1000, 10)).toEqual([{ path: "a.txt", status: "too_large" }]);
    expect(tiny(1000, 1000)).toMatchObject([{ path: "a.txt", status: "merged" }]);
  });

  it("reports a binary content conflict as failed", () => {
    commit("bin.dat", "\0one", "bin");
    git(work, "push", "-q", origin, "main");
    git(work, "push", "-q", fork, "main");
    const { head } = diverged("bin.dat", "\0two", "bin.dat", "\0three");
    const result = run<ConflictCheckResult>(conflictCheckScript(origin, fork, head));
    expect(result.remerges).toEqual([{ path: "bin.dat", status: "failed" }]);
  });
});

describe("retestScript", () => {
  it("runs setup and the checks on the merged tree", () => {
    const { head } = diverged();
    const merge = checked(head);
    const raw = run<RawScore>(
      retestScript(
        origin,
        fork,
        merge,
        plan(
          [{ name: "both", command: "test -f b.txt && test -f c.txt && test -f built", timeoutMs: 60_000 }],
          ["touch built"],
        ),
      ),
    );
    expect(raw).toMatchObject({ setupFailed: null, checks: [{ exit: 0 }] });
  });

  it("reports a failing check", () => {
    const { head } = diverged();
    const raw = run<RawScore>(
      retestScript(
        origin,
        fork,
        checked(head),
        plan([{ name: "no-c", command: "test ! -f c.txt", timeoutMs: 60_000 }]),
      ),
    );
    expect(raw.checks).toMatchObject([{ exit: 1 }]);
  });
});

describe("landScript", () => {
  it("lands the exact merged tree as a merge commit of main and the approved head", () => {
    const { head, main } = diverged();
    const merge = checked(head);
    const result = run<LandResult>(landScript(origin, fork, landing(merge)));

    const landed = git(origin, "rev-parse", "main");
    expect(result).toEqual({ kind: "landed", sha: landed });
    expect(git(origin, "rev-parse", "main^{tree}")).toBe(merge.tree);
    expect(git(origin, "log", "-1", "--format=%P", "main")).toBe(`${main} ${head}`);
    expect(git(origin, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%B", "main")).toBe(
      "ada <ada00001+ada@users.noreply.throng>|Throng <noreply@users.noreply.throng>|Merge t1a1: Do it\n\nThrong-Task: t1",
    );
  });

  it("reports the same landing when rerun after it pushed", () => {
    const { head } = diverged();
    const merge = checked(head);
    const first = run<LandResult>(landScript(origin, fork, landing(merge)));
    expect(run<LandResult>(landScript(origin, fork, landing(merge)))).toEqual(first);
  });

  it("fails the lease, without pushing, when main moved after the conflict check", () => {
    const { head } = diverged();
    const merge = checked(head);
    commit("d.txt", "later\n", "main moved again");
    git(work, "push", "-q", origin, "main");
    const before = git(origin, "rev-parse", "main");

    expect(run<LandResult>(landScript(origin, fork, landing(merge)))).toEqual({ kind: "moved" });
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  it("refuses to push a tree other than the one the conflict check recorded", () => {
    const { head } = diverged();
    const merge = checked(head);
    const before = git(origin, "rev-parse", "main");
    const forged = { ...merge, tree: git(work, "rev-parse", "HEAD^{tree}") };

    expect(run<LandResult>(landScript(origin, fork, landing(forged)))).toEqual({ kind: "mismatch", tree: merge.tree });
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  it("runs no repository code: no npm or node, hooks off, no repo or global config", () => {
    const script = landScript("https://example.invalid/c.git", "https://example.invalid/f.git", {
      head: "a".repeat(40),
      main: "b".repeat(40),
      tree: "c".repeat(40),
      message: "m",
      author: { name: "ada", email: "ada@x" },
      committedAt: 1,
    });
    expect(script).not.toMatch(/\bnpm\b|\bnode\b|\bcheckout\b/);
    expect(script).toContain("core.hooksPath /dev/null");
    expect(script).toContain("GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null");
  });
});
