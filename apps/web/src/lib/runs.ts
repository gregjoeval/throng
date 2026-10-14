// What the runs pages show about a pipeline run, in the platform's own values: labels, how long it
// took, where its line links, and its outcome's steps in the sections the run page shows them in.

import { LANDING_STEPS } from "@throng/platform/landing";
import { parseAttemptRef, parseTaskRef, taskRef } from "@throng/platform/task-refs";
import type { ProjectRef, Run, RunWithOutcome } from "@/lib/api";
import { shortSha } from "@/lib/commits";
import { buildPath } from "@/lib/paths";

export type RunStep = NonNullable<RunWithOutcome["outcome"]>["steps"][number];

export const RUN_STATUS_LABELS: Record<Run["status"], string> = {
  queued: "Queued",
  waiting: "Waiting for the owner",
  running: "Running",
  done: "Done",
  cancelled: "Cancelled",
  errored: "Errored",
};

export const TRIGGER_LABELS: Record<Run["trigger"], string> = {
  open: "Open",
  push: "Push",
  scoreNow: "Score now",
  rescore: "Rescore",
  merge: "Merge",
  start: "Start",
};

export const STEP_OUTCOME_LABELS: Record<RunStep["outcome"], string> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  errored: "Errored",
};

/** The runs list's line filter: every line, `main`, or every line but `main`. */
export const LINE_FILTERS = [
  { value: undefined, label: "All lines" },
  { value: "main", label: "main" },
  { value: "tasks", label: "Tasks" },
] as const;

/** `1.2 s` under a minute, `3m 04s` from there. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** How long the run took, or has taken so far while it runs; null before it started. */
export function runDuration(run: Pick<Run, "startedAt" | "finishedAt">, now = Date.now()): number | null {
  if (run.startedAt === null) return null;
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  return Math.max(0, end - Date.parse(run.startedAt));
}

/** Who triggered the run: `ada`, `ada (claude)` under an alias, or Throng when no user did. */
export function triggeredBy(run: Pick<Run, "requestedBy" | "alias">): string {
  if (run.requestedBy === null) return "Throng";
  return run.alias === null ? run.requestedBy.handle : `${run.requestedBy.handle} (${run.alias})`;
}

/**
 * Where a run's line links: an attempt's or a task branch's line to its task's page, and `main` to
 * the commit the run ran, or to `main`'s commits for a landing that hasn't landed.
 */
export function lineHref(projectRef: ProjectRef, run: Pick<Run, "line" | "sha">): string {
  const attempt = parseAttemptRef(run.line);
  if (attempt !== null) return buildPath({ view: "task", ...projectRef, task: taskRef(attempt.task) });
  const task = parseTaskRef(run.line);
  if (task !== null) return buildPath({ view: "task", ...projectRef, task: taskRef(task) });
  if (run.sha === null) return buildPath({ view: "commits", ...projectRef, ref: run.line });
  return buildPath({ view: "commit", ...projectRef, sha: run.sha });
}

/** What starting a run waiting for the owner means: the head it runs, the attempt that's on, and the secrets it holds. */
export type Waiting = NonNullable<Run["waiting"]>;

/**
 * Where a waiting run's diff is: everything Start would run, not just its head's last commit, so no
 * change hides in an earlier one. An attempt's or task branch's head is compared from its base (where
 * it meets its task branch or `main`); a held landing's approved head, which has none, from `main`, as
 * is a head that shares no history with its base. Looked up in the attempt it's on.
 */
export function waitingHref(projectRef: ProjectRef, waiting: Waiting): string {
  const attempt = waiting.attempt === null ? {} : { attempt: waiting.attempt };
  return buildPath({ view: "compare", ...projectRef, from: waiting.base ?? "main", to: waiting.head, ...attempt });
}

/**
 * The task a run belongs to (`t42`): its line's, or for a merge request's landing its source
 * attempt's; null for any other `main` run.
 */
export function runTask(run: Pick<Run, "line" | "waiting">): string | null {
  const attempt = parseAttemptRef(run.waiting?.attempt ?? run.line);
  if (attempt !== null) return taskRef(attempt.task);
  const task = parseTaskRef(run.line);
  return task === null ? null : taskRef(task);
}

/** A run's head as the runs pages show it: short, or a dash for a landing that hasn't landed. */
export function runHead(run: Pick<Run, "sha">): string {
  return run.sha === null ? "—" : shortSha(run.sha);
}

/** Whether a step is Throng's own of a landing, which the run page shows between the checks and the post-gate steps. */
const isLanding = (step: RunStep) =>
  step.source === "platform" && (LANDING_STEPS as readonly string[]).includes(step.name);

/** One group of checks: its name, or null for the checks in none. */
export interface CheckGroup {
  group: string | null;
  checks: RunStep[];
}

/** A run's steps in the sections the run page shows: setups, checks by group, the landing, then post-gate steps. */
export interface RunSections {
  setups: RunStep[];
  /** Ungrouped checks first (Throng's `_diff` among them), then each group in the order it first ran. */
  checks: CheckGroup[];
  landing: RunStep[];
  steps: RunStep[];
}

export function runSections(steps: RunStep[]): RunSections {
  const groups = new Map<string | null, RunStep[]>([[null, []]]);
  for (const step of steps.filter((s) => s.kind === "check" && !isLanding(s))) {
    groups.set(step.group, [...(groups.get(step.group) ?? []), step]);
  }
  return {
    setups: steps.filter((s) => s.kind === "setup"),
    checks: [...groups].filter(([, checks]) => checks.length > 0).map(([group, checks]) => ({ group, checks })),
    landing: steps.filter(isLanding),
    steps: steps.filter((s) => s.kind === "step" && !isLanding(s)),
  };
}

/** The setup that failed, if one did: what an attempt's details call out as "Setup failed". */
export function failedSetup(steps: RunStep[]): RunStep | null {
  return steps.find((s) => s.kind === "setup" && s.outcome === "failed") ?? null;
}
