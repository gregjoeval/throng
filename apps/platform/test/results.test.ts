import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  buildResult,
  checkOutcome,
  gateFor,
  parseShortstat,
  previewPlan,
  scorePlan,
  scoreTimeoutMs,
  SETUP_TIMEOUT_MS,
  upgradeResult,
  withPreview,
} from "../src/results.ts";
import type { CheckResult, LegacyResult, RawScore, ScoringResult } from "../src/results.ts";

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
  - npm ci
checks:
  - name: test
    command: npm test
    timeout: 2m
  - name: bundle
    command: npm run size
    required: false
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

function entry(required: boolean, outcome: CheckResult["outcome"]): CheckResult {
  return {
    name: "c",
    source: "project",
    required,
    outcome,
    durationMs: 0,
    notes: [],
  };
}

describe("gateFor", () => {
  it("passes when every required check passed, and with no checks at all", () => {
    expect(gateFor([])).toBe("passed");
    expect(gateFor([entry(true, "passed"), entry(false, "failed")])).toBe("passed");
  });

  it("fails on any required check that didn't pass", () => {
    for (const outcome of ["failed", "timedOut", "skipped"] as const) {
      expect(gateFor([entry(true, "passed"), entry(true, outcome)])).toBe("failed");
    }
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
      setup: ["npm ci"],
      checks: [
        {
          name: "test",
          command: "npm test",
          timeoutMs: 120_000,
          metrics: [{ name: "coverage", from: "test.coverage-summary.total.lines.pct", type: "number" }],
        },
        {
          name: "bundle",
          command: "npm run size",
          timeoutMs: 600_000,
          metrics: [{ name: "bundle_kb", from: "bundle.size.kb", type: "number" }],
        },
      ],
      allow: ["api.github.com"],
    });
    expect(scorePlan({ kind: "none" })).toEqual({ setup: [], checks: [], allow: [] });
    expect(scorePlan({ kind: "invalid", error: "x" })).toEqual({ setup: [], checks: [], allow: [] });
  });

  it("gives the score step room for every setup command and check at its timeout", () => {
    expect(scoreTimeoutMs(scorePlan(CONFIG))).toBe(SETUP_TIMEOUT_MS + 720_000 + 5 * 60 * 1000);
  });
});

describe("buildResult", () => {
  it("passes a zero-config project, recording the diff as the _diff check and skipping _preview", () => {
    expect(buildResult({ kind: "none" }, raw())).toEqual({
      base: BASE,
      config: { kind: "none" },
      gate: "passed",
      checks: [
        { name: "_diff", source: "platform", required: false, outcome: "passed", durationMs: 12, notes: [] },
        {
          name: "_preview",
          source: "platform",
          required: false,
          outcome: "skipped",
          durationMs: 0,
          notes: ["skipped: the config has no preview section"],
        },
      ],
      metrics: {
        _diff: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
        "_diff.filesChanged": { source: "platform", type: "number", value: 3, order: "asc" },
        "_diff.additions": { source: "platform", type: "number", value: 10, order: "asc" },
        "_diff.deletions": { source: "platform", type: "number", value: 4, order: "asc" },
        _preview: { source: "platform", type: "enum", value: "skipped", values: OUTCOMES },
        "_preview.url": {
          source: "platform",
          type: "string",
          format: "url",
          value: null,
          note: "_preview was skipped: the config has no preview section",
        },
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
    expect(result.checks.map((c) => [c.name, c.outcome, c.notes])).toEqual([
      ["_diff", "passed", []],
      ["_preview", "skipped", ["skipped: the config is invalid"]],
    ]);
  });

  it("scores each check from its exit, and gates on the required ones", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 900, metrics: { coverage: { value: 92 } } },
          { exit: 1, durationMs: 40, metrics: { bundle_kb: { value: 120 } } },
        ],
      }),
    );
    expect(result.gate).toBe("passed");
    expect(result.checks.slice(1, 3)).toEqual([
      { name: "test", source: "project", required: true, outcome: "passed", durationMs: 900, notes: [] },
      { name: "bundle", source: "project", required: false, outcome: "failed", durationMs: 40, notes: [] },
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
      "_preview",
      "_preview.url",
    ]);
    expect(result.metrics).toMatchObject({
      test: { source: "project", type: "enum", value: "passed", values: OUTCOMES },
      coverage: { source: "project", type: "number", value: 92, order: "desc", unit: "%" },
      bundle: { source: "project", type: "enum", value: "failed", values: OUTCOMES },
      bundle_kb: { source: "project", type: "number", value: 120, order: "asc", unit: "KB" },
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

  it("fails the gate on a required check that timed out, and still reads its output", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 124, durationMs: 120_000, metrics: { coverage: { value: 40 } } },
          { exit: 0, durationMs: 1, metrics: {} },
        ],
      }),
    );
    expect(result.checks.map((c) => c.outcome)).toEqual(["passed", "timedOut", "passed", "skipped"]);
    expect(result.metrics.test).toMatchObject({ value: "timedOut" });
    expect(result.metrics.coverage).toMatchObject({ value: 40 });
    expect(result.gate).toBe("failed");
  });

  it("skips every check after a failed setup, saying which command failed, and nulls its metrics", () => {
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
      ["skipped", ["skipped: setup command 1 failed"]],
      ["skipped", ["skipped: setup command 1 failed"]],
    ]);
    expect(result.metrics.coverage).toMatchObject({
      value: null,
      note: "test: test was skipped: setup command 1 failed",
    });
  });
});

describe("previewPlan", () => {
  const WITH_PREVIEW = parseConfig("preview:\n  command: npm run build\n");
  const passed = buildResult(WITH_PREVIEW, raw());

  it("deploys a Preview, with the configured build command, when preview is configured and the gate passed", () => {
    expect(previewPlan(WITH_PREVIEW, passed)).toEqual({ command: "npm run build", allow: [] });
    expect(previewPlan(parseConfig("preview: {}\n"), passed)).toEqual({ command: null, allow: [] });
  });

  it("lets the build reach the config's network.allow hosts, as scoring does", () => {
    const config = parseConfig("preview: {}\nnetwork:\n  allow: [fonts.example.com]\n");
    expect(previewPlan(config, buildResult(config, raw()))).toEqual({ command: null, allow: ["fonts.example.com"] });
  });

  it("deploys nothing when the gate failed", () => {
    const failing = parseConfig("preview:\n  command: npm run build\nchecks:\n  - { name: test, command: npm test }\n");
    const result = buildResult(failing, raw({ checks: [{ exit: 1, durationMs: 1, metrics: {} }] }));
    expect(result.gate).toBe("failed");
    expect(previewPlan(failing, result)).toBeNull();
    expect(result.checks.at(-1)).toMatchObject({
      name: "_preview",
      outcome: "skipped",
      notes: ["skipped: the gate failed"],
    });
    expect(result.metrics["_preview.url"]).toMatchObject({
      value: null,
      note: "_preview was skipped: the gate failed",
    });
  });

  it("deploys nothing without a preview section, without a config, or with an invalid one", () => {
    for (const config of [parseConfig(""), parseConfig(null), parseConfig("preview: nope\n")]) {
      expect(previewPlan(config, buildResult(config, raw()))).toBeNull();
    }
  });
});

/** A result's `_preview` check, its outcome metric and `_preview.url`. */
const preview = (result: ScoringResult) => ({
  check: result.checks.at(-1),
  outcome: result.metrics["_preview"],
  url: result.metrics["_preview.url"],
});

describe("withPreview", () => {
  const passed = buildResult(parseConfig("preview: {}\n"), raw());

  it("skips _preview until it deploys, as the last check", () => {
    expect(preview(passed)).toMatchObject({ check: { name: "_preview", outcome: "skipped" } });
  });

  it("records a deployed Preview as passed, with _preview.url", () => {
    const result = withPreview(passed, { ok: true, url: "https://t1a1-pabc-w.acct.workers.dev" }, 4200);
    expect(preview(result)).toEqual({
      check: { name: "_preview", source: "platform", required: false, outcome: "passed", durationMs: 4200, notes: [] },
      outcome: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
      url: { source: "platform", type: "string", format: "url", value: "https://t1a1-pabc-w.acct.workers.dev" },
    });
  });

  it("records a failed build or deploy as failed, with a null URL, without changing the gate or the other checks", () => {
    for (const [deployed, why] of [
      [{ ok: false, stage: "build", output: "boom" }, "its build step failed"],
      [null, "the preview script gave no result"],
    ] as const) {
      const result = withPreview(passed, deployed, 10);
      expect(result.gate).toBe("passed");
      expect(result.checks.slice(0, -1)).toEqual(passed.checks.slice(0, -1));
      expect(preview(result)).toMatchObject({
        check: { outcome: "failed", notes: [`failed: ${why}`] },
        outcome: { value: "failed" },
        url: { value: null, note: `_preview failed: ${why}` },
      });
    }
  });

  it("records an infrastructure error as errored, apart from a failed build, without changing the gate", () => {
    const result = withPreview(passed, { error: "Error: preview script exited 12: fetch failed" }, 0);
    expect(result.gate).toBe("passed");
    expect(preview(result)).toMatchObject({
      check: { outcome: "errored", notes: ["errored: Error: preview script exited 12: fetch failed"] },
      outcome: { value: "errored" },
      url: { value: null, note: "_preview errored: Error: preview script exited 12: fetch failed" },
    });
  });

  it("keeps the metrics in run order", () => {
    const result = withPreview(passed, { ok: true, url: "https://x.workers.dev" }, 1);
    expect(Object.keys(result.metrics)).toEqual(Object.keys(passed.metrics));
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

/** A legacy result with this Preview status, upgraded: `_preview`'s outcome and notes, and `_preview.url`. */
function upgradedPreview(status: LegacyResult["preview"]) {
  const result = upgradeResult(legacy({ preview: status }));
  return [result.checks.at(-1)?.outcome, result.checks.at(-1)?.notes, result.metrics["_preview.url"]?.value];
}

describe("upgradeResult", () => {
  it("turns builtin into _diff, preview into _preview, and each check's metrics into project numbers", () => {
    expect(upgradeResult(legacy())).toEqual({
      base: BASE,
      config: { kind: "valid" },
      gate: "passed",
      checks: [
        { name: "_diff", source: "platform", required: false, outcome: "passed", durationMs: 12, notes: [] },
        { name: "test", source: "project", required: true, outcome: "passed", durationMs: 900, notes: [] },
        {
          name: "bundle",
          source: "project",
          required: false,
          outcome: "timedOut",
          durationMs: 40,
          notes: ["metric bundle_kb was not reported"],
        },
        { name: "_preview", source: "platform", required: false, outcome: "passed", durationMs: 0, notes: [] },
      ],
      metrics: {
        _diff: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
        "_diff.filesChanged": { source: "platform", type: "number", value: 3, order: "asc" },
        "_diff.additions": { source: "platform", type: "number", value: 10, order: "asc" },
        "_diff.deletions": { source: "platform", type: "number", value: 4, order: "asc" },
        test: { source: "project", type: "enum", value: "passed", values: OUTCOMES },
        coverage: { source: "project", type: "number", value: 92, order: "desc" },
        bundle: { source: "project", type: "enum", value: "timedOut", values: OUTCOMES },
        _preview: { source: "platform", type: "enum", value: "passed", values: OUTCOMES },
        "_preview.url": { source: "platform", type: "string", format: "url", value: "https://x.workers.dev" },
      },
      logs: ["test", "preview.deploy"],
    });
  });

  it("reads each stored Preview status as a _preview outcome", () => {
    expect(upgradedPreview({ status: "none" })).toEqual(["skipped", [], null]);
    expect(upgradedPreview({ status: "failed" })).toEqual(["failed", [], null]);
    expect(upgradedPreview({ status: "errored", error: "boom" })).toEqual(["errored", ["errored: boom"], null]);
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
    expect(result.checks.map((c) => c.name)).toEqual(["_diff", "_preview"]);
    expect(result.config).toEqual({ kind: "invalid", error: "checks[0].name: bad" });
    expect(result.gate).toBe("failed");
  });

  it("leaves a result already in the new shape as it is", () => {
    const current = buildResult(CONFIG, raw());
    expect(upgradeResult(current)).toBe(current);
  });
});
