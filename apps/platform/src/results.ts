// A scoring run's result: what the spec's "Results" section records for one run, and the pure steps
// that turn the project's config and the score script's raw output into it. Metrics parsing and the
// gate live here so they're tested without a container.

import { DEFAULT_CHECK_TIMEOUT_MS, networkAllow } from "./config.ts";
import type { CheckConfig, Config, ConfigResult, MetricConfig, MetricOrder, SetupConfig, Source } from "./config.ts";
import { parseFrom, typedValue } from "./metric-values.ts";
import type { MetricFormat, MetricRule, MetricValue } from "./metric-values.ts";

/** A check's outcome, best first; they are also the values of the check's outcome metric. */
export const CHECK_OUTCOMES = ["passed", "failed", "timedOut", "errored", "skipped"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Longest a `setup` command may run; the spec gives setup no timeout of its own. */
export const SETUP_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS;
/** The parse guard: largest output file in `$THRONG_OUTPUT` the score script parses. */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Exit codes `timeout` gives a command it stopped: TERM (124), then KILL after the grace (128 + 9). */
const TIMED_OUT_EXITS = new Set([124, 137]);

/** Throng's own check: finding the base and diffing. */
export const DIFF_CHECK = "_diff";

/** A check: a process the run ran, or skipped. Its outcome is also a metric named after it. */
export interface CheckResult {
  name: string;
  source: Source;
  outcome: CheckOutcome;
  durationMs: number;
  /** What the run noticed about the check, such as why it was skipped. */
  notes: string[];
}

interface MetricFields {
  source: Source;
  /** Why the value is null; on a value, what to know about it, such as that it came from an older result. */
  note?: string;
}

/**
 * One typed, nullable value in a run's score. A number or boolean says which way is better in
 * `order` (for a boolean, `desc` means true is), an enum lists its `values` best first, and a string
 * never ranks.
 */
export type MetricResult =
  | (MetricFields & { type: "number"; value: number | null; order: MetricOrder; unit?: string })
  | (MetricFields & { type: "boolean"; value: boolean | null; order: MetricOrder })
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
  /**
   * Passed when setup passed and every check that ran passed, including when there are none; failed on
   * an invalid config. Throng's own checks never gate.
   */
  gate: Gate;
  /** Every check in run order: `_diff`, then the config's checks. */
  checks: CheckResult[];
  /** Every metric by name: each check's outcome metric, followed by the metrics read from its output. */
  metrics: Record<string, MetricResult>;
  /**
   * The run's stored logs, by name (`setup.<n>` or a check's name), in run order. A
   * step that never ran has none; see `logs.ts` for where each is kept.
   */
  logs: string[];
}

/**
 * What a run runs, and the hosts it may reach beyond the npm registry. Each check carries the checks
 * it waits for and the metrics read from its output, which are read as soon as the check exits.
 */
export interface ScorePlan {
  setup: SetupConfig[];
  checks: PlannedCheck[];
  allow: string[];
}

/** A check as a run runs it. */
export interface PlannedCheck {
  name: string;
  command: string;
  timeoutMs: number;
  after: string[];
  /** The secrets its container holds in a trusted run, by name. */
  secrets: string[];
  metrics: PlannedMetric[];
}

/** A metric as the score script reads it: where from, and the rule its value must fit. */
export interface PlannedMetric {
  name: string;
  from: string;
  rule: MetricRule;
}

/** The score script's raw output, before values are checked again and the gate is computed. */
export interface RawScore {
  base: string | null;
  /** `git diff --shortstat` from the base (or the empty tree) to the head. */
  shortstat: string;
  /** How long finding the base and diffing took. */
  builtinMs: number;
  /** The 1-based setup that failed, or null when every setup passed. */
  setupFailed: number | null;
  /**
   * One per planned check, in order; `exit` is null for a check that didn't run. `metrics` holds the
   * value of each metric read from its output, by name; none for a check that didn't run. `error`
   * says why a check never started, such as a secret it names being gone: it errored.
   */
  checks: { exit: number | null; durationMs: number; metrics: Record<string, MetricValue>; error?: string }[];
}

/** The metrics read from `check`'s output, in config order. */
function metricsFrom(check: string, metrics: MetricConfig[]): MetricConfig[] {
  return metrics.filter((metric) => parseFrom(metric.from).check === check);
}

/** The rule a metric's value must fit: its type, and an enum's values. */
function ruleOf(metric: MetricConfig): MetricRule {
  return metric.type === "enum" ? { type: "enum", values: metric.values } : { type: metric.type };
}

/** The config's setup, checks and `network.allow`; nothing at all without a valid config. */
export function scorePlan(config: ConfigResult): ScorePlan {
  if (config.kind !== "valid") return { setup: [], checks: [], allow: [] };
  return {
    setup: config.config.setup,
    checks: config.config.checks.map(({ name, command, timeoutMs, after, secrets }) => ({
      name,
      command,
      timeoutMs,
      after,
      secrets,
      metrics: metricsFrom(name, config.config.metrics).map((metric) => ({
        name: metric.name,
        from: metric.from,
        rule: ruleOf(metric),
      })),
    })),
    allow: networkAllow(config),
  };
}

/** Room a step that runs commands gets beyond their timeouts: starting, fetching and storing logs. */
export const STEP_SLACK_MS = 5 * 60 * 1000;

/** How long running every setup may take: each at its timeout. */
export function setupTimeoutMs(plan: Pick<ScorePlan, "setup">): number {
  return plan.setup.length * SETUP_TIMEOUT_MS;
}

/** How long a script that runs the whole plan in one container may take: every setup and check at its timeout, plus slack. */
export function scoreTimeoutMs(plan: ScorePlan): number {
  const checks = plan.checks.reduce((sum, check) => sum + check.timeoutMs, 0);
  return setupTimeoutMs(plan) + checks + STEP_SLACK_MS;
}

/**
 * The plan's checks in an order that runs each after the checks it waits for, otherwise in plan
 * order. A valid config's `after`s make no circle; a check in one would come last.
 */
export function checkOrder<C extends Pick<PlannedCheck, "name" | "after">>(checks: readonly C[]): C[] {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const ordered: C[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (check: C): void => {
    if (placed.has(check.name) || visiting.has(check.name)) return;
    visiting.add(check.name);
    for (const waited of check.after) {
      const dep = byName.get(waited);
      if (dep !== undefined) place(dep);
    }
    visiting.delete(check.name);
    placed.add(check.name);
    ordered.push(check);
  };
  for (const check of checks) place(check);
  return ordered;
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

/**
 * Passed when every project and task check passed; no checks at all passes. Throng's own checks never
 * gate. A check skipped because setup failed, or that the score script didn't report, didn't pass.
 */
export function gateFor(checks: CheckResult[]): Gate {
  return checks.every((c) => c.source === "platform" || c.outcome === "passed") ? "passed" : "failed";
}

/** A check with its metrics, before its outcome metric is added. */
interface ScoredCheck {
  check: CheckResult;
  metrics: Record<string, MetricResult>;
}

/** The check's outcome metric, then its own metrics. */
function metricsOf({ check, metrics }: ScoredCheck): Record<string, MetricResult> {
  const outcome: MetricResult = {
    source: check.source,
    type: "enum",
    value: check.outcome,
    values: [...CHECK_OUTCOMES],
  };
  return { [check.name]: outcome, ...metrics };
}

function platformCheck(name: string, outcome: CheckOutcome, durationMs: number, notes: string[]): CheckResult {
  return { name, source: "platform", outcome, durationMs, notes };
}

/** One of `_diff`'s sizes: a smaller change is better. */
function diffMetric(value: number): MetricResult {
  return { source: "platform", type: "number", value, order: "asc" };
}

/** `_diff`: finding the base and diffing, with the diff's size. */
function diffScored(size: ReturnType<typeof parseShortstat>, durationMs: number): ScoredCheck {
  return {
    check: platformCheck(DIFF_CHECK, "passed", durationMs, []),
    metrics: {
      [`${DIFF_CHECK}.filesChanged`]: diffMetric(size.filesChanged),
      [`${DIFF_CHECK}.additions`]: diffMetric(size.additions),
      [`${DIFF_CHECK}.deletions`]: diffMetric(size.deletions),
    },
  };
}

/**
 * A metric's value as the score script reported it, checked against its type again: the script runs
 * beside the attempt's code, so the Worker trusts nothing it hands back.
 */
function checkedValue(metric: MetricConfig, reported: MetricValue | undefined): MetricValue {
  const notReported = { value: null, note: `${metric.from}: not reported` };
  if (typeof reported !== "object" || reported === null) return notReported;
  if (reported.value === null) {
    return typeof reported.note === "string" && reported.note !== ""
      ? { value: null, note: reported.note }
      : notReported;
  }
  const typed = typedValue(reported.value, ruleOf(metric));
  return "problem" in typed ? { value: null, note: `${metric.from}: ${typed.problem}` } : typed;
}

/**
 * A metric's entry in the result: its type's fields, and its value, already checked against its
 * type, or null with the note.
 */
function metricResult(metric: MetricConfig, checked: MetricValue): MetricResult {
  const { source } = metric;
  const note = checked.value === null ? { note: checked.note } : {};
  const { value } = checked;
  switch (metric.type) {
    case "number": {
      const unit = metric.unit === null ? {} : { unit: metric.unit };
      return {
        source,
        type: "number",
        order: metric.order,
        ...unit,
        value: typeof value === "number" ? value : null,
        ...note,
      };
    }
    case "boolean": {
      return {
        source,
        type: "boolean",
        order: metric.order,
        value: typeof value === "boolean" ? value : null,
        ...note,
      };
    }
    case "string": {
      const format = metric.format === null ? {} : { format: metric.format };
      return { source, type: "string", ...format, value: typeof value === "string" ? value : null, ...note };
    }
    case "enum": {
      return { source, type: "enum", values: metric.values, value: typeof value === "string" ? value : null, ...note };
    }
  }
}

/** How a metric's note says its check ended. */
const ENDED: Record<Exclude<CheckOutcome, "passed" | "skipped">, string> = {
  failed: "failed",
  timedOut: "timed out",
  errored: "errored",
};

/** How a skipped check's note says a check it waits for ended. */
const WAITED_ENDED: Record<Exclude<CheckOutcome, "passed">, string> = { ...ENDED, skipped: "was skipped" };

/**
 * Why a check that never ran was skipped: a setup failed, a check it waits for didn't pass, or, when
 * neither, nothing reported it.
 */
function skipNote(
  check: CheckConfig,
  failedSetup: SetupConfig | null,
  outcomes: ReadonlyMap<string, CheckOutcome>,
): string {
  if (failedSetup !== null) return `skipped: setup ${failedSetup.name} failed`;
  for (const waited of check.after) {
    const outcome = outcomes.get(waited);
    if (outcome !== undefined && outcome !== "passed")
      return `skipped: waits for ${waited}, which ${WAITED_ENDED[outcome]}`;
  }
  return "skipped: the run didn't report it";
}

/** How a config check's run went: `errored` when it never started for a reason it gave, else by its exit. */
function ranOutcome(check: CheckConfig, ran: RawScore["checks"][number] | undefined): CheckOutcome {
  if (ran?.error !== undefined) return "errored";
  return checkOutcome(ran?.exit ?? null, ran?.durationMs ?? 0, check.timeoutMs);
}

/**
 * A config check from its run: its outcome and notes, and the metrics read from its output. A check
 * that didn't pass reports no metrics: each is null, saying why.
 */
function configScored(
  check: CheckConfig,
  metrics: MetricConfig[],
  ran: RawScore["checks"][number] | undefined,
  skipped: string,
): ScoredCheck {
  const outcome = ranOutcome(check, ran);
  const metricValue = (metric: MetricConfig): MetricValue => {
    if (outcome === "passed") return checkedValue(metric, ran?.metrics[metric.name]);
    const why = outcome === "skipped" ? `was ${skipped}` : ENDED[outcome];
    return { value: null, note: `${check.name}: ${check.name} ${why}` };
  };
  return {
    check: {
      name: check.name,
      source: check.source,
      outcome,
      durationMs: ran?.durationMs ?? 0,
      notes: [...(outcome === "skipped" ? [skipped] : []), ...(ran?.error === undefined ? [] : [ran.error])],
    },
    metrics: Object.fromEntries(
      metricsFrom(check.name, metrics).map((metric): [string, MetricResult] => [
        metric.name,
        metricResult(metric, metricValue(metric)),
      ]),
    ),
  };
}

/**
 * The run's result from the config it ran under and the raw output of its scripts: `_diff`, then the
 * config's checks. Its `logs` are empty: the run stores its logs, with each check's notes, once the
 * result is built.
 */
export function buildResult(config: ConfigResult, raw: RawScore): ScoringResult {
  const checks = config.kind === "valid" ? configChecks(config.config, raw) : [];
  const gate = config.kind === "invalid" || raw.setupFailed !== null ? "failed" : gateFor(checks.map((s) => s.check));
  const scored = [diffScored(parseShortstat(raw.shortstat), raw.builtinMs), ...checks];
  const configSummary =
    config.kind === "invalid" ? { kind: "invalid" as const, error: config.error } : { kind: config.kind };
  return { base: raw.base, config: configSummary, gate, ...flatten(scored), logs: [] };
}

/** Each of the config's checks, scored from its run, a check that never ran saying why. */
function configChecks(config: Config, raw: RawScore): ScoredCheck[] {
  const failedSetup = raw.setupFailed === null ? null : (config.setup[raw.setupFailed - 1] ?? null);
  const outcomes = new Map(config.checks.map((check, i) => [check.name, ranOutcome(check, raw.checks[i])]));
  return config.checks.map((check, i) =>
    configScored(check, config.metrics, raw.checks[i], skipNote(check, failedSetup, outcomes)),
  );
}

/** The checks, and every metric by name: each check's outcome metric, then its own metrics. */
function flatten(scored: ScoredCheck[]): Pick<ScoringResult, "checks" | "metrics"> {
  return {
    checks: scored.map((s) => s.check),
    metrics: Object.assign({}, ...scored.map(metricsOf)) as Record<string, MetricResult>,
  };
}

/** The note on each metric `upgradeResult` converts: its order is a guess. */
const LEGACY_METRIC_NOTE = "converted from an older result, which didn't record its order or unit";

/**
 * A result as runs stored it before Throng's own work became checks: `builtin` held the diff's size,
 * `preview` the Preview's status, each check its reported metrics, and an invalid config a synthetic
 * `config` check carrying the error.
 */
export interface LegacyResult extends Pick<ScoringResult, "base" | "config" | "gate" | "logs"> {
  checks: (Omit<CheckResult, "source"> & { required: boolean; metrics: Record<string, number>; error?: string })[];
  builtin: { filesChanged: number; additions: number; deletions: number; durationMs: number };
  preview:
    | { status: "none" }
    | { status: "ready"; url: string }
    | { status: "failed" }
    | { status: "errored"; error: string };
}

/** A check as results stored it while a check could be optional: `required` said whether it gated. */
type OptionalCheck = CheckResult & { required?: boolean };

/** A result as runs have stored it: the current shape, perhaps with `required` on its checks, or a legacy one. */
export type StoredResult = (Omit<ScoringResult, "checks"> & { checks: OptionalCheck[] }) | LegacyResult;

/**
 * A stored result in the current shape. `required` is dropped from each check, as every check that
 * runs must pass now; the stored gate stays as it was scored. A legacy one becomes `_diff` and its
 * checks with their metrics as project numbers. Its synthetic `config` check is dropped, as `config`
 * already holds the error, and so is its `preview`, as Throng no longer deploys previews. No order or
 * unit was stored, so each number takes a config's default order (higher is better) with a note saying
 * so. A metric named like a check is dropped, as the check's outcome metric holds that name now, with
 * a note on that check.
 */
export function upgradeResult(stored: StoredResult): ScoringResult {
  if (!("builtin" in stored)) {
    if (!stored.checks.some((check) => "required" in check)) return stored;
    return { ...stored, checks: stored.checks.map(({ required: _required, ...check }) => check) };
  }
  const { builtin } = stored;
  const legacyChecks = stored.checks.filter((check) => check.error === undefined);
  const names = new Set(legacyChecks.map((check) => check.name));
  const dropped = new Map<string, string[]>();
  for (const { name: check, metrics } of legacyChecks) {
    for (const name of Object.keys(metrics).filter((metric) => names.has(metric))) {
      const note = `dropped metric ${name}, read from ${check} in an older result: its name is this check's`;
      dropped.set(name, [...(dropped.get(name) ?? []), note]);
    }
  }
  const checks = legacyChecks.map(({ metrics, error: _error, required: _required, ...check }): ScoredCheck => ({
    check: { ...check, source: "project", notes: [...check.notes, ...(dropped.get(check.name) ?? [])] },
    metrics: Object.fromEntries(
      Object.entries(metrics)
        .filter(([name]) => !names.has(name))
        .map(([name, value]): [string, MetricResult] => [
          name,
          { source: "project", type: "number", value, order: "desc", note: LEGACY_METRIC_NOTE },
        ]),
    ),
  }));
  const scored = [diffScored(builtin, builtin.durationMs), ...checks];
  return { base: stored.base, config: stored.config, gate: stored.gate, ...flatten(scored), logs: stored.logs };
}
