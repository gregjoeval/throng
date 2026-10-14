// A pipeline run's outcome: every step it ran in run order, with its gate and metrics (spec #257,
// "Run storage"). Runs store it; an attempt's scoring reads a slice of it, the `ScoringResult` that
// lanes, the arena and votes have always read.

import type { Source } from "./config.ts";
import { PREVIEW_LOG } from "./logs.ts";
import { DIFF_CHECK, PREVIEW_CHECK } from "./results.ts";
import type { CheckOutcome, ScoringResult } from "./results.ts";

export const STEP_KINDS = ["setup", "check", "step"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_OUTCOMES = ["passed", "failed", "skipped", "cancelled", "errored"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** One setup, check or post-gate step of a run. */
export interface RunStep {
  /** `setup.<n>`, a check's name, or a post-gate step's. */
  name: string;
  kind: StepKind;
  source: Source;
  /** The check's group; null outside one. */
  group: string | null;
  outcome: StepOutcome;
  durationMs: number;
  /** What the run noticed about the step, such as why it was skipped. */
  notes: string[];
  /** The name of the step's stored log; null when it stored none. */
  log: string | null;
}

export interface RunOutcome extends Pick<ScoringResult, "base" | "config" | "gate" | "metrics"> {
  /** Every step in run order: `_diff`, the setups, the checks, then `_preview`. */
  steps: RunStep[];
}

/**
 * A check's outcome as a step's. A step has no `timedOut`: a check that ran out its time failed, and
 * its outcome metric still says `timedOut`.
 */
const STEP_OUTCOME: Record<CheckOutcome, StepOutcome> = {
  passed: "passed",
  failed: "failed",
  timedOut: "failed",
  errored: "errored",
  skipped: "skipped",
};

const SETUP_LOG = /^setup\.\d+$/u;

/** The log a check stores: its own name, except the Preview's. */
function checkLog(check: string): string {
  return check === PREVIEW_CHECK ? PREVIEW_LOG : check;
}

/**
 * A scoring result as a run's outcome. A result names no setups, so each stored setup log is a setup
 * that ran; when setup failed (the config was valid, the gate failed and no check of the config ran),
 * the last of them is the one that failed. A setup's duration wasn't recorded, so it is 0.
 */
export function runOutcome(result: ScoringResult): RunOutcome {
  const { base, config, gate, metrics, logs } = result;
  const setupLogs = logs.filter((log) => SETUP_LOG.test(log));
  const ranNoCheck = result.checks.every((check) => check.source === "platform" || check.outcome === "skipped");
  const setupFailed = config.kind === "valid" && gate === "failed" && ranNoCheck;
  const setups = setupLogs.map((log, i): RunStep => ({
    name: log,
    kind: "setup",
    source: "project",
    group: null,
    outcome: setupFailed && i === setupLogs.length - 1 ? "failed" : "passed",
    durationMs: 0,
    notes: [],
    log,
  }));
  const checks = result.checks.map(({ name, source, outcome, durationMs, notes }): RunStep => ({
    name,
    kind: "check",
    source,
    group: null,
    outcome: STEP_OUTCOME[outcome],
    durationMs,
    notes,
    log: logs.includes(checkLog(name)) ? checkLog(name) : null,
  }));
  const steps = [
    ...checks.filter((check) => check.name === DIFF_CHECK),
    ...setups,
    ...checks.filter((check) => check.name !== DIFF_CHECK),
  ];
  return { base, config, gate, steps, metrics };
}

/**
 * A check step's outcome as scoring reports it: `timedOut` when its outcome metric says so, and a
 * cancelled check as skipped.
 */
function checkOutcome(step: RunStep, metrics: ScoringResult["metrics"]): CheckOutcome {
  if (step.outcome === "failed" && metrics[step.name]?.value === "timedOut") return "timedOut";
  return step.outcome === "cancelled" ? "skipped" : step.outcome;
}

/** The slice of a run's outcome an attempt's scoring reads: its checks, and the logs it stored in run order. */
export function scoringResult({ base, config, gate, steps, metrics }: RunOutcome): ScoringResult {
  return {
    base,
    config,
    gate,
    checks: steps
      .filter((step) => step.kind === "check")
      .map((step) => ({
        name: step.name,
        source: step.source,
        outcome: checkOutcome(step, metrics),
        durationMs: step.durationMs,
        notes: step.notes,
      })),
    metrics,
    logs: steps.flatMap((step) => (step.log === null ? [] : [step.log])),
  };
}
