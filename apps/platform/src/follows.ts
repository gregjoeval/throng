// Active attempts following their task branch (ADR 0003): one row per Follow Workflow, in the project
// Durable Object's SQLite. The task store decides when an attempt follows and what a report does to
// it; this module keeps the rows. A follow is
//
//   queued ─► running ─► done (reported), or stopped (its attempt ended, or a landing held its push)
//
// An attempt has at most one follow running and one queued. A newer task head replaces the queued
// one's, so an attempt behind by several pushes catches up in one merge.

import type { FollowResult } from "./scripts.ts";
import { attemptRef, taskRef } from "./task-refs.ts";
import type { Sql } from "./task-store.ts";

const FOLLOW_STATUSES = ["queued", "running", "done", "stopped"] as const;
export type FollowStatus = (typeof FOLLOW_STATUSES)[number];

export interface StoredFollow {
  id: number;
  project: string;
  task: number;
  attempt: number;
  /** The task branch head to merge in. */
  task_head: string;
  /** Its Workflow's instance id, once started. */
  instance_id: string | null;
  status: FollowStatus;
  /** Ms since epoch; null while queued. */
  started_at: number | null;
  finished_at: number | null;
}

/** What a Follow Workflow is started with. */
export interface FollowParams {
  project: string;
  /** The follow's id, which its claim and report name. */
  follow: number;
  task: number;
  attempt: number;
  taskHead: string;
  /** When it started, in ms: the merge commit's time, so a retried step makes the same commit. */
  startedAt: number;
}

/** How a follow ended, as its Workflow reports it: the script's result, or the step that kept failing. */
export type FollowOutcome = FollowResult | { kind: "errored"; step: string; error: string };

/** The part of the Follow Workflow binding the DO uses; tests pass a fake. */
export interface FollowWorkflowBinding {
  create: (options: { id: string; params: FollowParams }) => Promise<unknown>;
}

export interface FollowRunner {
  workflow: FollowWorkflowBinding;
}

/** The merge commit's message: `Merge t42's task branch into t42a3` with the Throng trailers. */
export function followMessage(task: number, attempt: number): string {
  const ref = attemptRef(task, attempt);
  return `Merge ${taskRef(task)}'s task branch into ${ref}\n\nThrong-Task: ${taskRef(task)}\nThrong-Attempt: ${ref}\n`;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  task INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  task_head TEXT NOT NULL,
  instance_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
)`;

interface FollowRow extends Omit<StoredFollow, "status"> {
  status: string;
}

export class Follows {
  readonly #sql: Sql;
  readonly #now: () => Date;

  constructor({ sql, now }: { sql: Sql; now: () => Date }) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(SCHEMA);
  }

  /** Queues a follow of `taskHead`, or moves the attempt's queued one on to it. */
  request(input: { project: string; task: number; attempt: number; taskHead: string }): void {
    const [queued] = this.#sql.exec<FollowRow>(
      "SELECT * FROM follows WHERE task = ? AND attempt = ? AND status = 'queued'",
      input.task,
      input.attempt,
    );
    if (queued !== undefined) {
      this.#sql.exec("UPDATE follows SET task_head = ? WHERE id = ?", input.taskHead, queued.id);
      return;
    }
    this.#sql.exec(
      "INSERT INTO follows (project, task, attempt, task_head, status) VALUES (?, ?, ?, ?, 'queued')",
      input.project,
      input.task,
      input.attempt,
      input.taskHead,
    );
  }

  /** Queues `follow` to run again, from the same task head. */
  requeue(follow: StoredFollow): void {
    this.request({ ...follow, taskHead: follow.task_head });
  }

  get(id: number): StoredFollow | null {
    const [row] = this.#sql.exec<FollowRow>("SELECT * FROM follows WHERE id = ?", id);
    return row === undefined ? null : toFollow(row);
  }

  /** Queued follows whose attempt has none running, oldest first. */
  startable(): StoredFollow[] {
    return this.#sql
      .exec<FollowRow>(
        `SELECT * FROM follows AS f WHERE status = 'queued' AND NOT EXISTS (
           SELECT 1 FROM follows AS r WHERE r.task = f.task AND r.attempt = f.attempt AND r.status = 'running'
         ) ORDER BY id`,
      )
      .map(toFollow);
  }

  running(): number {
    const [{ n } = { n: 0 }] = this.#sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM follows WHERE status = 'running'",
    );
    return n;
  }

  /** Marks a queued follow running, naming its Workflow `instanceId(id)`. */
  start(id: number, instanceId: (id: number) => string): StoredFollow {
    this.#sql.exec(
      "UPDATE follows SET status = 'running', instance_id = ?, started_at = ? WHERE id = ?",
      instanceId(id),
      this.#now().getTime(),
      id,
    );
    return this.get(id) as StoredFollow;
  }

  /** Ends a follow as `done` or `stopped`. */
  end(id: number, status: "done" | "stopped"): void {
    this.#sql.exec("UPDATE follows SET status = ?, finished_at = ? WHERE id = ?", status, this.#now().getTime(), id);
  }
}

function toFollow(row: FollowRow): StoredFollow {
  return { ...row, status: row.status as FollowStatus };
}
