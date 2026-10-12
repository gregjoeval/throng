// A scoring run's result: what the spec's "Results" section records for one run, and the pure steps
// that turn the project's config and the score script's raw output into it. Metrics parsing and the
// gate live here so they're tested without a container.

import { DEFAULT_CHECK_TIMEOUT_MS } from "./config.ts";
import type { CheckConfig, ConfigResult, MetricConfig, MetricOrder } from "./config.ts";
import { typedValue } from "./metric-values.ts";
import type { MetricType, MetricValue } from "./metric-values.ts";
import type { PreviewScriptResult } from "./scripts.ts";

/** A check's outcome, best first; they are also the values of the check's outcome metric. */
export const CHECK_OUTCOMES = ["passed", "failed", "timedOut", "errored", "skipped"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Who defined a check or metric: Throng itself, the project's config, or the task. */
export const METRIC_SOURCES = ["platform", "project", "task"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

/** How a string metric's value is shown. */
export const METRIC_FORMATS = ["url"] as const;
type MetricFormat = (typeof METRIC_FORMATS)[number];

/** Longest a `setup` command may run; the spec gives setup no timeout of its own. */
export const SETUP_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS;
/** The parse guard: largest output file in `$THRONG_OUTPUT` the score script parses. */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Exit codes `timeout` gives a command it stopped: TERM (124), then KILL after the grace (128 + 9). */
const TIMED_OUT_EXITS = new Set([124, 137]);

/** Throng's own checks: finding the base and diffing, and deploying the Preview. */
const DIFF_CHECK = "_diff";
const PREVIEW_CHECK = "_preview";

/** A check: a process the run ran, or skipped. Its outcome is also a metric named after it. */
export interface CheckResult {
  name: string;
  source: MetricSource;
  /** Whether the gate needs it to pass. */
  required: boolean;
  outcome: CheckOutcome;
  durationMs: number;
  /** What the run noticed about the check, such as why it was skipped. */
  notes: string[];
}

interface MetricFields {
  source: MetricSource;
  /** Why the value is null. */
  note?: string;
}

/** One typed, nullable value in a run's score. An enum lists its `values` best first. */
export type MetricResult =
  | (MetricFields & { type: "number"; value: number | null; order: MetricOrder; unit?: string })
  | (MetricFields & { type: "string"; value: string | null; format?: MetricFormat })
  | (MetricFields & { type: "enum"; value: string | null; values: string[] });

export const GATES = ["passed", "failed"] as const;
export type Gate = (typeof GATES)[number];

export interface ScoringResult {
  /**
   * The head's base at scoring time (`attemptBase`): its merge base with the task branch, or with
   * `origin/main` when the task has none; null when they share no history.
   */
  base: string | null;
  config: { kind: "none" } | { kind: "valid" } | { kind: "invalid"; error: string };
  /** Passed when every required check passed, including when there are none; failed on an invalid config. */
  gate: Gate;
  /** Every check in run order: `_diff`, the config's checks, then `_preview`. */
  checks: CheckResult[];
  /** Every metric by name: each check's outcome metric, followed by the metrics read from its output. */
  metrics: Record<string, MetricResult>;
  /**
   * The run's stored logs, by name (`setup.<n>`, a check's name, `preview.deploy`), in run order. A
   * step that never ran has none; see `logs.ts` for where each is kept.
   */
  logs: string[];
}

/**
 * What the score script runs, and the hosts it may reach beyond the npm registry. Each check carries
 * the metrics read from its output, which the script reads as soon as the check exits.
 */
export interface ScorePlan {
  setup: string[];
  checks: { name: string; command: string; timeoutMs: number; metrics: PlannedMetric[] }[];
  allow: string[];
}

/** A metric as the score script reads it: where from, and as which type. */
export interface PlannedMetric {
  name: string;
  from: string;
  type: MetricType;
}

/** The score script's raw output, before values are checked again and the gate is computed. */
export interface RawScore {
  base: string | null;
  /** `git diff --shortstat` from the base (or the empty tree) to the head. */
  shortstat: string;
  /** How long finding the base and diffing took. */
  builtinMs: number;
  /** The 1-based `setup` command that failed, or null when setup succeeded. */
  setupFailed: number | null;
  /**
   * One per planned check, in order; `exit` is null for a check that didn't run. `metrics` holds the
   * value of each metric read from its output, by name; none for a check that didn't run.
   */
  checks: { exit: number | null; durationMs: number; metrics: Record<string, MetricValue> }[];
}

/** The metrics read from `check`'s output, in config order. */
function metricsFrom(check: string, metrics: MetricConfig[]): MetricConfig[] {
  return metrics.filter((metric) => metric.from.split(".")[0] === check);
}

/** The config's setup, checks and `network.allow`; nothing at all without a valid config. */
export function scorePlan(config: ConfigResult): ScorePlan {
  if (config.kind !== "valid") return { setup: [], checks: [], allow: [] };
  return {
    setup: config.config.setup,
    checks: config.config.checks.map(({ name, command, timeoutMs }) => ({
      name,
      command,
      timeoutMs,
      metrics: metricsFrom(name, config.config.metrics).map((metric) => ({
        name: metric.name,
        from: metric.from,
        type: metric.type,
      })),
    })),
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
export function parseShortstat(line: string): { filesChanged: number; additions: number; deletions: number } {
  const count = (pattern: RegExp) => Number(pattern.exec(line)?.[1] ?? 0);
  return {
    filesChanged: count(/(\d+) files? changed/u),
    additions: count(/(\d+) insertions?\(\+\)/u),
    deletions: count(/(\d+) deletions?\(-\)/u),
  };
}

/** Passed when every required check passed; no checks at all passes. */
export function gateFor(checks: CheckResult[]): Gate {
  return checks.every((c) => !c.required || c.outcome === "passed") ? "passed" : "failed";
}

/** What the preview container runs, and the hosts its build may reach beyond the npm registry. */
export interface PreviewPlan {
  command: string | null;
  allow: string[];
}

/**
 * Whether to deploy a Preview, its build step and its `network.allow`: only when the config has a
 * `preview` section and the gate passed. Null means no Preview, and `_preview` stays skipped.
 */
export function previewPlan(config: ConfigResult, result: ScoringResult): PreviewPlan | null {
  if (config.kind !== "valid" || config.config.preview === null || result.gate !== "passed") return null;
  return { command: config.config.preview.command, allow: config.config.network.allow };
}

/** A check with its metrics, before its outcome metric is added. */
interface Scored {
  check: CheckResult;
  metrics: Record<string, MetricResult>;
}

/** The check's outcome metric, then its own metrics. */
function metricsOf({ check, metrics }: Scored): Record<string, MetricResult> {
  const outcome: MetricResult = {
    source: check.source,
    type: "enum",
    value: check.outcome,
    values: [...CHECK_OUTCOMES],
  };
  return { [check.name]: outcome, ...metrics };
}

function platformCheck(name: string, outcome: CheckOutcome, durationMs: number, notes: string[]): CheckResult {
  return { name, source: "platform", required: false, outcome, durationMs, notes };
}

/** One of `_diff`'s sizes: a smaller change is better. */
function diffMetric(value: number): MetricResult {
  return { source: "platform", type: "number", value, order: "asc" };
}

/** `_diff`: finding the base and diffing, with the diff's size. */
function diffScored(size: ReturnType<typeof parseShortstat>, durationMs: number): Scored {
  return {
    check: platformCheck(DIFF_CHECK, "passed", durationMs, []),
    metrics: {
      [`${DIFF_CHECK}.filesChanged`]: diffMetric(size.filesChanged),
      [`${DIFF_CHECK}.additions`]: diffMetric(size.additions),
      [`${DIFF_CHECK}.deletions`]: diffMetric(size.deletions),
    },
  };
}

/** `_preview` with its outcome, and `_preview.url`: null with a note unless it passed. */
function previewScored(outcome: CheckOutcome, durationMs: number, notes: string[], url: string | null): Scored {
  const what = `${PREVIEW_CHECK} ${outcome === "skipped" ? "was skipped" : outcome}`;
  const note = notes.length === 0 ? what : `${what}: ${notes.join("; ")}`;
  const base = { source: "platform", type: "string", format: "url" } as const;
  return {
    check: platformCheck(
      PREVIEW_CHECK,
      outcome,
      durationMs,
      notes.map((n) => `${outcome}: ${n}`),
    ),
    metrics: { [`${PREVIEW_CHECK}.url`]: url === null ? { ...base, value: null, note } : { ...base, value: url } },
  };
}

/** Why `_preview` is skipped before any deploy: the reason `previewPlan` gives no plan. */
function previewSkipped(config: ConfigResult, gate: Gate): string {
  if (config.kind === "invalid") return "the config is invalid";
  if (config.kind === "none" || config.config.preview === null) return "the config has no preview section";
  return gate === "failed" ? "the gate failed" : "it wasn't deployed";
}

/**
 * The result with the Preview's outcome recorded on `_preview`: `passed` with `_preview.url` when it
 * deployed, `failed` otherwise (null when the preview script gave no result), or `errored` with the
 * error the step kept failing on. The gate and the other checks never change.
 */
export function withPreview(
  result: ScoringResult,
  deployed: PreviewScriptResult | null | { error: string },
  durationMs: number,
): ScoringResult {
  let scored: Scored;
  if (deployed !== null && "error" in deployed) scored = previewScored("errored", durationMs, [deployed.error], null);
  else if (deployed === null) scored = previewScored("failed", durationMs, ["the preview script gave no result"], null);
  else if (deployed.ok) scored = previewScored("passed", durationMs, [], deployed.url);
  else scored = previewScored("failed", durationMs, [`its ${deployed.stage} step failed`], null);
  return {
    ...result,
    checks: result.checks.map((check) => (check.name === PREVIEW_CHECK ? scored.check : check)),
    metrics: { ...result.metrics, ...metricsOf(scored) },
  };
}

/**
 * A metric's value as the score script reported it, checked against its type again: the script runs
 * beside the attempt's code, so the Worker trusts nothing it hands back.
 */
function checkedValue(metric: MetricConfig, reported: MetricValue | undefined): MetricValue {
  if (typeof reported !== "object" || reported === null) return { value: null, note: `${metric.from}: not reported` };
  if (reported.value === null) return { value: null, note: String(reported.note) };
  const typed = typedValue(reported.value, metric.type);
  return "problem" in typed ? { value: null, note: `${metric.from}: ${typed.problem}` } : typed;
}

/** A config check from its run: its outcome and notes, and the metrics read from its output. */
function configScored(
  check: CheckConfig,
  metrics: MetricConfig[],
  ran: RawScore["checks"][number] | undefined,
  setupFailed: number | null,
): Scored {
  const outcome = checkOutcome(ran?.exit ?? null, ran?.durationMs ?? 0, check.timeoutMs);
  const skipped = setupFailed === null ? "skipped" : `skipped: setup command ${setupFailed} failed`;
  const value = (metric: MetricConfig): MetricValue =>
    outcome === "skipped"
      ? { value: null, note: `${check.name}: ${check.name} was ${skipped}` }
      : checkedValue(metric, ran?.metrics[metric.name]);
  return {
    check: {
      name: check.name,
      source: "project",
      required: check.required,
      outcome,
      durationMs: ran?.durationMs ?? 0,
      notes: outcome === "skipped" && setupFailed !== null ? [skipped] : [],
    },
    metrics: Object.fromEntries(
      metricsFrom(check.name, metrics).map((metric): [string, MetricResult] => [
        metric.name,
        {
          source: "project",
          type: metric.type,
          order: metric.order,
          ...(metric.unit === null ? {} : { unit: metric.unit }),
          ...value(metric),
        },
      ]),
    ),
  };
}

/**
 * The run's result from the config it was scored under and the score script's raw output: `_diff`,
 * the config's checks, then `_preview`, skipped until `withPreview` records a deploy. Its `logs` are
 * empty: the run stores its logs, with each check's notes, once the result is built.
 */
export function buildResult(config: ConfigResult, raw: RawScore): ScoringResult {
  const checks =
    config.kind === "valid"
      ? config.config.checks.map((check, i) =>
          configScored(check, config.config.metrics, raw.checks[i], raw.setupFailed),
        )
      : [];
  const gate = config.kind === "invalid" ? "failed" : gateFor(checks.map((s) => s.check));
  const scored = [
    diffScored(parseShortstat(raw.shortstat), raw.builtinMs),
    ...checks,
    previewScored("skipped", 0, [previewSkipped(config, gate)], null),
  ];
  const kind = config.kind === "invalid" ? { kind: "invalid" as const, error: config.error } : { kind: config.kind };
  return { base: raw.base, config: kind, gate, ...flatten(scored), logs: [] };
}

/** The checks, and every metric by name: each check's outcome metric, then its own metrics. */
function flatten(scored: Scored[]): Pick<ScoringResult, "checks" | "metrics"> {
  return {
    checks: scored.map((s) => s.check),
    metrics: Object.assign({}, ...scored.map(metricsOf)) as Record<string, MetricResult>,
  };
}

/**
 * A result as runs stored it before Throng's own work became checks: `builtin` held the diff's size,
 * `preview` the Preview's status, each check its reported metrics, and an invalid config a synthetic
 * `config` check carrying the error.
 */
export interface LegacyResult extends Pick<ScoringResult, "base" | "config" | "gate" | "logs"> {
  checks: (Omit<CheckResult, "source"> & { metrics: Record<string, number>; error?: string })[];
  builtin: { filesChanged: number; additions: number; deletions: number; durationMs: number };
  preview:
    | { status: "none" }
    | { status: "ready"; url: string }
    | { status: "failed" }
    | { status: "errored"; error: string };
}

/**
 * A stored result in the current shape. A legacy one becomes `_diff`, its checks with their metrics
 * as project numbers (the order a config gives a number by default, since no order was stored), and
 * `_preview`; its synthetic `config` check is dropped, as `config` already holds the error.
 */
export function upgradeResult(stored: ScoringResult | LegacyResult): ScoringResult {
  if (!("builtin" in stored)) return stored;
  const { builtin, preview } = stored;
  const checks = stored.checks
    .filter((check) => check.error === undefined)
    .map(({ metrics, error: _error, ...check }): Scored => ({
      check: { ...check, source: "project" },
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([name, value]): [string, MetricResult] => [
          name,
          { source: "project", type: "number", value, order: "desc" },
        ]),
      ),
    }));
  let deployed: Scored;
  if (preview.status === "ready") deployed = previewScored("passed", 0, [], preview.url);
  else if (preview.status === "errored") deployed = previewScored("errored", 0, [preview.error], null);
  else deployed = previewScored(preview.status === "none" ? "skipped" : "failed", 0, [], null);
  const scored = [diffScored(builtin, builtin.durationMs), ...checks, deployed];
  return { base: stored.base, config: stored.config, gate: stored.gate, ...flatten(scored), logs: stored.logs };
}
