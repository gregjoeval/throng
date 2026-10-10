// Tasks and attempts, kept in the project Durable Object's SQLite: the source of truth for both,
// their per-project counters and the journal of their transitions. This module holds the state
// machine and the P0 permission rules; `ProjectCoordinator` runs it inside the Durable Object, and
// tests run it over local SQLite. The `tasks.ts` service resolves projects and calls it.
//
// Users are stored by id only, so renaming a handle never rewrites history; the service resolves
// handles when it answers.

import { CONFIG_PATH, loadConfig, type ConfigResult } from "./config.ts";
import { ServiceError, type ErrorCode } from "./errors.ts";
import { forkRepo, originRepo, type Repos } from "./repos.ts";
import type { Actor } from "./tokens.ts";

/** Active attempts a task may have when neither the project config nor the task overrides it. */
export const DEFAULT_ATTEMPT_LIMIT = 10;

export const TASK_STATES = ["open", "closed", "obsolete"] as const;
export const ATTEMPT_STATES = ["draft", "open", "merged", "closed", "obsolete"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** Draft and open attempts are active: they have a fork and a claim, and count toward the cap. */
const ACTIVE = ["draft", "open"] as const;

export interface StoredTask {
  number: number;
  title: string;
  body: string;
  /** The creator's user id. */
  creator: string;
  state: TaskState;
  created_at: string;
  closed_at: string | null;
  /** The user id that closed (or made obsolete) the task. */
  closed_by: string | null;
  attempt_limit: number | null;
}

export interface StoredAttempt {
  task: number;
  number: number;
  /** The author's user id. */
  author: string;
  state: AttemptState;
  /** The logical fork name, `t42a3`; its repo is `<projectId>-t42a3`. */
  fork: string;
  branch: string | null;
  note: string;
  created_at: string;
  closed_at: string | null;
  merged_sha: string | null;
  archived_sha: string | null;
}

/** The project a call acts in: its id and its owner's user id. */
export interface ProjectContext {
  id: string;
  owner: string;
}

/** Journal events for tasks and attempts, as the spec names them. */
export type TaskEvent =
  | "created"
  | "opened"
  | "returned_to_draft"
  | "closed"
  | "reopened"
  | "handed_off"
  | "merged"
  | "made_obsolete"
  | "restored"
  | "pushed";

/** The slice of SQLite the store needs: Durable Object storage in production, `node:sqlite` in tests. */
export interface Sql {
  /** Runs one statement and returns its rows. */
  exec<T>(query: string, ...bindings: unknown[]): T[];
  /** Runs `fn` atomically: its writes all commit, or none do if it throws. */
  transaction<T>(fn: () => T): T;
}

// ---------------------------------------------------------------------------------------------
// References

const TASK_REF = /^t?([1-9]\d*)$/;
const ATTEMPT_REF = /^t?([1-9]\d*)a([1-9]\d*)$/;
const RESERVED_BRANCH = /^t([1-9]\d*)\//;

/** A task reference, `t42` or `42`, as its number; null when it isn't one. */
export function parseTaskRef(ref: string): number | null {
  const match = TASK_REF.exec(ref);
  return match === null ? null : safeNumber(match[1]);
}

/** An attempt reference, `t42a3` (or `42a3`), as its task and attempt numbers; null when it isn't one. */
export function parseAttemptRef(ref: string): { task: number; number: number } | null {
  const match = ATTEMPT_REF.exec(ref);
  if (match === null) return null;
  const task = safeNumber(match[1]);
  const number = safeNumber(match[2]);
  return task === null || number === null ? null : { task, number };
}

export function taskRef(task: number): string {
  return `t${task}`;
}

export function attemptRef(task: number, number: number): string {
  return `t${task}a${number}`;
}

/**
 * The task a branch is reserved for: `t<n>/<anything>` belongs to task `t<n>` and never creates a
 * task of its own. Null for any other branch.
 */
export function reservedTask(branch: string): number | null {
  const match = RESERVED_BRANCH.exec(branch);
  return match === null ? null : safeNumber(match[1]);
}

function safeNumber(digits: string | undefined): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Inputs

export interface CreateTaskInput {
  title: string;
  body?: string | undefined;
  attempt_limit?: number | null | undefined;
}

export interface EditTaskInput {
  task: number;
  title?: string | undefined;
  body?: string | undefined;
  attempt_limit?: number | null | undefined;
}

export interface CreateAttemptsInput {
  task: number;
  count?: number | undefined;
  note?: string | undefined;
  /** The origin branch a push created this attempt from. Internal: the API doesn't take it. */
  branch?: string | undefined;
}

export interface AttemptInput {
  task: number;
  number: number;
}

/** One ref a push updated: its full name and its ids before and after (all zeros for none). */
export interface PushedRef {
  ref: string;
  before: string;
  after: string;
}

// ---------------------------------------------------------------------------------------------
// Store

interface TaskRow {
  number: number;
  title: string;
  body: string;
  creator: string;
  state: TaskState;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  attempt_limit: number | null;
}

interface AttemptRow {
  task: number;
  number: number;
  author: string;
  state: AttemptState;
  branch: string | null;
  note: string;
  created_at: string;
  closed_at: string | null;
  merged_sha: string | null;
  archived_sha: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    number INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    creator TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    attempt_limit INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    task INTEGER NOT NULL REFERENCES tasks (number),
    number INTEGER NOT NULL,
    author TEXT NOT NULL,
    state TEXT NOT NULL,
    branch TEXT,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    merged_sha TEXT,
    archived_sha TEXT,
    PRIMARY KEY (task, number)
  )`,
  // Branch names are unique per project among active attempts.
  `CREATE UNIQUE INDEX IF NOT EXISTS attempts_active_branch ON attempts (branch)
    WHERE branch IS NOT NULL AND state IN ('draft', 'open')`,
  `CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, detail TEXT)`,
];

/** Columns added to the spike's journal, so task and attempt events record who acted on what. */
const JOURNAL_COLUMNS = ["user_id TEXT", "agent TEXT", "task INTEGER", "attempt INTEGER"];

/** Creates the store's tables, and adds the journal's newer columns to a journal that predates them. */
export function migrate(sql: Sql): void {
  for (const statement of SCHEMA) sql.exec(statement);
  const columns = new Set(sql.exec<{ name: string }>("PRAGMA table_info(journal)").map((c) => c.name));
  for (const column of JOURNAL_COLUMNS) {
    if (!columns.has(column.split(" ")[0] ?? "")) sql.exec(`ALTER TABLE journal ADD COLUMN ${column}`);
  }
}

export interface TaskStoreDeps {
  sql: Sql;
  repos: Repos;
  now?: () => Date;
}

/**
 * The task and attempt state machine for one project. Every method takes the project, the actor
 * and an input, checks the actor may act, and throws `ServiceError`s for the API to report.
 */
export class TaskStore {
  readonly #sql: Sql;
  readonly #repos: Repos;
  readonly #now: () => Date;
  /** Attempts being created per task, counted toward the cap while their forks are made. */
  readonly #reserved = new Map<number, number>();

  constructor({ sql, repos, now = () => new Date() }: TaskStoreDeps) {
    this.#sql = sql;
    this.#repos = repos;
    this.#now = now;
    migrate(sql);
  }

  // --- tasks -----------------------------------------------------------------------------------

  /** Creates an open task. Any signed-in user may, in any project. */
  createTask(_project: ProjectContext, actor: Actor, input: CreateTaskInput): StoredTask {
    return this.#sql.transaction(() => {
      const number = this.#next("tasks");
      this.#sql.exec(
        `INSERT INTO tasks (number, title, body, creator, state, created_at, attempt_limit)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        number,
        input.title,
        input.body ?? "",
        actor.user.id,
        this.#stamp(),
        input.attempt_limit ?? null,
      );
      this.#journal(actor, "created", number, null);
      return this.#task(number);
    });
  }

  getTask(_project: ProjectContext, _actor: Actor, input: { task: number }): StoredTask {
    return this.#task(input.task);
  }

  /** The project's tasks by number. Obsolete tasks are left out unless `state` asks for them. */
  listTasks(_project: ProjectContext, _actor: Actor, input: { state?: TaskState | undefined }): StoredTask[] {
    const rows =
      input.state === undefined
        ? this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE state != 'obsolete' ORDER BY number")
        : this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE state = ? ORDER BY number", input.state);
    return rows.map(toTask);
  }

  /** Edits a task's title, body or attempt limit. The project owner or the task's creator may. */
  editTask(project: ProjectContext, actor: Actor, input: EditTaskInput): StoredTask {
    const current = this.#task(input.task);
    this.#mayManageTask(project, actor, current);
    if (current.state === "obsolete") throw invalidState(`${taskRef(current.number)} is obsolete`);
    this.#sql.exec(
      "UPDATE tasks SET title = ?, body = ?, attempt_limit = ? WHERE number = ?",
      input.title ?? current.title,
      input.body ?? current.body,
      input.attempt_limit === undefined ? current.attempt_limit : input.attempt_limit,
      current.number,
    );
    return this.#task(current.number);
  }

  /**
   * Closes an open task, and closes its active attempts with it: a closed task can't merge, so
   * they would hold forks for nothing. The project owner or the task's creator may.
   */
  closeTask(project: ProjectContext, actor: Actor, input: { task: number }): StoredTask {
    const current = this.#task(input.task);
    this.#mayManageTask(project, actor, current);
    this.#expect(current, ["open"], "close");
    return this.#sql.transaction(() => {
      this.#endTask(actor, current.number, "closed");
      for (const attempt of this.#activeAttempts(current.number)) this.#endAttempt(actor, attempt, "closed");
      return this.#task(current.number);
    });
  }

  /**
   * Reopens a closed task. A task whose attempt merged has landed, and follow-up work is a new
   * task, so it stays closed. The project owner or the task's creator may.
   */
  reopenTask(project: ProjectContext, actor: Actor, input: { task: number }): StoredTask {
    const current = this.#task(input.task);
    this.#mayManageTask(project, actor, current);
    this.#expect(current, ["closed"], "reopen");
    const merged = this.#sql.exec("SELECT 1 FROM attempts WHERE task = ? AND state = 'merged'", current.number);
    if (merged.length > 0) throw invalidState(`${taskRef(current.number)} has merged; open a new task instead`);
    return this.#sql.transaction(() => {
      this.#sql.exec(
        "UPDATE tasks SET state = 'open', closed_at = NULL, closed_by = NULL WHERE number = ?",
        current.number,
      );
      this.#journal(actor, "reopened", current.number, null);
      return this.#task(current.number);
    });
  }

  /** Makes a task obsolete, and its active attempts with it. Only the project owner may. */
  obsoleteTask(project: ProjectContext, actor: Actor, input: { task: number }): StoredTask {
    const current = this.#task(input.task);
    mayOwn(project, actor);
    this.#expect(current, ["open", "closed"], "make obsolete");
    return this.#sql.transaction(() => {
      this.#endTask(actor, current.number, "obsolete");
      for (const attempt of this.#activeAttempts(current.number)) this.#endAttempt(actor, attempt, "obsolete");
      return this.#task(current.number);
    });
  }

  /** Restores an obsolete task to closed. Its attempts stay as they are. Only the project owner may. */
  restoreTask(project: ProjectContext, actor: Actor, input: { task: number }): StoredTask {
    const current = this.#task(input.task);
    mayOwn(project, actor);
    this.#expect(current, ["obsolete"], "restore");
    return this.#sql.transaction(() => {
      this.#sql.exec("UPDATE tasks SET state = 'closed' WHERE number = ?", current.number);
      this.#journal(actor, "restored", current.number, null);
      return this.#task(current.number);
    });
  }

  // --- attempts --------------------------------------------------------------------------------

  /**
   * Creates `count` draft attempts on an open task, authored by the actor's human, each with a
   * fork of the origin. Any signed-in user may. Either every attempt is created or none is: the cap
   * is checked for the whole batch, and if any fork fails the others are deleted again.
   *
   * Numbers are drawn before the forks are made and are never handed out again, even when the
   * batch fails, so a failed batch leaves a gap rather than a number that could name two forks.
   */
  async createAttempts(project: ProjectContext, actor: Actor, input: CreateAttemptsInput): Promise<StoredAttempt[]> {
    const count = input.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1)
      throw new ServiceError("invalid_request", "count must be at least 1");
    if (input.branch !== undefined) this.#checkBranch(input.task, input.branch, count);
    this.#expect(this.#task(input.task), ["open"], "add attempts to");

    const projectLimit = await this.#projectLimit(project);

    // From here to the reservation nothing awaits, so concurrent batches can't both pass the cap.
    const current = this.#task(input.task);
    this.#expect(current, ["open"], "add attempts to");
    const limit = current.attempt_limit ?? projectLimit;
    const reserved = this.#reserved.get(current.number) ?? 0;
    const active = this.#activeAttempts(current.number).length + reserved;
    if (active + count > limit) {
      throw new ServiceError(
        "attempt_limit",
        `${taskRef(current.number)} has ${active} of ${limit} active attempts; ${count} more would exceed it`,
      );
    }
    const first = this.#advance(attemptCounter(current.number), count) - count + 1;
    const numbers = Array.from({ length: count }, (_, i) => first + i);
    this.#reserved.set(current.number, reserved + count);

    let forked = false;
    try {
      await this.#fork(project, current.number, numbers);
      forked = true;
      return this.#sql.transaction(() => {
        // The task may have been closed while the forks were made.
        this.#expect(this.#task(current.number), ["open"], "add attempts to");
        const at = this.#stamp();
        for (const number of numbers) {
          this.#sql.exec(
            `INSERT INTO attempts (task, number, author, state, branch, note, created_at)
             VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
            current.number,
            number,
            actor.user.id,
            input.branch ?? null,
            input.note ?? "",
            at,
          );
          this.#journal(actor, "created", current.number, number);
        }
        return numbers.map((number) => this.#attempt({ task: current.number, number }));
      });
    } catch (err) {
      // A failed fork cleans up after itself; past that, every fork exists and must go.
      if (forked) await this.#deleteForks(project, current.number, numbers);
      throw err;
    } finally {
      const left = (this.#reserved.get(current.number) ?? count) - count;
      if (left > 0) this.#reserved.set(current.number, left);
      else this.#reserved.delete(current.number);
    }
  }

  getAttempt(_project: ProjectContext, _actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#attempt(input);
  }

  /** A task's attempts by number. Obsolete attempts are left out unless `state` asks for them. */
  listAttempts(
    _project: ProjectContext,
    _actor: Actor,
    input: { task: number; state?: AttemptState | undefined },
  ): StoredAttempt[] {
    this.#task(input.task);
    const rows =
      input.state === undefined
        ? this.#sql.exec<AttemptRow>(
            "SELECT * FROM attempts WHERE task = ? AND state != 'obsolete' ORDER BY number",
            input.task,
          )
        : this.#sql.exec<AttemptRow>(
            "SELECT * FROM attempts WHERE task = ? AND state = ? ORDER BY number",
            input.task,
            input.state,
          );
    return rows.map(toAttempt);
  }

  /** The active attempt pushed from an origin branch, if any. */
  attemptForBranch(_project: ProjectContext, _actor: Actor, input: { branch: string }): StoredAttempt | null {
    const [row] = this.#sql.exec<AttemptRow>(
      "SELECT * FROM attempts WHERE branch = ? AND state IN ('draft', 'open')",
      input.branch,
    );
    return row === undefined ? null : toAttempt(row);
  }

  /** Edits an attempt's note. Only its author (or their agents) may. */
  editAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput & { note: string }): StoredAttempt {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    if (current.state === "obsolete") throw invalidState(`${current.fork} is obsolete`);
    this.#sql.exec(
      "UPDATE attempts SET note = ? WHERE task = ? AND number = ?",
      input.note,
      current.task,
      current.number,
    );
    return this.#attempt(current);
  }

  /** draft → open: submits the attempt to be scored and considered. Only its author may. */
  openAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#authorMoves(actor, input, ["draft"], "open", "opened");
  }

  /** open → draft: takes the attempt back out of consideration. Only its author may. */
  draftAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#authorMoves(actor, input, ["open"], "draft", "returned_to_draft");
  }

  /** draft or open → closed. Only its author may. */
  closeAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ACTIVE, "close");
    return this.#sql.transaction(() => {
      this.#endAttempt(actor, current, "closed");
      return this.#attempt(current);
    });
  }

  /**
   * closed → draft. The task must be open and have room under its cap, since the attempt becomes
   * active again. Only its author may.
   */
  async reopenAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredAttempt> {
    const projectLimit = await this.#projectLimit(project);
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ["closed"], "reopen");
    const parent = this.#task(current.task);
    this.#expect(parent, ["open"], "reopen an attempt of");
    const limit = parent.attempt_limit ?? projectLimit;
    const active = this.#activeAttempts(parent.number).length + (this.#reserved.get(parent.number) ?? 0);
    if (active + 1 > limit) {
      throw new ServiceError("attempt_limit", `${taskRef(parent.number)} has ${active} of ${limit} active attempts`);
    }
    if (current.branch !== null && this.attemptForBranch(project, actor, { branch: current.branch }) !== null) {
      throw new ServiceError("conflict", `another active attempt has branch ${current.branch}`);
    }
    return this.#sql.transaction(() => {
      this.#sql.exec(
        "UPDATE attempts SET state = 'draft', closed_at = NULL WHERE task = ? AND number = ?",
        current.task,
        current.number,
      );
      this.#journal(actor, "reopened", current.task, current.number);
      return this.#attempt(current);
    });
  }

  /** Makes a draft, open or closed attempt obsolete. Only the project owner may. */
  obsoleteAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    const current = this.#attempt(input);
    mayOwn(project, actor);
    this.#expect(current, ["draft", "open", "closed"], "make obsolete");
    return this.#sql.transaction(() => {
      this.#endAttempt(actor, current, "obsolete");
      return this.#attempt(current);
    });
  }

  /** Restores an obsolete attempt to closed. Only the project owner may. */
  restoreAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    const current = this.#attempt(input);
    mayOwn(project, actor);
    this.#expect(current, ["obsolete"], "restore");
    return this.#sql.transaction(() => {
      this.#sql.exec(
        "UPDATE attempts SET state = 'closed' WHERE task = ? AND number = ?",
        current.task,
        current.number,
      );
      this.#journal(actor, "restored", current.task, current.number);
      return this.#attempt(current);
    });
  }

  /**
   * open → merged, for the merge queue: records the landed sha, closes the task and closes its
   * other active attempts. The merge queue decides who may merge, so this checks no permission.
   */
  markMerged(_project: ProjectContext, actor: Actor, input: AttemptInput & { sha: string }): StoredAttempt {
    const current = this.#attempt(input);
    this.#expect(current, ["open"], "merge");
    this.#expect(this.#task(current.task), ["open"], "merge into");
    return this.#sql.transaction(() => {
      const at = this.#stamp();
      this.#sql.exec(
        "UPDATE attempts SET state = 'merged', merged_sha = ?, closed_at = ? WHERE task = ? AND number = ?",
        input.sha,
        at,
        current.task,
        current.number,
      );
      this.#journal(actor, "merged", current.task, current.number, { sha: input.sha });
      for (const other of this.#activeAttempts(current.task)) this.#endAttempt(actor, other, "closed");
      this.#endTask(actor, current.task, "closed");
      return this.#attempt(current);
    });
  }

  /**
   * Checks the actor holds the claim on an attempt, so the git proxy may let them push to its
   * fork: the attempt is active and the actor's human is its author. Checked on every push, so a
   * hand-off or close takes effect on the next one.
   */
  authorizePush(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    const current = this.#attempt(input);
    if (!(ACTIVE as readonly AttemptState[]).includes(current.state)) {
      throw invalidState(`${current.fork} is ${current.state}; only an active attempt's fork takes pushes`);
    }
    mayAuthor(actor, current);
    return current;
  }

  /**
   * Journals a `pushed` event for each ref a push through the git proxy updated on an attempt's
   * fork, with the old and new ids so force-pushes show up afterwards. The proxy checked the
   * claim before forwarding the push, and the push has landed, so this checks nothing.
   */
  recordPush(_project: ProjectContext, actor: Actor, input: AttemptInput & { updates: PushedRef[] }): void {
    const current = this.#attempt(input);
    this.#sql.transaction(() => {
      for (const { ref, before, after } of input.updates) {
        this.#journal(actor, "pushed", current.task, current.number, { git_ref: ref, before, after });
      }
    });
  }

  // --- internals -------------------------------------------------------------------------------

  #task(number: number): StoredTask {
    const [row] = this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", number);
    if (row === undefined) throw new ServiceError("not_found", `no task ${taskRef(number)}`);
    return toTask(row);
  }

  #attempt({ task, number }: AttemptInput): StoredAttempt {
    const [row] = this.#sql.exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? AND number = ?", task, number);
    if (row === undefined) throw new ServiceError("not_found", `no attempt ${attemptRef(task, number)}`);
    return toAttempt(row);
  }

  #activeAttempts(task: number): StoredAttempt[] {
    return this.#sql
      .exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? AND state IN ('draft', 'open') ORDER BY number", task)
      .map(toAttempt);
  }

  #mayManageTask(project: ProjectContext, actor: Actor, current: StoredTask): void {
    if (actor.user.id === project.owner || actor.user.id === current.creator) return;
    throw new ServiceError("forbidden", `only the project owner or the creator of ${taskRef(current.number)} may`);
  }

  #expect<S extends string>(
    current: { state: S } & ({ fork: string } | { number: number }),
    from: readonly S[],
    verb: string,
  ): void {
    if (from.includes(current.state)) return;
    const name = "fork" in current ? current.fork : taskRef(current.number);
    throw invalidState(`can't ${verb} ${name}: it is ${current.state}`);
  }

  #authorMoves(
    actor: Actor,
    input: AttemptInput,
    from: readonly AttemptState[],
    to: AttemptState,
    event: TaskEvent,
  ): StoredAttempt {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, from, event === "opened" ? "open" : "return to draft");
    return this.#sql.transaction(() => {
      this.#sql.exec("UPDATE attempts SET state = ? WHERE task = ? AND number = ?", to, current.task, current.number);
      this.#journal(actor, event, current.task, current.number);
      return this.#attempt(current);
    });
  }

  /** Moves a task to closed or obsolete, keeping the first close time and who closed it. */
  #endTask(actor: Actor, number: number, to: "closed" | "obsolete"): void {
    this.#sql.exec(
      `UPDATE tasks SET state = ?, closed_at = COALESCE(closed_at, ?), closed_by = COALESCE(closed_by, ?)
       WHERE number = ?`,
      to,
      this.#stamp(),
      actor.user.id,
      number,
    );
    this.#journal(actor, to === "closed" ? "closed" : "made_obsolete", number, null);
  }

  /**
   * Moves an attempt to closed or obsolete. The close-and-archive slice will archive and delete
   * its fork here; until it lands, closing deletes nothing.
   */
  #endAttempt(actor: Actor, current: StoredAttempt, to: "closed" | "obsolete"): void {
    this.#sql.exec(
      "UPDATE attempts SET state = ?, closed_at = COALESCE(closed_at, ?) WHERE task = ? AND number = ?",
      to,
      this.#stamp(),
      current.task,
      current.number,
    );
    this.#journal(actor, to === "closed" ? "closed" : "made_obsolete", current.task, current.number);
  }

  /** A branch can carry only one attempt, and a `t<n>/` branch only an attempt on `t<n>`. */
  #checkBranch(task: number, branch: string, count: number): void {
    if (count !== 1) throw new ServiceError("invalid_request", "a branch carries exactly one attempt");
    const reserved = reservedTask(branch);
    if (reserved !== null && reserved !== task) {
      throw new ServiceError("conflict", `branch ${branch} is reserved for ${taskRef(reserved)}`);
    }
    const [taken] = this.#sql.exec<AttemptRow>(
      "SELECT * FROM attempts WHERE branch = ? AND state IN ('draft', 'open')",
      branch,
    );
    if (taken !== undefined) {
      throw new ServiceError("conflict", `branch ${branch} belongs to ${attemptRef(taken.task, taken.number)}`);
    }
  }

  /** The project's cap: `attempts.limit` in the origin's `.throng/config.yml` on `main`, or the default. */
  async #projectLimit(project: ProjectContext): Promise<number> {
    return attemptLimitFromConfig(await loadConfig(this.#repos, project.id));
  }

  async #fork(project: ProjectContext, task: number, numbers: number[]): Promise<void> {
    const origin = originRepo(project.id);
    const results = await Promise.allSettled(
      numbers.map((n) => this.#repos.fork(origin, forkRepo(project.id, attemptRef(task, n)))),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed === undefined) return;
    const made = numbers.filter((_, i) => results[i]?.status === "fulfilled");
    await this.#deleteForks(project, task, made);
    throw failed.reason;
  }

  async #deleteForks(project: ProjectContext, task: number, numbers: number[]): Promise<void> {
    await Promise.all(
      numbers.map((n) => {
        const name = forkRepo(project.id, attemptRef(task, n));
        return this.#repos.delete(name).catch((cause: unknown) => {
          console.error({ event: "attempt.orphan_fork", repo: name, error: String(cause) });
        });
      }),
    );
  }

  /** Draws the next number from a counter. */
  #next(counter: string): number {
    return this.#advance(counter, 1);
  }

  /** Advances a counter by `by` and returns its new value, the last number drawn. */
  #advance(counter: string, by: number): number {
    const [row] = this.#sql.exec<{ value: number }>(
      `INSERT INTO counters (name, value) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET value = value + excluded.value
       RETURNING value`,
      counter,
      by,
    );
    if (row === undefined) throw new Error(`counter ${counter} returned no row`);
    return row.value;
  }

  #journal(
    actor: Actor,
    kind: TaskEvent,
    task: number,
    attempt: number | null,
    extra: Record<string, unknown> = {},
  ): void {
    const detail = { ref: attempt === null ? taskRef(task) : attemptRef(task, attempt), ...extra };
    this.#sql.exec(
      "INSERT INTO journal (at, kind, detail, user_id, agent, task, attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.#now().getTime(),
      kind,
      JSON.stringify(detail),
      actor.user.id,
      actor.agent,
      task,
      attempt,
    );
  }

  #stamp(): string {
    return this.#now().toISOString();
  }
}

/** The task methods a caller may invoke, in the Durable Object and through `runTaskMethod`. */
export const TASK_METHODS = [
  "createTask",
  "getTask",
  "listTasks",
  "editTask",
  "closeTask",
  "reopenTask",
  "obsoleteTask",
  "restoreTask",
  "createAttempts",
  "getAttempt",
  "listAttempts",
  "attemptForBranch",
  "editAttempt",
  "openAttempt",
  "draftAttempt",
  "closeAttempt",
  "reopenAttempt",
  "obsoleteAttempt",
  "restoreAttempt",
  "markMerged",
  "authorizePush",
  "recordPush",
] as const satisfies readonly (keyof TaskStore)[];

export type TaskMethod = (typeof TASK_METHODS)[number];

/**
 * What a task method returns across the Durable Object boundary. RPC doesn't carry an error's
 * code, so a `ServiceError` travels as data and the caller throws it again.
 */
export type TaskOutcome = { ok: true; value: unknown } | { ok: false; code: ErrorCode; message: string };

/** Runs one store method and captures its result or `ServiceError` as a `TaskOutcome`. */
export async function runTaskMethod(store: TaskStore, method: string, args: unknown[]): Promise<TaskOutcome> {
  if (!(TASK_METHODS as readonly string[]).includes(method)) {
    return { ok: false, code: "invalid_request", message: `no task method ${method}` };
  }
  try {
    const fn = store[method as TaskMethod] as (...a: unknown[]) => unknown;
    return { ok: true, value: await fn.apply(store, args) };
  } catch (err) {
    if (err instanceof ServiceError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

/**
 * The project's cap on active attempts per task: `attempts.limit` from a valid config, or the
 * default. An invalid config gets the default too, so a config mistake can't lock a project's tasks
 * out of new attempts; scoring is where the mistake is surfaced.
 */
export function attemptLimitFromConfig(result: ConfigResult): number {
  if (result.kind === "invalid") {
    console.warn({ event: "config.invalid", path: CONFIG_PATH, error: result.error });
    return DEFAULT_ATTEMPT_LIMIT;
  }
  if (result.kind === "none") return DEFAULT_ATTEMPT_LIMIT;
  return result.config.attempts.limit ?? DEFAULT_ATTEMPT_LIMIT;
}

function attemptCounter(task: number): string {
  return `attempts:${task}`;
}

function toTask(row: TaskRow): StoredTask {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    creator: row.creator,
    state: row.state,
    created_at: row.created_at,
    closed_at: row.closed_at,
    closed_by: row.closed_by,
    attempt_limit: row.attempt_limit,
  };
}

function toAttempt(row: AttemptRow): StoredAttempt {
  return {
    task: row.task,
    number: row.number,
    author: row.author,
    state: row.state,
    fork: attemptRef(row.task, row.number),
    branch: row.branch,
    note: row.note,
    created_at: row.created_at,
    closed_at: row.closed_at,
    merged_sha: row.merged_sha,
    archived_sha: row.archived_sha,
  };
}

function mayOwn(project: ProjectContext, actor: Actor): void {
  if (actor.user.id !== project.owner) throw new ServiceError("forbidden", "only the project owner may");
}

/** The attempt's author, or one of their agents, holds its claim. */
function mayAuthor(actor: Actor, current: StoredAttempt): void {
  if (actor.user.id !== current.author) throw new ServiceError("forbidden", `only the author of ${current.fork} may`);
}

function invalidState(message: string): ServiceError {
  return new ServiceError("invalid_state", message);
}
