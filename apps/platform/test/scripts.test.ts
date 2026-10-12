import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { buildResult, MAX_OUTPUT_BYTES, scorePlan } from "../src/results.ts";
import type { PlannedMetric, RawScore, ScorePlan } from "../src/results.ts";
import { parseResult, previewScript, scoreScript } from "../src/scripts.ts";
import type { PreviewScriptResult } from "../src/scripts.ts";
import { NO_TASK_DEFINITIONS, taskDefinitionsFrom, withTask } from "../src/task-definitions.ts";
import { at } from "./support/defined.ts";

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

afterEach(() => rmSync(root, { recursive: true, force: true }));

const plan = (overrides: Partial<ScorePlan> = {}): ScorePlan => ({ setup: [], checks: [], allow: [], ...overrides });
const check = (name: string, command: string, timeoutMs = 60_000, metrics: PlannedMetric[] = []) => ({
  name,
  command,
  timeoutMs,
  metrics,
});
const number = (name: string, from: string): PlannedMetric => ({ name, from, rule: { type: "number" } });

/** Pushes an attempt to the fork on top of the origin's main (adds 2 lines, deletes 2) and returns its head. */
function attemptHead(): string {
  commit("b.txt", "attempt\nline two\n", "attempt");
  const head = commit("a.txt", "one\n", "attempt trims a.txt");
  git(work, "push", "-q", fork, "main");
  return head;
}

describe("scoreScript", () => {
  it("records the base it's given and the diff size from it, and runs nothing without a plan", () => {
    const base = git(origin, "rev-parse", "main");
    const head = attemptHead();
    const raw = runScript<RawScore>(scoreScript(fork, { sha: head, base }, plan()));
    expect(raw).toMatchObject({ base, setupFailed: null, checks: [] });
    expect(raw.shortstat.trim()).toBe("2 files changed, 2 insertions(+), 2 deletions(-)");
    expect(raw.builtinMs).toBeGreaterThanOrEqual(0);
  });

  it("diffs against the empty tree when the attempt has no base", () => {
    git(work, "checkout", "-q", "--orphan", "lone");
    git(work, "rm", "-rqf", ".");
    const head = commit("only.txt", "x\ny\n", "unrelated");
    git(work, "push", "-q", fork, "lone:main", "--force");
    const raw = runScript<RawScore>(scoreScript(fork, { sha: head, base: null }, plan()));
    expect(raw.base).toBeNull();
    expect(raw.shortstat.trim()).toBe("1 file changed, 2 insertions(+)");
  });

  it("runs every check in order, after a failure too, with a fresh $THRONG_OUTPUT directory each, reading a failed check's output too", () => {
    const head = attemptHead();
    const empty = `test -z "$(ls -A "$THRONG_OUTPUT")"`;
    const checks = [
      check("first", `${empty} && echo '{"n": 1}' > "$THRONG_OUTPUT/r.json" && echo first >> ../order`, 60_000, [
        number("n", "first.r.n"),
      ]),
      check("broken", `echo broken >> ../order; echo '{"failed": 2}' > "$THRONG_OUTPUT/r.json"; exit 3`, 60_000, [
        number("failed", "broken.r.failed"),
      ]),
      check("last", `${empty} && echo last >> ../order && test -f b.txt`),
    ];
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const raw = runScript<RawScore>(scoreScript(fork, { sha: head, base: null }, plan({ checks })), sandbox);
    expect(raw.checks.map((c) => [c.exit, c.metrics])).toEqual([
      [0, { n: { value: 1 } }],
      [3, { failed: { value: 2 } }],
      [0, {}],
    ]);
    expect(execFileSync("cat", [join(sandbox, "order")], { encoding: "utf8" })).toBe("first\nbroken\nlast\n");
    expect(execFileSync("cat", [join(sandbox, "logs/broken.log")], { encoding: "utf8" })).toBe("");
  });

  it("skips every check after a failed setup command, and names the command", () => {
    const head = attemptHead();
    const setup = ["true", "echo nope >&2; false", "touch ../never"];
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const raw = runScript<RawScore>(
      scoreScript(
        fork,
        { sha: head, base: null },
        plan({ setup, checks: [check("test", "true", 60_000, [number("n", "test.r.n")])] }),
      ),
      sandbox,
    );
    expect(raw).toMatchObject({ setupFailed: 2, checks: [{ exit: null, metrics: {} }] });
    expect(execFileSync("cat", [join(sandbox, "logs/setup.2.log")], { encoding: "utf8" })).toBe("nope\n");
    expect(() => execFileSync("test", ["-e", join(sandbox, "never")])).toThrow();
  });

  it("stops a check at its timeout", () => {
    const head = attemptHead();
    const raw = runScript<RawScore>(
      scoreScript(fork, { sha: head, base: null }, plan({ checks: [check("slow", "sleep 20", 1000)] })),
    );
    expect(raw.checks[0]).toMatchObject({ exit: 124 });
    expect(at(raw.checks, 0).durationMs).toBeGreaterThanOrEqual(1000);
    expect(at(raw.checks, 0).durationMs).toBeLessThan(10_000);
  });

  it("quotes commands so a check can't break out of the script", () => {
    const head = attemptHead();
    const raw = runScript<RawScore>(
      scoreScript(
        fork,
        { sha: head, base: null },
        plan({ checks: [check("quotes", `echo "it's" '$HOME' "$(echo ok)" > ../quoted`)] }),
      ),
    );
    expect(at(raw.checks, 0).exit).toBe(0);
  });

  it("is idempotent: rerunning in the same directory gives the same result", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const script = scoreScript(
      fork,
      { sha: head, base: null },
      plan({
        checks: [
          check("test", `test ! -e "$THRONG_OUTPUT/r.json" && echo '{"n": 1}' > "$THRONG_OUTPUT/r.json"`, 60_000, [
            number("n", "test.r.n"),
          ]),
        ],
      }),
    );
    const first = runScript<RawScore>(script, sandbox);
    const second = runScript<RawScore>(script, sandbox);
    expect(first.checks[0]).toMatchObject({ exit: 0, metrics: { n: { value: 1 } } });
    expect({ ...second, builtinMs: 0, checks: second.checks.map((c) => ({ ...c, durationMs: 0 })) }).toEqual({
      ...first,
      builtinMs: 0,
      checks: first.checks.map((c) => ({ ...c, durationMs: 0 })),
    });
  });

  it("turns a project's config into a scored result end to end, reading two files from one check", () => {
    const head = attemptHead();
    const report = { numTotalTests: 12, numFailedTests: 0, testResults: [{ name: "a", duration: 7 }] };
    const coverage = { total: { lines: { pct: 87.5 } } };
    const config = parseConfig(`checks:
  - name: test
    command: >-
      echo '${JSON.stringify(report)}' > "$THRONG_OUTPUT/report.json" &&
      echo '${JSON.stringify(coverage)}' > "$THRONG_OUTPUT/coverage-summary.json"
  - name: lint
    command: >-
      echo '{"errors": 3}' > "$THRONG_OUTPUT/lint.json"; exit 1
    required: false
metrics:
  - { name: tests, from: test.report.numTotalTests, type: number }
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
  - { name: first-duration, from: test.report.testResults.0.duration, type: number, order: asc }
  - { name: lint-errors, from: lint.lint.errors, type: number, order: asc }
`);
    const raw = runScript<RawScore>(
      scoreScript(fork, { sha: head, base: git(origin, "rev-parse", "main") }, scorePlan(config)),
    );
    const result = buildResult(config, raw);
    expect(result).toMatchObject({
      config: { kind: "valid" },
      gate: "passed",
      checks: [
        { name: "_diff", outcome: "passed" },
        { name: "test", required: true, outcome: "passed" },
        { name: "lint", required: false, outcome: "failed" },
        { name: "_preview", outcome: "skipped" },
      ],
      metrics: {
        "_diff.filesChanged": { value: 2 },
        "_diff.additions": { value: 2 },
        "_diff.deletions": { value: 2 },
        tests: { source: "project", type: "number", value: 12, order: "desc" },
        coverage: { source: "project", type: "number", value: 87.5, unit: "%" },
        "first-duration": { value: 7, order: "asc" },
        "lint-errors": { value: 3 },
      },
    });
  });

  it("runs a task's checks after the project's, after its setup, and gates on a required one", () => {
    const head = attemptHead();
    const project = parseConfig(`setup:
  - echo ready > ../setup-ran
checks:
  - name: test
    command: >-
      echo '{"lines": 40}' > "$THRONG_OUTPUT/report.json"
`);
    const task = taskDefinitionsFrom(
      {
        checks: [
          {
            name: "smoke",
            command: `test -f ../setup-ran && echo '{"ok": false}' > "$THRONG_OUTPUT/smoke.json"; exit 1`,
          },
        ],
        metrics: [
          { name: "lines", from: "test.report.lines", type: "number" },
          { name: "smoked", from: "smoke.smoke.ok", type: "boolean" },
        ],
      },
      NO_TASK_DEFINITIONS,
      project,
    );
    if ("error" in task) throw new Error(task.error);
    const config = withTask(project, task.definitions);
    const raw = runScript<RawScore>(
      scoreScript(fork, { sha: head, base: git(origin, "rev-parse", "main") }, scorePlan(config)),
    );
    expect(buildResult(config, raw)).toMatchObject({
      gate: "failed",
      checks: [
        { name: "_diff" },
        { name: "test", source: "project", outcome: "passed" },
        { name: "smoke", source: "task", required: true, outcome: "failed" },
        { name: "_preview", outcome: "skipped" },
      ],
      metrics: {
        smoke: { source: "task", value: "failed" },
        lines: { source: "task", value: 40 },
        smoked: { source: "task", value: false },
      },
    });
  });

  it("nulls a metric it can't read, naming the segment of from that failed and what was there", () => {
    const head = attemptHead();
    const json = { total: { lines: { pct: "87" } }, runs: [{ ms: 1 }], label: "x" };
    const metrics = [
      number("missing-file", "test.nope.total"),
      number("missing-key", "test.out.totals.lines"),
      number("missing-index", "test.out.runs.3.ms"),
      number("not-an-index", "test.out.runs.first"),
      number("into-a-string", "test.out.label.length"),
      number("wrong-type", "test.out.total.lines.pct"),
      number("bad-json", "test.bad.n"),
      number("too-large", "test.big.n"),
    ];
    const command = [
      `echo '${JSON.stringify(json)}' > "$THRONG_OUTPUT/out.json"`,
      `echo '{"n": ' > "$THRONG_OUTPUT/bad.json"`,
      `head -c ${MAX_OUTPUT_BYTES + 1} /dev/zero > "$THRONG_OUTPUT/big.json"`,
      `touch "$THRONG_OUTPUT/notes.txt"`,
    ].join(" && ");
    const raw = runScript<RawScore>(
      scoreScript(fork, { sha: head, base: null }, plan({ checks: [check("test", command, 60_000, metrics)] })),
    );
    expect(at(raw.checks, 0).metrics).toEqual({
      "missing-file": { value: null, note: "test.nope: no nope.json in $THRONG_OUTPUT; files there: bad, big, out" },
      "missing-key": { value: null, note: "test.out.totals: no key totals; keys there: total, runs, label" },
      "missing-index": { value: null, note: "test.out.runs.3: no index 3 in an array; indexes there: 0 to 0" },
      "not-an-index": { value: null, note: "test.out.runs.first: no index first in an array; indexes there: 0 to 0" },
      "into-a-string": {
        value: null,
        note: "test.out.label.length: no key length; label is a string, not an object or array",
      },
      "wrong-type": { value: null, note: "test.out.total.lines.pct: expected a number, got a string" },
      "bad-json": { value: null, note: "test.bad: bad.json is not valid JSON" },
      "too-large": { value: null, note: "test.big: big.json is over the parse guard of 32 MB" },
    });
  });

  it("checks each value against its metric's type: booleans, strings and an enum's listed values", () => {
    const head = attemptHead();
    const json = { ok: true, flaky: "no", grade: "b", other: "z", url: "https://ci.example.test/1", n: 1 };
    const metrics: PlannedMetric[] = [
      { name: "ok", from: "test.out.ok", rule: { type: "boolean" } },
      { name: "flaky", from: "test.out.flaky", rule: { type: "boolean" } },
      { name: "grade", from: "test.out.grade", rule: { type: "enum", values: ["a", "b"] } },
      { name: "other", from: "test.out.other", rule: { type: "enum", values: ["a", "b"] } },
      { name: "url", from: "test.out.url", rule: { type: "string" } },
      { name: "n", from: "test.out.n", rule: { type: "string" } },
    ];
    const command = `echo '${JSON.stringify(json)}' > "$THRONG_OUTPUT/out.json"`;
    const raw = runScript<RawScore>(
      scoreScript(fork, { sha: head, base: null }, plan({ checks: [check("test", command, 60_000, metrics)] })),
    );
    expect(at(raw.checks, 0).metrics).toEqual({
      ok: { value: true },
      flaky: { value: null, note: "test.out.flaky: expected a boolean, got a string" },
      grade: { value: "b" },
      other: { value: null, note: 'test.out.other: "z" is not one of its values: a, b' },
      url: { value: "https://ci.example.test/1" },
      n: { value: null, note: "test.out.n: expected a string, got a number" },
    });
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

/** The preview's log the script left for storing. */
const previewLog = (sandbox: string) =>
  execFileSync("cat", [join(sandbox, "logs/preview.deploy.log")], { encoding: "utf8" });

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

  it("writes the build's and the deploy's output to the preview's log, whichever stage it ends at", () => {
    const head = attemptHead();
    const failed = runPreview(
      previewScript(fork, head, { ...target, command: "echo building; echo 'it is broken' >&2; exit 2" }),
      fakeWrangler("deploys"),
    );
    expect(previewLog(failed.sandbox)).toBe("building\nit is broken\n");

    const sandbox = mkdtempSync(join(root, "sandbox-"));
    runPreview(previewScript(fork, head, { ...target, command: "echo building" }), fakeWrangler("fails"), sandbox);
    expect(previewLog(sandbox)).toBe("building\ndeploy refused\n");
    // A rerun starts the log afresh.
    runPreview(previewScript(fork, head, { ...target, command: null }), fakeWrangler("fails"), sandbox);
    expect(previewLog(sandbox)).toBe("deploy refused\n");
  });

  it("is idempotent: rerunning in the same directory deploys again", () => {
    const head = attemptHead();
    const script = previewScript(fork, head, { ...target, command: "touch built" });
    const bin = fakeWrangler("deploys");
    const { result, sandbox } = runPreview(script, bin);
    expect(runPreview(script, bin, sandbox).result).toEqual(result);
  });
});
