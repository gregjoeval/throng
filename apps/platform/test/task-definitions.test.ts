import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { CheckConfig, MetricConfig } from "../src/config.ts";
import { buildResult, scorePlan, scoreTimeoutMs } from "../src/results.ts";
import type { RawScore } from "../src/results.ts";
import { NO_TASK_DEFINITIONS, withTask } from "../src/task-definitions.ts";

const PROJECT = parseConfig(`checks:
  - name: test
    command: npm test
metrics:
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
`);

const task = (...metrics: Partial<Pick<MetricConfig, "name" | "from">>[]) => ({
  checks: [],
  metrics: metrics.map((metric): MetricConfig => ({
    name: "lines",
    from: "test.coverage-summary.total.lines.total",
    type: "number",
    unit: null,
    order: "asc",
    source: "task",
    ...metric,
  })),
});

const taskCheck = (check: Partial<CheckConfig> = {}): CheckConfig => ({
  name: "smoke",
  command: "./smoke.sh",
  timeoutMs: 60_000,
  after: [],
  source: "task",
  ...check,
});

function raw(checks: RawScore["checks"]): RawScore {
  return { base: null, shortstat: "", builtinMs: 0, setupFailed: null, checks };
}

describe("a run's config with its task's definitions", () => {
  it("reads a task metric over a project check, and scores it with source task", () => {
    const config = withTask(PROJECT, task({}));
    expect(scorePlan(config).checks[0]?.metrics.map((metric) => metric.name)).toEqual(["coverage", "lines"]);
    const result = buildResult(
      config,
      raw([{ exit: 0, durationMs: 5, metrics: { coverage: { value: 81.5 }, lines: { value: 1200 } } }]),
    );
    expect(result.config).toEqual({ kind: "valid" });
    expect(result.metrics["coverage"]).toMatchObject({ source: "project", value: 81.5 });
    expect(result.metrics["lines"]).toEqual({ source: "task", type: "number", value: 1200, order: "asc" });
  });

  it("is the project's alone when the task defines nothing", () => {
    expect(withTask(PROJECT, NO_TASK_DEFINITIONS)).toBe(PROJECT);
  });

  it("is invalid, naming each clash, when the project's config came to use a task's names", () => {
    const clashing = withTask(PROJECT, task({ name: "coverage" }, { name: "test" }, { from: "lint.report.errors" }));
    expect(clashing).toEqual({
      kind: "invalid",
      error: [
        "task metrics[0].name: coverage is also a metric's name in .throng/config.yml",
        "task metrics[1].name: test is also a check's name in .throng/config.yml",
        "task metrics[2].from: no check is named lint",
      ].join("\n"),
    });
    const result = buildResult(clashing, raw([]));
    expect(result.gate).toBe("failed");
    expect(result.config).toMatchObject({ kind: "invalid", error: expect.stringContaining("coverage") });
  });

  it("keeps the project's error when its config is invalid, and needs a check for a task metric without one", () => {
    const invalid = parseConfig("nope: 1\n");
    expect(withTask(invalid, task({}))).toBe(invalid);
    expect(withTask(parseConfig(null), task({}))).toEqual({
      kind: "invalid",
      error: "task metrics[0].from: no check is named test",
    });
  });

  it("runs a task's checks after the project's, under its setup and network, with source task", () => {
    const project = parseConfig(`setup: [{ name: deps, command: pnpm install }]
network: { allow: [api.example.com] }
checks:
  - { name: test, command: npm test, timeout: 2m }
`);
    const config = withTask(project, {
      checks: [taskCheck()],
      metrics: [
        {
          name: "smoked",
          from: "smoke.report.ok",
          type: "boolean",
          order: "desc",
          source: "task",
        },
      ],
    });
    const plan = scorePlan(config);
    expect(plan.setup).toEqual([{ name: "deps", command: "pnpm install" }]);
    expect(plan.allow).toEqual(["api.example.com"]);
    expect(plan.checks.map((check) => [check.name, check.metrics.map((metric) => metric.name)])).toEqual([
      ["test", []],
      ["smoke", ["smoked"]],
    ]);
    expect(scoreTimeoutMs(plan)).toBe(scoreTimeoutMs({ ...plan, checks: plan.checks.slice(0, 1) }) + 60_000);

    const result = buildResult(
      config,
      raw([
        { exit: 0, durationMs: 5, metrics: {} },
        { exit: 0, durationMs: 7, metrics: { smoked: { value: true } } },
      ]),
    );
    expect(result.gate).toBe("passed");
    expect(result.checks.map((check) => [check.name, check.source])).toEqual([
      ["_diff", "platform"],
      ["test", "project"],
      ["smoke", "task"],
    ]);
    expect(result.metrics["smoke"]).toMatchObject({ source: "task", type: "enum", value: "passed" });
    expect(result.metrics["smoked"]).toEqual({ source: "task", type: "boolean", order: "desc", value: true });
  });

  it("fails the gate when a task check fails", () => {
    const failing = raw([
      { exit: 0, durationMs: 5, metrics: {} },
      { exit: 1, durationMs: 5, metrics: {} },
    ]);
    expect(buildResult(withTask(PROJECT, { checks: [taskCheck()], metrics: [] }), failing).gate).toBe("failed");
  });

  it("runs a task's checks on a project with no config", () => {
    const config = withTask(parseConfig(null), { checks: [taskCheck()], metrics: [] });
    expect(scorePlan(config).checks.map((check) => check.name)).toEqual(["smoke"]);
    expect(buildResult(config, raw([{ exit: 1, durationMs: 5, metrics: {} }])).gate).toBe("failed");
  });

  it("is invalid when the project's config came to use a task check's name", () => {
    const clashing = withTask(PROJECT, {
      checks: [taskCheck({ name: "test" }), taskCheck({ name: "coverage" })],
      metrics: [],
    });
    expect(clashing).toEqual({
      kind: "invalid",
      error: [
        "task checks[0].name: test is also a check's name in .throng/config.yml",
        "task checks[1].name: coverage is also a metric's name in .throng/config.yml",
      ].join("\n"),
    });
  });

  it("lets a task's check wait for a project check, or another of the task's", () => {
    const config = withTask(PROJECT, {
      checks: [taskCheck({ name: "smoke", after: ["test"] }), taskCheck({ name: "e2e", after: ["smoke"] })],
      metrics: [],
    });
    expect(scorePlan(config).checks.map((check) => [check.name, check.after])).toEqual([
      ["test", []],
      ["smoke", ["test"]],
      ["e2e", ["smoke"]],
    ]);
  });

  it("is invalid when a task's check waits for a setup, an unknown check, itself or in a circle", () => {
    const project = parseConfig("setup: [{ name: deps, command: npm ci }]\nchecks: [{ name: test, command: x }]\n");
    const invalid = withTask(project, {
      checks: [
        taskCheck({ name: "a", after: ["deps"] }),
        taskCheck({ name: "b", after: ["nope"] }),
        taskCheck({ name: "c", after: ["c"] }),
        taskCheck({ name: "d", after: ["e"] }),
        taskCheck({ name: "e", after: ["d"] }),
        taskCheck({ name: "deps" }),
      ],
      metrics: [],
    });
    expect(invalid).toEqual({
      kind: "invalid",
      error: [
        "task checks[5].name: deps is also a setup's name in .throng/config.yml",
        "task checks[0].after: deps is a setup; every check already waits for every setup, so after only names checks",
        "task checks[1].after: no check is named nope",
        "task checks[2].after: a check can't wait for itself",
        "task checks[3].after: after makes a circle: d → e → d",
      ].join("\n"),
    });
  });
});
