import type { ConflictDetails } from "../../src/conflicts.ts";
import { conflictOutcome } from "../../src/landing.ts";
import type { RunReport } from "../../src/scoring.ts";
import type { TaskStore } from "../../src/task-store.ts";

/** A landing's run that conflicted with `details`, as its Workflow reports it. */
export const conflicted = (details: ConflictDetails): RunReport => ({
  status: "done",
  outcome: conflictOutcome(details),
});

/** A landing's run that errored, as its Workflow reports it. */
export const ERRORED: RunReport = { status: "errored", error: "land: boom" };

/**
 * Lands the front of the project's merge queue as far as its run's report: drains, so the front
 * merge request is `landing` and its run started, then reports `report` for that run. Returns the
 * run's id. The store needs a runner.
 */
export async function endLanding(store: TaskStore, project: string, report: RunReport): Promise<number> {
  await store.drain(project);
  const [run] = store.scoring.liveLandings();
  if (run?.status !== "running") throw new Error("no landing is running");
  store.pipelineFinished(run.id, report);
  return run.id;
}
