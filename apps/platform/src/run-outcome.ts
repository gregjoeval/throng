// A pipeline run's outcome: every step it ran in run order, with its gate and metrics (spec #257,
// "Run storage"). Runs store it; an attempt's scoring reads a slice of it, the `ScoringResult` that
// lanes, the arena and votes have always read.

import type { ConfigResult, Source, StepConfig } from "./config.ts";
import { setupLogName, stepLogName } from "./logs.ts";
import {
  buildResult,
  DIFF_CHECK,
  POST_GATE_STEP_TIMEOUT_MS,
  checkOutcome as ranOutcome,
  SETUP_TIMEOUT_MS,
} from "./results.ts";
import type { CheckOutcome, RawScore, ScoringResult } from "./results.ts";

export const STEP_KINDS = ["setup", "check", "step"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_OUTCOMES = ["passed", "failed", "skipped", "cancelled", "errored"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** One setup, check or post-gate step of a run. */
export interface RunStep {
  /** A setup's, check's or post-gate step's name; `setup.<n>` for a setup from before setups had names. */
  name: string;
  kind: StepKind;
  source: Source;
  /** The check's group; null outside one. */
  group: string | null;
  /** The checks a check waited for; absent on a step stored before checks could wait, which waited for none. */
  after?: string[];
  outcome: StepOutcome;
  durationMs: number;
  /** What the run noticed about the step, such as why it was skipped. */
  notes: string[];
  /** The name of the step's stored log; null when it stored none. */
  log: string | null;
}

export interface RunOutcome extends Pick<ScoringResult, "base" | "config" | "gate" | "metrics"> {
  /** Every step in run order: `_diff`, the setups, the checks, then any post-gate steps. */
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

/** The check results kept for a Preview before previews became a check, and the log it stored. */
const LEGACY_PREVIEW = { check: "_preview", log: "preview.deploy" };

/** The log a check stores: its own name, except a legacy Preview's. */
function checkLog(check: string): string {
  return check === LEGACY_PREVIEW.check ? LEGACY_PREVIEW.log : check;
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
 * How one setup went: its exit code, null when it never ran, and how long it took. `error` says why
 * the setups never started, on the setup that caused it, such as a secret it names being gone.
 */
export interface SetupRun {
  exit: number | null;
  durationMs: number;
  error?: string;
}

/** What a setup's step notes: why it errored, or that it was skipped for the setup that failed. */
function setupNotes(ran: SetupRun, failed: string | null): string[] {
  if (ran.error !== undefined) return [ran.error];
  return ran.exit === null && failed !== null ? [`skipped: setup ${failed} failed`] : [];
}

/**
 * A pipeline run's outcome from the config it ran under and what its containers reported: `_diff`,
 * each setup, then each check with the checks it waited for. `raw.setupFailed` names the first setup
 * that failed; `logs` are the names of the logs the run stored, and `notes` what the run noted about
 * each check besides why it was skipped.
 */
export function pipelineOutcome(
  config: ConfigResult,
  raw: RawScore,
  setups: SetupRun[],
  logs: string[],
  notes: ReadonlyMap<string, string[]> = new Map(),
): RunOutcome {
  const result = buildResult(config, raw);
  const configured = config.kind === "valid" ? config.config : null;
  const failed = raw.setupFailed === null ? null : (configured?.setup[raw.setupFailed - 1]?.name ?? null);
  const setupSteps = (configured?.setup ?? []).map(({ name }, i): RunStep => {
    const ran = setups[i] ?? { exit: null, durationMs: 0 };
    const log = setupLogName(i + 1);
    return {
      name,
      kind: "setup",
      source: "project",
      group: null,
      outcome:
        ran.error === undefined ? STEP_OUTCOME[ranOutcome(ran.exit, ran.durationMs, SETUP_TIMEOUT_MS)] : "errored",
      durationMs: ran.durationMs,
      notes: setupNotes(ran, failed),
      log: logs.includes(log) ? log : null,
    };
  });
  const configuredChecks = new Map(configured?.checks.map((check) => [check.name, check]));
  const after = new Map(configured?.checks.map((check) => [check.name, check.after]));
  const checks = result.checks.map((check): RunStep => ({
    name: check.name,
    kind: "check",
    source: check.source,
    group: configuredChecks.get(check.name)?.group ?? null,
    ...(check.source === "platform" ? {} : { after: after.get(check.name) ?? [] }),
    outcome: STEP_OUTCOME[check.outcome],
    durationMs: check.durationMs,
    notes: [...check.notes, ...(notes.get(check.name) ?? [])],
    log: logs.includes(check.name) ? check.name : null,
  }));
  const steps = [
    ...checks.filter((check) => check.name === DIFF_CHECK),
    ...setupSteps,
    ...checks.filter((check) => check.name !== DIFF_CHECK),
  ];
  return { base: result.base, config: result.config, gate: result.gate, steps, metrics: result.metrics };
}

/** How one post-gate step's command went, and whether its log was stored. */
export interface PostGateRun {
  exit: number;
  durationMs: number;
  logged: boolean;
  notes: string[];
}

/**
 * The run's outcome with its post-gate steps after its checks, in order: each that ran with how it
 * went, and every one after a failed gate or a step that didn't pass `skipped`, saying why. The gate
 * is the setups' and checks' alone.
 */
export function withPostGateSteps(
  outcome: RunOutcome,
  steps: readonly StepConfig[],
  ran: ReadonlyMap<string, PostGateRun>,
): RunOutcome {
  let stopped = outcome.gate === "passed" ? null : "skipped: the gate failed";
  const after = steps.map(({ name }): RunStep => {
    const step = { name, kind: "step" as const, source: "project" as const, group: null };
    const run = ran.get(name);
    if (stopped !== null || run === undefined) {
      return {
        ...step,
        outcome: "skipped",
        durationMs: 0,
        notes: [stopped ?? "skipped: the run didn't report it"],
        log: null,
      };
    }
    const ended = ranOutcome(run.exit, run.durationMs, POST_GATE_STEP_TIMEOUT_MS);
    if (ended !== "passed") stopped = `skipped: step ${name} didn't pass`;
    return {
      ...step,
      outcome: STEP_OUTCOME[ended],
      durationMs: run.durationMs,
      notes: ended === "timedOut" ? ["timed out", ...run.notes] : run.notes,
      log: run.logged ? stepLogName(name) : null,
    };
  });
  return { ...outcome, steps: [...outcome.steps, ...after] };
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
