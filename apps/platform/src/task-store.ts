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

/** The longest task title; a push-created task's title is cut to it. */
export const MAX_TITLE = 200;
/**
 * How long a push-to-create may hold its branch between forking and creating the attempt. A row
 * older than this belongs to a push that died part way; the next push of an origin branch sweeps it.
 */
export const BRANCH_PUSH_TTL_MS = 15 * 60 * 1000;

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

/**
 * Where a push of an origin branch goes: the pusher's own active attempt on that branch, or a new
 * attempt (on a new task, or on `t<n>` for a `t<n>/` branch) whose fork has just been made.
 */
export type BranchRoute =
  | { kind: "attempt"; attempt: StoredAttempt }
  | { kind: "create"; task: number; number: number; new_task: boolean };

export interface CompleteBranchPushInput extends AttemptInput {
  /** The commit the push left on the fork's `main`. */
  head: string;
  /** The refs the push updated on the fork, for the `pushed` event. */
  updates: PushedRef[];
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

/** A push-to-create between forking and creating its attempt. */
interface BranchPushRow {
  branch: string;
  task: number;
  attempt: number;
  user_id: string;
  /** 1 when the push creates its task too. */
  new_task: number;
  /** Ms since epoch. */
  started_at: number;
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
  // Pushes creating an attempt from an origin branch, between forking and creating the attempt
  // (and task). A row holds its branch, and its attempt counts toward the task's cap.
  `CREATE TABLE IF NOT EXISTS branch_pushes (
    branch TEXT PRIMARY KEY,
    task INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    new_task INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  )`,
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
    const active = this.#activeAttempts(current.number).length + reserved + this.#branchPushes(current.number);
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
    const active =
      this.#activeAttempts(parent.number).length +
      (this.#reserved.get(parent.number) ?? 0) +
      this.#branchPushes(parent.number);
    if (active + 1 > limit) {
      throw new ServiceError("attempt_limit", `${taskRef(parent.number)} has ${active} of ${limit} active attempts`);
    }
    if (
      current.branch !== null &&
      (this.attemptForBranch(project, actor, { branch: current.branch }) !== null ||
        this.#branchPush(current.branch) !== undefined)
    ) {
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
   * Hands a draft or open attempt to another user, `to` (a user id), who becomes its author at
   * once. Only its author (or their agents) may, and not to themselves. Pushes check the claim
   * on every request, so the old author's next push is refused and nothing needs revoking.
   */
  handOffAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput & { to: string }): StoredAttempt {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ACTIVE, "hand off");
    if (input.to === current.author) {
      throw new ServiceError("invalid_request", `${current.fork} is already theirs: hand it to another user`);
    }
    return this.#sql.transaction(() => {
      this.#sql.exec(
        "UPDATE attempts SET author = ? WHERE task = ? AND number = ?",
        input.to,
        current.task,
        current.number,
      );
      this.#journal(actor, "handed_off", current.task, current.number, { from: current.author, to: input.to });
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

  // --- push-to-create --------------------------------------------------------------------------
  //
  // A push of branch `B` to the origin never lands there. The git proxy asks `routeBranchPush`
  // where it goes: the pusher's own active attempt on `B`, or a new attempt. For a new one the
  // store draws its numbers, holds `B` in `branch_pushes` and forks the origin, all before the task
  // exists: the task's title comes from the pushed head commit, which can only be read once its pack
  // has been indexed somewhere, and the fork is the one place it may land. The proxy forwards the
  // push to the fork's `main` and then calls `completeBranchPush`, which reads the head commit back
  // through `Repos` and creates the task and opened attempt in one transaction. If anything fails
  // in between, the proxy calls `abandonBranchPush`, which frees the branch and deletes the fork;
  // a push that dies without doing either is swept after `BRANCH_PUSH_TTL_MS`. Numbers drawn for
  // an abandoned push are never reused, so it leaves a gap.

  /**
   * Routes a push of origin branch `branch` by the actor:
   * - the actor's own active attempt on `branch` takes it;
   * - another user's active attempt on `branch` refuses it, naming that attempt's task;
   * - `t<n>/<anything>` adds an attempt to `t<n>`, refused when the task doesn't exist, isn't open,
   *   has an open merge request or is at its attempt limit;
   * - any other branch creates a task.
   * A new attempt's fork exists when this returns; the caller must complete or abandon it.
   */
  async routeBranchPush(project: ProjectContext, actor: Actor, input: { branch: string }): Promise<BranchRoute> {
    const { branch } = input;
    await this.#sweepBranchPushes(project);
    const reserved = reservedTask(branch);
    const projectLimit = reserved === null ? DEFAULT_ATTEMPT_LIMIT : await this.#projectLimit(project);

    // From here to the `branch_pushes` row nothing awaits, so two pushes of a branch can't both pass.
    const active = this.attemptForBranch(project, actor, { branch });
    if (active !== null) {
      if (active.author === actor.user.id) return { kind: "attempt", attempt: active };
      throw new ServiceError(
        "conflict",
        `branch ${branch} belongs to ${active.fork}, another user's attempt on ${taskRef(active.task)}; ` +
          `push a branch named ${taskRef(active.task)}/<name> to make your own attempt`,
      );
    }
    if (this.#branchPush(branch) !== undefined) {
      throw new ServiceError("conflict", `another push of branch ${branch} is creating its attempt; try again shortly`);
    }

    let task: number | null = null;
    if (reserved !== null) {
      const [row] = this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", reserved);
      if (row === undefined) {
        throw new ServiceError("not_found", `branch ${branch} is for ${taskRef(reserved)}, which doesn't exist`);
      }
      const current = toTask(row);
      this.#expect(current, ["open"], "add attempts to");
      if (this.hasOpenMergeRequest(project, actor, { task: current.number })) {
        throw invalidState(`${taskRef(current.number)} has an open merge request, so it takes no new attempts`);
      }
      const limit = current.attempt_limit ?? projectLimit;
      const count =
        this.#activeAttempts(current.number).length +
        (this.#reserved.get(current.number) ?? 0) +
        this.#branchPushes(current.number);
      if (count + 1 > limit) {
        throw new ServiceError("attempt_limit", `${taskRef(current.number)} has ${count} of ${limit} active attempts`);
      }
      task = current.number;
    }

    const route = this.#sql.transaction(() => {
      const number = task ?? this.#next("tasks");
      const attempt = this.#next(attemptCounter(number));
      this.#sql.exec(
        "INSERT INTO branch_pushes (branch, task, attempt, user_id, new_task, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        branch,
        number,
        attempt,
        actor.user.id,
        task === null ? 1 : 0,
        this.#now().getTime(),
      );
      return { kind: "create", task: number, number: attempt, new_task: task === null } as const;
    });
    try {
      await this.#fork(project, route.task, [route.number]);
    } catch (err) {
      // A failed fork deletes what it made; only the branch is left to free.
      this.#dropBranchPush(route);
      throw err;
    }
    return route;
  }

  /**
   * Creates the attempt (and, for a new branch, the task) for a push `routeBranchPush` sent to a new
   * fork, once the push has landed on the fork's `main` at `head`. A new task takes its title from
   * the head commit's subject and its body from the rest of the message. The attempt is opened
   * straight away, and the push is journalled. Only the pusher may.
   */
  async completeBranchPush(
    project: ProjectContext,
    actor: Actor,
    input: CompleteBranchPushInput,
  ): Promise<{ task: StoredTask; attempt: StoredAttempt }> {
    const pending = this.#pendingPush(input, actor);
    let created: { title: string; body: string } | null = null;
    if (pending.new_task === 1) {
      const fork = forkRepo(project.id, attemptRef(pending.task, pending.attempt));
      const [head] = await this.#repos.listCommits(fork, { ref: "main", limit: 1 });
      if (head?.hash !== input.head) {
        throw new ServiceError(
          "conflict",
          `the pushed commit isn't the head of ${attemptRef(pending.task, pending.attempt)}`,
        );
      }
      created = taskFromCommit(head.message, pending.branch);
    }

    return this.#sql.transaction(() => {
      const row = this.#pendingPush(input, actor);
      const at = this.#stamp();
      if (created !== null) {
        this.#sql.exec(
          `INSERT INTO tasks (number, title, body, creator, state, created_at, attempt_limit)
           VALUES (?, ?, ?, ?, 'open', ?, NULL)`,
          row.task,
          created.title,
          created.body,
          actor.user.id,
          at,
        );
        this.#journal(actor, "created", row.task, null);
      } else {
        // The task may have been closed while the push was forwarded.
        this.#expect(this.#task(row.task), ["open"], "add attempts to");
      }
      this.#sql.exec(
        `INSERT INTO attempts (task, number, author, state, branch, note, created_at)
         VALUES (?, ?, ?, 'open', ?, '', ?)`,
        row.task,
        row.attempt,
        actor.user.id,
        row.branch,
        at,
      );
      this.#journal(actor, "created", row.task, row.attempt);
      this.#journal(actor, "opened", row.task, row.attempt);
      for (const { ref, before, after } of input.updates) {
        this.#journal(actor, "pushed", row.task, row.attempt, { git_ref: ref, before, after });
      }
      this.#dropBranchPush({ task: row.task, number: row.attempt });
      return { task: this.#task(row.task), attempt: this.#attempt({ task: row.task, number: row.attempt }) };
    });
  }

  /**
   * Undoes a push `routeBranchPush` sent to a new fork that won't be completed: frees its branch and
   * deletes its fork. Only the pusher may; once the push is completed there is nothing to undo.
   */
  async abandonBranchPush(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<void> {
    const [row] = this.#sql.exec<BranchPushRow>(
      "SELECT * FROM branch_pushes WHERE task = ? AND attempt = ? AND user_id = ?",
      input.task,
      input.number,
      actor.user.id,
    );
    if (row === undefined) return;
    this.#dropBranchPush(input);
    await this.#deleteForks(project, row.task, [row.attempt]);
  }

  /**
   * Whether a task has an open merge request; such a task takes no new attempts. Merge requests
   * don't exist yet (#139), so none does: this is where that check reads them once they land.
   */
  hasOpenMergeRequest(_project: ProjectContext, _actor: Actor, input: { task: number }): boolean {
    this.#task(input.task);
    return false;
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

  /** The push-to-create holding `branch`, if any. */
  #branchPush(branch: string): BranchPushRow | undefined {
    return this.#sql.exec<BranchPushRow>("SELECT * FROM branch_pushes WHERE branch = ?", branch)[0];
  }

  /** How many push-to-creates are making attempts on `task`. */
  #branchPushes(task: number): number {
    const [row] = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM branch_pushes WHERE task = ?", task);
    return row?.n ?? 0;
  }

  /** The actor's push-to-create of an attempt, or an error saying there is none. */
  #pendingPush(input: AttemptInput, actor: Actor): BranchPushRow {
    const [row] = this.#sql.exec<BranchPushRow>(
      "SELECT * FROM branch_pushes WHERE task = ? AND attempt = ? AND user_id = ?",
      input.task,
      input.number,
      actor.user.id,
    );
    if (row === undefined) {
      throw invalidState(`no push is creating ${attemptRef(input.task, input.number)}; push the branch again`);
    }
    return row;
  }

  #dropBranchPush(input: AttemptInput): void {
    this.#sql.exec("DELETE FROM branch_pushes WHERE task = ? AND attempt = ?", input.task, input.number);
  }

  /** Clears push-to-creates that died part way, deleting their forks. */
  async #sweepBranchPushes(project: ProjectContext): Promise<void> {
    const stale = this.#sql.exec<BranchPushRow>(
      "SELECT * FROM branch_pushes WHERE started_at < ?",
      this.#now().getTime() - BRANCH_PUSH_TTL_MS,
    );
    for (const row of stale) {
      this.#dropBranchPush({ task: row.task, number: row.attempt });
      console.warn({
        event: "attempt.branch_push_expired",
        branch: row.branch,
        attempt: attemptRef(row.task, row.attempt),
      });
    }
    await Promise.all(stale.map((row) => this.#deleteForks(project, row.task, [row.attempt])));
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
  "handOffAttempt",
  "markMerged",
  "authorizePush",
  "recordPush",
  "routeBranchPush",
  "completeBranchPush",
  "abandonBranchPush",
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

/**
 * A push-created task's title and body from its head commit's message: the subject (its first
 * paragraph, on one line) cut to `MAX_TITLE`, and the rest. A commit with no subject is titled
 * after its branch.
 */
export function taskFromCommit(message: string, branch: string): { title: string; body: string } {
  const text = message.replace(/\r\n/g, "\n").trim();
  const split = text.search(/\n[ \t]*\n/);
  const subject = (split === -1 ? text : text.slice(0, split)).replace(/\s+/g, " ").trim();
  const body = split === -1 ? "" : text.slice(split).trim();
  return { title: (subject || branch).slice(0, MAX_TITLE).trim(), body };
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
