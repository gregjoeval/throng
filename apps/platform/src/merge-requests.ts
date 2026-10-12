// Merge requests and the project's merge queue, kept in the project Durable Object's SQLite next to
// tasks and attempts. See the merge queue spec's "Selection and the merge request" and "States and
// transitions" sections. This module holds the records and their state changes, each journalled;
// the task store decides who may act and when, and calls it inside its own transactions.
//
//   selection ─► pending ─(approved head's gate passed)─► queued ─(front)─► landing ─► merged
//   push in pending, queued or landing ─► needs_review; approve ─► pending
//   conflict, failed_checks or errored in queued or landing ─► pending (held until approved or pushed)
//   cancel, or the source attempt ending, from any open state ─► cancelled

import type { Sql } from "./task-store.ts";
import type { Actor } from "./tokens.ts";

export const MERGE_REQUEST_STATES = ["pending", "queued", "landing", "needs_review", "merged", "cancelled"] as const;
export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

/** States a merge request is open in; a task has at most one open merge request. */
export const OPEN_MERGE_REQUEST_STATES = ["pending", "queued", "landing", "needs_review"] as const;
/** States in the merge queue. */
const IN_QUEUE = ["queued", "landing"] as const;

export const DEQUEUE_REASONS = ["conflict", "failed_checks", "new_push", "cancelled", "errored"] as const;
export type DequeueReason = (typeof DEQUEUE_REASONS)[number];

/** The journal events of a merge request, as the spec names them. */
export type MergeRequestEvent =
  | "selected"
  | "approved"
  | "queued"
  | "landing"
  | "dequeued"
  | "needs_review"
  | "merged"
  | "cancelled";

/** Who acted: a user id, and the agent alias they acted under, if any. */
export interface ActedBy {
  user: string;
  agent: string | null;
}

/** Why a merge request last left the queue without landing. `details` carries the conflict, say. */
export interface Dequeue {
  reason: DequeueReason;
  at: string;
  details?: unknown;
}

export interface StoredMergeRequest {
  id: number;
  task: number;
  /** The source attempt's number within the task. */
  attempt: number;
  state: MergeRequestState;
  approved_head: string;
  approved_by: ActedBy;
  approved_at: string;
  /** When it last entered the queue, while queued or landing. */
  queued_at: string | null;
  /** Its 1-based place in the queue while queued or landing; the landing one is first. */
  position: number | null;
  last_dequeue: Dequeue | null;
  merge_sha: string | null;
  merged_at: string | null;
  created_at: string;
  created_by: ActedBy;
}

interface MergeRequestRow {
  id: number;
  task: number;
  attempt: number;
  state: MergeRequestState;
  approved_head: string;
  approved_by_user: string;
  approved_by_agent: string | null;
  approved_at: string;
  queued_at: string | null;
  /** 1 after a dequeue back to pending, until an approval or a push: it doesn't requeue on its own. */
  held: number;
  last_dequeue: string | null;
  merge_sha: string | null;
  merged_at: string | null;
  created_at: string;
  created_by_user: string;
  created_by_agent: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS merge_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    approved_head TEXT NOT NULL,
    approved_by_user TEXT NOT NULL,
    approved_by_agent TEXT,
    approved_at TEXT NOT NULL,
    queued_at TEXT,
    held INTEGER NOT NULL DEFAULT 0,
    last_dequeue TEXT,
    merge_sha TEXT,
    merged_at TEXT,
    created_at TEXT NOT NULL,
    created_by_user TEXT NOT NULL,
    created_by_agent TEXT
  )`,
  // One open merge request per task.
  `CREATE UNIQUE INDEX IF NOT EXISTS merge_requests_open_task ON merge_requests (task)
    WHERE state IN ('pending', 'queued', 'landing', 'needs_review')`,
];

export interface MergeRequestsDeps {
  sql: Sql;
  now: () => Date;
  /** Journals one merge request event, with the source attempt and any detail. */
  journal: (
    actor: Actor | null,
    kind: MergeRequestEvent,
    mr: StoredMergeRequest,
    detail: Record<string, unknown>,
  ) => void;
}

const sqlList = (states: readonly string[]) => states.map((s) => `'${s}'`).join(", ");
const OPEN = sqlList(OPEN_MERGE_REQUEST_STATES);
const QUEUE = sqlList(IN_QUEUE);

/** One project's merge requests. Checks no permission and no attempt state: the task store does. */
export class MergeRequests {
  readonly #sql: Sql;
  readonly #now: () => Date;
  readonly #journal: MergeRequestsDeps["journal"];

  constructor({ sql, now, journal }: MergeRequestsDeps) {
    this.#sql = sql;
    this.#now = now;
    this.#journal = journal;
    for (const statement of SCHEMA) sql.exec(statement);
  }

  /** The task's open merge request, if any. */
  open(task: number): StoredMergeRequest | null {
    const [row] = this.#sql.exec<MergeRequestRow>(
      `SELECT * FROM merge_requests WHERE task = ? AND state IN (${OPEN})`,
      task,
    );
    return row === undefined ? null : this.#toMergeRequest(row);
  }

  /** The task's latest merge request, open or not. */
  latest(task: number): StoredMergeRequest | null {
    const [row] = this.#sql.exec<MergeRequestRow>(
      "SELECT * FROM merge_requests WHERE task = ? ORDER BY id DESC LIMIT 1",
      task,
    );
    return row === undefined ? null : this.#toMergeRequest(row);
  }

  /** The latest merge request whose source is the attempt, open or not. */
  forAttempt(task: number, attempt: number): StoredMergeRequest | null {
    const [row] = this.#sql.exec<MergeRequestRow>(
      "SELECT * FROM merge_requests WHERE task = ? AND attempt = ? ORDER BY id DESC LIMIT 1",
      task,
      attempt,
    );
    return row === undefined ? null : this.#toMergeRequest(row);
  }

  /** Whether the merge request is held in `pending` after a dequeue, waiting for an approval or a push. */
  held(mr: StoredMergeRequest): boolean {
    const [row] = this.#sql.exec<{ held: number }>("SELECT held FROM merge_requests WHERE id = ?", mr.id);
    return row?.held === 1;
  }

  /** The merge queue: landing first, then queued, first in first out. */
  queue(): StoredMergeRequest[] {
    return this.#sql
      .exec<MergeRequestRow>(`SELECT * FROM merge_requests WHERE state IN (${QUEUE}) ORDER BY queued_at, id`)
      .map((row, i) => this.#toMergeRequest(row, i + 1));
  }

  /** Creates a task's merge request from a selection, approving `head`, and moves it to `pending`. */
  select(actor: Actor, input: { task: number; attempt: number; head: string }): StoredMergeRequest {
    const at = this.#stamp();
    const [row] = this.#sql.exec<MergeRequestRow>(
      `INSERT INTO merge_requests (task, attempt, state, approved_head, approved_by_user, approved_by_agent,
         approved_at, created_at, created_by_user, created_by_agent)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      input.task,
      input.attempt,
      input.head,
      actor.user.id,
      actor.agent,
      at,
      at,
      actor.user.id,
      actor.agent,
    );
    if (row === undefined) throw new Error("merge request insert returned no row");
    const mr = this.#toMergeRequest(row);
    this.#journal(actor, "selected", mr, {});
    this.#journal(actor, "approved", mr, { head: input.head });
    return mr;
  }

  /** Approves `head`, moving the merge request to `pending` and releasing any hold. */
  approve(actor: Actor, mr: StoredMergeRequest, head: string): StoredMergeRequest {
    this.#sql.exec(
      `UPDATE merge_requests SET state = 'pending', approved_head = ?, approved_by_user = ?, approved_by_agent = ?,
         approved_at = ?, held = 0 WHERE id = ?`,
      head,
      actor.user.id,
      actor.agent,
      this.#stamp(),
      mr.id,
    );
    this.#journal(actor, "approved", mr, { head, from: mr.state });
    return this.#get(mr.id);
  }

  /** pending → queued, at the back of the queue. */
  enqueue(actor: Actor | null, mr: StoredMergeRequest): StoredMergeRequest {
    this.#sql.exec("UPDATE merge_requests SET state = 'queued', queued_at = ? WHERE id = ?", this.#stamp(), mr.id);
    this.#journal(actor, "queued", mr, { head: mr.approved_head });
    return this.#get(mr.id);
  }

  /** queued → landing. */
  startLanding(actor: Actor | null, mr: StoredMergeRequest): StoredMergeRequest {
    this.#sql.exec("UPDATE merge_requests SET state = 'landing' WHERE id = ?", mr.id);
    this.#journal(actor, "landing", mr, { head: mr.approved_head });
    return this.#get(mr.id);
  }

  /**
   * Takes a queued or landing merge request out of the queue for `reason`, recording it as
   * `last_dequeue`, and moves it to `to`: `pending` (held) for conflict, failed checks and errors,
   * `needs_review` for a new push, `cancelled` for a cancel.
   */
  dequeue(
    actor: Actor | null,
    mr: StoredMergeRequest,
    reason: DequeueReason,
    to: "pending" | "needs_review" | "cancelled",
    details?: unknown,
  ): StoredMergeRequest {
    const dequeue: Dequeue = { reason, at: this.#stamp(), ...(details === undefined ? {} : { details }) };
    this.#sql.exec(
      "UPDATE merge_requests SET state = ?, queued_at = NULL, last_dequeue = ?, held = ? WHERE id = ?",
      to,
      JSON.stringify(dequeue),
      to === "pending" ? 1 : 0,
      mr.id,
    );
    this.#journal(actor, "dequeued", mr, { reason, from: mr.state });
    if (to !== "pending") this.#journal(actor, to, mr, {});
    return this.#get(mr.id);
  }

  /** pending or needs_review → needs_review or cancelled, outside the queue. */
  move(
    actor: Actor | null,
    mr: StoredMergeRequest,
    to: "needs_review" | "cancelled",
    detail: Record<string, unknown> = {},
  ) {
    this.#sql.exec("UPDATE merge_requests SET state = ?, queued_at = NULL, held = 0 WHERE id = ?", to, mr.id);
    this.#journal(actor, to, mr, { from: mr.state, ...detail });
    return this.#get(mr.id);
  }

  /** landing → merged, at `sha`. */
  merged(actor: Actor | null, mr: StoredMergeRequest, sha: string): StoredMergeRequest {
    this.#sql.exec(
      "UPDATE merge_requests SET state = 'merged', queued_at = NULL, merge_sha = ?, merged_at = ? WHERE id = ?",
      sha,
      this.#stamp(),
      mr.id,
    );
    this.#journal(actor, "merged", mr, { sha });
    return this.#get(mr.id);
  }

  #get(id: number): StoredMergeRequest {
    const [row] = this.#sql.exec<MergeRequestRow>("SELECT * FROM merge_requests WHERE id = ?", id);
    if (row === undefined) throw new Error(`no merge request ${id}`);
    return this.#toMergeRequest(row);
  }

  #toMergeRequest(row: MergeRequestRow, position?: number): StoredMergeRequest {
    let place: number | null = position ?? null;
    if (place === null && (IN_QUEUE as readonly string[]).includes(row.state)) {
      const [ahead] = this.#sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM merge_requests WHERE state IN (${QUEUE})
           AND (queued_at < ? OR (queued_at = ? AND id < ?))`,
        row.queued_at,
        row.queued_at,
        row.id,
      );
      place = (ahead?.n ?? 0) + 1;
    }
    return {
      id: row.id,
      task: row.task,
      attempt: row.attempt,
      state: row.state,
      approved_head: row.approved_head,
      approved_by: { user: row.approved_by_user, agent: row.approved_by_agent },
      approved_at: row.approved_at,
      queued_at: row.queued_at,
      position: place,
      last_dequeue: row.last_dequeue === null ? null : (JSON.parse(row.last_dequeue) as Dequeue),
      merge_sha: row.merge_sha,
      merged_at: row.merged_at,
      created_at: row.created_at,
      created_by: { user: row.created_by_user, agent: row.created_by_agent },
    };
  }

  #stamp(): string {
    return this.#now().toISOString();
  }
}
