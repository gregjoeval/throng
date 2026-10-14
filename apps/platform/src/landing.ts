// A landing's pure parts: what its run's Workflow is told of the merge, the merge commit it makes,
// and the steps it adds to the run's outcome. A merge request's landing is a `main` run (spec #257,
// "Landing"): `merge`, setups and checks on the merged tree, `land`, then `main`'s post-gate steps.

import type { ConflictDetails } from "./conflicts.ts";
import type { Dequeue, LegacyDequeueDetails } from "./merge-requests.ts";
import type { RunOutcome, RunStep, StepKind, StepOutcome } from "./run-outcome.ts";
import type { StoredRun } from "./scoring.ts";
import { attemptRef, taskRef } from "./task-refs.ts";

/** Commits name people by a no-reply address, never their real email. */
export const NOREPLY_DOMAIN = "users.noreply.throng";

/** Who a merge commit names: a user, and the alias they acted under, if any. */
export interface Signer {
  id: string;
  handle: string;
  alias: string | null;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** The merge commit's committer. */
export const THRONG_COMMITTER: GitIdentity = { name: "Throng", email: `noreply@${NOREPLY_DOMAIN}` };

/** The merge commit's author: the approver's user. */
export function mergeAuthor(approver: Signer): GitIdentity {
  return { name: approver.handle, email: `${approver.id}+${approver.handle}@${NOREPLY_DOMAIN}` };
}

/** `ada (claude) <ada00001+claude@…>`, or `ada <ada00001+ada@…>` without an alias. */
function trailerName({ id, handle, alias }: Signer): string {
  return alias === null
    ? `${handle} <${id}+${handle}@${NOREPLY_DOMAIN}>`
    : `${handle} (${alias}) <${id}+${alias}@${NOREPLY_DOMAIN}>`;
}

export interface MergeCommitInput {
  task: number;
  attempt: number;
  title: string;
  approver: Signer;
  /** Each alias that pushed to the attempt. */
  coAuthors: Signer[];
}

/** `Merge t42a3: <task title>` with the Throng trailers, `Approved-by` and a `Co-authored-by` per alias. */
export function mergeCommitMessage({ task, attempt, title, approver, coAuthors }: MergeCommitInput): string {
  const subject = `Merge ${attemptRef(task, attempt)}: ${title.replace(/\s+/gu, " ").trim()}`;
  const trailers = [
    `Throng-Task: ${taskRef(task)}`,
    `Throng-Attempt: ${attemptRef(task, attempt)}`,
    `Throng-Merge-Request: ${taskRef(task)}`,
    `Approved-by: ${trailerName(approver)}`,
    ...coAuthors.map((signer) => `Co-authored-by: ${trailerName(signer)}`),
  ];
  return `${subject}\n\n${trailers.join("\n")}\n`;
}

/** What a landing's run is told of the merge it lands. */
export interface LandingParams {
  task: number;
  /** The source attempt's number within the task. */
  attempt: number;
  /** The task's title, for the merge commit's subject. */
  title: string;
  /** The approved head, the only commit that can land. */
  head: string;
  approver: { user: string; alias: string | null };
  /** Each alias that pushed to the source attempt, with its user. */
  coAuthors: { user: string; alias: string }[];
  /** When the landing was queued, in ms: the merge commit's time, so a retried land step makes the same commit. */
  startedAt: number;
}

/**
 * What a Landing Workflow was started with, before landings were `main` runs. One that was under
 * way when they became runs resumes as a Pipeline Workflow with these params.
 */
export interface LegacyLandingParams extends LandingParams {
  project: string;
  /** Its id in the `landings` table, which its reports name. */
  landing: number;
}

/**
 * The alias someone in a landing's params acted under. Params saved by a landing started before the
 * alias was called an alias name it `agent`; either way, acting as themselves is null.
 */
export function actedAlias(acted: { alias?: string | null; agent?: string | null }): string | null {
  return acted.alias ?? acted.agent ?? null;
}

/** A check that didn't pass a landing's retest, as a Landing Workflow reported it. */
export interface LegacyFailedCheck {
  name: string;
  outcome: "failed" | "timedOut" | "skipped";
  log: string | null;
}

/** How a landing ended, as a Landing Workflow reported it before landings were runs. */
export type LegacyLandingOutcome =
  | { kind: "landed"; sha: string }
  | { kind: "conflict"; details: ConflictDetails }
  | { kind: "failedChecks"; details: { checks: LegacyFailedCheck[]; error?: string } }
  | { kind: "errored"; details: { step: string; error: string } };

/** One of a landing's own steps (`merge` or `land`), as its run's outcome lists it. */
export function landingStep(name: "merge" | "land", outcome: StepOutcome, notes: string[] = []): RunStep {
  return { name, kind: "step", source: "platform", group: null, outcome, durationMs: 0, notes, log: null };
}

/**
 * A landing's outcome from its run's: `merge` passed after `_diff`, then the setups and checks, then
 * `land` (skipped when the gate failed) before the post-gate steps, and what landed.
 */
export function landingOutcome(outcome: RunOutcome, landed: { sha: string } | null): RunOutcome {
  const at = outcome.steps.findIndex((step) => step.kind === "step");
  const end = at === -1 ? outcome.steps.length : at;
  const diff = outcome.steps[0]?.source === "platform" ? 1 : 0;
  const land =
    landed === null ? landingStep("land", "skipped", ["skipped: the gate failed"]) : landingStep("land", "passed");
  return {
    ...outcome,
    steps: [
      ...outcome.steps.slice(0, diff),
      landingStep("merge", "passed"),
      ...outcome.steps.slice(diff, end),
      land,
      ...outcome.steps.slice(end),
    ],
    ...(landed === null ? {} : { landed }),
  };
}

/** The outcome of a landing whose merge conflicted: nothing after `merge` ran, and the conflict is kept. */
export function conflictOutcome(details: ConflictDetails): RunOutcome {
  return {
    base: details.base,
    config: { kind: "none" },
    gate: "failed",
    steps: [
      landingStep("merge", "failed", ["the merge conflicted"]),
      landingStep("land", "skipped", ["skipped: the merge conflicted"]),
    ],
    metrics: {},
    landed: "conflict",
    conflict: details,
  };
}

/**
 * The outcome of a landing that pushed `sha` and recorded nothing else of its own: one a Landing
 * Workflow ran, before landings were runs and kept their setups' and checks' steps.
 */
export function landedOutcome(sha: string): RunOutcome {
  return {
    base: null,
    config: { kind: "none" },
    gate: "passed",
    steps: [landingStep("merge", "passed"), landingStep("land", "passed")],
    metrics: {},
    landed: { sha },
  };
}

/** The outcome of a Landing Workflow's retest that didn't pass: the checks it reported, and nothing landed. */
export function legacyFailedOutcome({ checks, error }: { checks: LegacyFailedCheck[]; error?: string }): RunOutcome {
  return {
    base: null,
    config: error === undefined ? { kind: "valid" } : { kind: "invalid", error },
    gate: "failed",
    steps: [
      landingStep("merge", "passed"),
      ...checks.map(({ name, outcome }): RunStep => ({
        name,
        kind: "check",
        source: "project",
        group: null,
        outcome: outcome === "skipped" ? "skipped" : "failed",
        durationMs: 0,
        notes: outcome === "timedOut" ? ["timed out"] : [],
        log: null,
      })),
      landingStep("land", "skipped", ["skipped: the gate failed"]),
    ],
    metrics: {},
  };
}

/** A setup or check that didn't pass a landing's gate. */
export interface FailedStep {
  name: string;
  kind: StepKind;
  outcome: StepOutcome;
}

/** What a `failedChecks` dequeue's details say: the steps that didn't pass, and the config's errors when it was invalid. */
export interface FailedStepsDetails {
  steps: FailedStep[];
  error?: string;
}

/** What an `errored` dequeue's details say: the error that ended the landing, and the step that kept failing when one was named. */
export interface ErroredDetails {
  error: string;
  step?: string;
}

/** A dequeue's details: the conflict, the steps that failed, or the error. */
export type DequeueDetails = ConflictDetails | FailedStepsDetails | ErroredDetails;

/**
 * A dequeue's details, read from the landing's run behind it (`run`): the conflict its merge hit,
 * the setups and checks that failed its gate, or the error that ended it. A dequeue stored before
 * landings were runs kept its own, which are read in the same shape. A new push or a cancel has none.
 */
export function dequeueDetails(dequeue: Dequeue, run: StoredRun | null): DequeueDetails | null {
  if (dequeue.details !== undefined) return legacyDetails(dequeue.details);
  if (run === null) return null;
  switch (dequeue.reason) {
    case "conflict": {
      return run.outcome?.conflict ?? null;
    }
    case "failedChecks": {
      if (run.outcome === null) return null;
      const steps = run.outcome.steps.flatMap(({ name, kind, outcome }): FailedStep[] =>
        kind !== "step" && (outcome === "failed" || outcome === "errored") ? [{ name, kind, outcome }] : [],
      );
      const { config } = run.outcome;
      return config.kind === "invalid" ? { steps, error: config.error } : { steps };
    }
    case "errored": {
      return { error: run.error ?? "the landing errored" };
    }
    case "newPush":
    case "cancelled": {
      return null;
    }
  }
}

function legacyDetails(details: LegacyDequeueDetails): DequeueDetails {
  if (!("checks" in details)) return details;
  const steps = details.checks.map(({ name, outcome }): FailedStep => ({
    name,
    kind: "check",
    outcome: outcome === "skipped" ? "skipped" : "failed",
  }));
  return details.error === undefined ? { steps } : { steps, error: details.error };
}
