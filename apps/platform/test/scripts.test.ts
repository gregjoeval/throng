import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { ConfigResult, SetupConfig } from "../src/config.ts";
import { buildResult, checkOrder, MAX_OUTPUT_BYTES, scorePlan } from "../src/results.ts";
import type { PlannedCheck, PlannedMetric, RawScore } from "../src/results.ts";
import {
  checkScript,
  mergeCheckoutSha,
  parseResult,
  RERUN_SETUP_FAILED_EXIT,
  setupScript,
  STEP_NOT_READY_EXIT,
  stepReadyScript,
  stepScript,
} from "../src/scripts.ts";
import type { Checkout, CheckRun, MergeCheckout, SetupResult, StepReady, StepRun } from "../src/scripts.ts";
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

const check = (name: string, command: string, timeoutMs = 60_000, metrics: PlannedMetric[] = []): PlannedCheck => ({
  name,
  command,
  timeoutMs,
  after: [],
  secrets: [],
  caches: [],
  metrics,
});
const setup = (...commands: string[]): SetupConfig[] =>
  commands.map((command, i) => ({ name: `s${i + 1}`, command, secrets: [], caches: [] }));
const number = (name: string, from: string): PlannedMetric => ({ name, from, rule: { type: "number" } });
const cat = (path: string) => execFileSync("cat", [path], { encoding: "utf8" });

/** Pushes an attempt to the fork on top of the origin's main (adds 2 lines, deletes 2) and returns its head. */
function attemptHead(): string {
  commit("b.txt", "attempt\nline two\n", "attempt");
  const head = commit("a.txt", "one\n", "attempt trims a.txt");
  git(work, "push", "-q", fork, "main");
  return head;
}

/** What a line's containers check out: `sha`, fetched from `remote`. */
const line = (remote: string, sha: string): Checkout => ({ kind: "line", remote, sha });

/** Runs one check in `sandbox`: one the setup container's snapshot started (it holds `setup.done`), or a fresh one. */
function runCheck(sandbox: string, head: string, setups: SetupConfig[], planned: PlannedCheck): CheckRun {
  return runScript<CheckRun>(checkScript(line(fork, head), setups, planned), sandbox);
}

/**
 * Runs a config's plan as a pipeline run's containers would: the setups in one directory, then each
 * check in a copy of it (a snapshot's restore), skipping a check whose waits didn't all pass.
 */
function runPipeline(config: ConfigResult, base: string | null, head: string): RawScore {
  const plan = scorePlan(config);
  const setupDir = mkdtempSync(join(root, "setup-"));
  const ran = runScript<SetupResult>(setupScript(line(fork, head), base, plan.setup), setupDir);
  const failed = ran.setups.findIndex((s) => s.exit !== 0);
  const exits = new Map<string, number>();
  for (const planned of checkOrder(plan.checks)) {
    if (failed !== -1 || planned.after.some((name) => exits.get(name) !== 0)) continue;
    const restored = mkdtempSync(join(root, "check-"));
    cpSync(setupDir, restored, { recursive: true });
    exits.set(planned.name, runCheck(restored, head, plan.setup, planned).exit);
  }
  return {
    base: ran.base,
    shortstat: ran.shortstat,
    builtinMs: ran.builtinMs,
    setupFailed: failed === -1 ? null : failed + 1,
    checks: plan.checks.map((planned) => {
      const exit = exits.get(planned.name);
      return exit === undefined ? { exit: null, durationMs: 0, metrics: {} } : { exit, durationMs: 1, metrics: {} };
    }),
  };
}

describe("setupScript", () => {
  it("records the base it's given and the diff size from it, and runs nothing without setups", () => {
    const base = git(origin, "rev-parse", "main");
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const ran = runScript<SetupResult>(setupScript(line(fork, head), base, []), sandbox);
    expect(ran).toMatchObject({ base, setups: [] });
    expect(ran.shortstat.trim()).toBe("2 files changed, 2 insertions(+), 2 deletions(-)");
    expect(ran.builtinMs).toBeGreaterThanOrEqual(0);
    expect(cat(join(sandbox, "setup.done"))).toBe("");
  });

  it("diffs against the empty tree when the attempt has no base", () => {
    git(work, "checkout", "-q", "--orphan", "lone");
    git(work, "rm", "-rqf", ".");
    const head = commit("only.txt", "x\ny\n", "unrelated");
    git(work, "push", "-q", fork, "lone:main", "--force");
    const ran = runScript<SetupResult>(setupScript(line(fork, head), null, []));
    expect(ran.base).toBeNull();
    expect(ran.shortstat.trim()).toBe("1 file changed, 2 insertions(+)");
  });

  it("runs each setup in order, logging each, and gets the run's variables", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const ran = runScript<SetupResult>(
      setupScript(line(fork, head), null, setup("echo one >> ../order", "echo two >> ../order; echo logged")),
      sandbox,
    );
    expect(ran.setups.map((s) => s.exit)).toEqual([0, 0]);
    expect(cat(join(sandbox, "order"))).toBe("one\ntwo\n");
    expect(cat(join(sandbox, "logs/setup.2.log"))).toBe("logged\n");
  });

  it("stops at the first setup that fails, and leaves no mark for the checks", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const ran = runScript<SetupResult>(
      setupScript(line(fork, head), null, setup("true", "echo nope >&2; false", "touch ../never")),
      sandbox,
    );
    expect(ran.setups.map((s) => s.exit)).toEqual([0, 1, null]);
    expect(cat(join(sandbox, "logs/setup.2.log"))).toBe("nope\n");
    expect(() => execFileSync("test", ["-e", join(sandbox, "never")])).toThrow();
    expect(() => execFileSync("test", ["-e", join(sandbox, "setup.done")])).toThrow();
  });

  it("checks out a task branch's head from the origin, where it's only under refs/tasks", () => {
    commit("t.txt", "a test\n", "the task's test");
    const head = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", origin, "HEAD:refs/tasks/t1");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const ran = runScript<SetupResult>(setupScript(line(origin, head), null, setup("cat t.txt")), sandbox);
    expect(ran.setups.map((s) => s.exit)).toEqual([0]);
    expect(cat(join(sandbox, "logs/setup.1.log"))).toBe("a test\n");
  });

  it("is idempotent: rerunning in the same directory gives the same result", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const script = setupScript(line(fork, head), null, setup("test ! -e built && touch built"));
    const first = runScript<SetupResult>(script, sandbox);
    const second = runScript<SetupResult>(script, sandbox);
    expect(first.setups.map((s) => s.exit)).toEqual([0]);
    expect(second.setups.map((s) => s.exit)).toEqual([0]);
  });
});

describe("post-gate step scripts", () => {
  const deploy = {
    name: "deploy",
    command: "echo deploying >> ../deploys && test -f built && echo done",
    secrets: [],
    caches: [],
  };

  it("readies a step's container from the setups' snapshot, then runs its command once in the tree", () => {
    const head = attemptHead();
    const setups = setup("echo ran >> ../setups && touch built");
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    runScript<SetupResult>(setupScript(line(fork, head), null, setups), sandbox);
    expect(runScript<StepReady>(stepReadyScript(fork, head, setups, deploy), sandbox)).toEqual({ setupsRerun: false });
    expect(runScript<StepRun>(stepScript(deploy, 60_000), sandbox)).toMatchObject({ exit: 0 });
    expect(cat(join(sandbox, "setups"))).toBe("ran\n");
    expect(cat(join(sandbox, "deploys"))).toBe("deploying\n");
    expect(cat(join(sandbox, "logs/step.deploy.log"))).toBe("done\n");
  });

  it("readies a fresh container by fetching the head and running the setups, their output at the top of the log", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const setups = setup("echo installing && touch built");
    expect(runScript<StepReady>(stepReadyScript(fork, head, setups, deploy), sandbox)).toEqual({ setupsRerun: true });
    expect(runScript<StepRun>(stepScript(deploy, 60_000), sandbox)).toMatchObject({ exit: 0 });
    expect(cat(join(sandbox, "logs/step.deploy.log"))).toBe("== throng: setup s1 ==\ninstalling\ndone\n");
  });

  it("reports a failed command's exit, and refuses to run in a container that wasn't readied", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    expect(() => execFileSync("bash", ["-c", stepScript(deploy, 60_000)], { cwd: sandbox, env: ENV })).toThrow(
      expect.objectContaining({ status: STEP_NOT_READY_EXIT }),
    );
    runScript<StepReady>(stepReadyScript(fork, head, [], deploy), sandbox);
    expect(
      runScript<StepRun>(stepScript({ name: "deploy", command: "exit 4", secrets: [], caches: [] }, 60_000), sandbox),
    ).toMatchObject({
      exit: 4,
    });
  });

  it("moves a landing's restored container from the merged tree to the landed commit, keeping what the setups made", () => {
    const main = git(origin, "rev-parse", "main");
    const head = attemptHead();
    const tree = git(work, "rev-parse", `${head}^{tree}`);
    const merging: Checkout = { kind: "merge", origin, fork, merge: { head, main, tree, committedAt: 1 } };
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    runScript<SetupResult>(setupScript(merging, main, setup("touch built")), sandbox);
    // The land step pushed the merge to the origin's `main`: here, the head itself, whose tree is the same.
    git(work, "push", "-q", origin, "main");
    expect(runScript<StepReady>(stepReadyScript(origin, head, [], deploy), sandbox)).toEqual({ setupsRerun: false });
    expect(git(join(sandbox, "tree"), "rev-parse", "HEAD")).toBe(head);
    expect(runScript<StepRun>(stepScript(deploy, 60_000), sandbox)).toMatchObject({ exit: 0 });
  });

  it("never runs a step's command twice in one readied container", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    runScript<StepReady>(stepReadyScript(fork, head, setup("touch built"), deploy), sandbox);
    runScript<StepRun>(stepScript(deploy, 60_000), sandbox);
    expect(() => execFileSync("bash", ["-c", stepScript(deploy, 60_000)], { cwd: sandbox, env: ENV })).toThrow(
      expect.objectContaining({ status: STEP_NOT_READY_EXIT }),
    );
    expect(cat(join(sandbox, "deploys"))).toBe("deploying\n");
  });
});

/** `main` moved on after the attempt forked, so the landing merges the two. */
function diverged(): MergeCheckout {
  const head = attemptHead();
  git(work, "checkout", "-q", "-b", "other", `${head}~2`);
  const main = commit("c.txt", "main moved\n", "main moves");
  git(work, "push", "-q", origin, "other:main");
  const tree = git(work, "merge-tree", "--write-tree", main, head).split("\n")[0] ?? "";
  return { main, head, tree, committedAt: 1_700_000_000 };
}

describe("a landing's checkout", () => {
  it("makes the merge again from the origin and the fork, with `main` and the head as its parents", () => {
    const merge = diverged();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const merging: Checkout = { kind: "merge", origin, fork, merge };
    const ran = runScript<SetupResult>(
      setupScript(merging, merge.main, setup("test -f b.txt && test -f c.txt")),
      sandbox,
    );
    expect(ran.setups).toEqual([{ exit: 0, durationMs: expect.any(Number) }]);
    expect(ran.shortstat.trim()).toBe("2 files changed, 2 insertions(+), 2 deletions(-)");
    const tree = join(sandbox, "tree");
    expect(git(tree, "rev-parse", "HEAD^{tree}")).toBe(merge.tree);
    expect(git(tree, "rev-parse", "HEAD^1", "HEAD^2")).toBe(`${merge.main}\n${merge.head}`);
  });

  it("makes the same merge commit in every container, whose sha the Workflow knows without one", async () => {
    const merge = diverged();
    const merging: Checkout = { kind: "merge", origin, fork, merge };
    const heads = ["setup-", "check-"].map((prefix) => {
      const sandbox = mkdtempSync(join(root, prefix));
      runScript<SetupResult>(setupScript(merging, merge.main, []), sandbox);
      return git(join(sandbox, "tree"), "rev-parse", "HEAD");
    });
    expect(heads[1]).toBe(heads[0]);
    expect(await mergeCheckoutSha(merge)).toBe(heads[0]);
  });

  it("runs a check on the merge in a fresh container", () => {
    const merge = diverged();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const merging: Checkout = { kind: "merge", origin, fork, merge };
    const ran = runScript<CheckRun>(checkScript(merging, [], check("test", "test -f b.txt && test -f c.txt")), sandbox);
    expect(ran).toMatchObject({ exit: 0, setupsRerun: true });
  });

  it("fails as infrastructure when the merge doesn't give the tree its merge step recorded", () => {
    const merge = { ...diverged(), tree: "f".repeat(40) };
    const merging: Checkout = { kind: "merge", origin, fork, merge };
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    expect(() =>
      execFileSync("bash", ["-c", setupScript(merging, merge.main, [])], { cwd: sandbox, env: ENV, stdio: "pipe" }),
    ).toThrow(expect.objectContaining({ status: 14 }));
  });
});

describe("checkScript", () => {
  it("runs the check in the setups' tree when it starts from their snapshot, without running them again", () => {
    const head = attemptHead();
    const setups = setup("echo ran >> ../setups && touch built");
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    runScript<SetupResult>(setupScript(line(fork, head), null, setups), sandbox);
    const ran = runCheck(sandbox, head, setups, check("test", "test -f built && test -f b.txt"));
    expect(ran).toMatchObject({ exit: 0, setupsRerun: false });
    expect(cat(join(sandbox, "setups"))).toBe("ran\n");
  });

  it("fetches the head and runs the setups itself in a fresh container, their output at the top of its log", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const ran = runCheck(
      sandbox,
      head,
      setup("echo installing && touch built"),
      check("test", "test -f built && echo ok"),
    );
    expect(ran).toMatchObject({ exit: 0, setupsRerun: true });
    expect(cat(join(sandbox, "logs/test.log"))).toBe("== throng: setup s1 ==\ninstalling\nok\n");
  });

  it("fails as infrastructure when a setup that passed fails again in its own container", () => {
    const head = attemptHead();
    expect(() =>
      execFileSync("bash", ["-c", checkScript(line(fork, head), setup("false"), check("test", "true"))], {
        cwd: mkdtempSync(join(root, "sandbox-")),
        env: ENV,
      }),
    ).toThrow(expect.objectContaining({ status: RERUN_SETUP_FAILED_EXIT }));
  });

  it("gives the check an empty $THRONG_OUTPUT and reads a failed check's metrics too", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const empty = `test -z "$(ls -A "$THRONG_OUTPUT")"`;
    const ran = runCheck(
      sandbox,
      head,
      [],
      check("broken", `${empty} && echo '{"failed": 2}' > "$THRONG_OUTPUT/r.json"; exit 3`, 60_000, [
        number("failed", "broken.r.failed"),
      ]),
    );
    expect(ran).toMatchObject({ exit: 3, metrics: { failed: { value: 2 } } });
  });

  it("stops a check at its timeout", () => {
    const head = attemptHead();
    const ran = runCheck(mkdtempSync(join(root, "sandbox-")), head, [], check("slow", "sleep 20", 1000));
    expect(ran.exit).toBe(124);
    expect(ran.durationMs).toBeGreaterThanOrEqual(1000);
    expect(ran.durationMs).toBeLessThan(10_000);
  });

  it("quotes commands so a check can't break out of the script", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const ran = runCheck(sandbox, head, [], check("quotes", `echo "it's" '$HOME' "$(echo ok)" > ../quoted`));
    expect(ran.exit).toBe(0);
    expect(cat(join(sandbox, "quoted"))).toBe("it's $HOME ok\n");
  });

  it("is idempotent: rerunning in the same container gives the same result", () => {
    const head = attemptHead();
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const planned = check(
      "test",
      `test ! -e "$THRONG_OUTPUT/r.json" && echo '{"n": 1}' > "$THRONG_OUTPUT/r.json"`,
      60_000,
      [number("n", "test.r.n")],
    );
    const first = runCheck(sandbox, head, setup("touch built"), planned);
    const second = runCheck(sandbox, head, setup("touch built"), planned);
    expect(first).toMatchObject({ exit: 0, metrics: { n: { value: 1 } } });
    expect(second).toMatchObject({ exit: 0, metrics: { n: { value: 1 } } });
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
      echo '{"errors": 3}' > "$THRONG_OUTPUT/lint.json"
metrics:
  - { name: tests, from: test.report.numTotalTests, type: number }
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
  - { name: first-duration, from: test.report.testResults.0.duration, type: number, order: asc }
  - { name: lint-errors, from: lint.lint.errors, type: number, order: asc }
`);
    const plan = scorePlan(config);
    const raw = runPipeline(config, git(origin, "rev-parse", "main"), head);
    const sandbox = mkdtempSync(join(root, "sandbox-"));
    const metrics = Object.fromEntries(
      plan.checks.map((planned) => [planned.name, runCheck(sandbox, head, [], planned).metrics]),
    );
    const result = buildResult(config, {
      ...raw,
      checks: raw.checks.map((ran, i) => ({ ...ran, metrics: metrics[at(plan.checks, i).name] ?? {} })),
    });
    expect(result).toMatchObject({
      config: { kind: "valid" },
      gate: "passed",
      checks: [
        { name: "_diff", outcome: "passed" },
        { name: "test", outcome: "passed" },
        { name: "lint", outcome: "passed" },
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

  it("runs a task's checks beside the project's, after its setups, waiting as they say, and gates on them", () => {
    const head = attemptHead();
    const project = parseConfig(`setup:
  - { name: ready, command: echo ready > ../setup-ran }
checks:
  - name: test
    command: echo test >> ../order
`);
    const task = taskDefinitionsFrom(
      {
        checks: [
          { name: "smoke", command: "test -f ../setup-ran", after: "test" },
          { name: "e2e", command: "exit 1" },
          { name: "deploy", command: "true", after: ["smoke", "e2e"] },
        ],
      },
      NO_TASK_DEFINITIONS,
      project,
    );
    if ("error" in task) throw new Error(task.error);
    const config = withTask(project, task.definitions);
    expect(buildResult(config, runPipeline(config, null, head))).toMatchObject({
      gate: "failed",
      checks: [
        { name: "_diff" },
        { name: "test", source: "project", outcome: "passed" },
        { name: "smoke", source: "task", outcome: "passed" },
        { name: "e2e", source: "task", outcome: "failed" },
        { name: "deploy", source: "task", outcome: "skipped", notes: ["skipped: waits for e2e, which failed"] },
      ],
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
    const ran = runCheck(mkdtempSync(join(root, "sandbox-")), head, [], check("test", command, 60_000, metrics));
    expect(ran.metrics).toEqual({
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
    const ran = runCheck(mkdtempSync(join(root, "sandbox-")), head, [], check("test", command, 60_000, metrics));
    expect(ran.metrics).toEqual({
      ok: { value: true },
      flaky: { value: null, note: "test.out.flaky: expected a boolean, got a string" },
      grade: { value: "b" },
      other: { value: null, note: 'test.out.other: "z" is not one of its values: a, b' },
      url: { value: "https://ci.example.test/1" },
      n: { value: null, note: "test.out.n: expected a string, got a number" },
    });
  });
});
