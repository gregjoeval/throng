import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  buildResult,
  checkOutcome,
  gateFor,
  parseMetrics,
  parseShortstat,
  previewPlan,
  scorePlan,
  withPreview,
  scoreTimeoutMs,
  SETUP_TIMEOUT_MS,
} from "../src/results.ts";
import type { CheckResult, RawScore } from "../src/results.ts";

const BASE = "a".repeat(40);

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
    metrics:
      - { name: coverage, unit: "%", order: desc }
  - name: bundle
    command: npm run size
    required: false
    metrics:
      - { name: bundle_kb, unit: KB, order: asc }
network:
  allow: [api.github.com]
`);

describe("parseMetrics", () => {
  it("keeps declared metrics with finite numbers", () => {
    expect(parseMetrics('{"coverage": 81.5, "lines": 3}', ["coverage", "lines"])).toEqual({
      metrics: { coverage: 81.5, lines: 3 },
      notes: [],
    });
  });

  it("notes and ignores undeclared keys and non-numbers", () => {
    expect(parseMetrics('{"coverage": "81", "extra": 1, "nan": null}', ["coverage", "nan"])).toEqual({
      metrics: {},
      notes: [
        "ignored metric coverage: not a number",
        "ignored metric extra: not declared by this check",
        "ignored metric nan: not a number",
      ],
    });
  });

  it("notes a file that isn't a JSON object, and a declared metric that wasn't reported", () => {
    expect(parseMetrics("coverage=80", ["coverage"]).notes).toEqual(["ignored $THRONG_METRICS: not JSON"]);
    expect(parseMetrics("[1, 2]", []).notes).toEqual(["ignored $THRONG_METRICS: not a JSON object of name to number"]);
    expect(parseMetrics("", ["coverage"])).toEqual({ metrics: {}, notes: ["metric coverage was not reported"] });
    expect(parseMetrics(null, [])).toEqual({ metrics: {}, notes: [] });
  });
});

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
    required,
    outcome,
    durationMs: 0,
    metrics: {},
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
  it("runs the config's setup and checks with its allowed hosts, and nothing without a valid config", () => {
    expect(scorePlan(CONFIG)).toEqual({
      setup: ["npm ci"],
      checks: [
        { name: "test", command: "npm test", timeoutMs: 120_000 },
        { name: "bundle", command: "npm run size", timeoutMs: 600_000 },
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
  it("passes a zero-config project with no checks, keeping the built-in metrics", () => {
    expect(buildResult({ kind: "none" }, raw())).toEqual({
      base: BASE,
      config: { kind: "none" },
      gate: "passed",
      checks: [],
      builtin: { filesChanged: 3, additions: 10, deletions: 4, durationMs: 12 },
      preview: { status: "none" },
      logs: [],
    });
  });

  it("fails an invalid config's gate with a single config entry carrying the error", () => {
    const invalid = parseConfig("checks:\n  - name: Bad Name\n    command: x\n");
    expect(invalid.kind).toBe("invalid");
    const result = buildResult(invalid, raw());
    expect(result).toMatchObject({ config: { kind: "invalid" }, gate: "failed", builtin: { filesChanged: 3 } });
    expect(result.checks).toEqual([
      {
        name: "config",
        required: true,
        outcome: "failed",
        durationMs: 0,
        metrics: {},
        notes: [],
        error: expect.stringMatching(/checks\[0\]\.name/),
      },
    ]);
  });

  it("scores each check from its exit and metrics, and gates on the required ones", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 0, durationMs: 900, metrics: '{"coverage": 92, "bundle_kb": 3}' },
          { exit: 1, durationMs: 40, metrics: '{"bundle_kb": 120}' },
        ],
      }),
    );
    expect(result.gate).toBe("passed");
    expect(result.checks).toEqual([
      {
        name: "test",
        required: true,
        outcome: "passed",
        durationMs: 900,
        metrics: { coverage: 92 },
        notes: ["ignored metric bundle_kb: not declared by this check"],
      },
      { name: "bundle", required: false, outcome: "failed", durationMs: 40, metrics: { bundle_kb: 120 }, notes: [] },
    ]);
  });

  it("fails the gate on a required check that timed out", () => {
    const result = buildResult(
      CONFIG,
      raw({
        checks: [
          { exit: 124, durationMs: 120_000, metrics: "" },
          { exit: 0, durationMs: 1, metrics: "" },
        ],
      }),
    );
    expect(result.checks.map((c) => c.outcome)).toEqual(["timedOut", "passed"]);
    expect(result.gate).toBe("failed");
  });

  it("skips every check after a failed setup, saying which command failed", () => {
    const result = buildResult(
      CONFIG,
      raw({
        setupFailed: 1,
        checks: [
          { exit: null, durationMs: 0, metrics: null },
          { exit: null, durationMs: 0, metrics: null },
        ],
      }),
    );
    expect(result.gate).toBe("failed");
    expect(result.checks.map((c) => [c.outcome, c.notes])).toEqual([
      ["skipped", ["skipped: setup command 1 failed"]],
      ["skipped", ["skipped: setup command 1 failed"]],
    ]);
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
    const result = buildResult(failing, raw({ checks: [{ exit: 1, durationMs: 1, metrics: "" }] }));
    expect(result.gate).toBe("failed");
    expect(previewPlan(failing, result)).toBeNull();
  });

  it("deploys nothing without a preview section, without a config, or with an invalid one", () => {
    for (const config of [parseConfig(""), parseConfig(null), parseConfig("preview: nope\n")]) {
      expect(previewPlan(config, buildResult(config, raw()))).toBeNull();
    }
  });
});

describe("withPreview", () => {
  const passed = buildResult(parseConfig("preview: {}\n"), raw());

  it("records a deployed Preview as ready with its URL", () => {
    const result = withPreview(passed, { ok: true, url: "https://t1a1-pabc-w.acct.workers.dev" });
    expect(result.preview).toEqual({ status: "ready", url: "https://t1a1-pabc-w.acct.workers.dev" });
  });

  it("records a failed Preview without changing the gate or the checks", () => {
    for (const outcome of [{ ok: false, stage: "build", output: "boom" } as const, null]) {
      const result = withPreview(passed, outcome);
      expect(result).toEqual({ ...passed, preview: { status: "failed" } });
    }
  });

  it("records an infrastructure error as errored, apart from a failed build, without changing the gate", () => {
    const result = withPreview(passed, { error: "Error: preview script exited 12: fetch failed" });
    expect(result).toEqual({
      ...passed,
      preview: { status: "errored", error: "Error: preview script exited 12: fetch failed" },
    });
  });
});
