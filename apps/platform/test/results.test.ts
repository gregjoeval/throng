import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { buildResult, checkOutcome, gateFor, parseShortstat, scorePlan, upgradeResult } from "../src/results.ts";
import type { CheckResult, LegacyResult, RawScore } from "../src/results.ts";

const BASE = "a".repeat(40);
const OUTCOMES = ["passed", "failed", "timedOut", "errored", "skipped"];

function raw(overrides: Partial<RawScore> = {}): RawScore {
  return {
    base: BASE,
    shortstat: " 3 files changed, 10 insertions(+), 4 deletions(-)",
    builtinMs: 12,
    setupFailed: null,
    checks: [],
    ...overrides,
  };
}

const CONFIG = parseConfig(`setup:
  - { name: deps, command: npm ci }
checks:
  - name: test
    command: npm test
    timeout: 2m
  - name: bundle
    command: npm run size
metrics:
  - { name: bundle_kb, from: bundle.size.kb, type: number, unit: KB, order: asc }
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
network:
  allow: [api.github.com]
`);

describe("checkOutcome", () => {
  it("passes on exit 0, fails otherwise, and skips a check that never ran", () => {
    expect(checkOutcome(0, 10, 1000)).toBe("passed");
    expect(checkOutcome(1, 10, 1000)).toBe("failed");
    expect(checkOutcome(null, 0, 1000)).toBe("skipped");
  });

  it("counts timeout's exits as timed out only when the check ran out its time", () => {
    expect(checkOutcome(124, 1000, 1000)).toBe("timedOut");
    expect(checkOutcome(137, 11_000, 1000)).toBe("timedOut");
    expect(checkOutcome(124, 5, 1000)).toBe("failed");
  });
});

function entry(outcome: CheckResult["outcome"], source: CheckResult["source"] = "project"): CheckResult {
  return {
    name: "c",
    source,
    outcome,
    durationMs: 0,
    notes: [],
  };
}

describe("gateFor", () => {
  it("passes when every check passed, and with no checks at all", () => {
    expect(gateFor([])).toBe("passed");
    expect(gateFor([entry("passed"), entry("passed", "task")])).toBe("passed");
  });

  it("fails on any project or task check that didn't pass", () => {
    for (const outcome of ["failed", "timedOut", "skipped"] as const) {
      expect(gateFor([entry("passed"), entry(outcome)])).toBe("failed");
      expect(gateFor([entry("passed"), entry(outcome, "task")])).toBe("failed");
    }
  });

  it("leaves Throng's own checks out of the gate", () => {
    expect(gateFor([entry("passed"), entry("errored", "platform")])).toBe("passed");
  });
});

describe("parseShortstat", () => {
  it("reads files, insertions and deletions, in any combination", () => {
    expect(parseShortstat(" 3 files changed, 10 insertions(+), 4 deletions(-)")).toEqual({
      filesChanged: 3,
      additions: 10,
      deletions: 4,
    });
    expect(parseShortstat(" 1 file changed, 1 deletion(-)")).toEqual({ filesChanged: 1, additions: 0, deletions: 1 });
    expect(parseShortstat("")).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  });
});

describe("scorePlan", () => {
  it("runs the config's setup and checks, each with the metrics it feeds, and nothing without a valid config", () => {
    expect(scorePlan(CONFIG)).toEqual({
      setup: [{ name: "deps", command: "npm ci", secrets: [], caches: [] }],
      checks: [
        {
          name: "test",
          command: "npm test",
          timeoutMs: 120_000,
          after: [],
          secrets: [],
          caches: [],
          metrics: [{ name: "coverage", from: "test.coverage-summary.total.lines.pct", rule: { type: "number" } }],
        },
        {
          name: "bundle",
          command: "npm run size",
          timeoutMs: 600_000,
          after: [],
          secrets: [],
          caches: [],
          metrics: [{ name: "bundle_kb", from: "bundle.size.kb", rule: { type: "number" } }],
        },
      ],
      allow: ["api.github.com"],
    });
    expect(scorePlan({ kind: "none" })).toEqual({ setup: [], checks: [], allow: [] });
  });

  it("hands the score script each metric's type rule, with an enum's values", () => {
    const config = parseConfig(
      "checks:\n  - { name: t, command: x }\nmetrics:\n" +
        "  - { name: grade, from: t.out.grade, type: enum, values: [a, b] }\n" +
        "  - { name: ok, from: t.out.ok, type: boolean, order: asc }\n" +
        "  - { name: link, from: t.out.link, type: string, format: url }\n",
    );
    expect(scorePlan(config).checks[0]?.metrics).toEqual([
      { name: "grade", from: "t.out.grade", rule: { type: "enum", values: ["a", "b"] } },
      { name: "ok", from: "t.out.ok", rule: { type: "boolean" } },
      { name: "link", from: "t.out.link", rule: { type: "string" } },
    ]);
    expect(scorePlan({ kind: "invalid", error: "x" })).toEqual({ setup: [], checks: [], allow: [] });
  });
});

describe("buildResult", () => {
  it("passes a zero-config project, recording the diff as the _diff check, Throng's only check", () => {
    expect(buildResult({ kind: "none" }, raw())).toEqual({
      base: BASE,
      config: { kind: "none" },
      gate: "passed",
      checks: [{ name: "_diff", source: "platform", outcome: "passed", durationMs: 12, notes: [] }],
      metrics: {
        _diff: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
        "_diff.filesChanged": { source: "platform", type: "number", value: 3, order: "asc" },
        "_diff.additions": { source: "platform", type: "number", value: 10, order: "asc" },
        "_diff.deletions": { source: "platform", type: "number", value: 4, order: "asc" },
      },
      logs: [],
    });
  });

  it("fails an invalid config's gate, keeping its error on config and running only _diff", () => {
    const invalid = parseConfig("checks:\n  - name: Bad Name\n    command: x\n");
    expect(invalid.kind).toBe("invalid");
    const result = buildResult(invalid, raw());
    expect(result).toMatchObject({
      config: { kind: "invalid", error: expect.stringMatching(/checks\[0\]\.name/u) },
      gate: "failed",
      metrics: { "_diff.filesChanged": { value: 3 } },
    });
    expect(result.checks.map((c) => [c.name, c.outcome, c.notes])).toEqual([["_diff", "passed", []]]);
  });

  it("scores each check from its exit, and fails the gate on any that didn't pass", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 900, metrics: { coverage: { value: 92 } } },
          { exit: 1, durationMs: 40, metrics: { bundle_kb: { value: 120 } } },
        ],
      }),
    );
    expect(result.gate).toBe("failed");
    expect(result.checks.slice(1, 3)).toEqual([
      { name: "test", source: "project", outcome: "passed", durationMs: 900, notes: [] },
      { name: "bundle", source: "project", outcome: "failed", durationMs: 40, notes: [] },
    ]);
  });

  it("gives each config check an outcome metric, followed by the metrics read from its output", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 900, metrics: { coverage: { value: 92 } } },
          { exit: 1, durationMs: 40, metrics: { bundle_kb: { value: 120 } } },
        ],
      }),
    );
    expect(Object.keys(result.metrics)).toEqual([
      "_diff",
      "_diff.filesChanged",
      "_diff.additions",
      "_diff.deletions",
      "test",
      "coverage",
      "bundle",
      "bundle_kb",
    ]);
    expect(result.metrics).toMatchObject({
      test: { source: "project", type: "enum", value: "passed", values: OUTCOMES },
      coverage: { source: "project", type: "number", value: 92, order: "desc", unit: "%" },
      bundle: { source: "project", type: "enum", value: "failed", values: OUTCOMES },
    });
  });

  it("nulls the metrics of a check that failed, whatever it reported, saying so", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 900, metrics: { coverage: { value: 92 } } },
          { exit: 1, durationMs: 40, metrics: { bundle_kb: { value: 120 } } },
        ],
      }),
    );
    expect(result.metrics.bundle_kb).toEqual({
      source: "project",
      type: "number",
      value: null,
      order: "asc",
      unit: "KB",
      note: "bundle: bundle failed",
    });
  });

  it("keeps the note of a metric the score script couldn't read", () => {
    const note = "test.coverage-summary.total: no key total; keys there: totals";
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 1, metrics: { coverage: { value: null, note } } },
          { exit: 0, durationMs: 1, metrics: { bundle_kb: { value: 3 } } },
        ],
      }),
    );
    expect(result.metrics.coverage).toEqual({
      source: "project",
      type: "number",
      value: null,
      order: "desc",
      unit: "%",
      note,
    });
  });

  it("checks a reported value's type again, and nulls a metric the score script didn't report", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 1, metrics: { coverage: { value: "92" as unknown as number } } },
          { exit: 0, durationMs: 1, metrics: {} },
        ],
      }),
    );
    expect(result.metrics.coverage).toMatchObject({
      value: null,
      note: "test.coverage-summary.total.lines.pct: expected a number, got a string",
    });
    expect(result.metrics.bundle_kb).toMatchObject({ value: null, note: "bundle.size.kb: not reported" });
  });

  it("leaves out a metric's unit when it declares none, and defaults a number to higher is better", () => {
    const config = parseConfig(
      "checks:\n  - name: t\n    command: x\nmetrics:\n  - { name: n, from: t.out.n, type: number }\n",
    );
    const result = buildResult(config, raw({ checks: [{ exit: 0, durationMs: 1, metrics: { n: { value: 1 } } }] }));
    expect(result.metrics.n).toEqual({ source: "project", type: "number", value: 1, order: "desc" });
  });

  it("fails the gate on a check that timed out, and nulls its metrics", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 124, durationMs: 120_000, metrics: { coverage: { value: 40 } } },
          { exit: 0, durationMs: 1, metrics: {} },
        ],
      }),
    );
    expect(result.checks.map((c) => c.outcome)).toEqual(["passed", "timedOut", "passed"]);
    expect(result.metrics.test).toMatchObject({ value: "timedOut" });
    expect(result.metrics.coverage).toMatchObject({ value: null, note: "test: test timed out" });
    expect(result.gate).toBe("failed");
  });

  it("skips every check after a failed setup, naming it, and nulls its metrics", () => {
    const result = buildResult(
      CONFIG,
      raw({
        setupFailed: 1,
        checks: [
          { exit: null, durationMs: 0, metrics: {} },
          { exit: null, durationMs: 0, metrics: {} },
        ],
      }),
    );
    expect(result.gate).toBe("failed");
    expect(result.checks.slice(1, 3).map((c) => [c.outcome, c.notes])).toEqual([
      ["skipped", ["skipped: setup deps failed"]],
      ["skipped", ["skipped: setup deps failed"]],
    ]);
    expect(result.metrics.coverage).toMatchObject({
      value: null,
      note: "test: test was skipped: setup deps failed",
    });
  });

  it("fails the gate on a failed setup, even with no checks", () => {
    const config = parseConfig("setup: [{ name: deps, command: npm ci }]\n");
    expect(buildResult(config, raw({ setupFailed: 1 })).gate).toBe("failed");
    expect(buildResult(config, raw()).gate).toBe("passed");
  });

  it("skips a check the run reported no exit for, saying so on it and its metrics", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: null, durationMs: 0, metrics: {} },
          { exit: 0, durationMs: 1, metrics: {} },
        ],
      }),
    );
    expect(result.checks[1]).toMatchObject({
      outcome: "skipped",
      notes: ["skipped: the run didn't report it"],
    });
    expect(result.metrics.coverage).toMatchObject({
      value: null,
      note: "test: test was skipped: the run didn't report it",
    });
  });

  it("skips a check whose wait didn't pass, naming the check it waited for and how it ended", () => {
    const config = parseConfig(
      "checks:\n  - { name: a, command: x }\n  - { name: b, command: x }\n" +
        "  - { name: c, command: x, after: [a, b] }\n  - { name: d, command: x, after: c }\n" +
        "metrics:\n  - { name: n, from: d.out.n, type: number }\n",
    );
    const result = buildResult(
      config,
      raw({
        checks: [
          { exit: 0, durationMs: 1, metrics: {} },
          { exit: 124, durationMs: 600_000, metrics: {} },
          { exit: null, durationMs: 0, metrics: {} },
          { exit: null, durationMs: 0, metrics: {} },
        ],
      }),
    );
    expect(result.checks.slice(3).map((c) => [c.name, c.outcome, c.notes])).toEqual([
      ["c", "skipped", ["skipped: waits for b, which timed out"]],
      ["d", "skipped", ["skipped: waits for c, which was skipped"]],
    ]);
    expect(result.metrics.n).toMatchObject({ value: null, note: "d: d was skipped: waits for c, which was skipped" });
    expect(result.gate).toBe("failed");
  });

  it("gives a null the score script sent without a note one naming its from", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          {
            exit: 0,
            durationMs: 1,
            metrics: { coverage: { value: null } as unknown as { value: null; note: string } },
          },
          { exit: 0, durationMs: 1, metrics: {} },
        ],
      }),
    );
    expect(result.metrics.coverage).toMatchObject({
      value: null,
      note: "test.coverage-summary.total.lines.pct: not reported",
    });
  });

  const TYPED = parseConfig(`checks:
  - { name: t, command: x }
metrics:
  - { name: typed, from: t.out.typed, type: boolean }
  - { name: untyped, from: t.out.untyped, type: boolean, order: asc }
  - { name: grade, from: t.out.grade, type: enum, values: [a, b, c] }
  - { name: summary, from: t.out.summary, type: string }
  - { name: report, from: t.out.report, type: string, format: url }
`);

  it("scores booleans, enums and strings with their type's fields: order, values and format", () => {
    const metrics = {
      typed: { value: true },
      untyped: { value: false },
      grade: { value: "b" },
      summary: { value: "all good" },
      report: { value: "https://ci.example.test/1" },
    };
    const result = buildResult(TYPED, raw({ checks: [{ exit: 0, durationMs: 1, metrics }] }));
    expect(result.metrics).toMatchObject({
      typed: { source: "project", type: "boolean", value: true, order: "desc" },
      untyped: { source: "project", type: "boolean", value: false, order: "asc" },
      grade: { source: "project", type: "enum", value: "b", values: ["a", "b", "c"] },
      summary: { source: "project", type: "string", value: "all good" },
      report: { source: "project", type: "string", value: "https://ci.example.test/1", format: "url" },
    });
    expect(result.metrics.summary).toEqual({ source: "project", type: "string", value: "all good" });
  });

  it("nulls an enum value that isn't listed, and a value of the wrong type, each with a note", () => {
    const metrics = {
      typed: { value: "true" },
      untyped: { value: 0 },
      grade: { value: "d" },
      summary: { value: 3 },
      report: { value: null, note: "t.out: no out.json in $THRONG_OUTPUT; files there: there are none" },
    };
    const result = buildResult(TYPED, raw({ checks: [{ exit: 0, durationMs: 1, metrics }] }));
    expect(result.metrics).toMatchObject({
      typed: { type: "boolean", value: null, note: "t.out.typed: expected a boolean, got a string" },
      untyped: { type: "boolean", value: null, note: "t.out.untyped: expected a boolean, got a number" },
      grade: { type: "enum", value: null, note: 't.out.grade: "d" is not one of its values: a, b, c' },
      summary: { type: "string", value: null, note: "t.out.summary: expected a string, got a number" },
      report: { type: "string", value: null, format: "url" },
    });
  });
});

/** A result as runs stored it before built-in checks: `builtin`, `preview` and per-check metrics. */
function legacy(overrides: Partial<LegacyResult> = {}): LegacyResult {
  return {
    base: BASE,
    config: { kind: "valid" },
    gate: "passed",
    checks: [
      { name: "test", required: true, outcome: "passed", durationMs: 900, metrics: { coverage: 92 }, notes: [] },
      {
        name: "bundle",
        required: false,
        outcome: "timedOut",
        durationMs: 40,
        metrics: {},
        notes: ["metric bundle_kb was not reported"],
      },
    ],
    builtin: { filesChanged: 3, additions: 10, deletions: 4, durationMs: 12 },
    preview: { status: "ready", url: "https://x.workers.dev" },
    logs: ["test", "preview.deploy"],
    ...overrides,
  };
}

describe("upgradeResult", () => {
  it("turns builtin into _diff and each check's metrics into project numbers, dropping the retired preview", () => {
    expect(upgradeResult(legacy())).toEqual({
      base: BASE,
      config: { kind: "valid" },
      gate: "passed",
      checks: [
        { name: "_diff", source: "platform", outcome: "passed", durationMs: 12, notes: [] },
        { name: "test", source: "project", outcome: "passed", durationMs: 900, notes: [] },
        {
          name: "bundle",
          source: "project",
          outcome: "timedOut",
          durationMs: 40,
          notes: ["metric bundle_kb was not reported"],
        },
      ],
      metrics: {
        _diff: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
        "_diff.filesChanged": { source: "platform", type: "number", value: 3, order: "asc" },
        "_diff.additions": { source: "platform", type: "number", value: 10, order: "asc" },
        "_diff.deletions": { source: "platform", type: "number", value: 4, order: "asc" },
        test: { source: "project", type: "enum", value: "passed", values: OUTCOMES },
        coverage: {
          source: "project",
          type: "number",
          value: 92,
          order: "desc",
          note: "converted from an older result, which didn't record its order or unit",
        },
        bundle: { source: "project", type: "enum", value: "timedOut", values: OUTCOMES },
      },
      logs: ["test", "preview.deploy"],
    });
  });

  it("keeps a check's outcome metric over an older metric of the same name, saying it dropped it", () => {
    const checks = legacy().checks.map((check) =>
      check.name === "test" ? { ...check, metrics: { coverage: 92, bundle: 5 } } : check,
    );
    const result = upgradeResult(legacy({ checks }));
    expect(result.metrics.bundle).toEqual({ source: "project", type: "enum", value: "timedOut", values: OUTCOMES });
    expect(result.checks.find((check) => check.name === "bundle")?.notes).toEqual([
      "metric bundle_kb was not reported",
      "dropped metric bundle, read from test in an older result: its name is this check's",
    ]);
  });

  it("drops an invalid config's synthetic config check, keeping the error on config", () => {
    const result = upgradeResult(
      legacy({
        config: { kind: "invalid", error: "checks[0].name: bad" },
        gate: "failed",
        checks: [
          { name: "config", required: true, outcome: "failed", durationMs: 0, metrics: {}, notes: [], error: "x" },
        ],
        preview: { status: "none" },
      }),
    );
    expect(result.checks.map((c) => c.name)).toEqual(["_diff"]);
    expect(result.config).toEqual({ kind: "invalid", error: "checks[0].name: bad" });
    expect(result.gate).toBe("failed");
  });

  it("drops required from the checks of a result stored when a check could be optional", () => {
    const current = buildResult(CONFIG, raw());
    const stored = {
      ...current,
      checks: current.checks.map((check) => ({ ...check, required: check.source !== "platform" })),
    };
    expect(upgradeResult(stored)).toEqual(current);
  });

  it("leaves a result already in the new shape as it is", () => {
    const current = buildResult(CONFIG, raw());
    expect(upgradeResult(current)).toBe(current);
  });
});
