// Tasks and attempts, kept in the project Durable Object's SQLite: the source of truth for both,
// their per-project counters and the journal of their transitions. This module holds the state
// machine and the P0 permission rules; `ProjectCoordinator` runs it inside the Durable Object, and
// tests run it over local SQLite. The `tasks.ts` service resolves projects and calls it.
//
// Users are stored by id only, so renaming a handle never rewrites history; the service resolves
// handles when it answers.

import { archiveRef } from "./archive.ts";
import { CONFIG_PATH, loadConfig, type ConfigResult } from "./config.ts";
import { ServiceError, type ErrorCode } from "./errors.ts";
import type { LandingOutcome, LandingParams, LandingRunner } from "./landing.ts";
import { Landings, type StoredLanding } from "./landings.ts";
import { isLogName, landingLogKey, logKey, missingLog } from "./logs.ts";
import {
  dequeueCause,
  MergeRequests,
  type Dequeue,
  type DequeueCause,
  type DequeueReason,
  type MergeRequestEvent,
  type MergeRequestState,
  type StoredMergeRequest,
} from "./merge-requests.ts";
import { isZeroId } from "./pkt-line.ts";
import { forkRepo, originRepo, type Repos } from "./repos.ts";
import {
  headAttemptRef,
  SCORING_CAP,
  ScoringQueue,
  type AttemptScoring,
  type ScoredAttempt,
  type ScoringOutcome,
  type ScoringRequest,
  type ScoringRunner,
  type ScoringTrigger,
  type StoredRun,
} from "./scoring.ts";
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
/** The fork ref that is an attempt's head: what gets archived, and what reopening restores. */
const FORK_HEAD = "refs/heads/main";
/** How often, and from what first delay (doubling), a restore waits for a new fork to be ready. */
const FORK_READY_RETRIES = 6;
const FORK_READY_BACKOFF_MS = 250;

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
  /** Its current head's scoring status, for polling. */
  scoring: AttemptScoring;
  /** The latest merge request it is the source of, if any, for polling: its state and last dequeue reason. */
  merge_request: AttemptMergeRequest | null;
}

/** A merge request as its source attempt shows it. */
export interface AttemptMergeRequest {
  state: MergeRequestState;
  last_dequeue: { reason: DequeueReason } | null;
}

/** An attempt's scoring status, and the run holding its current result, if its head has one. */
export interface AttemptScoringDetail extends AttemptScoring {
  current: StoredRun | null;
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

/** What `recordPush` did: the scoring it queued, and what to tell the pusher of their merge request. */
export interface PushRecord {
  scoring: ScoringRequest | null;
  merge_request: PushNotice | null;
}

/** The merge request news a push to its source attempt carries back to the pusher. */
export interface PushNotice {
  task: number;
  /** A dequeue not yet reported, with its conflict file count when known. */
  dequeue: { reason: DequeueReason; files: number | null } | null;
  /** The new head, when this push moved the merge request to `needs_review`. */
  needs_review: string | null;
}

/** How many files a dequeue's details name (a conflict's), or null when they name none. */
function fileCount(dequeue: Dequeue): number | null {
  return dequeue.reason === "conflict" ? dequeue.details.files.length : null;
}

/** An attempt as the scoring queue keys it. */
function scoredAttempt({ task, number }: AttemptInput): ScoredAttempt {
  return { task, attempt: number };
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

/**
 * Tables the spike's push inbox kept, which nothing reads since scoring moved to `scoring.ts`:
 * event deliveries, its checks and its pending queue.
 */
const DROPPED_TABLES = ["deliveries", "checks", "pending"];

/** Columns added to the spike's journal, so task and attempt events record who acted on what. */
const JOURNAL_COLUMNS = ["user_id TEXT", "agent TEXT", "task INTEGER", "attempt INTEGER"];

/**
 * Creates the store's tables, adds the journal's newer columns to a journal that predates them, and
 * drops the spike's tables.
 */
export function migrate(sql: Sql): void {
  for (const statement of SCHEMA) sql.exec(statement);
  for (const table of DROPPED_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  const columns = new Set(sql.exec<{ name: string }>("PRAGMA table_info(journal)").map((c) => c.name));
  for (const column of JOURNAL_COLUMNS) {
    if (!columns.has(column.split(" ")[0] ?? "")) sql.exec(`ALTER TABLE journal ADD COLUMN ${column}`);
  }
}

export interface TaskStoreDeps {
  sql: Sql;
  repos: Repos;
  now?: () => Date;
  /** Starts and stops scoring runs; without one, scoring requests stay queued. */
  scoring?: ScoringRunner | null | undefined;
  /** Starts and stops the merge queue's Landing Workflows; without one, nothing lands on its own. */
  landing?: LandingRunner | null | undefined;
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
  /** The project's scoring runs. Its caller runs `scoring.drain()` after every store call. */
  readonly scoring: ScoringQueue;
  /** The project's merge requests and merge queue. */
  readonly mergeRequests: MergeRequests;
  /** The merge queue's landings, one Landing Workflow each. */
  readonly landings: Landings;
  readonly #landing: LandingRunner | null;

  constructor({ sql, repos, now = () => new Date(), scoring = null, landing = null }: TaskStoreDeps) {
    this.#sql = sql;
    this.#repos = repos;
    this.#now = now;
    this.#landing = landing;
    migrate(sql);
    this.landings = new Landings({ sql, now });
    this.scoring = new ScoringQueue({ sql, runner: scoring, now, reserved: () => this.#landingSlots() });
    this.mergeRequests = new MergeRequests({
      sql,
      now,
      journal: (actor, kind, mr, detail) =>
        this.#journal(actor, kind, mr.task, mr.attempt, { merge_request: taskRef(mr.task), ...detail }),
    });
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
   * they would hold forks for nothing. Their forks are archived and deleted. The project owner or
   * the task's creator may.
   */
  async closeTask(project: ProjectContext, actor: Actor, input: { task: number }): Promise<StoredTask> {
    const current = this.#task(input.task);
    this.#mayManageTask(project, actor, current);
    this.#expect(current, ["open"], "close");
    const ended = this.#sql.transaction(() => {
      this.#endTask(actor, current.number, "closed");
      const active = this.#activeAttempts(current.number);
      for (const attempt of active) this.#endAttempt(actor, attempt, "closed");
      return active;
    });
    await this.#archive(project, ended);
    return this.#task(current.number);
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

  /**
   * Makes a task obsolete, and its active attempts with it; their forks are archived and deleted.
   * Only the project owner may.
   */
  async obsoleteTask(project: ProjectContext, actor: Actor, input: { task: number }): Promise<StoredTask> {
    const current = this.#task(input.task);
    mayOwn(project, actor);
    this.#expect(current, ["open", "closed"], "make obsolete");
    const ended = this.#sql.transaction(() => {
      this.#endTask(actor, current.number, "obsolete");
      const active = this.#activeAttempts(current.number);
      for (const attempt of active) this.#endAttempt(actor, attempt, "obsolete");
      return active;
    });
    await this.#archive(project, ended);
    return this.#task(current.number);
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
    this.#checkNoMergeRequest(current.number);
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
    return rows.map((row) => this.#toAttempt(row));
  }

  /** The attempt's scoring status, with its current result: the latest `done` run for its head. */
  getScoring(_project: ProjectContext, _actor: Actor, input: AttemptInput): AttemptScoringDetail {
    return this.#scoringDetail(this.#attempt(input));
  }

  /** The task's arena: every attempt, obsolete ones included, by number, with its scoring and current result. */
  taskArena(
    _project: ProjectContext,
    _actor: Actor,
    input: { task: number },
  ): (Omit<StoredAttempt, "scoring"> & { scoring: AttemptScoringDetail })[] {
    this.#task(input.task);
    return this.#sql
      .exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? ORDER BY number", input.task)
      .map((row) => this.#toAttempt(row))
      .map((a) => ({ ...a, scoring: this.#scoringDetail(a) }));
  }

  /** The attempt's scoring status, with the run holding its current result. */
  #scoringDetail(attempt: StoredAttempt): AttemptScoringDetail {
    return { ...attempt.scoring, current: this.scoring.currentRun(scoredAttempt(attempt)) };
  }

  /** The attempt's scoring runs, newest first, superseded and cancelled ones included. */
  listScoringRuns(_project: ProjectContext, _actor: Actor, input: AttemptInput): StoredRun[] {
    return this.scoring.listRuns(scoredAttempt(this.#attempt(input))).toReversed();
  }

  /** One scoring run of the project, by id. */
  getScoringRun(_project: ProjectContext, _actor: Actor, input: { run: number }): StoredRun {
    const run = this.scoring.getRun(input.run);
    if (run === null) throw new ServiceError("not_found", `no run ${input.run}`);
    return run;
  }

  /** Every attempt in the project, by task and then number, leaving out obsolete ones. For the ref list. */
  listProjectAttempts(_project: ProjectContext, _actor: Actor): StoredAttempt[] {
    return this.#sql
      .exec<AttemptRow>("SELECT * FROM attempts WHERE state != 'obsolete' ORDER BY task, number")
      .map((row) => this.#toAttempt(row));
  }

  /** The active attempt pushed from an origin branch, if any. */
  attemptForBranch(_project: ProjectContext, _actor: Actor, input: { branch: string }): StoredAttempt | null {
    const [row] = this.#sql.exec<AttemptRow>(
      "SELECT * FROM attempts WHERE branch = ? AND state IN ('draft', 'open')",
      input.branch,
    );
    return row === undefined ? null : this.#toAttempt(row);
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
  async openAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredAttempt> {
    const opened = this.#authorMoves(actor, input, ["draft"], "open", "opened");
    await this.#scoreHead(project, actor, opened, "open");
    return this.#attempt(opened);
  }

  /** Scores a draft attempt's head now, though drafts aren't scored otherwise. Only its author may. */
  async scoreNow(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<ScoringRequest> {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ["draft"], "score now");
    return this.#requireHead(await this.#scoreHead(project, actor, current, "score_now"), current);
  }

  /**
   * Scores an open attempt's head again, even if it already has a finished run. Its author, the
   * task's creator or the project owner may.
   */
  async rescore(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<ScoringRequest> {
    const current = this.#attempt(input);
    const id = actor.user.id;
    if (id !== current.author && id !== project.owner && id !== this.#task(current.task).creator) {
      throw new ServiceError("forbidden", `only ${current.fork}'s author, its task's creator or the project owner may`);
    }
    this.#expect(current, ["open"], "rescore");
    return this.#requireHead(await this.#scoreHead(project, actor, current, "rescore"), current);
  }

  /**
   * Where a run's log named `name` is stored in R2. Anyone signed in may read a run's logs. An
   * unknown run, or a name no log can have, is `not_found`; whether the log itself exists is R2's.
   */
  runLogKey(project: ProjectContext, actor: Actor, input: { run: number; name: string }): string {
    const run = this.getScoringRun(project, actor, input);
    if (!isLogName(input.name)) throw missingLog(input.run, input.name);
    return logKey({ project: project.id, attempt: headAttemptRef(run), sha: run.sha, run: run.id }, input.name);
  }

  /** open → draft: takes the attempt back out of consideration. Only its author may. */
  draftAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#sql.transaction(() => {
      const drafted = this.#authorMoves(actor, input, ["open"], "draft", "returned_to_draft");
      this.scoring.cancelAttempt(scoredAttempt(drafted), "returned to draft");
      return drafted;
    });
  }

  /** draft or open → closed, archiving and deleting its fork. Only its author may. */
  async closeAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredAttempt> {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ACTIVE, "close");
    this.#sql.transaction(() => this.#endAttempt(actor, current, "closed"));
    await this.#archive(project, [current]);
    return this.#attempt(current);
  }

  /**
   * closed → draft. The task must be open and have room under its cap, since the attempt becomes
   * active again. Its fork is made again from the origin and its `main` restored from the archive.
   * Either the attempt is back in draft with its fork, or nothing changed. Only its author may.
   */
  async reopenAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredAttempt> {
    const projectLimit = await this.#projectLimit(project);
    // From here to the reservation nothing awaits, so a concurrent batch can't take the same slot.
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ["closed"], "reopen");
    const parent = this.#task(current.task);
    this.#expect(parent, ["open"], "reopen an attempt of");
    this.#checkNoMergeRequest(parent.number);
    const limit = parent.attempt_limit ?? projectLimit;
    const reserved = this.#reserved.get(parent.number) ?? 0;
    const active = this.#activeAttempts(parent.number).length + reserved + this.#branchPushes(parent.number);
    if (active + 1 > limit) {
      throw new ServiceError("attempt_limit", `${taskRef(parent.number)} has ${active} of ${limit} active attempts`);
    }
    this.#checkReopenBranch(current);
    this.#reserved.set(parent.number, reserved + 1);

    let forked = false;
    try {
      forked = await this.#restore(project, current);
      return this.#sql.transaction(() => {
        // Another call may have moved the attempt, the task or the branch while the fork was made.
        const now = this.#attempt(current);
        this.#expect(now, ["closed"], "reopen");
        this.#expect(this.#task(current.task), ["open"], "reopen an attempt of");
        this.#checkReopenBranch(now);
        this.#sql.exec(
          "UPDATE attempts SET state = 'draft', closed_at = NULL WHERE task = ? AND number = ?",
          current.task,
          current.number,
        );
        this.#journal(actor, "reopened", current.task, current.number);
        return this.#attempt(current);
      });
    } catch (err) {
      if (forked) await this.#deleteForks(project, current.task, [current.number]);
      throw err;
    } finally {
      const left = (this.#reserved.get(parent.number) ?? 1) - 1;
      if (left > 0) this.#reserved.set(parent.number, left);
      else this.#reserved.delete(parent.number);
    }
  }

  /**
   * Makes a draft, open or closed attempt obsolete. An active one's fork is archived and deleted,
   * as on close. Only the project owner may.
   */
  async obsoleteAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredAttempt> {
    const current = this.#attempt(input);
    mayOwn(project, actor);
    this.#expect(current, ["draft", "open", "closed"], "make obsolete");
    this.#sql.transaction(() => this.#endAttempt(actor, current, "obsolete"));
    if ((ACTIVE as readonly AttemptState[]).includes(current.state)) await this.#archive(project, [current]);
    return this.#attempt(current);
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
   * open → merged, for the merge queue: records the landed sha and closes the task. The merged
   * attempt's fork is archived and deleted. Its siblings were closed by the selection, so this
   * leaves any others as they are. The merge queue decides who may merge, so this checks no
   * permission.
   */
  async markMerged(
    project: ProjectContext,
    actor: Actor | null,
    input: AttemptInput & { sha: string },
  ): Promise<StoredAttempt> {
    const current = this.#attempt(input);
    this.#checkMergeable(current);
    this.#sql.transaction(() => this.#markMergedRows(actor, current, input.sha));
    await this.#archive(project, [current]);
    return this.#attempt(current);
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
   * fork, with the old and new ids so force-pushes show up afterwards, and queues scoring when the
   * attempt is open and its head moved; the scoring queue skips a head it already covers. The
   * proxy checked the claim before forwarding the push, and the push has landed, so this checks
   * nothing. Returns the scoring request, or null when the push asked for none.
   */
  recordPush(project: ProjectContext, actor: Actor, input: AttemptInput & { updates: PushedRef[] }): PushRecord {
    const current = this.#attempt(input);
    return this.#sql.transaction(() => {
      const head = this.#recordPushed(actor, current, input.updates);
      const needsReview = head !== null && this.#pushedToSource(actor, current, head);
      const merge_request = this.#pushNotice(current, needsReview ? head : null);
      if (head === null) return { scoring: null, merge_request };
      // A draft isn't scored, but its old result no longer describes its head.
      if (current.state !== "open") {
        this.scoring.moveHead({ ...scoredAttempt(current), sha: head });
        return { scoring: null, merge_request };
      }
      return { scoring: this.#request(project, actor, current, head, "push"), merge_request };
    });
  }

  /**
   * What a push to the attempt has to tell its pusher about the merge request it is the source of:
   * a dequeue they haven't been told of (marked told), and the new head if this push moved it to
   * `needs_review`. A `new_push` dequeue is this push's own doing, which `needs_review` already says.
   */
  #pushNotice(attempt: StoredAttempt, needsReview: string | null): PushNotice | null {
    const mr = this.mergeRequests.forAttempt(attempt.task, attempt.number);
    if (mr === null) return null;
    const unseen = this.mergeRequests.takeUnseenDequeue(mr);
    const dequeue =
      unseen === null || unseen.reason === "new_push" ? null : { reason: unseen.reason, files: fileCount(unseen) };
    if (dequeue === null && needsReview === null) return null;
    return { task: mr.task, dequeue, needs_review: needsReview };
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
  ): Promise<{ task: StoredTask; attempt: StoredAttempt; scoring: ScoringRequest }> {
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
      const attempt = this.#attempt({ task: row.task, number: row.attempt });
      this.#recordPushed(actor, attempt, input.updates);
      this.#dropBranchPush(attempt);
      const scoring = this.#request(project, actor, attempt, input.head, "open");
      return { task: this.#task(row.task), attempt: this.#attempt(attempt), scoring };
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

  /** Whether a task has an open merge request; such a task takes no new attempts. */
  hasOpenMergeRequest(_project: ProjectContext, _actor: Actor, input: { task: number }): boolean {
    this.#task(input.task);
    return this.mergeRequests.open(input.task) !== null;
  }

  // --- merge requests --------------------------------------------------------------------------
  //
  // A task's selection makes one open attempt its merge request, approving its current head, and
  // closes its other active attempts. The merge request enters the queue once its approved head's
  // latest scoring run is done with a passing gate, checked on selection, on approval and whenever
  // a run finishes (`scoringFinished`). A push to the source needs a new approval; ending the source
  // cancels it. Landings (below) move the front of the queue to `landing` and start its Landing
  // Workflow, whose report merges it (`landMergeRequest`) or dequeues it (`dequeueMergeRequest`).

  /**
   * Selects an open attempt of an open task as its merge request, approving the attempt's current
   * head, and closes the task's other active attempts (archived once this commits). The merge
   * request is `pending`, or `queued` if its head's gate has already passed. The task's creator or
   * the project owner (or their agents) may; the creator may select their own attempt.
   */
  async selectAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredMergeRequest> {
    const current = this.#attempt(input);
    const task = this.#task(current.task);
    this.#mayManageTask(project, actor, task);
    this.#checkSelectable(current);
    const head = await this.#currentHead(project, current);
    const { mr, closed } = this.#sql.transaction(() => {
      // The attempt, the task or its merge requests may have moved while the head was read.
      this.#checkSelectable(this.#attempt(current));
      const created = this.mergeRequests.select(actor, { task: current.task, attempt: current.number, head });
      const others = this.#activeAttempts(current.task).filter((a) => a.number !== current.number);
      for (const other of others) this.#endAttempt(actor, other, "closed");
      return { mr: this.#evaluate(actor, created), closed: others };
    });
    await this.#archive(project, closed);
    return mr;
  }

  /**
   * Approves the source attempt's current head: `needs_review` → `pending`. From `pending` it
   * re-approves the same head, which lets a merge request held after a dequeue (an `errored` one,
   * say) requeue. Either way the gate is checked again. The task's creator or the project owner may.
   */
  async approveMergeRequest(
    project: ProjectContext,
    actor: Actor,
    input: { task: number },
  ): Promise<StoredMergeRequest> {
    const task = this.#task(input.task);
    this.#mayManageTask(project, actor, task);
    const mr = this.#openMergeRequest(task.number);
    this.#expectMergeRequest(mr, ["pending", "needs_review"], "approve");
    const head =
      mr.state === "pending" ? mr.approved_head : await this.#currentHead(project, this.#attempt(sourceOf(mr)));
    return this.#sql.transaction(() => {
      const now = this.#openMergeRequest(task.number);
      if (now.id !== mr.id || now.state !== mr.state) {
        throw invalidState(`${taskRef(task.number)}'s merge request moved; try again`);
      }
      return this.#evaluate(actor, this.mergeRequests.approve(actor, now, head));
    });
  }

  /**
   * Cancels the task's open merge request from any open state, dequeuing it (`cancelled`) if it was
   * in the queue. The task stays open and can be selected again. The task's creator or the project
   * owner may.
   */
  cancelMergeRequest(project: ProjectContext, actor: Actor, input: { task: number }): StoredMergeRequest {
    const task = this.#task(input.task);
    this.#mayManageTask(project, actor, task);
    return this.#sql.transaction(() => this.#cancel(actor, this.#openMergeRequest(task.number)));
  }

  /** The task's latest merge request, open or not. Anyone signed in may read it. */
  getMergeRequest(_project: ProjectContext, _actor: Actor, input: { task: number }): StoredMergeRequest {
    this.#task(input.task);
    const mr = this.mergeRequests.latest(input.task);
    if (mr === null) throw new ServiceError("not_found", `${taskRef(input.task)} has no merge request`);
    return mr;
  }

  /**
   * Where the log `name` of the retest that dequeued the task's merge request with `failed_checks`
   * is stored. Anyone signed in may read it. `not_found` unless its latest dequeue is `failed_checks`
   * with a stored log by that name.
   */
  dequeueLogKey(project: ProjectContext, actor: Actor, input: { task: number; name: string }): string {
    const mr = this.getMergeRequest(project, actor, input);
    const dequeue = mr.last_dequeue;
    const missing = new ServiceError("not_found", `${taskRef(input.task)}'s last dequeue has no log ${input.name}`);
    if (dequeue?.reason !== "failed_checks" || !isLogName(input.name)) throw missing;
    if (!dequeue.details.checks.some((check) => check.log === input.name)) throw missing;
    const landing = this.landings.lastDequeued(mr.id);
    if (landing === null) throw missing;
    return landingLogKey(
      { project: project.id, task: mr.task, attempt: mr.attempt, head: landing.head, landing: landing.id },
      input.name,
    );
  }

  /** The project's merge queue: the landing merge request first, then the queued ones, first in first out. */
  mergeQueue(_project: ProjectContext, _actor: Actor): StoredMergeRequest[] {
    return this.mergeRequests.queue();
  }

  /**
   * Records how a scoring run ended (see `ScoringQueue.finish`), then checks whether the merge
   * request its attempt is the source of can enter the queue. Returns whether the run was recorded.
   */
  scoringFinished(run: number, outcome: ScoringOutcome): boolean {
    return this.#sql.transaction(() => {
      if (!this.scoring.finish(run, outcome)) return false;
      const finished = this.scoring.getRun(run);
      if (finished === null) return true;
      const mr = this.mergeRequests.open(finished.task);
      if (mr !== null && mr.attempt === finished.attempt) this.#evaluate(null, mr);
      return true;
    });
  }

  /**
   * For the merge queue: when nothing is landing, moves the front of the queue to `landing` and
   * returns it; otherwise null. The caller starts its Landing Workflow.
   */
  startLanding(_project: ProjectContext, actor: Actor | null): StoredMergeRequest | null {
    return this.#sql.transaction(() => {
      const [front] = this.mergeRequests.queue();
      if (front === undefined || front.state !== "queued") return null;
      return this.mergeRequests.startLanding(actor, front);
    });
  }

  /**
   * For the merge queue: takes a queued or landing merge request out of the queue for `conflict`,
   * `failed_checks` or `errored`, back to `pending` with its approval kept. It requeues only on a
   * new approval, or after a push and its approval.
   */
  dequeueMergeRequest(
    _project: ProjectContext,
    actor: Actor | null,
    { task, ...cause }: { task: number } & Extract<DequeueCause, { details: unknown }>,
  ): StoredMergeRequest {
    return this.#sql.transaction(() => {
      const mr = this.#openMergeRequest(task);
      this.#expectMergeRequest(mr, ["queued", "landing"], "dequeue");
      return this.mergeRequests.dequeue(actor, mr, cause, "pending");
    });
  }

  /**
   * For the merge queue: a landing merge request landed at `sha`. It becomes `merged`, and its
   * source attempt is marked merged and its task closed (as `markMerged` does), in one transaction.
   */
  async landMergeRequest(
    project: ProjectContext,
    actor: Actor | null,
    input: { task: number; sha: string },
  ): Promise<StoredMergeRequest> {
    const mr = this.#openMergeRequest(input.task);
    this.#expectMergeRequest(mr, ["landing"], "land");
    const source = this.#attempt(sourceOf(mr));
    this.#checkMergeable(source);
    const merged = this.#sql.transaction(() => {
      const landed = this.mergeRequests.merged(actor, mr, input.sha);
      this.#markMergedRows(actor, source, input.sha);
      return landed;
    });
    await this.#archive(project, [source]);
    return merged;
  }

  // --- landings --------------------------------------------------------------------------------
  //
  // The Durable Object calls `drain` after every store call and report. It stops the Landing
  // Workflow of a merge request that left the queue (a new push or a cancel) before its land step
  // claimed the push to main, then starts one for the front of the queue when nothing is landing
  // and a Sandbox slot is free, then starts scoring runs. A landing takes a slot under the cap ahead
  // of waiting scoring runs: while one is landing or waiting to, scoring leaves it a slot.

  /** Stops stale landings, starts the next one, then drains the scoring queue. */
  async drain(project: string): Promise<void> {
    await this.#drainLandings(project);
    await this.scoring.drain();
  }

  /**
   * For the Landing Workflow's land step, right before it pushes: claims the push (again, for a retried step), so the merge
   * request can no longer be dequeued by a push or cancelled, and the result of the push to main is
   * what gets recorded. False when the landing was stopped; it must not push.
   */
  claimLandingPush(landing: number): boolean {
    return this.#sql.transaction(() => {
      const current = this.landings.get(landing);
      if (current === null || !this.#landingCurrent(current)) return false;
      if (current.status === "pushing") return true;
      if (current.status !== "running") return false;
      this.landings.move(landing, "pushing");
      return true;
    });
  }

  /**
   * Records how a landing ended, from its Workflow's report: `landed` merges the merge request (its
   * source attempt merged, its task closed, its fork archived) and journals `main_advanced`; any
   * other outcome dequeues it with that reason and its details, back to `pending`, or to
   * `needs_review` if its source moved while it was pushing. A report from a landing that was stopped,
   * or already reported, is discarded. Returns whether it was recorded. The caller drains afterwards,
   * which starts the next landing.
   */
  async landingFinished(landing: number, outcome: LandingOutcome): Promise<boolean> {
    const current = this.landings.get(landing);
    if (current === null || (current.status !== "running" && current.status !== "pushing")) {
      console.log({ event: "landing.discarded_report", landing, status: current?.status ?? null });
      return false;
    }
    if (!this.#landingCurrent(current)) {
      this.#sql.transaction(() => this.landings.move(landing, "stopped"));
      return false;
    }
    const project = { id: current.project, owner: "" };
    if (outcome.kind === "landed") {
      await this.landMergeRequest(project, null, { task: current.task, sha: outcome.sha });
      this.landings.move(landing, "landed");
      this.#journal(null, "main_advanced", current.task, current.attempt, {
        merge_request: taskRef(current.task),
        head: current.head,
        sha: outcome.sha,
      });
      return true;
    }
    this.#sql.transaction(() => {
      this.landings.move(landing, "dequeued");
      const mr = this.#openMergeRequest(current.task);
      const source = this.#attempt(sourceOf(mr));
      const moved = this.scoring.statusFor(scoredAttempt(source)).sha !== mr.approved_head;
      this.mergeRequests.dequeue(null, mr, dequeueCause(outcome), moved ? "needs_review" : "pending");
    });
    return true;
  }

  /** The landing's merge request is still open and landing. */
  #landingCurrent(landing: StoredLanding): boolean {
    const mr = this.mergeRequests.open(landing.task);
    return mr !== null && mr.id === landing.merge_request && mr.state === "landing";
  }

  /** Whether the merge request's landing has claimed its push to main. */
  #pushing(mr: StoredMergeRequest): boolean {
    if (mr.state !== "landing") return false;
    const active = this.landings.active();
    return active?.merge_request === mr.id && active.status === "pushing";
  }

  /** The Sandbox slot the merge queue holds: one while a landing is in flight or the queue is waiting to start one. */
  #landingSlots(): number {
    if (this.#landing === null) return 0;
    return this.landings.active() !== null || this.mergeRequests.queue().length > 0 ? 1 : 0;
  }

  async #drainLandings(project: string): Promise<void> {
    const runner = this.#landing;
    if (runner === null) return;
    const stopping = this.#sql.transaction(() => {
      const active = this.landings.active();
      if (active?.status === "running" && !this.#landingCurrent(active)) this.landings.move(active.id, "stopped");
      return this.landings.claimStopped();
    });
    await Promise.all(stopping.map((landing) => this.#stopLanding(runner, landing)));

    const started = this.#sql.transaction(() => this.#startLanding(project));
    if (started === null) return;
    try {
      await runner.workflow.create({ id: started.instance_id, params: started.params });
    } catch (cause) {
      await this.landingFinished(started.id, {
        kind: "errored",
        details: { step: "start", error: String(cause).slice(0, 2000) },
      });
      await this.#drainLandings(project);
      return;
    }
    // A push or cancel may have dequeued it while its Workflow was being created.
    if (this.landings.get(started.id)?.status === "running" && !this.#landingCurrent(started)) {
      await this.#drainLandings(project);
    }
  }

  /**
   * Starts a landing for the front of the queue when nothing is landing and a Sandbox slot is free:
   * moves it to `landing` and records the landing with what its Workflow needs.
   */
  #startLanding(project: string): (StoredLanding & { params: LandingParams }) | null {
    if (this.landings.active() !== null) return null;
    if (this.scoring.running() >= SCORING_CAP) return null;
    const [front] = this.mergeRequests.queue();
    if (front === undefined) return null;
    // A merge request already landing without a landing in flight (one started before landings were
    // recorded) gets one now.
    const mr = front.state === "queued" ? this.mergeRequests.startLanding(null, front) : front;
    const landing = this.landings.start(
      { project, task: mr.task, attempt: mr.attempt, merge_request: mr.id, head: mr.approved_head },
      (id) => `${forkRepo(project, attemptRef(mr.task, mr.attempt))}-landing-${id}`,
    );
    const coAuthors = this.#sql.exec<{ user: string; agent: string }>(
      `SELECT user_id AS user, agent FROM journal WHERE kind = 'pushed' AND task = ? AND attempt = ?
         AND user_id IS NOT NULL AND agent IS NOT NULL GROUP BY user_id, agent ORDER BY MIN(id)`,
      mr.task,
      mr.attempt,
    );
    const params: LandingParams = {
      project,
      landing: landing.id,
      task: mr.task,
      attempt: mr.attempt,
      title: this.#task(mr.task).title,
      head: mr.approved_head,
      approver: mr.approved_by,
      coAuthors: coAuthors.map(({ user, agent }) => ({ user, agent })),
      startedAt: landing.started_at,
    };
    return { ...landing, params };
  }

  async #stopLanding(runner: LandingRunner, landing: StoredLanding): Promise<void> {
    try {
      const instance = await runner.workflow.get(landing.instance_id);
      await instance.terminate();
      await runner.teardown(landing.instance_id);
    } catch (cause) {
      // It may already have ended; its report is discarded either way.
      console.warn({ event: "landing.stop_failed", instance_id: landing.instance_id, error: String(cause) });
    }
  }

  // --- internals -------------------------------------------------------------------------------

  #task(number: number): StoredTask {
    const [row] = this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", number);
    if (row === undefined) throw new ServiceError("not_found", `no task ${taskRef(number)}`);
    return toTask(row);
  }

  #openMergeRequest(task: number): StoredMergeRequest {
    const mr = this.mergeRequests.open(task);
    if (mr === null) throw invalidState(`${taskRef(task)} has no open merge request`);
    return mr;
  }

  #expectMergeRequest(mr: StoredMergeRequest, from: readonly MergeRequestState[], verb: string): void {
    if (from.includes(mr.state)) return;
    throw invalidState(`can't ${verb} ${taskRef(mr.task)}'s merge request: it is ${mr.state}`);
  }

  /** An attempt may be selected while it is open, on an open task with no open merge request. */
  #checkSelectable(attempt: StoredAttempt): void {
    this.#expect(attempt, ["open"], "select");
    this.#expect(this.#task(attempt.task), ["open"], "select an attempt of");
    if (this.mergeRequests.open(attempt.task) !== null) {
      throw invalidState(`${taskRef(attempt.task)} already has an open merge request`);
    }
  }

  /** A task with an open merge request takes no new or reopened attempts. */
  #checkNoMergeRequest(task: number): void {
    if (this.mergeRequests.open(task) === null) return;
    throw invalidState(`${taskRef(task)} has an open merge request, so it takes no new attempts`);
  }

  /**
   * pending → queued when the merge request isn't held after a dequeue, its source attempt is open,
   * the approved head is still the attempt's head, and that head's latest scoring run is done with
   * a passing gate. Returns the merge request as it is afterwards.
   */
  #evaluate(actor: Actor | null, mr: StoredMergeRequest): StoredMergeRequest {
    if (mr.state !== "pending" || this.mergeRequests.held(mr)) return mr;
    const source = this.#attempt(sourceOf(mr));
    if (source.state !== "open") return mr;
    const { status, sha } = this.scoring.statusFor(scoredAttempt(source));
    if (sha !== mr.approved_head || status !== "done") return mr;
    if (this.scoring.currentRun(scoredAttempt(source))?.result?.gate !== "passed") return mr;
    return this.mergeRequests.enqueue(actor, mr);
  }

  /**
   * A push moved the attempt's head: if it is an open merge request's source, that needs a new
   * approval. True when this moved the merge request to `needs_review`.
   */
  #pushedToSource(actor: Actor, attempt: StoredAttempt, head: string): boolean {
    const mr = this.mergeRequests.open(attempt.task);
    if (mr === null || mr.attempt !== attempt.number || mr.state === "needs_review") return false;
    if (head === mr.approved_head) return false;
    // A landing pushing to main lands the approved head; the compare-and-swap on main decides.
    if (this.#pushing(mr)) return false;
    if (mr.state === "queued" || mr.state === "landing") {
      this.mergeRequests.dequeue(actor, mr, { reason: "new_push" }, "needs_review");
    } else {
      this.mergeRequests.move(actor, mr, "needs_review", { head });
    }
    return true;
  }

  /** Cancels an open merge request, dequeuing it if it is in the queue. */
  #cancel(actor: Actor | null, mr: StoredMergeRequest): StoredMergeRequest {
    if (this.#pushing(mr)) {
      throw invalidState(`${taskRef(mr.task)}'s merge request is landing on main; try again once it has landed`);
    }
    if (mr.state === "queued" || mr.state === "landing") {
      return this.mergeRequests.dequeue(actor, mr, { reason: "cancelled" }, "cancelled");
    }
    return this.mergeRequests.move(actor, mr, "cancelled");
  }

  /**
   * The attempt's current head: the one its pushes and scoring last recorded, or else its fork's
   * `main`. An attempt with no commits has none to approve.
   */
  async #currentHead(project: ProjectContext, attempt: StoredAttempt): Promise<string> {
    const known = this.scoring.statusFor(scoredAttempt(attempt)).sha;
    if (known !== null) return known;
    const [commit] = await this.#repos.listCommits(forkRepo(project.id, attempt.fork), { ref: "main", limit: 1 });
    if (commit === undefined) throw invalidState(`${attempt.fork} has no head to approve; push a commit first`);
    return commit.hash;
  }

  #checkMergeable(attempt: StoredAttempt): void {
    this.#expect(attempt, ["open"], "merge");
    this.#expect(this.#task(attempt.task), ["open"], "merge into");
  }

  #markMergedRows(actor: Actor | null, attempt: StoredAttempt, sha: string): void {
    this.#sql.exec(
      "UPDATE attempts SET state = 'merged', merged_sha = ?, closed_at = ? WHERE task = ? AND number = ?",
      sha,
      this.#stamp(),
      attempt.task,
      attempt.number,
    );
    this.#journal(actor, "merged", attempt.task, attempt.number, { sha });
    this.scoring.cancelAttempt(scoredAttempt(attempt), "attempt merged");
    this.#endTask(actor, attempt.task, "closed");
  }

  #attempt({ task, number }: AttemptInput): StoredAttempt {
    const [row] = this.#sql.exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? AND number = ?", task, number);
    if (row === undefined) throw new ServiceError("not_found", `no attempt ${attemptRef(task, number)}`);
    return this.#toAttempt(row);
  }

  #toAttempt(row: AttemptRow): StoredAttempt {
    const mr = this.mergeRequests.forAttempt(row.task, row.number);
    return {
      ...toAttempt(row),
      scoring: this.scoring.statusFor(scoredAttempt(row)),
      merge_request:
        mr === null
          ? null
          : { state: mr.state, last_dequeue: mr.last_dequeue === null ? null : { reason: mr.last_dequeue.reason } },
    };
  }

  #activeAttempts(task: number): StoredAttempt[] {
    return this.#sql
      .exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? AND state IN ('draft', 'open') ORDER BY number", task)
      .map((row) => this.#toAttempt(row));
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

  /**
   * Journals every ref a push updated on an attempt's fork. The proxy records each accepted push
   * once, so nothing is deduped here: a force-push back to an earlier commit is journalled too.
   * Returns the fork's new head when the push moved it, or null.
   */
  #recordPushed(actor: Actor, attempt: StoredAttempt, updates: PushedRef[]): string | null {
    let head: string | null = null;
    for (const { ref, before, after } of updates) {
      if (ref === FORK_HEAD && !isZeroId(after)) head = after;
      this.#journal(actor, "pushed", attempt.task, attempt.number, { git_ref: ref, before, after });
    }
    return head;
  }

  /**
   * Requests scoring of the attempt's current head, read from its fork. Null when there is none to
   * score: the fork has no commits, or it couldn't be read (logged; a rescore can ask again). A
   * push recorded while the head is read queues its own run, which the request then yields to.
   */
  async #scoreHead(
    project: ProjectContext,
    actor: Actor,
    attempt: StoredAttempt,
    trigger: ScoringTrigger,
  ): Promise<ScoringRequest | null> {
    const readSince = this.scoring.latestRunId(scoredAttempt(attempt));
    let head: string | null;
    try {
      const [commit] = await this.#repos.listCommits(forkRepo(project.id, attempt.fork), { ref: "main", limit: 1 });
      head = commit?.hash ?? null;
    } catch (cause) {
      console.error({ event: "scoring.head_unreadable", attempt: attempt.fork, trigger, error: String(cause) });
      return null;
    }
    return head === null ? null : this.#request(project, actor, attempt, head, trigger, readSince);
  }

  #request(
    project: ProjectContext,
    actor: Actor,
    attempt: StoredAttempt,
    sha: string,
    trigger: ScoringTrigger,
    readSince?: number,
  ): ScoringRequest {
    return this.scoring.request({
      project: project.id,
      task: attempt.task,
      attempt: attempt.number,
      sha,
      trigger,
      actor,
      readSince,
    });
  }

  /** A scoring request asked for by a user, or an error saying the attempt has no head to score. */
  #requireHead(request: ScoringRequest | null, attempt: StoredAttempt): ScoringRequest {
    if (request === null) throw invalidState(`${attempt.fork} has no head to score; push a commit, or try again`);
    return request;
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
  #endTask(actor: Actor | null, number: number, to: "closed" | "obsolete"): void {
    this.#sql.exec(
      `UPDATE tasks SET state = ?, closed_at = COALESCE(closed_at, ?), closed_by = COALESCE(closed_by, ?)
       WHERE number = ?`,
      to,
      this.#stamp(),
      actor?.user.id ?? null,
      number,
    );
    this.#journal(actor, to === "closed" ? "closed" : "made_obsolete", number, null);
  }

  /**
   * Moves an attempt to closed or obsolete, which ends its claim: the git proxy refuses its next
   * push. A caller ending an active attempt then runs `#archive` on it, once this has committed.
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
    this.scoring.cancelAttempt(scoredAttempt(current), `attempt ${to}`);
    const mr = this.mergeRequests.open(current.task);
    if (mr !== null && mr.attempt === current.number) this.#cancel(actor, mr);
  }

  /**
   * Archives each ended attempt's fork and then deletes it: pushes the fork's `main` to
   * `refs/attempts/<attempt>` in the origin, records the sha as `archived_sha`, and only then
   * deletes the fork. The attempt has already ended, so its claim is gone and no new push can
   * race the archive.
   *
   * Archiving never fails the close: the state change is what the caller asked for, and it has
   * committed. If the archive fails, the fork is kept (nothing is lost), `archived_sha` stays
   * null, and `attempt.archive_failed` is logged; reopening such an attempt reuses the kept fork.
   */
  async #archive(project: ProjectContext, attempts: StoredAttempt[]): Promise<void> {
    const origin = originRepo(project.id);
    await Promise.all(
      attempts.map(async (attempt) => {
        const fork = forkRepo(project.id, attempt.fork);
        let sha: string | null;
        try {
          sha = await this.#repos.copyRef({
            from: fork,
            fromRef: FORK_HEAD,
            to: origin,
            toRef: archiveRef(attempt.fork),
          });
        } catch (cause) {
          console.error({ event: "attempt.archive_failed", repo: fork, error: String(cause) });
          return;
        }
        if (sha !== null) {
          this.#sql.exec(
            "UPDATE attempts SET archived_sha = ? WHERE task = ? AND number = ?",
            sha,
            attempt.task,
            attempt.number,
          );
        }
        await this.#deleteForks(project, attempt.task, [attempt.number]);
      }),
    );
  }

  /**
   * Makes a closed attempt's fork again for reopening, and returns whether it made one. A fork
   * that still exists (its archive failed on close) is kept as it is. A new fork starts from the
   * origin's `main` and has its `main` force-set to `archived_sha`, read back from the archive ref.
   * If the restore fails the new fork is deleted again and the reopen fails.
   */
  async #restore(project: ProjectContext, attempt: StoredAttempt): Promise<boolean> {
    const origin = originRepo(project.id);
    const fork = forkRepo(project.id, attempt.fork);
    try {
      await this.#repos.fork(origin, fork);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ALREADY_EXISTS") return false;
      throw err;
    }
    if (attempt.archived_sha === null) return true;
    try {
      await this.#untilReady(() =>
        this.#repos.copyRef({
          from: origin,
          fromRef: archiveRef(attempt.fork),
          to: fork,
          toRef: FORK_HEAD,
          expect: attempt.archived_sha ?? undefined,
        }),
      );
    } catch (cause) {
      await this.#deleteForks(project, attempt.task, [attempt.number]);
      console.error({ event: "attempt.restore_failed", repo: fork, error: String(cause) });
      throw new ServiceError("internal", `couldn't restore ${attempt.fork} from its archive; it is still closed`);
    }
    return true;
  }

  /** Runs `work`, retrying with backoff while a just-made fork isn't ready yet. */
  async #untilReady<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (attempt >= FORK_READY_RETRIES || (code !== "FORK_IN_PROGRESS" && code !== "NOT_FOUND")) throw err;
        await new Promise((resolve) => setTimeout(resolve, FORK_READY_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  /** Reopening may not take a branch another active attempt holds now. */
  #checkReopenBranch(current: StoredAttempt): void {
    if (current.branch === null) return;
    const [taken] = this.#sql.exec<AttemptRow>(
      "SELECT * FROM attempts WHERE branch = ? AND state IN ('draft', 'open')",
      current.branch,
    );
    if (taken !== undefined || this.#branchPush(current.branch) !== undefined) {
      throw new ServiceError("conflict", `another active attempt has branch ${current.branch}`);
    }
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
    actor: Actor | null,
    kind: TaskEvent | MergeRequestEvent | "main_advanced",
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
      actor?.user.id ?? null,
      actor?.agent ?? null,
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
  "listProjectAttempts",
  "getScoring",
  "taskArena",
  "listScoringRuns",
  "getScoringRun",
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
  "selectAttempt",
  "approveMergeRequest",
  "cancelMergeRequest",
  "getMergeRequest",
  "dequeueLogKey",
  "mergeQueue",
  "scoreNow",
  "rescore",
  "runLogKey",
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

function toAttempt(row: AttemptRow): Omit<StoredAttempt, "scoring" | "merge_request"> {
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

function sourceOf(mr: StoredMergeRequest): AttemptInput {
  return { task: mr.task, number: mr.attempt };
}

function invalidState(message: string): ServiceError {
  return new ServiceError("invalid_state", message);
}
