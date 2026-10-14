// The `landings` table, from before a merge request's landing was a `main` run, folded into
// `pipeline_runs` (spec #257, "Run storage"). Each landing becomes a landing's run, linked to its
// merge request, so the runs list and the dequeue banner find it; the table is then dropped.

import { normaliseDequeue } from "./casing.ts";
import type { ConflictDetails } from "./conflicts.ts";
import { conflictOutcome, landedOutcome, legacyFailedOutcome } from "./landing.ts";
import type { LegacyFailedCheck } from "./landing.ts";
import type { LegacyDequeueDetails } from "./merge-requests.ts";
import type { RunOutcome } from "./run-outcome.ts";
import { MAIN_LINE } from "./scoring.ts";
import type { RunStatus } from "./scoring.ts";
import type { Sql } from "./task-store.ts";

/** A row of the `landings` table: `running ─► pushing ─► landed | dequeued`, or `stopped`. */
interface LandingRow {
  id: number;
  project: string;
  merge_request: number;
  instance_id: string;
  status: "running" | "pushing" | "landed" | "dequeued" | "stopped";
  started_at: number;
  finished_at: number | null;
  torn_down: number;
}

/** What a landing's run takes from its merge request. */
interface MergeRequestRow {
  approved_by_user: string;
  approved_by_alias: string | null;
  approved_by_owner: number;
  merge_sha: string | null;
  last_dequeue: string | null;
}

/** How a landing went, as its run records it. */
interface Ended {
  status: RunStatus;
  sha: string | null;
  outcome: RunOutcome | null;
  error: string | null;
}

/** The reasons only a landing's report dequeues with. */
const LANDING_REASONS = new Set(["conflict", "failedChecks", "errored"]);

/** The error of a landing dequeued before its merge request's last dequeue, whose reason only that kept. */
const UNKNOWN_DEQUEUE = "dequeued before landings were runs, which kept no reason for it";

/**
 * Moves every landing into `pipeline_runs` as a landing's run on `main`, asked for by its merge
 * request's approver and trusted as their approval was, keeping its instance id and times. One in
 * flight stays `running` (its claim on the push kept), naming its old id so its Landing Workflow's
 * reports still find it. A landed one is `done` at its merge request's merge commit. A dequeued one
 * takes what its merge request's last dequeue kept, when it was that dequeue's landing, and that
 * dequeue now names its run. A stopped one is `cancelled`. Idempotent: the table is dropped after.
 */
export function migrateLandings(sql: Sql): void {
  const [table] = sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'landings'",
  );
  if (table === undefined) return;
  sql.transaction(() => {
    for (const landing of sql.exec<LandingRow>("SELECT * FROM landings ORDER BY id")) {
      const [mr] = sql.exec<MergeRequestRow>("SELECT * FROM merge_requests WHERE id = ?", landing.merge_request);
      if (mr === undefined) continue;
      const [last] = sql.exec<{ id: number }>(
        "SELECT id FROM landings WHERE merge_request = ? AND status = 'dequeued' ORDER BY id DESC LIMIT 1",
        landing.merge_request,
      );
      // The merge request's last dequeue is this landing's when it's the latest dequeued one, and no
      // new push or cancel dequeued it since.
      const stored = last?.id === landing.id && mr.last_dequeue !== null ? storedDequeue(mr.last_dequeue) : null;
      const dequeue = stored !== null && LANDING_REASONS.has(stored.reason) ? stored : null;
      const ended = endOf(landing, mr, dequeue);
      const [run] = sql.exec<{ id: number }>(
        `INSERT INTO pipeline_runs (project, line, sha, pipeline, trigger, merge_request, user_id, alias, trusted,
           status, outcome, error, instance_id, created_at, started_at, finished_at, torn_down, land_claimed,
           legacy_landing)
         VALUES (?, ?, ?, 'main', 'merge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        landing.project,
        MAIN_LINE,
        ended.sha,
        landing.merge_request,
        mr.approved_by_user,
        mr.approved_by_alias,
        mr.approved_by_owner,
        ended.status,
        ended.outcome === null ? null : JSON.stringify(ended.outcome),
        ended.error,
        landing.instance_id,
        landing.started_at,
        landing.started_at,
        landing.finished_at,
        landing.torn_down,
        landing.status === "pushing" ? 1 : 0,
        landing.id,
      );
      if (dequeue !== null && run !== undefined) {
        sql.exec(
          "UPDATE merge_requests SET last_dequeue = ? WHERE id = ?",
          JSON.stringify({ ...dequeue, run: run.id }),
          landing.merge_request,
        );
      }
    }
    sql.exec("DROP TABLE landings");
  });
}

/** A dequeue as stored before landings were runs: its reason, its details, and when. */
interface StoredDequeue {
  reason: string;
  at: string;
  details?: LegacyDequeueDetails;
}

function storedDequeue(json: string): StoredDequeue {
  return normaliseDequeue(JSON.parse(json) as StoredDequeue);
}

/** How the landing went, from its status and, for a dequeued one, the dequeue it left. */
function endOf(landing: LandingRow, mr: MergeRequestRow, dequeue: StoredDequeue | null): Ended {
  const none = { sha: null, outcome: null, error: null };
  switch (landing.status) {
    case "running":
    case "pushing": {
      return { status: "running", ...none };
    }
    case "stopped": {
      return { status: "cancelled", ...none };
    }
    case "landed": {
      const sha = mr.merge_sha;
      return { status: "done", sha, outcome: sha === null ? null : landedOutcome(sha), error: null };
    }
    case "dequeued": {
      const details = dequeue?.details;
      if (dequeue?.reason === "conflict" && details !== undefined && "files" in details) {
        return { status: "done", sha: null, outcome: conflictOutcome(details as ConflictDetails), error: null };
      }
      if (dequeue?.reason === "failedChecks" && details !== undefined && "checks" in details) {
        const failed = details as { checks: LegacyFailedCheck[]; error?: string };
        return { status: "done", sha: null, outcome: legacyFailedOutcome(failed), error: null };
      }
      if (dequeue?.reason === "errored" && details !== undefined && "step" in details) {
        return { status: "errored", sha: null, outcome: null, error: `${details.step}: ${details.error}` };
      }
      return { status: "errored", sha: null, outcome: null, error: UNKNOWN_DEQUEUE };
    }
  }
}
