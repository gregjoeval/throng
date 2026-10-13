// Tasks and attempts, kept in the project Durable Object's SQLite: the source of truth for both,
// their per-project counters and the journal of their transitions. This module holds the state
// machine and the P0 permission rules; `ProjectCoordinator` runs it inside the Durable Object, and
// tests run it over local SQLite. The `tasks.ts` service resolves projects and calls it.
//
// Users are stored by id only, so renaming a handle never rewrites history; the service resolves
// handles when it answers.

import { archiveRef } from "./archive.ts";
import { containsCommit, taskBranchHead } from "./base.ts";
import { migrateValues, normaliseLandingOutcome } from "./casing.ts";
import { addColumns, renameColumns } from "./columns.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import type { ConfigResult } from "./config.ts";
import { ServiceError } from "./errors.ts";
import type { ErrorCode } from "./errors.ts";
import { Follows } from "./follows.ts";
import type { FollowOutcome, FollowParams, FollowRunner, StoredFollow } from "./follows.ts";
import type { LandingOutcome, LandingParams, LandingRunner } from "./landing.ts";
import { Landings } from "./landings.ts";
import type { StoredLanding } from "./landings.ts";
import { isLogName, landingLogKey, logKey, missingLog } from "./logs.ts";
import { dequeueCause, MergeRequests } from "./merge-requests.ts";
import type {
  Dequeue,
  DequeueCause,
  DequeueReason,
  MergeRequestEvent,
  MergeRequestState,
  StoredMergeRequest,
} from "./merge-requests.ts";
import { isZeroId } from "./pkt-line.ts";
import { forkRepo, originRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";
import { GATES } from "./results.ts";
import type { Gate } from "./results.ts";
import { headAttemptRef, SCORING_CAP, ScoringQueue } from "./scoring.ts";
import type {
  AttemptScoring,
  ScoredAttempt,
  ScoringOutcome,
  ScoringRequest,
  ScoringRunner,
  ScoringTrigger,
  StoredRun,
} from "./scoring.ts";
import { attemptRef, reservedTask, taskBranchRef, taskRef } from "./task-refs.ts";
import type { Actor } from "./tokens.ts";
import { Verdicts } from "./verdicts.ts";
import type { StoredVerdict, VerdictRecommendation, VerdictSummary } from "./verdicts.ts";
import { alreadyMet, Waiters, watchChanged } from "./waiters.ts";
import type { AttemptWatch, WaitCondition } from "./waiters.ts";

/** Active attempts a task may have when neither the project config nor the task overrides it. */
export const DEFAULT_ATTEMPT_LIMIT = 10;

export const TASK_STATES = ["open", "closed", "obsolete"] as const;
export const ATTEMPT_STATES = ["draft", "open", "merged", "closed", "obsolete"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** Draft and open attempts are active: they have a fork and a claim, and count toward the cap. */
const ACTIVE = ["draft", "open"] as const;

export const isActive = (state: AttemptState): boolean => (ACTIVE as readonly AttemptState[]).includes(state);

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
  /** The alias the author started it under (`claude`), or null: started as themselves, or handed off since. */
  alias: string | null;
  state: AttemptState;
  /** The logical fork name, `t42a3`; its repo is `<projectId>-t42a3`. */
  fork: string;
  branch: string | null;
  note: string;
  created_at: string;
  closed_at: string | null;
  merged_sha: string | null;
  archived_sha: string | null;
  /**
   * The attempt of the same task this one was copied from when it was started (`t42a1`), or null.
   * Provenance only: it is never this attempt's base.
   */
  forked_from: string | null;
  /**
   * True while its task branch has moved and merging it in conflicted (ADR 0003). It clears once its
   * history contains that task head: its author merges the task branch and pushes.
   */
  needs_update: boolean;
  /** Its current head's scoring status, for polling. */
  scoring: AttemptScoring;
  /** The latest merge request it is the source of, if any, for polling: its state and last dequeue reason. */
  merge_request: AttemptMergeRequest | null;
  /** Its verdicts on its current head, counted by recommendation. */
  verdicts: VerdictSummary;
}

/** A task as the task list shows it: with what its rows summarise, so the list is one call. */
export interface ListedTask extends StoredTask {
  /** Its attempts, obsolete ones left out. */
  attempt_count: number;
  /** `passed` when any of those attempts' current results passed, else `failed` when any failed, else null. */
  best_gate: Gate | null;
  /** Its latest merge request's state, or null when it has none. */
  merge_request_state: MergeRequestState | null;
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

/** The part of a project's context that work done for no user (a follow, a landing) has. */
type ProjectId = Pick<ProjectContext, "id">;

/** Journal events for tasks and attempts, as the spec names them. */
export type TaskEvent =
  | "created"
  | "opened"
  | "returnedToDraft"
  | "closed"
  | "reopened"
  | "handedOff"
  | "merged"
  | "madeObsolete"
  | "restored"
  | "pushed"
  | "verdictPosted"
  | "taskBranchPushed"
  | "needsUpdate";

/** The slice of SQLite the store needs: Durable Object storage in production, `node:sqlite` in tests. */
export interface Sql {
  /** Runs one statement and returns its rows. */
  exec: <T>(query: string, ...bindings: unknown[]) => T[];
  /** Runs `fn` atomically: its writes all commit, or none do if it throws. */
  transaction: <T>(fn: () => T) => T;
}

/**
 * What `recordPush` did: the scoring it queued, what to tell the pusher of their merge request, and
 * the attempt's new head, which the proxy checks (`followIfDropped`) once git has its reply; null
 * when the push didn't move it.
 */
export interface PushRecord {
  scoring: ScoringRequest | null;
  mergeRequest: PushNotice | null;
  head: string | null;
}

/** The merge request news a push to its source attempt carries back to the pusher. */
export interface PushNotice {
  task: number;
  /** A dequeue not yet reported, with its conflict file count when known. */
  dequeue: { reason: DequeueReason; files: number | null } | null;
  /** The new head, when this push moved the merge request to `needsReview`. */
  needsReview: string | null;
}

/** How many files a dequeue's details name (a conflict's), or null when they name none. */
function fileCount(dequeue: Dequeue): number | null {
  return dequeue.reason === "conflict" ? dequeue.details.files.length : null;
}

/** An attempt as the scoring queue keys it. */
function scoredAttempt({ task, number }: AttemptInput): ScoredAttempt {
  return { task, attempt: number };
}

// ---------------------------------------------------------------------------------------------
// Inputs

export interface CreateTaskInput {
  title: string;
  body?: string | undefined;
  attemptLimit?: number | null | undefined;
}

export interface EditTaskInput {
  task: number;
  title?: string | undefined;
  body?: string | undefined;
  attemptLimit?: number | null | undefined;
}

export interface CreateAttemptsInput {
  task: number;
  count?: number | undefined;
  note?: string | undefined;
  /** The origin branch a push created this attempt from. Internal: the API doesn't take it. */
  branch?: string | undefined;
  /** An attempt of the same task, current or archived, whose head each new attempt starts at. */
  from?: AttemptInput | undefined;
}

export interface AttemptInput {
  task: number;
  number: number;
}

export interface PostVerdictInput extends AttemptInput {
  recommendation: VerdictRecommendation;
  body: string;
}

/** A verdict, and whether its head is no longer the attempt's current head. */
export interface VerdictDetail extends StoredVerdict {
  superseded: boolean;
}

/**
 * Where a push of an origin branch goes: the pusher's own active attempt on that branch, or a new
 * attempt (on a new task, or on `t<n>` for a `t<n>/` branch) whose fork has just been made.
 */
export type BranchRoute =
  | { kind: "attempt"; attempt: StoredAttempt }
  | { kind: "create"; task: number; number: number; newTask: boolean };

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
  /** The head its task branch's last recorded push left, or null when it has none. */
  task_head: string | null;
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
  alias: string | null;
  state: AttemptState;
  branch: string | null;
  note: string;
  created_at: string;
  closed_at: string | null;
  merged_sha: string | null;
  archived_sha: string | null;
  /** The number of the attempt of the same task it was forked from. */
  forked_from: number | null;
  /** The task head merging in conflicted, while it needs update. */
  needs_update: string | null;
  /** The head a follow last wrote to its fork, until its author pushes again. */
  followed_head: string | null;
  /** A head of the attempt known to contain its task head, where checking a later push stops. */
  contains_task_head: string | null;
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
    attempt_limit INTEGER,
    task_head TEXT
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
    forked_from INTEGER,
    needs_update TEXT,
    followed_head TEXT,
    alias TEXT,
    contains_task_head TEXT,
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
const JOURNAL_COLUMNS = ["user_id TEXT", "alias TEXT", "task INTEGER", "attempt INTEGER"];

/** The journal's `agent` column, from before an actor's alias was called an alias. */
const JOURNAL_RENAMES = [["agent", "alias"]] as const;

/** Columns added to tasks after their table was made: the head of its task branch. */
const TASK_COLUMNS = ["task_head TEXT"];

/**
 * Columns added to attempts after their table was made: where a forked attempt was copied from, how
 * it follows its task branch, and the alias its author started it under.
 */
const ATTEMPT_COLUMNS = [
  "forked_from INTEGER",
  "needs_update TEXT",
  "followed_head TEXT",
  "alias TEXT",
  "contains_task_head TEXT",
];

/**
 * Creates the store's tables, adds the journal's and attempts' newer columns to tables that predate
 * them, and drops the spike's tables.
 */
export function migrate(sql: Sql): void {
  for (const statement of SCHEMA) sql.exec(statement);
  for (const table of DROPPED_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  renameColumns(sql, "journal", JOURNAL_RENAMES);
  addColumns(sql, "journal", JOURNAL_COLUMNS);
  if (addColumns(sql, "tasks", TASK_COLUMNS).includes("task_head")) {
    // Tasks whose task branch was pushed before `task_head` take it from their latest push.
    sql.exec(
      `UPDATE tasks SET task_head = (
         SELECT json_extract(detail, '$.head') FROM journal
         WHERE kind = 'taskBranchPushed' AND journal.task = tasks.number ORDER BY id DESC LIMIT 1
       )`,
    );
  }
  const added = addColumns(sql, "attempts", ATTEMPT_COLUMNS);
  if (added.includes("alias")) {
    // Attempts made before `alias` take it from their `created` entry (renamed above), unless handed off since.
    sql.exec(
      `UPDATE attempts SET alias = (
         SELECT alias FROM journal WHERE kind = 'created' AND journal.task = attempts.task AND journal.attempt = attempts.number
       )
       WHERE NOT EXISTS (
         SELECT 1 FROM journal WHERE kind = 'handedOff' AND journal.task = attempts.task AND journal.attempt = attempts.number
       )`,
    );
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
  /** Starts Follow Workflows, which merge a moved task branch into active attempts; without one, follows stay queued. */
  follow?: FollowRunner | null | undefined;
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
  /** The project's verdicts. */
  readonly verdicts: Verdicts;
  readonly #landing: LandingRunner | null;
  /** Active attempts' follows of their task branch. */
  readonly follows: Follows;
  readonly #follow: FollowRunner | null;
  /** Requests waiting on an attempt to change. */
  readonly #waiters = new Waiters();

  constructor({ sql, repos, now = () => new Date(), scoring = null, landing = null, follow = null }: TaskStoreDeps) {
    this.#sql = sql;
    this.#repos = repos;
    this.#now = now;
    this.#landing = landing;
    this.#follow = follow;
    migrate(sql);
    this.landings = new Landings({ sql, now });
    this.follows = new Follows({ sql, now, taskHead: (task) => this.#taskHead(task) });
    this.verdicts = new Verdicts({ sql });
    this.scoring = new ScoringQueue({
      sql,
      runner: scoring,
      now,
      reserved: () => this.#landingSlots() + this.follows.running(),
    });
    this.mergeRequests = new MergeRequests({
      sql,
      now,
      journal: (actor, kind, mr, detail) =>
        this.#journal(actor, kind, mr.task, mr.attempt, { mergeRequest: taskRef(mr.task), ...detail }),
    });
    migrateValues(sql);
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
        input.attemptLimit ?? null,
      );
      this.#journal(actor, "created", number, null);
      return this.#task(number);
    });
  }

  getTask(_project: ProjectContext, _actor: Actor, input: { task: number }): StoredTask {
    return this.#task(input.task);
  }

  /** The project's tasks by number. Obsolete tasks are left out unless `state` asks for them. */
  listTasks(_project: ProjectContext, _actor: Actor, input: { state?: TaskState | undefined }): ListedTask[] {
    const rows =
      input.state === undefined
        ? this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE state != 'obsolete' ORDER BY number")
        : this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE state = ? ORDER BY number", input.state);
    return rows.map((row) => this.#listed(toTask(row)));
  }

  /** The task with its attempt count, best gate and latest merge request's state. */
  #listed(task: StoredTask): ListedTask {
    const attempts = this.#sql
      .exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? AND state != 'obsolete'", task.number)
      .map((row) => toAttempt(row));
    const gates = attempts.map((a) => this.scoring.currentRun(scoredAttempt(a))?.result?.gate);
    // `passed` is best, then `failed`; GATES lists them in that order.
    return {
      ...task,
      attempt_count: attempts.length,
      best_gate: GATES.find((gate) => gates.includes(gate)) ?? null,
      merge_request_state: this.mergeRequests.latest(task.number)?.state ?? null,
    };
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
      input.attemptLimit === undefined ? current.attempt_limit : input.attemptLimit,
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
   * Creates `count` draft attempts on an open task, authored by the actor's user, each with a
   * fork of the origin. Any signed-in user may. Either every attempt is created or none is: the cap
   * is checked for the whole batch, and if any fork fails the others are deleted again.
   *
   * Numbers are drawn before the forks are made and are never handed out again, even when the
   * batch fails, so a failed batch leaves a gap rather than a number that could name two forks.
   */
  async createAttempts(project: ProjectContext, actor: Actor, input: CreateAttemptsInput): Promise<StoredAttempt[]> {
    const count = input.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1) throw new ServiceError("invalidRequest", "count must be at least 1");
    if (input.branch !== undefined) this.#checkBranch(input.task, input.branch, count);
    this.#expect(this.#task(input.task), ["open"], "add attempts to");
    if (input.from !== undefined) this.#checkForkSource(input.task, input.from);

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
        "attemptLimit",
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
      if (input.from !== undefined) await this.#seed(project, input.from, numbers);
      const created = this.#sql.transaction(() => {
        // The task may have been closed while the forks were made.
        this.#expect(this.#task(current.number), ["open"], "add attempts to");
        const at = this.#stamp();
        for (const number of numbers) {
          this.#sql.exec(
            `INSERT INTO attempts (task, number, author, alias, state, branch, note, created_at, forked_from)
             VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
            current.number,
            number,
            actor.user.id,
            actor.alias,
            input.branch ?? null,
            input.note ?? "",
            at,
            input.from?.number ?? null,
          );
          this.#journal(actor, "created", current.number, number);
        }
        return numbers.map((number) => this.#attempt({ task: current.number, number }));
      });
      // A copy of another attempt starts at its head, which may be behind the task branch.
      if (input.from !== undefined) for (const attempt of created) await this.#catchUp(project, attempt);
      return created;
    } catch (error) {
      // A failed fork cleans up after itself; past that, every fork exists and must go.
      if (forked) await this.#deleteForks(project, current.number, numbers);
      throw error;
    } finally {
      const left = (this.#reserved.get(current.number) ?? count) - count;
      if (left > 0) this.#reserved.set(current.number, left);
      else this.#reserved.delete(current.number);
    }
  }

  getAttempt(_project: ProjectContext, _actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#attempt(input);
  }

  /**
   * Holds until what `until` watches on the attempt changes from now, or `wait` seconds pass, then
   * answers with the attempt and whether it changed. `scored` answers at once, changed, when the
   * current head is already scored. Past the actor's user's cap on waiting requests, answers at
   * once, unchanged.
   */
  async waitForAttempt(
    _project: ProjectContext,
    actor: Actor,
    input: AttemptInput & { wait: number; until: WaitCondition },
  ): Promise<StoredAttempt & { changed: boolean }> {
    const before = this.#watch(input);
    if (alreadyMet(input.until, before)) return { ...this.#attempt(input), changed: true };
    const ready = () => watchChanged(input.until, before, this.#watch(input));
    const changed = await this.#waiters.wait(actor.user.id, ready, input.wait * 1000);
    return { ...this.#attempt(input), changed };
  }

  /** Answers the waits whose attempts changed; run after every call that may change one. */
  wakeWaiters(): void {
    this.#waiters.wake();
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
    if (run === null) throw new ServiceError("notFound", `no run ${input.run}`);
    return run;
  }

  /**
   * Posts the actor's verdict on the attempt's current head, replacing their earlier one on that
   * head, and journals `verdictPosted`. Anyone but the attempt's author (and their aliases) may, on
   * an active attempt with a head, or a merged one for the record.
   */
  postVerdict(_project: ProjectContext, actor: Actor, input: PostVerdictInput): VerdictDetail {
    const current = this.#attempt(input);
    if (actor.user.id === current.author) {
      throw new ServiceError("forbidden", `the author of ${current.fork} can't post a verdict on it`);
    }
    this.#expect(current, [...ACTIVE, "merged"], "post a verdict on");
    const head = current.scoring.sha;
    if (head === null) throw invalidState(`${current.fork} has no head to review; nothing has been pushed to it`);
    const verdict: StoredVerdict = {
      task: current.task,
      attempt: current.number,
      head,
      reviewer: actor.user.id,
      alias: actor.alias,
      recommendation: input.recommendation,
      body: input.body,
      at: this.#stamp(),
    };
    this.#sql.transaction(() => {
      this.verdicts.put(verdict);
      this.#journal(actor, "verdictPosted", current.task, current.number, {
        head,
        recommendation: input.recommendation,
      });
    });
    return { ...verdict, superseded: false };
  }

  /** The attempt's verdicts on every head, oldest first, each marked superseded once its head isn't current. */
  listVerdicts(_project: ProjectContext, _actor: Actor, input: AttemptInput): VerdictDetail[] {
    const current = this.#attempt(input);
    return this.verdicts
      .list(scoredAttempt(current))
      .map((v) => ({ ...v, superseded: v.head !== current.scoring.sha }));
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

  /** Edits an attempt's note. Only its author (or their aliases) may. */
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
    return this.#requireHead(await this.#scoreHead(project, actor, current, "scoreNow"), current);
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
   * unknown run, or a name no log can have, is `notFound`; whether the log itself exists is R2's.
   */
  runLogKey(project: ProjectContext, actor: Actor, input: { run: number; name: string }): string {
    const run = this.getScoringRun(project, actor, input);
    if (!isLogName(input.name)) throw missingLog(input.run, input.name);
    return logKey({ project: project.id, attempt: headAttemptRef(run), sha: run.sha, run: run.id }, input.name);
  }

  /** open → draft: takes the attempt back out of consideration. Only its author may. */
  draftAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#sql.transaction(() => {
      const drafted = this.#authorMoves(actor, input, ["open"], "draft", "returnedToDraft");
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
      throw new ServiceError("attemptLimit", `${taskRef(parent.number)} has ${active} of ${limit} active attempts`);
    }
    this.#checkReopenBranch(current);
    this.#reserved.set(parent.number, reserved + 1);

    let forked = false;
    try {
      forked = await this.#restore(project, current);
      const reopened = this.#sql.transaction(() => {
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
      // It didn't follow the task branch while it was closed; it catches up now.
      await this.#catchUp(project, current);
      return reopened;
    } catch (error) {
      if (forked) await this.#deleteForks(project, current.task, [current.number]);
      throw error;
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
    if (isActive(current.state)) await this.#archive(project, [current]);
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
   * once. Only its author (or their aliases) may, and not to themselves. Pushes check the claim
   * on every request, so the old author's next push is refused and nothing needs revoking.
   */
  handOffAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput & { to: string }): StoredAttempt {
    const current = this.#attempt(input);
    mayAuthor(actor, current);
    this.#expect(current, ACTIVE, "hand off");
    if (input.to === current.author) {
      throw new ServiceError("invalidRequest", `${current.fork} is already theirs: hand it to another user`);
    }
    return this.#sql.transaction(() => {
      this.#sql.exec(
        "UPDATE attempts SET author = ?, alias = NULL WHERE task = ? AND number = ?",
        input.to,
        current.task,
        current.number,
      );
      this.#journal(actor, "handedOff", current.task, current.number, { from: current.author, to: input.to });
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
   * fork: the attempt is active and the actor's user is its author. Checked on every push, so a
   * hand-off or close takes effect on the next one.
   */
  authorizePush(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    const current = this.#attempt(input);
    if (!isActive(current.state)) {
      throw invalidState(`${current.fork} is ${current.state}; only an active attempt's fork takes pushes`);
    }
    mayAuthor(actor, current);
    return current;
  }

  /**
   * Checks the actor may push task `task`'s task branch (`refs/tasks/t42` in the origin), so the git
   * proxy may forward the push: the task exists and the actor is its creator or the project
   * owner. The task branch may be pushed in any state.
   */
  authorizeTaskBranchPush(project: ProjectContext, actor: Actor, input: { task: number }): StoredTask {
    const current = this.#task(input.task);
    if (actor.user.id === project.owner || actor.user.id === current.creator) return current;
    throw new ServiceError(
      "forbidden",
      `only ${taskRef(current.number)}'s creator or the project owner may push its task branch`,
    );
  }

  /**
   * Journals a `pushed` event for each ref a push through the git proxy updated on an attempt's
   * fork, with the old and new ids so force-pushes show up afterwards, and queues scoring when the
   * attempt is open and its head moved; the scoring queue skips a head it already covers. The
   * proxy checked the claim before forwarding the push, and the push has landed, so this checks
   * nothing, and leaves checking whether the new head dropped the task branch to `followIfDropped`.
   * Returns the scoring request, or null when the push asked for none, and the new head.
   */
  recordPush(project: ProjectContext, actor: Actor, input: AttemptInput & { updates: PushedRef[] }): PushRecord {
    const current = this.#attempt(input);
    return this.#sql.transaction(() => {
      const head = this.#recordPushed(actor, current, input.updates);
      if (head !== null) this.#authorMoved(project, current);
      const needsReview = head !== null && this.#pushedToSource(actor, current, head);
      const mergeRequest = this.#pushNotice(current, needsReview ? head : null);
      if (head === null) return { scoring: null, mergeRequest, head };
      // A draft isn't scored, but its old result no longer describes its head.
      if (current.state !== "open") {
        this.scoring.moveHead({ ...scoredAttempt(current), sha: head });
        return { scoring: null, mergeRequest, head };
      }
      return { scoring: this.#request(project, actor, current, head, "push"), mergeRequest, head };
    });
  }

  /**
   * The author moved the attempt's head: it is no longer the one a follow wrote, and when it needs
   * update a follow checks whether the push merged the task branch in (or merges it now).
   */
  #authorMoved(project: ProjectContext, attempt: StoredAttempt): void {
    const row = this.#attemptRow(attempt);
    this.#sql.exec(
      "UPDATE attempts SET followed_head = NULL WHERE task = ? AND number = ?",
      attempt.task,
      attempt.number,
    );
    if (row?.needs_update != null && isActive(attempt.state)) {
      this.#queueFollow(project, attempt, row.needs_update);
    }
  }

  // --- following the task branch ---------------------------------------------------------------
  //
  // Active attempts follow their task branch (ADR 0003). A push of the task branch, an author's push
  // to an attempt that needs update, and reopening or starting an attempt on a task with a task
  // branch each queue a follow. So does an author's push that drops the task head (a forced push
  // over a follow's merge), which the git proxy checks once git has its reply; a check that can't
  // tell queues nothing, and the next push is checked again. A follow is only ever queued for the
  // task head the last recorded task branch push left. The DO's drain starts its Follow Workflow,
  // which claims the push, merges the task head into the fork's `main` in a trusted container with
  // a lease on the head it read, and reports. A clean merge is recorded as a push by no user: its
  // new head is scored, and a merge request it is the source of goes to `needsReview`. A conflict
  // writes nothing and marks the attempt needs update. A landing that has claimed its push to
  // `main` holds its source's follow back until it ends.

  /**
   * Records a push of task `task`'s task branch to `head`, which the git proxy authorized
   * (`authorizeTaskBranchPush`) and the origin accepted, and queues a follow of it for each active
   * attempt. Returns those attempts' references.
   */
  recordTaskBranchPush(project: ProjectContext, actor: Actor, input: { task: number; head: string }): string[] {
    return this.#sql.transaction(() => {
      this.#task(input.task);
      this.#sql.exec("UPDATE tasks SET task_head = ? WHERE number = ?", input.head, input.task);
      this.#sql.exec("UPDATE attempts SET contains_task_head = NULL WHERE task = ?", input.task);
      this.#journal(actor, "taskBranchPushed", input.task, null, { head: input.head });
      const active = this.#activeAttempts(input.task);
      for (const attempt of active) {
        this.#queueFollow(project, attempt, input.head);
      }
      return active.map((attempt) => attempt.fork);
    });
  }

  /**
   * For a Follow Workflow, right before it merges and pushes (again, for a retried step): true while
   * its attempt is active. False, and it must not push, when the attempt ended or the follow already
   * reported; or while a landing of a merge request the attempt is the source of has claimed its
   * push to `main`, when it is queued again to run once that landing ends.
   */
  claimFollowPush(follow: number): boolean {
    return this.#sql.transaction(() => {
      const current = this.follows.get(follow);
      if (current?.status !== "running") return false;
      const attempt = this.#attempt(followed(current));
      if (!isActive(attempt.state)) {
        this.follows.end(follow, "stopped");
        return false;
      }
      if (this.#landingHolds(attempt)) {
        this.follows.end(follow, "stopped");
        this.follows.requeue(current);
        return false;
      }
      return true;
    });
  }

  /**
   * Records how a follow ended, from its Workflow's report, and returns whether it was recorded. A
   * new head (`merged`, or a `current` head nothing recorded, after a retried push) is recorded as
   * a push by no user and clears needs update, as does a head that already contained the task head.
   * A conflict marks the attempt needs update. A lease beaten by an author's push follows again. A
   * report from a follow that already reported, or whose attempt ended, is discarded.
   */
  async followFinished(follow: number, outcome: FollowOutcome): Promise<boolean> {
    try {
      return this.#followFinished(follow, outcome);
    } finally {
      this.wakeWaiters();
    }
  }

  #followFinished(follow: number, outcome: FollowOutcome): boolean {
    return this.#sql.transaction(() => {
      const current = this.follows.get(follow);
      if (current?.status !== "running") return false;
      this.follows.end(follow, "done");
      const attempt = this.#attempt(followed(current));
      if (!isActive(attempt.state)) return false;
      const project = { id: current.project };
      switch (outcome.kind) {
        case "merged":
        case "current": {
          const { head } = outcome;
          const recorded = this.scoring.statusFor(scoredAttempt(attempt)).sha;
          this.#setFollow(attempt, { needs_update: null });
          if (current.task_head === this.#taskHead(attempt.task))
            this.#setFollow(attempt, { contains_task_head: head });
          // A `current` head other than the recorded one is this follow's own push, made before its
          // step was retried. An attempt with no recorded head yet has nothing to move on from.
          const [moved, before] =
            outcome.kind === "merged"
              ? [head !== recorded, outcome.before]
              : [recorded !== null && head !== recorded, head];
          if (moved) this.#followedTo(project, attempt, { before, after: head, taskHead: current.task_head });
          break;
        }
        case "conflict": {
          this.#setFollow(attempt, { needs_update: current.task_head });
          this.#journal(null, "needsUpdate", attempt.task, attempt.number, { taskBranch: current.task_head });
          break;
        }
        case "moved": {
          this.follows.requeue(current);
          break;
        }
        case "stale":
        case "errored": {
          console.warn({ event: "follow.not_merged", follow, attempt: attempt.fork, outcome });
          break;
        }
      }
      return true;
    });
  }

  /**
   * The `remote:` notice for a push to the attempt the host rejected as non-fast-forward, when its
   * head is one a follow wrote: the author hasn't pulled the task branch merge.
   */
  pullFirstNotice(_project: ProjectContext, _actor: Actor, input: AttemptInput): string | null {
    const row = this.#attemptRow(input);
    if (row?.followed_head == null) return null;
    return `${taskRef(input.task)}'s task branch moved; pull first`;
  }

  /** A follow's new head on the attempt's fork, recorded as a push by no user. */
  #followedTo(
    project: ProjectId,
    attempt: StoredAttempt,
    { before, after, taskHead }: { before: string; after: string; taskHead: string },
  ): void {
    this.#journal(null, "pushed", attempt.task, attempt.number, {
      gitRef: FORK_HEAD,
      before,
      after,
      taskBranch: taskHead,
    });
    this.#setFollow(attempt, { followed_head: after });
    this.#pushedToSource(null, attempt, after);
    if (attempt.state === "open") this.#request(project, null, attempt, after, "push");
    else this.scoring.moveHead({ ...scoredAttempt(attempt), sha: after });
  }

  #setFollow(
    attempt: AttemptInput,
    set: Partial<Pick<AttemptRow, "needs_update" | "followed_head" | "contains_task_head">>,
  ): void {
    for (const [column, value] of Object.entries(set)) {
      this.#sql.exec(
        `UPDATE attempts SET ${column} = ? WHERE task = ? AND number = ?`,
        value,
        attempt.task,
        attempt.number,
      );
    }
  }

  /** Queues a follow of task head `taskHead` for the attempt. */
  #queueFollow(project: ProjectId, attempt: AttemptInput, taskHead: string): void {
    this.follows.request({ project: project.id, task: attempt.task, attempt: attempt.number, taskHead });
  }

  /** Whether a landing of the merge request the attempt is the source of has claimed its push to `main`. */
  #landingHolds(attempt: AttemptInput): boolean {
    const mr = this.mergeRequests.open(attempt.task);
    return mr !== null && mr.attempt === attempt.number && this.#pushing(mr);
  }

  /**
   * For the git proxy, once it has answered an author's push that moved the attempt to `head`
   * (`recordPush`): queues a follow of the task head when `head` doesn't contain it, as a forced
   * push over a follow's merge does; when it does, remembers `head`, where checking a later push
   * stops. Nothing to check (`#toCheck`) checks nothing. A check that can't tell, because a commit
   * can't be read or the history is too long to walk, is logged and queues nothing: the attempt's
   * next push is checked again, and a task branch push follows it anyway.
   */
  async followIfDropped(project: ProjectContext, _actor: Actor, input: AttemptInput & { head: string }): Promise<void> {
    const { head } = input;
    const check = this.#toCheck(input, head);
    if (check === null) return;
    const { taskHead, known } = check;
    const fork = attemptRef(input.task, input.number);
    let contains: boolean | null;
    try {
      contains = await containsCommit(this.#repos, project.id, { attempt: fork, head, known }, taskHead);
    } catch (error) {
      console.error({ event: "follow.check_failed", attempt: fork, head, taskHead, error: String(error) });
      return;
    }
    if (contains === null) {
      console.warn({ event: "follow.check_unknown", attempt: fork, head, taskHead });
      return;
    }
    this.#sql.transaction(() => {
      // The task branch, the attempt or its head may have moved on while the head was read: a newer
      // push is checked on its own, and a task branch push queued a follow of its new head.
      if (this.#toCheck(input, head)?.taskHead !== taskHead) return;
      if (contains) this.#setFollow(input, { contains_task_head: head });
      else this.#queueFollow(project, input, taskHead);
    });
  }

  /**
   * What checking the attempt's head `head` needs: its task head, and the head known to contain it.
   * Null when there is nothing to check: the attempt ended, or needs update (`#authorMoved` queued
   * its follow), `head` is no longer its head, or its task has no task branch.
   */
  #toCheck(input: AttemptInput, head: string): { taskHead: string; known: string | null } | null {
    const row = this.#attemptRow(input);
    if (row === undefined || !isActive(row.state) || row.needs_update !== null) return null;
    if (this.scoring.statusFor(scoredAttempt(row)).sha !== head) return null;
    const taskHead = this.#taskHead(row.task);
    return taskHead === null ? null : { taskHead, known: row.contains_task_head };
  }

  /** Queues a follow of the task's task branch for an attempt that (re)starts, when the task has one. */
  async #catchUp(project: ProjectId, attempt: AttemptInput): Promise<void> {
    let head: { sha: string } | null;
    try {
      head = await taskBranchHead(this.#repos, project.id, attempt.task);
    } catch (error) {
      console.error({ event: "follow.task_branch_unreadable", task: attempt.task, error: String(error) });
      return;
    }
    if (head === null) return;
    this.#sql.transaction(() => this.#queueFollow(project, attempt, head.sha));
  }

  /**
   * Starts a Follow Workflow for each queued follow whose attempt has none running, while a Sandbox
   * slot is free; a landing goes first, and scoring waits for both. A follow whose attempt ended is
   * dropped, and one a claimed landing holds back waits.
   */
  async #drainFollows(project: string): Promise<void> {
    const runner = this.#follow;
    if (runner === null) return;
    const started = this.#sql.transaction(() => {
      const starting: (StoredFollow & { params: FollowParams })[] = [];
      for (const follow of this.follows.startable()) {
        const attempt = this.#attempt(followed(follow));
        if (!isActive(attempt.state)) {
          this.follows.end(follow.id, "stopped");
          continue;
        }
        if (this.#landingHolds(attempt)) continue;
        if (SCORING_CAP - this.scoring.running() - this.#landingSlots() - this.follows.running() <= 0) break;
        const running = this.follows.start(
          follow.id,
          (id) => `${forkRepo(project, attemptRef(follow.task, follow.attempt))}-follow-${id}`,
        );
        starting.push({
          ...running,
          params: {
            project,
            follow: running.id,
            task: running.task,
            attempt: running.attempt,
            taskHead: running.task_head,
            startedAt: running.started_at ?? 0,
          },
        });
      }
      return starting;
    });
    for (const follow of started) {
      try {
        await runner.workflow.create({ id: follow.instance_id ?? "", params: follow.params });
      } catch (error) {
        await this.followFinished(follow.id, { kind: "errored", step: "start", error: String(error).slice(0, 2000) });
      }
    }
  }

  /**
   * What a push to the attempt has to tell its pusher about the merge request it is the source of:
   * a dequeue they haven't been told of (marked told), and the new head if this push moved it to
   * `needsReview`. A `newPush` dequeue is this push's own doing, which `needsReview` already says.
   */
  #pushNotice(attempt: StoredAttempt, needsReview: string | null): PushNotice | null {
    const mr = this.mergeRequests.forAttempt(attempt.task, attempt.number);
    if (mr === null) return null;
    const unseen = this.mergeRequests.takeUnseenDequeue(mr);
    const dequeue =
      unseen === null || unseen.reason === "newPush" ? null : { reason: unseen.reason, files: fileCount(unseen) };
    if (dequeue === null && needsReview === null) return null;
    return { task: mr.task, dequeue, needsReview };
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
        throw new ServiceError("notFound", `branch ${branch} is for ${taskRef(reserved)}, which doesn't exist`);
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
        throw new ServiceError("attemptLimit", `${taskRef(current.number)} has ${count} of ${limit} active attempts`);
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
      return { kind: "create", task: number, number: attempt, newTask: task === null } as const;
    });
    try {
      await this.#fork(project, route.task, [route.number]);
    } catch (error) {
      // A failed fork deletes what it made; only the branch is left to free.
      this.#dropBranchPush(route);
      throw error;
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

    const completed = this.#sql.transaction(() => {
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
        `INSERT INTO attempts (task, number, author, alias, state, branch, note, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, '', ?)`,
        row.task,
        row.attempt,
        actor.user.id,
        actor.alias,
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
    // The pushed head replaced the fork's `main`, which began at the task head; if its author didn't
    // build on the task branch, the follow merges it in.
    if (created === null) await this.#catchUp(project, completed.attempt);
    return completed;
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
   * the project owner (or their aliases) may; the creator may select their own attempt.
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
   * Approves the source attempt's current head: `needsReview` → `pending`. From `pending` it
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
    this.#expectMergeRequest(mr, ["pending", "needsReview"], "approve");
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
    if (mr === null) throw new ServiceError("notFound", `${taskRef(input.task)} has no merge request`);
    return mr;
  }

  /**
   * Where the log `name` of the retest that dequeued the task's merge request with `failedChecks`
   * is stored. Anyone signed in may read it. `notFound` unless its latest dequeue is `failedChecks`
   * with a stored log by that name.
   */
  dequeueLogKey(project: ProjectContext, actor: Actor, input: { task: number; name: string }): string {
    const mr = this.getMergeRequest(project, actor, input);
    const dequeue = mr.last_dequeue;
    const missing = new ServiceError("notFound", `${taskRef(input.task)}'s last dequeue has no log ${input.name}`);
    if (dequeue?.reason !== "failedChecks" || !isLogName(input.name)) throw missing;
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
    try {
      return this.#sql.transaction(() => {
        if (!this.scoring.finish(run, outcome)) return false;
        const finished = this.scoring.getRun(run);
        if (finished === null) return true;
        const mr = this.mergeRequests.open(finished.task);
        if (mr !== null && mr.attempt === finished.attempt) this.#evaluate(null, mr);
        return true;
      });
    } finally {
      this.wakeWaiters();
    }
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
   * `failedChecks` or `errored`, back to `pending` with its approval kept. It requeues only on a
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
    const { merged, source } = this.#sql.transaction(() => this.#landRows(actor, input));
    await this.#archive(project, [source]);
    return merged;
  }

  /** `landMergeRequest`'s row changes, in the caller's transaction; the caller archives `source` after it. */
  #landRows(
    actor: Actor | null,
    input: { task: number; sha: string },
  ): { merged: StoredMergeRequest; source: StoredAttempt } {
    const mr = this.#openMergeRequest(input.task);
    this.#expectMergeRequest(mr, ["landing"], "land");
    const source = this.#attempt(sourceOf(mr));
    this.#checkMergeable(source);
    const merged = this.mergeRequests.merged(actor, mr, input.sha);
    this.#markMergedRows(actor, source, input.sha);
    return { merged, source };
  }

  // --- landings --------------------------------------------------------------------------------
  //
  // The Durable Object calls `drain` after every store call and report. It stops the Landing
  // Workflow of a merge request that left the queue (a new push or a cancel) before its land step
  // claimed the push to main, then starts one for the front of the queue when nothing is landing
  // and a Sandbox slot is free, then starts scoring runs. A landing takes a slot under the cap ahead
  // of waiting scoring runs: while one is landing or waiting to, scoring leaves it a slot.

  /** Stops stale landings, starts the next one, starts queued follows, then drains the scoring queue. */
  async drain(project: string): Promise<void> {
    try {
      await this.#drainLandings(project);
      await this.#drainFollows(project);
      await this.scoring.drain();
    } finally {
      this.wakeWaiters();
    }
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
   * source attempt merged, its task closed, its fork archived) and journals `mainAdvanced`; any
   * other outcome dequeues it with that reason and its details, back to `pending`, or to
   * `needsReview` if its source moved while it was pushing. A report from a landing that was stopped,
   * or already reported, is discarded. Returns whether it was recorded. The caller drains afterwards,
   * which starts the next landing.
   *
   * An `errored` landing that claimed its push may have pushed anyway (its result lost after the
   * push, say). When `main`'s head is its merge commit it is recorded as landed, so its merge request
   * never returns to `pending` and lands twice. A landing's merge and its `mainAdvanced` are
   * recorded in one transaction before the source is archived, so a report retried after an
   * interrupted archive finds the landing already recorded.
   */
  async landingFinished(landing: number, reported: LandingOutcome): Promise<boolean> {
    try {
      return await this.#landingFinished(landing, reported);
    } finally {
      this.wakeWaiters();
    }
  }

  async #landingFinished(landing: number, reported: LandingOutcome): Promise<boolean> {
    // A Workflow started before values were camelCase may still report `failedChecks`.
    const outcome = normaliseLandingOutcome(reported);
    let current = this.#reportable(landing);
    if (current === null) return false;
    let sha = outcome.kind === "landed" ? outcome.sha : null;
    if (outcome.kind === "errored" && current.status === "pushing") {
      sha = await this.#mergedOnMain(current);
      current = this.#reportable(landing);
      if (current === null) return false;
    }
    const { task, attempt, head, project } = current;
    if (sha !== null) {
      const landedSha = sha;
      const { source } = this.#sql.transaction(() => {
        const landed = this.#landRows(null, { task, sha: landedSha });
        this.landings.move(landing, "landed");
        this.#journal(null, "mainAdvanced", task, attempt, { mergeRequest: taskRef(task), head, sha: landedSha });
        return landed;
      });
      await this.#archive({ id: project }, [source]);
      return true;
    }
    if (outcome.kind === "landed") return false;
    this.#sql.transaction(() => {
      this.landings.move(landing, "dequeued");
      const mr = this.#openMergeRequest(task);
      const source = this.#attempt(sourceOf(mr));
      const moved = this.scoring.statusFor(scoredAttempt(source)).sha !== mr.approved_head;
      this.mergeRequests.dequeue(null, mr, dequeueCause(outcome), moved ? "needsReview" : "pending");
    });
    return true;
  }

  /**
   * The landing, while a report from it can still be recorded: it is running or pushing and its
   * merge request is still landing. A landing whose merge request left the queue is marked stopped.
   */
  #reportable(landing: number): StoredLanding | null {
    const current = this.landings.get(landing);
    if (current === null || (current.status !== "running" && current.status !== "pushing")) {
      console.log({ event: "landing.discarded_report", landing, status: current?.status ?? null });
      return null;
    }
    if (!this.#landingCurrent(current)) {
      this.#sql.transaction(() => this.landings.move(landing, "stopped"));
      return null;
    }
    return current;
  }

  /**
   * The landing's merge commit when `main`'s head is one: a merge whose second parent is the
   * landing's head. Only the merge queue writes `main`, one landing at a time, so nothing else can
   * have put it there. A failed read throws, so the report is retried rather than recorded wrongly.
   */
  async #mergedOnMain(landing: StoredLanding): Promise<string | null> {
    const [tip] = await this.#repos.listCommits(originRepo(landing.project), { ref: "main", limit: 1 });
    return tip !== undefined && tip.parents.length === 2 && tip.parents[1] === landing.head ? tip.hash : null;
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
    } catch (error) {
      await this.landingFinished(started.id, {
        kind: "errored",
        details: { step: "start", error: String(error).slice(0, 2000) },
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
    const coAuthors = this.#sql.exec<{ user: string; alias: string }>(
      `SELECT user_id AS user, alias FROM journal WHERE kind = 'pushed' AND task = ? AND attempt = ?
         AND user_id IS NOT NULL AND alias IS NOT NULL GROUP BY user_id, alias ORDER BY MIN(id)`,
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
      coAuthors: coAuthors.map(({ user, alias }) => ({ user, alias })),
      startedAt: landing.started_at,
    };
    return { ...landing, params };
  }

  async #stopLanding(runner: LandingRunner, landing: StoredLanding): Promise<void> {
    try {
      const instance = await runner.workflow.get(landing.instance_id);
      await instance.terminate();
      await runner.teardown(landing.instance_id);
    } catch (error) {
      // It may already have ended; its report is discarded either way.
      console.warn({ event: "landing.stop_failed", instance_id: landing.instance_id, error: String(error) });
    }
  }

  // --- internals -------------------------------------------------------------------------------

  #task(number: number): StoredTask {
    const [row] = this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", number);
    if (row === undefined) throw new ServiceError("notFound", `no task ${taskRef(number)}`);
    return toTask(row);
  }

  /** The head of the task's task branch, as its last recorded push left it; null when it has none. */
  #taskHead(task: number): string | null {
    const [row] = this.#sql.exec<Pick<TaskRow, "task_head">>("SELECT task_head FROM tasks WHERE number = ?", task);
    return row?.task_head ?? null;
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
   * approval. True when this moved the merge request to `needsReview`.
   */
  #pushedToSource(actor: Actor | null, attempt: StoredAttempt, head: string): boolean {
    const mr = this.mergeRequests.open(attempt.task);
    if (mr === null || mr.attempt !== attempt.number || mr.state === "needsReview") return false;
    if (head === mr.approved_head) return false;
    // A landing pushing to main lands the approved head; the compare-and-swap on main decides.
    if (this.#pushing(mr)) return false;
    if (mr.state === "queued" || mr.state === "landing") {
      this.mergeRequests.dequeue(actor, mr, { reason: "newPush" }, "needsReview");
    } else {
      this.mergeRequests.move(actor, mr, "needsReview", { head });
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

  #attempt(attempt: AttemptInput): StoredAttempt {
    const row = this.#attemptRow(attempt);
    if (row === undefined) throw new ServiceError("notFound", `no attempt ${attemptRef(attempt.task, attempt.number)}`);
    return this.#toAttempt(row);
  }

  #attemptRow({ task, number }: AttemptInput): AttemptRow | undefined {
    const [row] = this.#sql.exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? AND number = ?", task, number);
    return row;
  }

  #toAttempt(row: AttemptRow): StoredAttempt {
    const mr = this.mergeRequests.forAttempt(row.task, row.number);
    const scoring = this.scoring.statusFor(scoredAttempt(row));
    return {
      ...toAttempt(row),
      scoring,
      verdicts: this.verdicts.summary(scoredAttempt(row), scoring.sha),
      merge_request:
        mr === null
          ? null
          : { state: mr.state, last_dequeue: mr.last_dequeue === null ? null : { reason: mr.last_dequeue.reason } },
    };
  }

  /** What a wait on the attempt compares against its snapshot. */
  #watch(input: AttemptInput): AttemptWatch {
    const { state } = this.#attempt(input);
    const mr = this.mergeRequests.forAttempt(input.task, input.number);
    return {
      state,
      scoredRun: this.scoring.scoredRun({ task: input.task, attempt: input.number }),
      mergeRequest: mr === null ? null : { id: mr.id, state: mr.state, dequeuedAt: mr.last_dequeue?.at ?? null },
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
      this.#journal(actor, "pushed", attempt.task, attempt.number, { gitRef: ref, before, after });
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
    } catch (error) {
      console.error({ event: "scoring.head_unreadable", attempt: attempt.fork, trigger, error: String(error) });
      return null;
    }
    return head === null ? null : this.#request(project, actor, attempt, head, trigger, readSince);
  }

  #request(
    project: ProjectId,
    actor: Actor | null,
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
    this.#journal(actor, to === "closed" ? "closed" : "madeObsolete", number, null);
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
    this.#journal(actor, to === "closed" ? "closed" : "madeObsolete", current.task, current.number);
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
  async #archive(project: ProjectId, attempts: StoredAttempt[]): Promise<void> {
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
        } catch (error) {
          console.error({ event: "attempt.archive_failed", repo: fork, error: String(error) });
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
    } catch (error) {
      if ((error as { code?: unknown }).code === "ALREADY_EXISTS") return false;
      throw error;
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
    } catch (error) {
      await this.#deleteForks(project, attempt.task, [attempt.number]);
      console.error({ event: "attempt.restore_failed", repo: fork, error: String(error) });
      throw new ServiceError("internal", `couldn't restore ${attempt.fork} from its archive; it is still closed`);
    }
    return true;
  }

  /** Runs `work`, retrying with backoff while a just-made fork isn't ready yet. */
  async #untilReady<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (attempt >= FORK_READY_RETRIES || (code !== "FORK_IN_PROGRESS" && code !== "NOT_FOUND")) throw error;
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
    if (count !== 1) throw new ServiceError("invalidRequest", "a branch carries exactly one attempt");
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
    if (failed !== undefined) {
      const made = numbers.filter((_, i) => results[i]?.status === "fulfilled");
      await this.#deleteForks(project, task, made);
      throw failed.reason;
    }
    try {
      await Promise.all(numbers.map((n) => this.#startFromTaskBranch(project, task, n)));
    } catch (error) {
      await this.#deleteForks(project, task, numbers);
      throw error;
    }
  }

  /**
   * Sets a new fork's `main` to its task's task branch head, so the attempt starts from it; the
   * fork is left at the origin's `main` when the task has no task branch.
   */
  async #startFromTaskBranch(project: ProjectContext, task: number, number: number): Promise<void> {
    await this.#untilReady(() =>
      this.#repos.copyRef({
        from: originRepo(project.id),
        fromRef: taskBranchRef(task),
        to: forkRepo(project.id, attemptRef(task, number)),
        toRef: FORK_HEAD,
      }),
    );
  }

  /** A fork source is an attempt of the same task with a head to copy: its fork's, or its archive's. */
  #checkForkSource(task: number, from: AttemptInput): StoredAttempt {
    if (from.task !== task) {
      throw new ServiceError(
        "invalidRequest",
        `${attemptRef(from.task, from.number)} isn't an attempt of ${taskRef(task)}`,
      );
    }
    const source = this.#attempt(from);
    if (!isActive(source.state) && source.archived_sha === null) {
      throw invalidState(`${source.fork} has no archived head to fork`);
    }
    return source;
  }

  /**
   * Points each new fork's `main` at the source attempt's head: its fork's `main` while it is
   * active, else its archived head. The new forks are siblings: nothing ties them to the source after.
   */
  async #seed(project: ProjectContext, from: AttemptInput, numbers: number[]): Promise<void> {
    // Read again: the source may have ended while the forks were made.
    const source = this.#checkForkSource(from.task, from);
    const head = isActive(source.state)
      ? { from: forkRepo(project.id, source.fork), fromRef: FORK_HEAD }
      : {
          from: originRepo(project.id),
          fromRef: archiveRef(source.fork),
          expect: source.archived_sha ?? undefined,
        };
    await Promise.all(
      numbers.map((n) =>
        this.#untilReady(() =>
          this.#repos.copyRef({ ...head, to: forkRepo(project.id, attemptRef(from.task, n)), toRef: FORK_HEAD }),
        ),
      ),
    );
  }

  async #deleteForks(project: ProjectId, task: number, numbers: number[]): Promise<void> {
    await Promise.all(
      numbers.map((n) => {
        const name = forkRepo(project.id, attemptRef(task, n));
        return this.#repos.delete(name).catch((error: unknown) => {
          console.error({ event: "attempt.orphan_fork", repo: name, error: String(error) });
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
    kind: TaskEvent | MergeRequestEvent | "mainAdvanced",
    task: number,
    attempt: number | null,
    extra: Record<string, unknown> = {},
  ): void {
    const detail = { ref: attempt === null ? taskRef(task) : attemptRef(task, attempt), ...extra };
    this.#sql.exec(
      "INSERT INTO journal (at, kind, detail, user_id, alias, task, attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.#now().getTime(),
      kind,
      JSON.stringify(detail),
      actor?.user.id ?? null,
      actor?.alias ?? null,
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
  "waitForAttempt",
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
  "postVerdict",
  "listVerdicts",
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
  "authorizeTaskBranchPush",
  "recordTaskBranchPush",
  "pullFirstNotice",
  "recordPush",
  "followIfDropped",
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
    return { ok: false, code: "invalidRequest", message: `no task method ${method}` };
  }
  try {
    const fn = store[method as TaskMethod] as (...a: unknown[]) => unknown;
    return { ok: true, value: await fn.apply(store, args) };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, code: error.code, message: error.message };
    throw error;
  } finally {
    store.wakeWaiters();
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
  const text = message.replace(/\r\n/gu, "\n").trim();
  const split = text.search(/\n[ \t]*\n/u);
  const subject = (split === -1 ? text : text.slice(0, split)).replace(/\s+/gu, " ").trim();
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

function toAttempt(row: AttemptRow): Omit<StoredAttempt, "scoring" | "merge_request" | "verdicts"> {
  return {
    task: row.task,
    number: row.number,
    author: row.author,
    alias: row.alias,
    state: row.state,
    fork: attemptRef(row.task, row.number),
    branch: row.branch,
    note: row.note,
    created_at: row.created_at,
    closed_at: row.closed_at,
    merged_sha: row.merged_sha,
    archived_sha: row.archived_sha,
    forked_from: row.forked_from === null ? null : attemptRef(row.task, row.forked_from),
    needs_update: row.needs_update !== null,
  };
}

function mayOwn(project: ProjectContext, actor: Actor): void {
  if (actor.user.id !== project.owner) throw new ServiceError("forbidden", "only the project owner may");
}

/** The attempt's author, or one of their aliases, holds its claim. */
function mayAuthor(actor: Actor, current: StoredAttempt): void {
  if (actor.user.id !== current.author) throw new ServiceError("forbidden", `only the author of ${current.fork} may`);
}

function sourceOf(mr: StoredMergeRequest): AttemptInput {
  return { task: mr.task, number: mr.attempt };
}

/** The attempt a follow merges into. */
function followed(follow: StoredFollow): AttemptInput {
  return { task: follow.task, number: follow.attempt };
}

function invalidState(message: string): ServiceError {
  return new ServiceError("invalidState", message);
}
