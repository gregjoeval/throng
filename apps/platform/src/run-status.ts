// A pipeline run's statuses, and which of them it rests in. Kept apart from the scoring queue so
// throng-web can read them without importing it.

/** A run is `waiting` while it needs the owner to start it, and holds no slot meanwhile. */
export const RUN_STATUSES = ["queued", "waiting", "running", "done", "cancelled", "errored"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The statuses a run ends in: nothing moves it on from one. */
export const ENDED_RUN_STATUSES = ["done", "cancelled", "errored"] as const satisfies readonly RunStatus[];

/** Whether `status` is one of `RUN_STATUSES`: for a status read from outside, such as a URL. */
export function isRunStatus(status: string): status is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(status);
}

/** Whether the run ended: nothing moves it on now. */
export function runEnded(run: { status: RunStatus }): boolean {
  return (ENDED_RUN_STATUSES as readonly RunStatus[]).includes(run.status);
}

/** Whether the run rests until someone acts: it ended, or it waits for the owner. What `wait_for_run` waits for. */
export function runSettled(run: { status: RunStatus }): boolean {
  return runEnded(run) || run.status === "waiting";
}
