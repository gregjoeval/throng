// A scoring run's result: what the spec's "Results" section records for one run, and the pure steps
// that turn the project's config and the score script's raw output into it. Metrics parsing and the
// gate live here so they're tested without a container.

import { DEFAULT_CHECK_TIMEOUT_MS, type ConfigResult } from "./config.ts";
import type { PreviewScriptResult } from "./scripts.ts";

export const CHECK_OUTCOMES = ["passed", "failed", "timedOut", "skipped"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Longest a `setup` command may run; the spec gives setup no timeout of its own. */
export const SETUP_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS;
/** Most bytes of a check's `$THRONG_METRICS` file the score script reads. */
export const MAX_METRICS_BYTES = 64 * 1024;
/** Exit codes `timeout` gives a command it stopped: TERM (124), then KILL after the grace (128 + 9). */
const TIMED_OUT_EXITS = new Set([124, 137]);

export interface CheckResult {
  name: string;
  required: boolean;
  outcome: CheckOutcome;
  durationMs: number;
  /** The metrics the check declared and reported, by name. */
  metrics: Record<string, number>;
  /** What the run noticed about the check: ignored metrics, why it was skipped. */
  notes: string[];
  /** Only on the `config` entry of an invalid config: the config's errors. */
  error?: string;
}

/** Diff size against the base, recorded for every run whatever the config. */
export interface BuiltinMetrics {
  filesChanged: number;
  additions: number;
  deletions: number;
  durationMs: number;
}

/**
 * The Preview's outcome: `failed` when its build or deploy failed, `errored` when the infrastructure
 * kept failing (container start, lost Sandbox, a script crash). Neither changes the gate.
 */
export type PreviewResult =
  | { status: "none" }
  | { status: "ready"; url: string }
  | { status: "failed" }
  | { status: "errored"; error: string };

export interface ScoringResult {
  /** `git merge-base <head> origin/main` at scoring time; null when they share no history. */
  base: string | null;
  config: { kind: "none" } | { kind: "valid" } | { kind: "invalid"; error: string };
  /** Passed when every required check passed, including when there are none. */
  gate: "passed" | "failed";
  checks: CheckResult[];
  builtin: BuiltinMetrics;
  preview: PreviewResult;
  /**
   * The run's stored logs, by name (`setup.<n>`, a check's name, `preview.deploy`), in run order. A
   * step that never ran has none; see `logs.ts` for where each is kept.
   */
  logs: string[];
}

/** What the score script runs, and the hosts it may reach beyond the npm registry. */
export interface ScorePlan {
  setup: string[];
  checks: { name: string; command: string; timeoutMs: number }[];
  allow: string[];
}

/** The score script's raw output, before metrics are parsed and the gate is computed. */
export interface RawScore {
  base: string | null;
  /** `git diff --shortstat` from the base (or the empty tree) to the head. */
  shortstat: string;
  /** How long finding the base and diffing took. */
  builtinMs: number;
  /** The 1-based `setup` command that failed, or null when setup succeeded. */
  setupFailed: number | null;
  /** One per planned check, in order; `exit` is null for a check that didn't run. */
  checks: { exit: number | null; durationMs: number; metrics: string | null }[];
}

/** The config's setup, checks and `network.allow`; nothing at all without a valid config. */
export function scorePlan(config: ConfigResult): ScorePlan {
  if (config.kind !== "valid") return { setup: [], checks: [], allow: [] };
  return {
    setup: config.config.setup,
    checks: config.config.checks.map(({ name, command, timeoutMs }) => ({ name, command, timeoutMs })),
    allow: config.config.network.allow,
  };
}

/** How long the whole score script may take: every setup command and check at its timeout, plus slack. */
export function scoreTimeoutMs(plan: ScorePlan): number {
  const checks = plan.checks.reduce((sum, check) => sum + check.timeoutMs, 0);
  return plan.setup.length * SETUP_TIMEOUT_MS + checks + 5 * 60 * 1000;
}

/**
 * A check's outcome from its exit code and how long it ran; a null exit means it never ran. `timeout`
 * stops a check that runs out its time with 124 (or 137 once it had to kill it), so those exits only
 * count as timed out when the check really ran that long.
 */
export function checkOutcome(exit: number | null, durationMs: number, timeoutMs: number): CheckOutcome {
  if (exit === null) return "skipped";
  if (exit === 0) return "passed";
  return TIMED_OUT_EXITS.has(exit) && durationMs >= timeoutMs ? "timedOut" : "failed";
}

/** Files changed, lines added and lines deleted from a `git diff --shortstat` line; zeros when empty. */
export function parseShortstat(line: string): Omit<BuiltinMetrics, "durationMs"> {
  const count = (pattern: RegExp) => Number(pattern.exec(line)?.[1] ?? 0);
  return {
    filesChanged: count(/(\d+) files? changed/),
    additions: count(/(\d+) insertions?\(\+\)/),
    deletions: count(/(\d+) deletions?\(-\)/),
  };
}

/**
 * A check's `$THRONG_METRICS` file: a JSON object of `name → number`. Only metrics the check
 * declares, with finite numbers, are kept; everything else is noted and ignored.
 */
export function parseMetrics(
  text: string | null,
  declared: string[],
): { metrics: Record<string, number>; notes: string[] } {
  const metrics: Record<string, number> = {};
  const notes: string[] = [];
  if (text !== null && text.trim() !== "") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { metrics, notes: ["ignored $THRONG_METRICS: not JSON"] };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { metrics, notes: ["ignored $THRONG_METRICS: not a JSON object of name to number"] };
    }
    for (const [name, reported] of Object.entries(value)) {
      if (!declared.includes(name)) notes.push(`ignored metric ${name}: not declared by this check`);
      else if (typeof reported !== "number" || !Number.isFinite(reported))
        notes.push(`ignored metric ${name}: not a number`);
      else metrics[name] = reported;
    }
  }
  for (const name of declared) {
    if (!(name in metrics) && !notes.some((n) => n.startsWith(`ignored metric ${name}:`))) {
      notes.push(`metric ${name} was not reported`);
    }
  }
  return { metrics, notes };
}

/** Passed when every required check passed; no checks at all passes. */
export function gateFor(checks: CheckResult[]): "passed" | "failed" {
  return checks.every((c) => !c.required || c.outcome === "passed") ? "passed" : "failed";
}

/** What the preview container runs, and the hosts its build may reach beyond the npm registry. */
export interface PreviewPlan {
  command: string | null;
  allow: string[];
}

/**
 * Whether to deploy a Preview, its build step and its `network.allow`: only when the config has a
 * `preview` section and the gate passed. Null means no Preview, and the result keeps `preview: none`.
 */
export function previewPlan(config: ConfigResult, result: ScoringResult): PreviewPlan | null {
  if (config.kind !== "valid" || config.config.preview === null || result.gate !== "passed") return null;
  return { command: config.config.preview.command, allow: config.config.network.allow };
}

/**
 * The result with the Preview's outcome recorded: `ready` with its URL when it deployed, `failed`
 * otherwise (null when the preview script gave no result), or `errored` with the error the step kept
 * failing on. The gate and checks never change.
 */
export function withPreview(
  result: ScoringResult,
  deployed: PreviewScriptResult | null | { error: string },
): ScoringResult {
  let preview: PreviewResult;
  if (deployed !== null && "error" in deployed) preview = { status: "errored", error: deployed.error };
  else if (deployed?.ok === true) preview = { status: "ready", url: deployed.url };
  else preview = { status: "failed" };
  return { ...result, preview };
}

/**
 * The run's result from the config it was scored under and the score script's raw output. Its
 * `logs` are empty: the run stores its logs, with each check's notes, once the result is built.
 */
export function buildResult(config: ConfigResult, raw: RawScore): ScoringResult {
  const builtin = { ...parseShortstat(raw.shortstat), durationMs: raw.builtinMs };
  const common = { base: raw.base, builtin, preview: { status: "none" } as const, logs: [] };
  if (config.kind === "none") return { ...common, config: { kind: "none" }, gate: "passed", checks: [] };
  if (config.kind === "invalid") {
    const entry: CheckResult = {
      name: "config",
      required: true,
      outcome: "failed",
      durationMs: 0,
      metrics: {},
      notes: [],
      error: config.error,
    };
    return { ...common, config: { kind: "invalid", error: config.error }, gate: "failed", checks: [entry] };
  }
  const checks = config.config.checks.map((check, i): CheckResult => {
    const ran = raw.checks[i];
    const outcome = checkOutcome(ran?.exit ?? null, ran?.durationMs ?? 0, check.timeoutMs);
    const parsed =
      outcome === "skipped"
        ? { metrics: {}, notes: [] }
        : parseMetrics(
            ran?.metrics ?? null,
            check.metrics.map((m) => m.name),
          );
    const notes = [...parsed.notes];
    if (outcome === "skipped" && raw.setupFailed !== null)
      notes.push(`skipped: setup command ${raw.setupFailed} failed`);
    return {
      name: check.name,
      required: check.required,
      outcome,
      durationMs: ran?.durationMs ?? 0,
      metrics: parsed.metrics,
      notes,
    };
  });
  return { ...common, config: { kind: "valid" }, gate: gateFor(checks), checks };
}
