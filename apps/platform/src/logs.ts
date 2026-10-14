// A scoring run's logs: one per `setup` step and check, stored in R2 under the run. The key
// layout, the log names and the script that reads a log out of the Sandbox (truncated to fit) live
// here; the R2 lifecycle deletes logs after `LOG_RETENTION_DAYS` (see the README's setup).

import type { SandboxSize } from "./config.ts";
import { ServiceError } from "./errors.ts";

/** Logs over this many bytes are stored truncated, keeping their head and tail. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** How long the R2 lifecycle rule keeps a log. */
export const LOG_RETENTION_DAYS = 30;
/** The key prefix every log is stored under, and the lifecycle rule applies to. */
export const LOG_PREFIX = "logs/";

/** A check's log name is its own name; setup steps and checks never share one. */
const LOG_NAME = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)?$/u;

/** The part of the logs R2 bucket Throng uses; tests pass one in memory. */
export interface LogStore {
  get: (key: string) => Promise<{ body: ReadableStream } | null>;
  put: (key: string, value: string) => Promise<unknown>;
}

/** What R2 and the log endpoint serve a log as. */
export const LOG_CONTENT_TYPE = "text/plain; charset=utf-8";

/** The 1-based `setup` command's log name, `setup.2`. */
export function setupLogName(step: number): string {
  return `setup.${step}`;
}

/** Whether `name` could name a run's log, so a request can't build a key outside the run. */
export function isLogName(name: string): boolean {
  return LOG_NAME.test(name);
}

/** Where a run's log is stored: `logs/<projectId>/<line>/<runId>/<name>.log`. */
export function logKey({ project, line, run }: { project: string; line: string; run: number }, name: string): string {
  return `${LOG_PREFIX}${project}/${line}/${run}/${name}.log`;
}

/**
 * Where a run stored its log before runs were keyed on their line,
 * `logs/<projectId>/<t42a3>/<sha>/<runId>/<name>.log`; read until the lifecycle rule expires them.
 */
export function legacyLogKey(
  { project, line, sha, run }: { project: string; line: string; sha: string; run: number },
  name: string,
): string {
  return `${LOG_PREFIX}${project}/${line}/${sha}/${run}/${name}.log`;
}

/**
 * Where a landing's retest log is stored: `logs/<projectId>/<t42a3>/<head>/landing-<landingId>/<name>.log`,
 * next to the head's scoring runs and under the same lifecycle rule.
 */
export function landingLogKey(
  {
    project,
    task,
    attempt,
    head,
    landing,
  }: { project: string; task: number; attempt: number; head: string; landing: number },
  name: string,
): string {
  return `${LOG_PREFIX}${project}/t${task}a${attempt}/${head}/landing-${landing}/${name}.log`;
}

/** The `notFound` for a log a run doesn't have: never stored, expired, or a name no log can have. */
export function missingLog(run: number, name: string): ServiceError {
  return new ServiceError("notFound", `run ${run} has no log ${name}`);
}

/** `readLogScript`'s exit code when the step wrote no log (it was skipped). */
export const MISSING_LOG_EXIT = 3;
/** Room left for the truncation marker; the head and tail kept share the rest equally. */
const MARKER_ROOM = 200;

/**
 * Bash, run in the Sandbox's workspace, that prints `logs/<name>.log` for storing. A log over
 * `maxBytes` prints its head and tail with a marker between them saying how much was dropped, at
 * most `maxBytes` in all, so a huge log is never read whole. A missing log exits `MISSING_LOG_EXIT`.
 */
export function readLogScript(name: string, maxBytes = MAX_LOG_BYTES): string {
  if (!isLogName(name)) throw new Error(`not a log name: ${name}`);
  const keep = Math.floor((maxBytes - MARKER_ROOM) / 2);
  return `
f=logs/${name}.log
[ -f "$f" ] || exit ${MISSING_LOG_EXIT}
size=$(stat -c %s "$f")
if [ "$size" -le ${maxBytes} ]; then exec cat "$f"; fi
head -c ${keep} "$f"
printf '\\n[throng: truncated %d of %d bytes]\\n' $(( size - ${2 * keep} )) "$size"
tail -c ${keep} "$f"
`;
}

/** The logs a score plan may write, in run order: each setup step, then each check. */
export function logNames(plan: { setup: string[]; checks: { name: string }[] }): string[] {
  return [...plan.setup.map((_, i) => setupLogName(i + 1)), ...plan.checks.map((check) => check.name)];
}

/** The note on every log a step wrote: the Sandbox size its container ran at. */
export function sandboxNote(size: SandboxSize): string {
  return `sandbox: ${size}`;
}

/**
 * A check's log with what the run noted about it (ignored metrics, why it was skipped) appended
 * under a `== throng ==` trailer. A step that wrote no log (`null`) gets one holding just its notes;
 * with no notes either, there's nothing to store.
 */
export function withNotes(log: string | null, notes: string[]): string | null {
  if (notes.length === 0) return log;
  const head = log === null || log === "" || log.endsWith("\n") ? (log ?? "") : `${log}\n`;
  return `${head}== throng ==\n${notes.join("\n")}\n`;
}
