import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { buildResult, scorePlan, type RawScore, type ScorePlan } from "../src/results.ts";
import {
  landScript,
  parseResult,
  previewScript,
  retestScript,
  scoreScript,
  type LandResult,
  type PreviewScriptResult,
  type RetestResult,
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

function runScript<T>(script: string, sandbox = mkdtempSync(join(root, "sandbox-"))): T {
  const stdout = execFileSync("bash", ["-c", script], { cwd: sandbox, env: ENV, encoding: "utf8" });
  const result = parseResult<T>(stdout);
  if (result === null) throw new Error(`no result in: ${stdout}`);
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "throng-scripts-"));
  origin = join(root, "origin.git");
  fork = join(root, "fork.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
  writeFileSync(
    join(work, "check.js"),
    `if (require("fs").readFileSync("a.txt", "utf8").includes("bad")) process.exit(1);`,
  );
  commit("a.txt", "one\ntwo\nthree\n", "base");
  git(work, "push", "-q", origin, "main");
  git(root, "clone", "-q", "--bare", origin, fork);
});

/**
 * Gives the repo a local `file:` dependency and a lockfile. Its tests pass only if the dependency was
 * installed and the dependency's install script did not run.
 */
function addDependency(): void {
  mkdirSync(join(work, "dep"));
  writeFileSync(
    join(work, "dep/package.json"),
    JSON.stringify({
      name: "dep",
      version: "1.0.0",
      main: "index.js",
      scripts: {
        postinstall: `node -e "require('fs').writeFileSync(process.env.INIT_CWD + '/ran-install-script', '')"`,
      },
    }),
  );
  writeFileSync(join(work, "dep/index.js"), "module.exports = 42;");
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ scripts: { test: "node check.js" }, dependencies: { dep: "file:./dep" } }),
  );
  writeFileSync(
    join(work, "check.js"),
    `const fs = require("fs");
if (require("dep") !== 42) process.exit(1);
if (fs.existsSync("ran-install-script")) { console.error("install script ran"); process.exit(1); }`,
  );
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work });
}

describe("dependency install", () => {
  it("installs before the retest after rebasing, without running install scripts", () => {
    addDependency();
    const attempt = commit("a.txt", "one\ntwo\nthree\n", "with dependency");
    git(work, "push", "-q", fork, "main");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    commit("c.txt", "someone else\n", "main moved");
    git(work, "push", "-q", origin, "main");
    expect(runScript<RetestResult>(retestScript(origin, fork, attempt))).toMatchObject({ kind: "tested" });
  });
});

const plan = (overrides: Partial<ScorePlan> = {}): ScorePlan => ({ setup: [], checks: [], allow: [], ...overrides });
const check = (name: string, command: string, timeoutMs = 60_000) => ({ name, command, timeoutMs });

/** Pushes an attempt to the fork on top of the origin's main (adds 2 lines, deletes 2) and returns its head. */
function attemptHead(): string {
  commit("b.txt", "attempt\nline two\n", "attempt");
  const head = commit("a.txt", "one\n", "attempt trims a.txt");
  git(work, "push", "-q", fork, "main");
  return head;
}

describe("scoreScript", () => {
  it("records the merge base and the diff size from it, and runs nothing without a plan", () => {
    const head = attemptHead();
    const raw = runScript<RawScore>(scoreScript(fork, origin, head, plan()));
    expect(raw).toMatchObject({ base: git(origin, "rev-parse", "main"), setupFailed: null, checks: [] });
    expect(raw.shortstat.trim()).toBe("2 files changed, 2 insertions(+), 2 deletions(-)");
    expect(raw.builtinMs).toBeGreaterThanOrEqual(0);
  });

  it("measures the base from the origin's main, not the fork's", () => {
    const head = attemptHead();
    commit("c.txt", "later\n", "main moves on");
    git(work, "push", "-q", origin, "HEAD:main");
    const raw = runScript<RawScore>(scoreScript(fork, origin, head, plan()));
    expect(raw.base).toBe(git(origin, "rev-parse", "main~1"));
  });

  it("diffs against the empty tree when the head shares no history with main", () => {
    git(work, "checkout", "-q", "--orphan", "lone");
    git(work, "rm", "-rqf", ".");
    const head = commit("only.txt", "x\ny\n", "unrelated");
    git(work, "push", "-q", fork, "lone:main", "--force");
    const raw = runScript<RawScore>(scoreScript(fork, origin, head, plan()));
    expect(raw.base).toBeNull();
    expect(raw.shortstat.trim()).toBe("1 file changed, 2 insertions(+)");
  });

  it("runs every check in order, after a failure too, with an empty $THRONG_METRICS file each", () => {
    const head = attemptHead();
    const checks = [
      check(
        "first",
        `test ! -s "$THRONG_METRICS" && echo '{"coverage": 81.5}' > "$THRONG_METRICS" && echo first >> ../order`,
      ),
      check("broken", "echo broken >> ../order; exit 3"),
      check("last", `test ! -s "$THRONG_METRICS" && echo last >> ../order && test -f b.txt`),
    ];
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const raw = runScript<RawScore>(scoreScript(fork, origin, head, plan({ checks })), sandbox);
    expect(raw.checks.map((c) => [c.exit, c.metrics?.trim()])).toEqual([
      [0, '{"coverage": 81.5}'],
      [3, ""],
      [0, ""],
    ]);
    expect(execFileSync("cat", [join(sandbox, "order")], { encoding: "utf8" })).toBe("first\nbroken\nlast\n");
    expect(execFileSync("cat", [join(sandbox, "logs/broken.log")], { encoding: "utf8" })).toBe("");
  });

  it("skips every check after a failed setup command, and names the command", () => {
    const head = attemptHead();
    const setup = ["true", "echo nope >&2; false", "touch ../never"];
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const raw = runScript<RawScore>(
      scoreScript(fork, origin, head, plan({ setup, checks: [check("test", "true")] })),
      sandbox,
    );
    expect(raw).toMatchObject({ setupFailed: 2, checks: [{ exit: null, metrics: null }] });
    expect(execFileSync("cat", [join(sandbox, "logs/setup.2.log")], { encoding: "utf8" })).toBe("nope\n");
    expect(() => execFileSync("test", ["-e", join(sandbox, "never")])).toThrow();
  });

  it("stops a check at its timeout", () => {
    const head = attemptHead();
    const raw = runScript<RawScore>(
      scoreScript(fork, origin, head, plan({ checks: [check("slow", "sleep 20", 1000)] })),
    );
    expect(raw.checks[0]).toMatchObject({ exit: 124 });
    expect(raw.checks[0]!.durationMs).toBeGreaterThanOrEqual(1000);
    expect(raw.checks[0]!.durationMs).toBeLessThan(10_000);
  });

  it("quotes commands so a check can't break out of the script", () => {
    const head = attemptHead();
    const raw = runScript<RawScore>(
      scoreScript(
        fork,
        origin,
        head,
        plan({ checks: [check("quotes", `echo "it's" '$HOME' "$(echo ok)" > ../quoted`)] }),
      ),
    );
    expect(raw.checks[0]!.exit).toBe(0);
  });

  it("is idempotent: rerunning in the same directory gives the same result", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const script = scoreScript(
      fork,
      origin,
      head,
      plan({ checks: [check("test", "echo '{\"n\": 1}' > $THRONG_METRICS")] }),
    );
    const first = runScript<RawScore>(script, sandbox);
    const second = runScript<RawScore>(script, sandbox);
    expect({ ...second, builtinMs: 0, checks: second.checks.map((c) => ({ ...c, durationMs: 0 })) }).toEqual({
      ...first,
      builtinMs: 0,
      checks: first.checks.map((c) => ({ ...c, durationMs: 0 })),
    });
  });

  it("turns a project's config into a scored result end to end", () => {
    const head = attemptHead();
    const config = parseConfig(`checks:
  - name: test
    command: >-
      echo '{"coverage": 90, "junk": 1}' > "$THRONG_METRICS"
    metrics:
      - { name: coverage, unit: "%", order: desc }
  - name: lint
    command: exit 1
    required: false
`);
    const raw = runScript<RawScore>(scoreScript(fork, origin, head, scorePlan(config)));
    const result = buildResult(config, raw);
    expect(result).toMatchObject({
      config: { kind: "valid" },
      gate: "passed",
      builtin: { filesChanged: 2, additions: 2, deletions: 2 },
      checks: [
        { name: "test", required: true, outcome: "passed", metrics: { coverage: 90 } },
        { name: "lint", required: false, outcome: "failed", metrics: {} },
      ],
    });
    expect(result.checks[0]!.notes).toEqual(["ignored metric junk: not declared by this check"]);
  });
});

/** A stand-in `wrangler` on PATH: records its args and env, then succeeds or fails. */
function fakeWrangler(behaviour: "deploys" | "fails"): string {
  const bin = mkdtempSync(join(root, "bin-"));
  const body =
    behaviour === "deploys"
      ? `echo '{"preview":{"urls":["https://t1a1-pabc123-fixture.acct.workers.dev"]}}'`
      : `echo 'deploy refused' >&2; exit 1`;
  writeFileSync(
    join(bin, "wrangler"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ACCOUNT_ID" "$(cat built 2>/dev/null)" > ../wrangler-call
${body}
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Runs a preview script with `bin` (the fake wrangler) first on PATH. */
function runPreview(script: string, bin: string, sandbox = mkdtempSync(join(root, "sandbox-"))) {
  const env = { ...ENV, PATH: `${bin}:${process.env.PATH}` };
  const stdout = execFileSync("bash", ["-c", script], { cwd: sandbox, env, encoding: "utf8" });
  const result = parseResult<PreviewScriptResult>(stdout);
  if (result === null) throw new Error(`no result in: ${stdout}`);
  return { result, sandbox };
}

/** What the fake wrangler recorded, or a throw if it never ran. */
const wranglerCall = (sandbox: string) => execFileSync("cat", [join(sandbox, "wrangler-call")], { encoding: "utf8" });

describe("previewScript", () => {
  const target = { accountId: "acct", workerName: "fixture", previewName: "t1a1-pabc123" };

  it("builds with preview.command, then deploys the head as the named Preview and reports its URL", () => {
    const head = attemptHead();
    const { result, sandbox } = runPreview(
      previewScript(fork, head, { ...target, command: "cat b.txt > built" }),
      fakeWrangler("deploys"),
    );
    expect(result).toEqual({ ok: true, url: "https://t1a1-pabc123-fixture.acct.workers.dev" });
    expect(wranglerCall(sandbox)).toBe(
      "preview --worker-name fixture --name t1a1-pabc123 --json\nadded-by-worker\nacct\nattempt\nline two\n",
    );
  });

  it("deploys without a build step when preview has no command", () => {
    const head = attemptHead();
    const { result } = runPreview(previewScript(fork, head, { ...target, command: null }), fakeWrangler("deploys"));
    expect(result).toMatchObject({ ok: true });
  });

  it("fails at the build stage, with its output, and deploys nothing when preview.command fails", () => {
    const head = attemptHead();
    const { result, sandbox } = runPreview(
      previewScript(fork, head, { ...target, command: "echo 'it is broken' >&2; exit 2" }),
      fakeWrangler("deploys"),
    );
    expect(result).toMatchObject({ ok: false, stage: "build" });
    expect(result.ok === false && result.output).toContain("it is broken");
    expect(() => wranglerCall(sandbox)).toThrow();
  });

  it("fails at the deploy stage, with wrangler's output, when the deploy fails", () => {
    const head = attemptHead();
    const { result } = runPreview(previewScript(fork, head, { ...target, command: null }), fakeWrangler("fails"));
    expect(result).toMatchObject({ ok: false, stage: "deploy" });
    expect(result.ok === false && result.output).toContain("deploy refused");
  });

  it("is idempotent: rerunning in the same directory deploys again", () => {
    const head = attemptHead();
    const script = previewScript(fork, head, { ...target, command: "touch built" });
    const bin = fakeWrangler("deploys");
    const { result, sandbox } = runPreview(script, bin);
    expect(runPreview(script, bin, sandbox).result).toEqual(result);
  });
});

/** The attempt adds b.txt on top of base; meanwhile main gains c.txt. */
function divergedAttempt(): string {
  const attempt = commit("b.txt", "attempt\n", "attempt");
  git(work, "push", "-q", fork, "main");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  commit("c.txt", "someone else\n", "main moved");
  git(work, "push", "-q", origin, "main");
  return attempt;
}

describe("retestScript", () => {
  it("rebases onto the current main and reports the base and the tested tree", () => {
    const attempt = divergedAttempt();
    const result = runScript<RetestResult>(retestScript(origin, fork, attempt));
    expect(result).toMatchObject({ kind: "tested", base: git(origin, "rev-parse", "main") });
    expect(result.kind === "tested" && result.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("bounces a conflicting attempt with the conflicted files and hunks", () => {
    const attempt = commit("a.txt", "one\nmine\nthree\n", "attempt");
    git(work, "push", "-q", fork, "main");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    commit("a.txt", "one\ntheirs\nthree\n", "main moved");
    git(work, "push", "-q", origin, "main");

    const result = runScript<RetestResult>(retestScript(origin, fork, attempt));
    expect(result).toMatchObject({ kind: "bounced", files: ["a.txt"] });
    expect(result.kind === "bounced" && result.diff).toMatch(/<<<<<<<[\s\S]*theirs[\s\S]*=======[\s\S]*mine/);
  });

  it("fails when tests break after the rebase", () => {
    const attempt = commit("b.txt", "attempt\n", "attempt");
    git(work, "push", "-q", fork, "main");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    commit("a.txt", "one\nbad\nthree\n", "main broke");
    git(work, "push", "-q", origin, "main");

    expect(runScript<RetestResult>(retestScript(origin, fork, attempt))).toMatchObject({ kind: "failed" });
  });
});

function retested(attempt: string): { base: string; tree: string } {
  const result = runScript<RetestResult>(retestScript(origin, fork, attempt));
  if (result.kind !== "tested") throw new Error(`retest did not pass: ${JSON.stringify(result)}`);
  return result;
}

describe("landScript", () => {
  it("lands exactly the tree the retest step tested", () => {
    const attempt = divergedAttempt();
    const tested = retested(attempt);

    const result = runScript<LandResult>(landScript(origin, fork, attempt, tested));
    expect(result).toEqual({ kind: "landed", mainSha: git(origin, "rev-parse", "main") });
    expect(git(origin, "rev-parse", "main^{tree}")).toBe(tested.tree);
    expect(git(origin, "log", "--format=%s", "main")).toBe("attempt\nmain moved\nbase");
  });

  it("reports main moved, without pushing, when main changed after the retest", () => {
    const attempt = divergedAttempt();
    const tested = retested(attempt);
    commit("d.txt", "later\n", "main moved again");
    git(work, "push", "-q", origin, "main");
    const before = git(origin, "rev-parse", "main");

    expect(runScript<LandResult>(landScript(origin, fork, attempt, tested))).toEqual({ kind: "moved" });
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  it("refuses to push a tree other than the one tested", () => {
    const attempt = divergedAttempt();
    const tested = retested(attempt);
    const before = git(origin, "rev-parse", "main");

    const forged = { ...tested, tree: git(work, "rev-parse", "HEAD^{tree}") };
    expect(runScript<LandResult>(landScript(origin, fork, attempt, forged))).toMatchObject({ kind: "mismatch" });
    expect(git(origin, "rev-parse", "main")).toBe(before);
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
