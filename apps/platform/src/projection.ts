// The D1 projection of tasks and attempts: an eventually consistent copy of every project's tasks
// and attempts, for listings across projects ("my attempts everywhere").
//
// The project's Durable Object stays the source of truth, and nothing reads the projection to decide
// a write. SQLite triggers on its `tasks` and `attempts` tables add a row to its outbox for every
// change to a listed field, in the same transaction as the change. Publishing snapshots the changed
// rows, upserts them into D1, then removes the outbox rows it covered. Each row carries its latest
// outbox id as its version, and D1 only replaces a row with a newer version, so deliveries that
// arrive late, twice or out of order leave the newest one standing.
//
// A delivery covers at most `PROJECTION_BATCH` changes, sent as one D1 batch, so a large backfill
// goes out over several bounded deliveries. Read by `my-listings.ts`.

import type { AttemptState, Sql, TaskState } from "./task-store.ts";
import type { BatchDatabase } from "./users.ts";

/** The most outbox rows one delivery covers: one statement each, at most, in its one D1 batch. */
export const PROJECTION_BATCH = 50;
/** How long the first retry after a failed delivery waits; each further failure doubles it. */
export const PROJECTION_RETRY_MS = 60_000;
/** The longest a retry waits. */
export const MAX_PROJECTION_RETRY_MS = 60 * 60_000;

const SCHEMA = [
  // AUTOINCREMENT keeps ids rising after rows are removed, so they can serve as versions.
  `CREATE TABLE IF NOT EXISTS projection_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task INTEGER NOT NULL,
    attempt INTEGER
  )`,
  `CREATE TRIGGER IF NOT EXISTS projection_task_inserted AFTER INSERT ON tasks
    BEGIN INSERT INTO projection_outbox (task) VALUES (NEW.number); END`,
  `CREATE TRIGGER IF NOT EXISTS projection_task_updated
    AFTER UPDATE OF title, creator, state, created_at, closed_at ON tasks
    BEGIN INSERT INTO projection_outbox (task) VALUES (NEW.number); END`,
  `CREATE TRIGGER IF NOT EXISTS projection_attempt_inserted AFTER INSERT ON attempts
    BEGIN INSERT INTO projection_outbox (task, attempt) VALUES (NEW.task, NEW.number); END`,
  `CREATE TRIGGER IF NOT EXISTS projection_attempt_updated
    AFTER UPDATE OF author, state, created_at, closed_at ON attempts
    BEGIN INSERT INTO projection_outbox (task, attempt) VALUES (NEW.task, NEW.number); END`,
];

/** A task as the projection holds it. */
export interface StoredProjectedTask {
  project_id: string;
  number: number;
  title: string;
  creator_id: string;
  state: TaskState;
  created_at: string;
  closed_at: string | null;
  version: number;
}

/** An attempt as the projection holds it. */
export interface StoredProjectedAttempt {
  project_id: string;
  task: number;
  number: number;
  author_id: string;
  state: AttemptState;
  created_at: string;
  closed_at: string | null;
  version: number;
}

/**
 * One delivery: snapshots of the rows changed up to outbox id `through`, each versioned by its latest
 * change, which may be past `through`.
 */
export interface ProjectionBatch {
  through: number;
  tasks: StoredProjectedTask[];
  attempts: StoredProjectedAttempt[];
}

/**
 * Creates the outbox and its triggers. A store that had tasks before the projection existed queues
 * all of them, so its first publish backfills D1.
 */
export function migrateProjection(sql: Sql): void {
  const fresh =
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_outbox'").length === 0;
  for (const statement of SCHEMA) sql.exec(statement);
  if (!fresh) return;
  sql.exec("INSERT INTO projection_outbox (task) SELECT number FROM tasks ORDER BY number");
  sql.exec("INSERT INTO projection_outbox (task, attempt) SELECT task, number FROM attempts ORDER BY task, number");
}

/**
 * A project Durable Object's side of the projection: what to publish, and publishing it. Expects
 * `migrateProjection` to have run on its SQLite.
 */
export class Projection {
  readonly #sql: Sql;
  /** Failed deliveries in a row, which space out the retries. In memory: an evicted object starts over. */
  #failures = 0;

  constructor({ sql }: { sql: Sql }) {
    this.#sql = sql;
  }

  /** Whether any change is still to be published. */
  hasChanges(): boolean {
    return this.#sql.exec("SELECT 1 FROM projection_outbox LIMIT 1").length > 0;
  }

  /**
   * A snapshot of the rows behind the oldest `limit` changes not yet acknowledged, or null when there
   * are none. Each row is read as it is now and versioned by its latest change, so a row's state and
   * version always match. A task's creation queues before its attempts', so it is delivered first.
   */
  pending(project: string, limit = PROJECTION_BATCH): ProjectionBatch | null {
    const through = this.#sql.exec<{ id: number | null }>(
      "SELECT MAX(id) AS id FROM (SELECT id FROM projection_outbox ORDER BY id LIMIT ?)",
      limit,
    )[0]?.id;
    if (through === undefined || through === null) return null;
    const tasks = this.#sql.exec<Omit<StoredProjectedTask, "project_id">>(
      `SELECT t.number, t.title, t.creator AS creator_id, t.state, t.created_at, t.closed_at, MAX(o.id) AS version
       FROM projection_outbox o JOIN tasks t ON t.number = o.task
       WHERE o.attempt IS NULL
         AND t.number IN (SELECT task FROM projection_outbox WHERE attempt IS NULL AND id <= ?)
       GROUP BY t.number ORDER BY t.number`,
      through,
    );
    const attempts = this.#sql.exec<Omit<StoredProjectedAttempt, "project_id">>(
      `SELECT a.task, a.number, a.author AS author_id, a.state, a.created_at, a.closed_at, MAX(o.id) AS version
       FROM projection_outbox o JOIN attempts a ON a.task = o.task AND a.number = o.attempt
       WHERE (a.task, a.number) IN (SELECT task, attempt FROM projection_outbox WHERE id <= ?)
       GROUP BY a.task, a.number ORDER BY a.task, a.number`,
      through,
    );
    return {
      through,
      tasks: tasks.map((t) => ({ project_id: project, ...t })),
      attempts: attempts.map((a) => ({ project_id: project, ...a })),
    };
  }

  /** Forgets the changes a delivered batch covered. */
  acknowledge(batch: ProjectionBatch): void {
    this.#sql.exec("DELETE FROM projection_outbox WHERE id <= ?", batch.through);
  }

  /**
   * Delivers the oldest pending changes to D1 and acknowledges them. Answers how many milliseconds
   * to wait before publishing again: 0 while changes remain, a growing back-off after a failed
   * delivery (whose changes stay pending), and null once nothing is left.
   */
  async publish(db: BatchDatabase, project: string): Promise<number | null> {
    const batch = this.pending(project);
    if (batch === null) return null;
    try {
      await deliver(db, batch);
    } catch (error) {
      this.#failures++;
      console.error({ event: "projection.failed", project, failures: this.#failures, error: String(error) });
      return Math.min(PROJECTION_RETRY_MS * 2 ** (this.#failures - 1), MAX_PROJECTION_RETRY_MS);
    }
    this.#failures = 0;
    this.acknowledge(batch);
    return this.hasChanges() ? 0 : null;
  }
}

/**
 * Upserts a batch's rows into D1, each only over an older version, in one `batch`: one round trip and
 * one transaction, so a delivery lands whole or not at all. Tasks go first, so an attempt's task is in
 * D1 once the attempt is.
 */
export async function deliver(db: BatchDatabase, batch: ProjectionBatch): Promise<void> {
  const tasks = batch.tasks.map((t) =>
    db
      .prepare(
        `INSERT INTO projected_tasks (project_id, number, title, creator_id, state, created_at, closed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, number) DO UPDATE SET
           title = excluded.title, creator_id = excluded.creator_id, state = excluded.state,
           created_at = excluded.created_at, closed_at = excluded.closed_at, version = excluded.version
         WHERE excluded.version > projected_tasks.version`,
      )
      .bind(t.project_id, t.number, t.title, t.creator_id, t.state, t.created_at, t.closed_at, t.version),
  );
  const attempts = batch.attempts.map((a) =>
    db
      .prepare(
        `INSERT INTO projected_attempts (project_id, task, number, author_id, state, created_at, closed_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, task, number) DO UPDATE SET
           author_id = excluded.author_id, state = excluded.state,
           created_at = excluded.created_at, closed_at = excluded.closed_at, version = excluded.version
         WHERE excluded.version > projected_attempts.version`,
      )
      .bind(a.project_id, a.task, a.number, a.author_id, a.state, a.created_at, a.closed_at, a.version),
  );
  const statements = [...tasks, ...attempts];
  if (statements.length > 0) await db.batch(statements);
}
