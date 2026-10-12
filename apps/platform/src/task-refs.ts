// Task and attempt references, `t42` and `t42a3`, and the task a reserved branch belongs to.
// Kept apart from the task store so the scoring queue can name attempts without importing it.

const TASK_REF = /^t?([1-9]\d*)$/u;
const ATTEMPT_REF = /^t?([1-9]\d*)a([1-9]\d*)$/u;
const RESERVED_BRANCH = /^t([1-9]\d*)\//u;

/** A task reference, `t42` or `42`, as its number; null when it isn't one. */
export function parseTaskRef(ref: string): number | null {
  const match = TASK_REF.exec(ref);
  return match === null ? null : safeNumber(match[1]);
}

/** An attempt reference, `t42a3` (or `42a3`), as its task and attempt numbers; null when it isn't one. */
export function parseAttemptRef(ref: string): { task: number; number: number } | null {
  const match = ATTEMPT_REF.exec(ref);
  if (match === null) return null;
  const task = safeNumber(match[1]);
  const number = safeNumber(match[2]);
  return task === null || number === null ? null : { task, number };
}

export function taskRef(task: number): string {
  return `t${task}`;
}

export function attemptRef(task: number, number: number): string {
  return `t${task}a${number}`;
}

/**
 * The task a branch is reserved for: `t<n>/<anything>` belongs to task `t<n>` and never creates a
 * task of its own. Null for any other branch.
 */
export function reservedTask(branch: string): number | null {
  const match = RESERVED_BRANCH.exec(branch);
  return match === null ? null : safeNumber(match[1]);
}

function safeNumber(digits: string | undefined): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
