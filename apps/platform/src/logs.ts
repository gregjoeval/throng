// A scoring run's logs: one per `setup` step, check and preview, stored in R2 under the run. The key
// layout, the log names and the script that reads a log out of the Sandbox (truncated to fit) live
// here; the R2 lifecycle deletes logs after `LOG_RETENTION_DAYS` (see the README's setup).

/** Logs over this many bytes are stored truncated, keeping their head and tail. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** How long the R2 lifecycle rule keeps a log. */
export const LOG_RETENTION_DAYS = 30;
/** The key prefix every log is stored under, and the lifecycle rule applies to. */
export const LOG_PREFIX = "logs/";

/** The preview's log. Check names can't contain a dot, so it never collides with a check's. */
export const PREVIEW_LOG = "preview.deploy";
/** A check's log name is its own name; setup steps, the preview and checks never share one. */
const LOG_NAME = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)?$/;

/** The part of the logs R2 bucket Throng uses; tests pass one in memory. */
export interface LogStore {
  get(key: string): Promise<{ body: ReadableStream } | null>;
  put(key: string, value: string): Promise<unknown>;
}

/** The run a log belongs to. */
export interface LogRun {
  /** The project id. */
  project: string;
  /** The attempt, `t42a3`. */
  attempt: string;
  sha: string;
  run: number;
}

/** The 1-based `setup` command's log name, `setup.2`. */
export function setupLogName(step: number): string {
  return `setup.${step}`;
}

/** Whether `name` could name a run's log, so a request can't build a key outside the run. */
export function isLogName(name: string): boolean {
  return LOG_NAME.test(name);
}

/** Where a run's log is stored: `logs/<projectId>/<t42a3>/<sha>/<runId>/<name>.log`. */
export function logKey({ project, attempt, sha, run }: LogRun, name: string): string {
  return `${LOG_PREFIX}${project}/${attempt}/${sha}/${run}/${name}.log`;
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
