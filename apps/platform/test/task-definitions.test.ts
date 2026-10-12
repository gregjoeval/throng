import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { MetricConfig } from "../src/config.ts";
import { buildResult, scorePlan } from "../src/results.ts";
import type { RawScore } from "../src/results.ts";
import { NO_TASK_DEFINITIONS, withTask } from "../src/task-definitions.ts";

const PROJECT = parseConfig(`checks:
  - name: test
    command: npm test
metrics:
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
`);

const task = (...metrics: Partial<Pick<MetricConfig, "name" | "from">>[]) => ({
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
});
