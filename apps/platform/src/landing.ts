// The Landing Workflow's pure parts: what it is started with, what it reports, and the merge
// commit it makes. See the merge queue spec's "Landing" section.

import type { ConfigResult } from "./config.ts";
import type { ConflictDetails } from "./conflicts.ts";
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

/** A required check that didn't pass on the merged tree, and the name of its stored log, if any. */
export interface FailedCheck {
  name: string;
  /** Only `_preview` errors, and it is never required. */
  outcome: Exclude<CheckOutcome, "passed" | "errored">;
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
 * The config the retest runs under: the merged tree's, with only its required checks. Null skips the
 * retest: no config, or no required checks. An invalid config is kept, and fails (see `buildResult`).
 */
export function retestConfig(config: ConfigResult): ConfigResult | null {
  if (config.kind === "none") return null;
  if (config.kind === "invalid") return config;
  const checks = config.config.checks.filter((check) => check.required);
  return checks.length === 0 ? null : { kind: "valid", config: { ...config.config, checks } };
}

/**
 * The required checks the retest's result didn't pass, each with its log when one was stored. Throng's
 * own checks are left out: the retest doesn't diff or deploy, and neither is ever required.
 */
export function failedChecks(result: ScoringResult, stored: string[]): FailedChecksDetails {
  const checks = result.checks
    .filter((check) => check.source !== "platform" && check.outcome !== "passed")
    .map((check) => ({
      name: check.name,
      outcome: check.outcome as FailedCheck["outcome"],
      log: stored.includes(check.name) ? check.name : null,
    }));
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
