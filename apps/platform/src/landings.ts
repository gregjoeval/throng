// A project's landings: one row per Landing Workflow the merge queue starts, in the project Durable
// Object's SQLite. The task store decides when a landing starts and what its report does to the merge
// request; this module keeps the rows. A landing is
//
//   running ─► pushing (its land step claimed the push to main) ─► landed | dequeued
//   running ─► dequeued, or stopped (its merge request left the queue; its Workflow is terminated)
//
// Only a `running` landing can be stopped. Once `pushing`, its merge request stays in the queue, so
// whatever the compare-and-swap on `main` decides is what the report records.

import type { Sql } from "./task-store.ts";

export const LANDING_STATUSES = ["running", "pushing", "landed", "dequeued", "stopped"] as const;
export type LandingStatus = (typeof LANDING_STATUSES)[number];

export interface StoredLanding {
  id: number;
  project: string;
  task: number;
  attempt: number;
  /** The merge request it lands. */
  merge_request: number;
  head: string;
  instance_id: string;
  status: LandingStatus;
  started_at: number;
  finished_at: number | null;
}

interface LandingRow extends Omit<StoredLanding, "status"> {
  status: string;
  torn_down: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS landings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  task INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  merge_request INTEGER NOT NULL,
  head TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  torn_down INTEGER NOT NULL DEFAULT 0
)`;

export class Landings {
  readonly #sql: Sql;
  readonly #now: () => Date;

  constructor({ sql, now }: { sql: Sql; now: () => Date }) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(SCHEMA);
  }

  /** Records a landing as `running`; `instanceId` names its Workflow. */
  start(
    input: Omit<StoredLanding, "id" | "instance_id" | "status" | "started_at" | "finished_at">,
    instanceId: (id: number) => string,
  ): StoredLanding {
    const [row] = this.#sql.exec<LandingRow>(
      `INSERT INTO landings (project, task, attempt, merge_request, head, instance_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, '', 'running', ?) RETURNING *`,
      input.project,
      input.task,
      input.attempt,
      input.merge_request,
      input.head,
      this.#now().getTime(),
    );
    if (row === undefined) throw new Error("landing insert returned no row");
    this.#sql.exec("UPDATE landings SET instance_id = ? WHERE id = ?", instanceId(row.id), row.id);
    return this.get(row.id) as StoredLanding;
  }

  get(id: number): StoredLanding | null {
    const [row] = this.#sql.exec<LandingRow>("SELECT * FROM landings WHERE id = ?", id);
    return row === undefined ? null : toLanding(row);
  }

  /** The landing still in flight (running or pushing), if any. There is at most one. */
  active(): StoredLanding | null {
    const [row] = this.#sql.exec<LandingRow>(
      "SELECT * FROM landings WHERE status IN ('running', 'pushing') ORDER BY id DESC LIMIT 1",
    );
    return row === undefined ? null : toLanding(row);
  }

  /** The merge request's latest landing that ended `dequeued`: the one its `last_dequeue` came from, if any did. */
  lastDequeued(mergeRequest: number): StoredLanding | null {
    const [row] = this.#sql.exec<LandingRow>(
      "SELECT * FROM landings WHERE merge_request = ? AND status = 'dequeued' ORDER BY id DESC LIMIT 1",
      mergeRequest,
    );
    return row === undefined ? null : toLanding(row);
  }

  /** Moves a landing on, recording when it ended unless it is now `pushing`. */
  move(id: number, status: LandingStatus): void {
    this.#sql.exec(
      "UPDATE landings SET status = ?, finished_at = ? WHERE id = ?",
      status,
      status === "pushing" ? null : this.#now().getTime(),
      id,
    );
  }

  /** Stopped landings whose Workflow hasn't been terminated yet, now marked torn down. */
  claimStopped(): StoredLanding[] {
    const rows = this.#sql.exec<LandingRow>("SELECT * FROM landings WHERE status = 'stopped' AND torn_down = 0");
    for (const row of rows) this.#sql.exec("UPDATE landings SET torn_down = 1 WHERE id = ?", row.id);
    return rows.map(toLanding);
  }
}

function toLanding(row: LandingRow): StoredLanding {
  const { torn_down: _tornDown, ...landing } = row;
  return { ...landing, status: row.status as LandingStatus };
}
