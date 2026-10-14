// The Landing Workflow's pure parts: what it is started with, what it reports, and the merge
// commit it makes. See the merge queue spec's "Landing" section.

import type { ConfigResult } from "./config.ts";
import type { ConflictDetails } from "./conflicts.ts";
import { CHECK_OUTCOMES } from "./results.ts";
import type { CheckOutcome, ScoringResult } from "./results.ts";
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

/** What a Landing Workflow is started with. */
export interface LandingParams {
  project: string;
  /** The landing's id, which its reports name. */
  landing: number;
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
  /** When the landing started, in ms: the merge commit's time, so a retried land step makes the same commit. */
  startedAt: number;
}

/**
 * The alias someone in a landing's params acted under. Params saved by a landing started before the
 * alias was called an alias name it `agent`; either way, acting as themselves is null.
 */
export function actedAlias(acted: { alias?: string | null; agent?: string | null }): string | null {
  return acted.alias ?? acted.agent ?? null;
}

/**
 * How a check can fail to pass: every outcome but `passed` and `errored`, as only `_preview` errors,
 * and Throng's own checks never gate.
 */
export type FailedCheckOutcome = Exclude<CheckOutcome, "passed" | "errored">;

function isFailedCheckOutcome(outcome: CheckOutcome): outcome is FailedCheckOutcome {
  return outcome !== "passed" && outcome !== "errored";
}

/** The outcomes a failed check can have, in `CHECK_OUTCOMES`'s order. */
export const FAILED_CHECK_OUTCOMES = CHECK_OUTCOMES.filter(isFailedCheckOutcome);

/** A check that didn't pass on the merged tree, and the name of its stored log, if any. */
export interface FailedCheck {
  name: string;
  outcome: FailedCheckOutcome;
  log: string | null;
}

/** What `last_dequeue.details` holds for `failedChecks`. */
export interface FailedChecksDetails {
  checks: FailedCheck[];
  /** The config's errors, when the merged tree's config is invalid. */
  error?: string;
}

/** What `last_dequeue.details` holds for `errored`: the step that kept failing, and its last error. */
export interface ErroredDetails {
  step: string;
  error: string;
}

/** How a landing ended, as its Workflow reports it. */
export type LandingOutcome =
  | { kind: "landed"; sha: string }
  | { kind: "conflict"; details: ConflictDetails }
  | { kind: "failedChecks"; details: FailedChecksDetails }
  | { kind: "errored"; details: ErroredDetails };

/**
 * The config the retest runs under: the merged tree's, as every check that runs must pass. Null skips
 * the retest: no config, or no checks. An invalid config is kept, and fails (see `buildResult`).
 */
export function retestConfig(config: ConfigResult): ConfigResult | null {
  if (config.kind === "none") return null;
  if (config.kind === "invalid") return config;
  return config.config.checks.length === 0 ? null : config;
}

/**
 * The checks the retest's result didn't pass, each with its log when one was stored. Throng's own
 * checks are left out: the retest doesn't diff or deploy, and neither ever gates.
 */
export function failedChecks(result: ScoringResult, stored: string[]): FailedChecksDetails {
  const checks = result.checks.flatMap(({ name, source, outcome }): FailedCheck[] =>
    source !== "platform" && isFailedCheckOutcome(outcome)
      ? [{ name, outcome, log: stored.includes(name) ? name : null }]
      : [],
  );
  return result.config.kind === "invalid" ? { checks, error: result.config.error } : { checks };
}

/** The part of the Landing Workflow binding the DO uses; tests pass a fake. */
export interface LandingWorkflowBinding {
  create: (options: { id: string; params: LandingParams }) => Promise<unknown>;
  get: (id: string) => Promise<{ terminate: () => Promise<void> }>;
}

export interface LandingRunner {
  workflow: LandingWorkflowBinding;
  /** Destroys a landing's Sandboxes once its Workflow is stopped. */
  teardown: (instanceId: string) => Promise<void>;
}
