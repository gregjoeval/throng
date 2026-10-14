// Merge requests and the project's merge queue, kept in the project Durable Object's SQLite next to
// tasks and attempts. See the merge queue spec's "Selection and the merge request" and "States and
// transitions" sections. This module holds the records and their state changes, each journalled;
// the task store decides who may act and when, and calls it inside its own transactions.
//
//   selection ─► pending ─(approved head's gate passed)─► queued ─(front)─► landing ─► merged
//   push in pending, queued or landing ─► needs_review; approve ─► pending
//   conflict, failed_checks or errored in queued or landing ─► pending (held until approved or pushed)
//   cancel, or the source attempt ending, from any open state ─► cancelled

import { normaliseDequeue } from "./casing.ts";
import { addColumns, renameColumns } from "./columns.ts";
import type { ConflictDetails } from "./conflicts.ts";
import type { LegacyFailedCheck } from "./landing.ts";
import type { Sql } from "./task-store.ts";
import type { Actor } from "./tokens.ts";

export const MERGE_REQUEST_STATES = ["pending", "queued", "landing", "needsReview", "merged", "cancelled"] as const;
export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

/** States a merge request is open in; a task has at most one open merge request. */
export const OPEN_MERGE_REQUEST_STATES = ["pending", "queued", "landing", "needsReview"] as const;
/** States in the merge queue. */
const IN_QUEUE = ["queued", "landing"] as const;

export const DEQUEUE_REASONS = ["conflict", "failedChecks", "newPush", "cancelled", "errored"] as const;
export type DequeueReason = (typeof DEQUEUE_REASONS)[number];

/** The journal events of a merge request, as the spec names them. */
export type MergeRequestEvent =
  | "selected"
  | "approved"
  | "queued"
  | "landing"
  | "dequeued"
  | "needsReview"
  | "merged"
  | "cancelled";

/** Who acted: a user id, and the alias they acted under, if any. */
export interface ActedBy {
  user: string;
  alias: string | null;
}

/** The reasons a landing's run dequeues its merge request: its merge conflicted, its gate failed, or it errored. */
export type LandingDequeueReason = Extract<DequeueReason, "conflict" | "failedChecks" | "errored">;

/**
 * Why a merge request left the queue without landing: a landing's run that conflicted, failed its
 * gate or errored, which holds the details; or a new push or a cancel, which carry none.
 */
export type DequeueCause =
  | { reason: LandingDequeueReason; run: number }
  | { reason: "newPush" }
  | { reason: "cancelled" };

/**
 * The details a dequeue kept itself before its landing was a run, which a dequeue stored since
 * leaves to its run: the conflict, the checks that failed the retest, or the step that errored.
 */
export type LegacyDequeueDetails =
  | ConflictDetails
  | { checks: LegacyFailedCheck[]; error?: string }
  | { step: string; error: string };

/**
 * A merge request's last dequeue: why, the landing's run behind it (null for a new push or a cancel,
 * and for a dequeue whose landing ran before landings were runs), and when.
 */
export interface Dequeue {
  reason: DequeueReason;
  run: number | null;
  at: string;
  /** Kept by a dequeue stored before landings were runs. */
  details?: LegacyDequeueDetails;
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
  approved_by_alias: string | null;
  approved_at: string;
  queued_at: string | null;
  /** 1 after a dequeue back to pending, until an approval or a push: it doesn't requeue on its own. */
  held: number;
  last_dequeue: string | null;
  /** 0 until a push to the source attempt has told its pusher of `last_dequeue`. */
  dequeue_seen: number;
  merge_sha: string | null;
  merged_at: string | null;
  created_at: string;
  created_by_user: string;
  created_by_alias: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS merge_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    approved_head TEXT NOT NULL,
    approved_by_user TEXT NOT NULL,
    approved_by_alias TEXT,
    approved_at TEXT NOT NULL,
    queued_at TEXT,
    held INTEGER NOT NULL DEFAULT 0,
    last_dequeue TEXT,
    dequeue_seen INTEGER NOT NULL DEFAULT 1,
    merge_sha TEXT,
    merged_at TEXT,
    created_at TEXT NOT NULL,
    created_by_user TEXT NOT NULL,
    created_by_alias TEXT
  )`,
  // One open merge request per task.
  `CREATE UNIQUE INDEX IF NOT EXISTS merge_requests_open_task ON merge_requests (task)
    WHERE state IN ('pending', 'queued', 'landing', 'needsReview')`,
];
/**
 * Columns `merge_requests` gained after its first version: whether the project owner, as themselves
 * and not under an alias, made the latest approval, so landing it is the owner's merge.
 */
const MERGE_REQUEST_COLUMNS = ["approved_by_owner INTEGER NOT NULL DEFAULT 0"];
/** `merge_requests` columns named before an actor's alias was called an alias. */
const RENAMES = [
  ["approved_by_agent", "approved_by_alias"],
  ["created_by_agent", "created_by_alias"],
] as const;

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

/** A stored dequeue, read in camelCase whenever it was stored; one stored before landings were runs names none. */
function storedDequeue(json: string): Dequeue {
  const dequeue = normaliseDequeue(JSON.parse(json) as Omit<Dequeue, "run"> & { run?: number | null });
  return { ...dequeue, run: dequeue.run ?? null };
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
    // The open-task index from before states were camelCase lists `needsReview`: rebuild it.
    const [index] = sql.exec<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'merge_requests_open_task'",
    );
    if (index?.sql.includes("needs_review") === true) sql.exec("DROP INDEX merge_requests_open_task");
    for (const statement of SCHEMA) sql.exec(statement);
    renameColumns(sql, "merge_requests", RENAMES);
    addColumns(sql, "merge_requests", MERGE_REQUEST_COLUMNS);
  }

  /** Whether the project owner made the merge request's latest approval: landing it is the owner's merge. */
  ownerApproved(mr: StoredMergeRequest): boolean {
    const [row] = this.#sql.exec<{ approved_by_owner: number }>(
      "SELECT approved_by_owner FROM merge_requests WHERE id = ?",
      mr.id,
    );
    return row?.approved_by_owner === 1;
  }

  /** The merge request with id `id`, if any. */
  get(id: number): StoredMergeRequest | null {
    const [row] = this.#sql.exec<MergeRequestRow>("SELECT * FROM merge_requests WHERE id = ?", id);
    return row === undefined ? null : this.#toMergeRequest(row);
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

  /** Its last dequeue if no push has reported it yet, marking it reported; otherwise null. */
  takeUnseenDequeue(mr: StoredMergeRequest): Dequeue | null {
    const [row] = this.#sql.exec<{ last_dequeue: string }>(
      `UPDATE merge_requests SET dequeue_seen = 1 WHERE id = ? AND dequeue_seen = 0 AND last_dequeue IS NOT NULL
       RETURNING last_dequeue`,
      mr.id,
    );
    return row === undefined ? null : storedDequeue(row.last_dequeue);
  }

  /** The merge queue: landing first, then queued, first in first out. */
  queue(): StoredMergeRequest[] {
    return this.#sql
      .exec<MergeRequestRow>(`SELECT * FROM merge_requests WHERE state IN (${QUEUE}) ORDER BY queued_at, id`)
      .map((row, i) => this.#toMergeRequest(row, i + 1));
  }

  /**
   * Creates a task's merge request from a selection, approving `head`, and moves it to `pending`.
   * `byOwner` says whether `actor` is the project's owner acting as themselves, not an alias.
   */
  select(actor: Actor, input: { task: number; attempt: number; head: string; byOwner: boolean }): StoredMergeRequest {
    const at = this.#stamp();
    const [row] = this.#sql.exec<MergeRequestRow>(
      `INSERT INTO merge_requests (task, attempt, state, approved_head, approved_by_user, approved_by_alias,
         approved_by_owner, approved_at, created_at, created_by_user, created_by_alias)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      input.task,
      input.attempt,
      input.head,
      actor.user.id,
      actor.alias,
      input.byOwner ? 1 : 0,
      at,
      at,
      actor.user.id,
      actor.alias,
    );
    if (row === undefined) throw new Error("merge request insert returned no row");
    const mr = this.#toMergeRequest(row);
    this.#journal(actor, "selected", mr, {});
    this.#journal(actor, "approved", mr, { head: input.head });
    return mr;
  }

  /**
   * Approves `head`, moving the merge request to `pending` and releasing any hold. `byOwner` says
   * whether `actor` is the project's owner acting as themselves, not an alias.
   */
  approve(actor: Actor, mr: StoredMergeRequest, head: string, byOwner: boolean): StoredMergeRequest {
    this.#sql.exec(
      `UPDATE merge_requests SET state = 'pending', approved_head = ?, approved_by_user = ?, approved_by_alias = ?,
         approved_by_owner = ?, approved_at = ?, held = 0 WHERE id = ?`,
      head,
      actor.user.id,
      actor.alias,
      byOwner ? 1 : 0,
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
   * Takes a queued or landing merge request out of the queue for `cause`, recording it as
   * `last_dequeue`, and moves it to `to`: `pending` (held) for conflict, failed checks and errors,
   * `needsReview` for a new push, `cancelled` for a cancel.
   */
  dequeue(
    actor: Actor | null,
    mr: StoredMergeRequest,
    cause: DequeueCause,
    to: "pending" | "needsReview" | "cancelled",
  ): StoredMergeRequest {
    const { reason } = cause;
    const dequeue: Dequeue = { reason, run: "run" in cause ? cause.run : null, at: this.#stamp() };
    this.#sql.exec(
      "UPDATE merge_requests SET state = ?, queued_at = NULL, last_dequeue = ?, dequeue_seen = 0, held = ? WHERE id = ?",
      to,
      JSON.stringify(dequeue),
      to === "pending" ? 1 : 0,
      mr.id,
    );
    this.#journal(actor, "dequeued", mr, { reason, from: mr.state, ...("run" in cause ? { run: cause.run } : {}) });
    if (to !== "pending") this.#journal(actor, to, mr, {});
    return this.#get(mr.id);
  }

  /** pending or needs_review → needs_review or cancelled, outside the queue. */
  move(
    actor: Actor | null,
    mr: StoredMergeRequest,
    to: "needsReview" | "cancelled",
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
      approved_by: { user: row.approved_by_user, alias: row.approved_by_alias },
      approved_at: row.approved_at,
      queued_at: row.queued_at,
      position: place,
      last_dequeue: row.last_dequeue === null ? null : storedDequeue(row.last_dequeue),
      merge_sha: row.merge_sha,
      merged_at: row.merged_at,
      created_at: row.created_at,
      created_by: { user: row.created_by_user, alias: row.created_by_alias },
    };
  }

  #stamp(): string {
    return this.#now().toISOString();
  }
}
