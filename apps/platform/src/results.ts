// A scoring run's result: what the spec's "Results" section records for one run, and the pure steps
// that turn the project's config and the score script's raw output into it. Metrics parsing and the
// gate live here so they're tested without a container.

import { DEFAULT_CHECK_TIMEOUT_MS } from "./config.ts";
import type { CheckConfig, ConfigResult, MetricOrder } from "./config.ts";
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
/** Most bytes of a check's `$THRONG_METRICS` file the score script reads. */
export const MAX_METRICS_BYTES = 64 * 1024;
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
  /** What the run noticed about the check: ignored metrics, why it was skipped. */
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
  /** Every metric by name: each check's outcome metric, followed by that check's own metrics. */
  metrics: Record<string, MetricResult>;
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
export function parseShortstat(line: string): { filesChanged: number; additions: number; deletions: number } {
  const count = (pattern: RegExp) => Number(pattern.exec(line)?.[1] ?? 0);
  return {
    filesChanged: count(/(\d+) files? changed/u),
    additions: count(/(\d+) insertions?\(\+\)/u),
    deletions: count(/(\d+) deletions?\(-\)/u),
  };
}

/** A declared metric's reported value, or null with why. */
type Reported = { value: number } | { value: null; note: string };

/**
 * A check's `$THRONG_METRICS` file: a JSON object of `name → number`. Each declared metric gets its
 * finite number, or null with a note saying why. What isn't declared is noted on the check and ignored.
 */
export function parseMetrics(
  text: string | null,
  declared: string[],
): { metrics: Record<string, Reported>; notes: string[] } {
  const every = (note: string) => Object.fromEntries(declared.map((name) => [name, { value: null, note }]));
  if (text === null || text.trim() === "") return { metrics: every("not reported"), notes: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { metrics: every("$THRONG_METRICS was not JSON"), notes: ["ignored $THRONG_METRICS: not JSON"] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const why = "not a JSON object of name to number";
    return { metrics: every(`$THRONG_METRICS was ${why}`), notes: [`ignored $THRONG_METRICS: ${why}`] };
  }
  const reported = new Map(Object.entries(value));
  const notes = [...reported.keys()]
    .filter((name) => !declared.includes(name))
    .map((name) => `ignored metric ${name}: not declared by this check`);
  const metrics = Object.fromEntries(
    declared.map((name): [string, Reported] => {
      const v = reported.get(name);
      if (v === undefined) return [name, { value: null, note: "not reported" }];
      if (typeof v !== "number" || !Number.isFinite(v)) return [name, { value: null, note: "not a number" }];
      return [name, { value: v }];
    }),
  );
  return { metrics, notes };
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

/** A config check from its run: its outcome, its declared metrics as project numbers, and its notes. */
function configScored(
  check: CheckConfig,
  ran: RawScore["checks"][number] | undefined,
  setupFailed: number | null,
): Scored {
  const outcome = checkOutcome(ran?.exit ?? null, ran?.durationMs ?? 0, check.timeoutMs);
  const skipped = setupFailed === null ? "skipped" : `skipped: setup command ${setupFailed} failed`;
  const parsed =
    outcome === "skipped"
      ? {
          metrics: Object.fromEntries(
            check.metrics.map((m) => [m.name, { value: null, note: `${check.name} was ${skipped}` }]),
          ),
          notes: [],
        }
      : parseMetrics(
          ran?.metrics ?? null,
          check.metrics.map((m) => m.name),
        );
  const notes = outcome === "skipped" && setupFailed !== null ? [...parsed.notes, skipped] : parsed.notes;
  const metrics = Object.fromEntries(
    check.metrics.map(({ name, order, unit }): [string, MetricResult] => [
      name,
      {
        source: "project",
        type: "number",
        order,
        ...(unit === null ? {} : { unit }),
        ...(parsed.metrics[name] ?? { value: null, note: "not reported" }),
      },
    ]),
  );
  return {
    check: {
      name: check.name,
      source: "project",
      required: check.required,
      outcome,
      durationMs: ran?.durationMs ?? 0,
      notes,
    },
    metrics,
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
      ? config.config.checks.map((check, i) => configScored(check, raw.checks[i], raw.setupFailed))
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
