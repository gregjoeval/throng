// The D1 projection of tasks and attempts: an eventually consistent copy of every project's tasks
// and attempts, for listings across projects ("my attempts everywhere").
//
// The project's Durable Object stays the source of truth, and nothing reads the projection to decide
// a write. SQLite triggers on its `tasks` and `attempts` tables add a row to its outbox for every
// change to a listed field, in the same transaction as the change. Publishing snapshots the changed
// rows, upserts them into D1, then removes the outbox rows it covered. Each row carries its latest
// outbox id as its version, and D1 only replaces a row with a newer version, so deliveries that
// arrive late, twice or out of order leave the newest one standing.

import { attemptRef, taskRef } from "./task-refs.ts";
import type { AttemptState, Sql, TaskState } from "./task-store.ts";
import type { Actor } from "./tokens.ts";
import type { Database } from "./users.ts";

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

/** One delivery: snapshots of every row changed since the last acknowledged one, up to outbox id `through`. */
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

/** A project Durable Object's side of the projection: what to publish, and publishing it. */
export class Projection {
  readonly #sql: Sql;

  constructor({ sql }: { sql: Sql }) {
    this.#sql = sql;
    migrateProjection(sql);
  }

  /** Whether any change is still to be published. */
  hasChanges(): boolean {
    return this.#sql.exec("SELECT 1 FROM projection_outbox LIMIT 1").length > 0;
  }

  /** A snapshot of every row changed since the last acknowledged batch, or null when nothing has. */
  pending(project: string): ProjectionBatch | null {
    const through = this.#sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM projection_outbox")[0]?.id;
    if (through === undefined || through === null) return null;
    const tasks = this.#sql.exec<Omit<StoredProjectedTask, "project_id">>(
      `SELECT t.number, t.title, t.creator AS creator_id, t.state, t.created_at, t.closed_at, MAX(o.id) AS version
       FROM projection_outbox o JOIN tasks t ON t.number = o.task
       WHERE o.attempt IS NULL AND o.id <= ? GROUP BY t.number ORDER BY t.number`,
      through,
    );
    const attempts = this.#sql.exec<Omit<StoredProjectedAttempt, "project_id">>(
      `SELECT a.task, a.number, a.author AS author_id, a.state, a.created_at, a.closed_at, MAX(o.id) AS version
       FROM projection_outbox o JOIN attempts a ON a.task = o.task AND a.number = o.attempt
       WHERE o.id <= ? GROUP BY a.task, a.number ORDER BY a.task, a.number`,
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
   * Delivers everything pending to D1 and acknowledges it. A failed delivery throws and keeps the
   * changes pending, so the next publish delivers them again. False when nothing was pending.
   */
  async publish(db: Database, project: string): Promise<boolean> {
    const batch = this.pending(project);
    if (batch === null) return false;
    await deliver(db, batch);
    this.acknowledge(batch);
    return true;
  }
}

/**
 * Upserts a batch's rows into D1, each only over an older version. Tasks go first, so an attempt's
 * task is in D1 once the attempt is.
 */
export async function deliver(db: Database, batch: ProjectionBatch): Promise<void> {
  await Promise.all(
    batch.tasks.map((t) =>
      db
        .prepare(
          `INSERT INTO projected_tasks (project_id, number, title, creator_id, state, created_at, closed_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, number) DO UPDATE SET
             title = excluded.title, creator_id = excluded.creator_id, state = excluded.state,
             created_at = excluded.created_at, closed_at = excluded.closed_at, version = excluded.version
           WHERE excluded.version > projected_tasks.version`,
        )
        .bind(t.project_id, t.number, t.title, t.creator_id, t.state, t.created_at, t.closed_at, t.version)
        .all(),
    ),
  );
  await Promise.all(
    batch.attempts.map((a) =>
      db
        .prepare(
          `INSERT INTO projected_attempts (project_id, task, number, author_id, state, created_at, closed_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, task, number) DO UPDATE SET
             author_id = excluded.author_id, state = excluded.state,
             created_at = excluded.created_at, closed_at = excluded.closed_at, version = excluded.version
           WHERE excluded.version > projected_attempts.version`,
        )
        .bind(a.project_id, a.task, a.number, a.author_id, a.state, a.created_at, a.closed_at, a.version)
        .all(),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Listings, read from D1

interface UserRef {
  id: string;
  handle: string;
}

/** The project a listed task or attempt belongs to, addressed as `owner/project` by handles. */
export interface ListedProject {
  id: string;
  handle: string;
  owner: UserRef;
}

/** A task in a listing across projects. */
export interface MyTask {
  project: ListedProject;
  ref: string;
  number: number;
  title: string;
  state: TaskState;
  creator: UserRef;
  createdAt: string;
  closedAt: string | null;
}

/** An attempt in a listing across projects. */
export interface MyAttempt {
  project: ListedProject;
  ref: string;
  task: { ref: string; number: number; title: string };
  number: number;
  state: AttemptState;
  author: UserRef;
  createdAt: string;
  closedAt: string | null;
}

interface ProjectColumns {
  project_id: string;
  project_handle: string;
  owner_id: string;
  owner_handle: string;
}

interface TaskListingRow extends ProjectColumns, Omit<StoredProjectedTask, "version"> {
  creator_handle: string;
}

interface AttemptListingRow extends ProjectColumns, Omit<StoredProjectedAttempt, "version"> {
  task_title: string;
  author_handle: string;
}

const PROJECT_COLUMNS = "p.id AS project_id, p.handle AS project_handle, o.id AS owner_id, o.handle AS owner_handle";

function listedProject(row: ProjectColumns): ListedProject {
  return { id: row.project_id, handle: row.project_handle, owner: { id: row.owner_id, handle: row.owner_handle } };
}

/**
 * The caller's tasks and attempts across every project, from the projection: they trail the
 * projects' Durable Objects by a moment. Obsolete ones are left out unless `state` asks for them.
 */
export function projectionService({ db }: { db: Database }) {
  return {
    /** The tasks the caller's user created, newest first. */
    async tasks(actor: Actor, input: { state?: TaskState | undefined }): Promise<MyTask[]> {
      const { results } = await db
        .prepare(
          `SELECT t.*, ${PROJECT_COLUMNS}, c.handle AS creator_handle
           FROM projected_tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN users o ON o.id = p.owner_id
           JOIN users c ON c.id = t.creator_id
           WHERE t.creator_id = ? AND ${stateFilter("t", input.state)}
           ORDER BY t.created_at DESC, p.id, t.number DESC`,
        )
        .bind(actor.user.id, ...stateValue(input.state))
        .all<TaskListingRow>();
      return results.map((row) => ({
        project: listedProject(row),
        ref: taskRef(row.number),
        number: row.number,
        title: row.title,
        state: row.state,
        creator: { id: row.creator_id, handle: row.creator_handle },
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
    },

    /** The attempts the caller's user authors, newest first. */
    async attempts(actor: Actor, input: { state?: AttemptState | undefined }): Promise<MyAttempt[]> {
      const { results } = await db
        .prepare(
          `SELECT a.*, ${PROJECT_COLUMNS}, t.title AS task_title, u.handle AS author_handle
           FROM projected_attempts a
           JOIN projected_tasks t ON t.project_id = a.project_id AND t.number = a.task
           JOIN projects p ON p.id = a.project_id
           JOIN users o ON o.id = p.owner_id
           JOIN users u ON u.id = a.author_id
           WHERE a.author_id = ? AND ${stateFilter("a", input.state)}
           ORDER BY a.created_at DESC, p.id, a.task DESC, a.number DESC`,
        )
        .bind(actor.user.id, ...stateValue(input.state))
        .all<AttemptListingRow>();
      return results.map((row) => ({
        project: listedProject(row),
        ref: attemptRef(row.task, row.number),
        task: { ref: taskRef(row.task), number: row.task, title: row.task_title },
        number: row.number,
        state: row.state,
        author: { id: row.author_id, handle: row.author_handle },
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
    },
  };
}

export type ProjectionService = ReturnType<typeof projectionService>;

/** Obsolete rows are left out of a listing unless its `state` asks for them. */
function stateFilter(table: string, state: string | undefined): string {
  return state === undefined ? `${table}.state != 'obsolete'` : `${table}.state = ?`;
}

function stateValue(state: string | undefined): string[] {
  return state === undefined ? [] : [state];
}
