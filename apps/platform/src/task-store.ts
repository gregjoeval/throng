// Tasks and attempts, kept in the project Durable Object's SQLite: the source of truth for both,
// their per-project counters and the journal of their transitions. This module holds the state
// machine and the P0 permission rules; `ProjectCoordinator` runs it inside the Durable Object, and
// tests run it over local SQLite. The `tasks.ts` service resolves projects and calls it.
//
// Users are stored by id only, so renaming a handle never rewrites history; the service resolves
// handles when it answers.

import { archiveRef } from "./archive.ts";
import { containsCommit, taskBranchHead } from "./base.ts";
import { CacheIndex } from "./cache-index.ts";
import { CacheStore } from "./cache-store.ts";
import type { CacheObjects } from "./cache-store.ts";
import type { CacheEntry, CacheKey, CacheLookup } from "./caches.ts";
import { migrateValues, normaliseLandingOutcome } from "./casing.ts";
import { addColumns, renameColumns } from "./columns.ts";
import { CONFIG_PATH, loadConfig, pipelineSecrets, selectionPolicy } from "./config.ts";
import type { CheckConfig, ConfigResult, MetricConfig, NamedSecrets, SelectionPolicy } from "./config.ts";
import { ServiceError } from "./errors.ts";
import type { ErrorCode } from "./errors.ts";
import { Follows } from "./follows.ts";
import type { FollowOutcome, FollowParams, FollowRunner, StoredFollow } from "./follows.ts";
import { conflictOutcome, dequeueDetails, landedOutcome, legacyFailedOutcome } from "./landing.ts";
import type { DequeueDetails, LandingParams, LegacyLandingOutcome } from "./landing.ts";
import { migrateLandings } from "./landings.ts";
import { isLogName, legacyLandingLogKey, legacyLogKey, logKey, missingLog } from "./logs.ts";
import { MergeRequests } from "./merge-requests.ts";
import type {
  Dequeue,
  DequeueCause,
  DequeueReason,
  LandingDequeueReason,
  MergeRequestEvent,
  MergeRequestState,
  StoredMergeRequest,
} from "./merge-requests.ts";
import { isZeroId } from "./pkt-line.ts";
import { migrateProjection, Projection } from "./projection.ts";
import { artifactsErrorCode, forkRepo, originRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";
import { GATES } from "./results.ts";
import type { Gate } from "./results.ts";
import { cancellable, PipelineRuns, pushBy, RUN_CAP, runReport, runSettled } from "./scoring.ts";
import type {
  AttemptScoring,
  LandingRequest,
  PipelineRunner,
  PlanVerdict,
  PushedBy,
  RunReport,
  RunsPage,
  RunsQuery,
  ScoringOutcome,
  ScoringRequest,
  ScoringTrigger,
  StoredRun,
} from "./scoring.ts";
import { keyringFrom, Secrets } from "./secrets.ts";
import type { Keyring, SecretChange, SecretSummary } from "./secrets.ts";
import { checkWriters, NO_TASK_DEFINITIONS, taskDefinitionsFrom } from "./task-definitions.ts";
import type { CheckWriter, TaskDefinitions, TaskDefinitionsInput } from "./task-definitions.ts";
import { attemptRef, parseAttemptRef, reservedTask, taskBranchRef, taskRef } from "./task-refs.ts";
import type { Actor } from "./tokens.ts";
import { Verdicts } from "./verdicts.ts";
import type { StoredVerdict, VerdictRecommendation, VerdictSummary } from "./verdicts.ts";
import { ELIGIBLE_VOTERS, mayVote, voteLeaders, Votes } from "./votes.ts";
import type { CandidateStanding, CandidateTally, StoredCandidate, StoredVote, VoteDetail } from "./votes.ts";
import { alreadyMet, Waiters, watchChanged } from "./waiters.ts";
import type { AttemptWatch, WaitCondition } from "./waiters.ts";

/** Active attempts a task may have when neither the project config nor the task overrides it. */
export const DEFAULT_ATTEMPT_LIMIT = 10;

export const TASK_STATES = ["open", "closed", "obsolete"] as const;
export const ATTEMPT_STATES = ["draft", "open", "merged", "closed", "obsolete"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/**
 * The states a listing of tasks or attempts shows: the one its `state` asks for, or else every state
 * but obsolete. Bind it as JSON, read with `state IN (SELECT value FROM json_each(?))`.
 */
export function listedStates<S extends TaskState | AttemptState>(all: readonly S[], state: S | undefined): string {
  return JSON.stringify(state === undefined ? all.filter((s) => s !== "obsolete") : [state]);
}

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
  /** What the task defines over the project's config. */
  definitions: TaskDefinitions;
  /**
   * Who wrote each of its checks, in their order. A check saved before writers were is taken as its
   * creator's and not the owner's.
   */
  check_writers: CheckWriter[];
  /** Overrides the project's selection policy; null to use the project's. */
  selection: SelectionPolicy | null;
}

export interface StoredAttempt {
  task: number;
  number: number;
  /** The author's user id. */
  author: string;
  /** The alias the author started it under (`agent`), or null: started as themselves, or handed off since. */
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
  | "needsUpdate"
  | "voteOpened"
  | "voteCast"
  | "candidateAdded"
  | "voteClosed";

/** Journal events for the project itself. */
type ProjectEvent = "secretSet" | "secretDeleted";

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
function fileCount(details: DequeueDetails | null): number | null {
  return details !== null && "files" in details ? details.files.length : null;
}

/** A merge request's latest dequeue, with the details its landing's run holds. */
export interface DequeueDetail {
  reason: DequeueReason;
  /** The landing's run behind it; null for a new push or a cancel, or a dequeue from before landings were runs. */
  run: number | null;
  at: string;
  details: DequeueDetails | null;
}

/** An attempt as verdicts key it. */
function attemptKey({ task, number }: AttemptInput): { task: number; attempt: number } {
  return { task, attempt: number };
}

/** An attempt's line, `t42a3`, which its runs are keyed on. */
function attemptLine({ task, number }: AttemptInput): string {
  return attemptRef(task, number);
}

// ---------------------------------------------------------------------------------------------
// Inputs

export interface CreateTaskInput {
  title: string;
  body?: string | undefined;
  attemptLimit?: number | null | undefined;
  selection?: SelectionPolicy | null | undefined;
  /** Already checked against the project's config (`taskDefinitionsFrom`). */
  checks?: CheckConfig[] | undefined;
  /** Already checked against the project's config (`taskDefinitionsFrom`). */
  metrics?: MetricConfig[] | undefined;
}

/** The checks and metrics it gives replace the task's, once checked against the project's config. */
export interface EditTaskInput extends TaskDefinitionsInput {
  task: number;
  title?: string | undefined;
  body?: string | undefined;
  attemptLimit?: number | null | undefined;
  selection?: SelectionPolicy | null | undefined;
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
  /** `TaskDefinitions` as JSON; null for none. */
  definitions: string | null;
  /** `SelectionPolicy` as JSON; null to use the project's. */
  selection: string | null;
  /** The head its task branch's last recorded push left, or null when it has none. */
  task_head: string | null;
  /** `CheckWriter[]` as JSON: who wrote each of its checks; null for a task saved before writers were. */
  check_writers: string | null;
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
    definitions TEXT,
    selection TEXT,
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
 * Columns added to tasks after their table was made: what a task defines over the project's config,
 * its selection policy and the head of its task branch.
 */
const TASK_COLUMNS = ["definitions TEXT", "selection TEXT", "task_head TEXT", "check_writers TEXT"];

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
  /** Starts and stops pipeline runs, landings included; without one, runs stay queued and nothing lands on its own. */
  runner?: PipelineRunner | null | undefined;
  /**
   * Whether the merge queue lands its front merge request on its own, which it does whenever there's
   * a runner; false holds merge requests in the queue, as a test needs to.
   */
  lands?: boolean | undefined;
  /** Starts Follow Workflows, which merge a moved task branch into active attempts; without one, follows stay queued. */
  follow?: FollowRunner | null | undefined;
  /** Seals secrets' values: `SECRETS_KEYRING`'s. Without one, setting a secret fails. */
  keyring?: Keyring | undefined;
  /** Deletes cache entries' objects from the `CACHES` bucket; without one, nothing is evicted. */
  cacheObjects?: CacheObjects | null | undefined;
}

/**
 * What holds a merge request no owner approved for the owner (see `TaskStore.#evaluate`): the
 * secrets the `main` pipeline names under `main`'s config, by name (`names`); nothing, as the owner
 * acted (`owner`); or unknown, as the caller couldn't read them (`unknown`).
 */
type MainSecrets = { kind: "owner" } | { kind: "unknown" } | { kind: "names"; project: string; names: string[] };

const OWNER_ACTS: MainSecrets = { kind: "owner" };
const UNKNOWN_MAIN: MainSecrets = { kind: "unknown" };

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
  /** The project's pipeline runs. Its caller runs `runs.drain()` after every store call. */
  readonly runs: PipelineRuns;
  /** The project's merge requests and merge queue. */
  readonly mergeRequests: MergeRequests;
  /** The project's verdicts. */
  readonly verdicts: Verdicts;
  /** The project's votes. */
  readonly votes: Votes;
  /** What of its tasks and attempts is still to be published to the D1 projection. */
  readonly projection: Projection;
  /** Whether the merge queue lands on its own. */
  readonly #lands: boolean;
  /** Active attempts' follows of their task branch. */
  readonly follows: Follows;
  readonly #follow: FollowRunner | null;
  /** Requests waiting on an attempt to change. */
  readonly #waiters = new Waiters();
  /** The project's secrets, which never reach the projection. */
  readonly #secrets: Secrets;
  /** The project's cache entries, indexed. */
  readonly caches: CacheIndex;
  /** What runs may do with the project's caches, and their eviction. */
  readonly #cacheStore: CacheStore;

  constructor({
    sql,
    repos,
    now = () => new Date(),
    runner = null,
    lands = runner !== null,
    follow = null,
    keyring = keyringFrom(undefined),
    cacheObjects = null,
  }: TaskStoreDeps) {
    this.#sql = sql;
    this.#repos = repos;
    this.#now = now;
    this.#lands = lands;
    this.#follow = follow;
    migrate(sql);
    migrateProjection(sql, now());
    this.projection = new Projection({ sql });
    this.follows = new Follows({ sql, now, taskHead: (task) => this.#taskHead(task) });
    this.verdicts = new Verdicts({ sql });
    this.votes = new Votes({ sql });
    this.#secrets = new Secrets({ sql, keyring, now });
    this.caches = new CacheIndex({ sql, now });
    this.#cacheStore = new CacheStore({
      sql,
      index: this.caches,
      objects: cacheObjects,
      run: (id) => this.runs.getRun(id),
    });
    this.runs = new PipelineRuns({
      sql,
      runner,
      now,
      reserved: () => this.follows.running(),
      landing: (run) => this.#landingParams(run),
      // A landing the owner started waits in the queue until its merge request is at the front.
      ready: (run) => run.merge_request === null || this.#landingCurrent(run),
    });
    this.mergeRequests = new MergeRequests({
      sql,
      now,
      journal: (actor, kind, mr, detail) =>
        this.#journal(actor, kind, mr.task, mr.attempt, { mergeRequest: taskRef(mr.task), ...detail }),
    });
    migrateLandings(sql);
    migrateValues(sql);
  }

  // --- tasks -----------------------------------------------------------------------------------

  /**
   * Creates an open task. Any signed-in user may, in any project; only the project owner may give it
   * a selection policy of its own.
   */
  createTask(project: ProjectContext, actor: Actor, input: CreateTaskInput): StoredTask {
    if ((input.selection ?? null) !== null) this.#maySetSelection(project, actor);
    return this.#sql.transaction(() => {
      const number = this.#next("tasks");
      this.#sql.exec(
        `INSERT INTO tasks (number, title, body, creator, state, created_at, attempt_limit, definitions, selection,
           check_writers)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        number,
        input.title,
        input.body ?? "",
        actor.user.id,
        this.#stamp(),
        input.attemptLimit ?? null,
        storedDefinitions({ checks: input.checks ?? [], metrics: input.metrics ?? [] }),
        storedSelection(input.selection ?? null),
        JSON.stringify(checkWriters(input.checks ?? [], [], [], this.#checkEditor(project, actor))),
      );
      this.#journal(actor, "created", number, null);
      return this.#task(number);
    });
  }

  getTask(_project: ProjectContext, _actor: Actor, input: { task: number }): StoredTask {
    return this.#task(input.task);
  }

  /**
   * What a task defines over the project's config, for a scoring run to merge. None for a task with
   * no row, like the e2e routes' attempts.
   */
  definitionsOf(task: number): TaskDefinitions {
    const [row] = this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", task);
    return row === undefined ? NO_TASK_DEFINITIONS : toTask(row).definitions;
  }

  /** Who writes the task checks `actor` sets now: the owner when it's them, as for a push (`isMaintainer`). */
  #checkEditor(project: ProjectContext, actor: Actor): Omit<CheckWriter, "name"> {
    return { user: actor.user.id, owner: isMaintainer(project, actor), at: this.#now().getTime() };
  }

  /**
   * For run `id`'s Workflow, as it reads its config: what its line's task defines over the project's
   * config (`definitionsOf`). A run of the owner's push that would run a task check someone else
   * wrote stops being trusted here, recording which check and who wrote it, as the check runs from
   * the setups' snapshot and could read what they left behind. A run the owner started stays trusted
   * whoever wrote its task's checks before they started it, as Start was the owner's review of them;
   * a check someone else changed since takes its trust the same way, and it waits for the owner again.
   */
  runDefinitions(id: number): TaskDefinitions {
    return this.#sql.transaction(() => {
      const run = this.runs.getRun(id);
      if (run === null) throw new Error(`no run ${id}`);
      const number = parseAttemptRef(run.line)?.task;
      const [row] = number === undefined ? [] : this.#sql.exec<TaskRow>("SELECT * FROM tasks WHERE number = ?", number);
      if (row === undefined) return NO_TASK_DEFINITIONS;
      const task = toTask(row);
      const reviewed = run.trigger === "start" ? (run.owner_started_at ?? 0) : null;
      const foreign = task.check_writers.find((w) => !w.owner && (reviewed === null || w.at >= reviewed));
      if (run.trusted && foreign !== undefined) {
        this.runs.distrust(id, { name: foreign.name, writer: foreign.user });
      }
      return task.definitions;
    });
  }

  /** The project's tasks by number. Obsolete tasks are left out unless `state` asks for them. */
  listTasks(_project: ProjectContext, _actor: Actor, input: { state?: TaskState | undefined }): ListedTask[] {
    const rows = this.#sql.exec<TaskRow>(
      "SELECT * FROM tasks WHERE state IN (SELECT value FROM json_each(?)) ORDER BY number",
      listedStates(TASK_STATES, input.state),
    );
    return rows.map((row) => this.#listed(toTask(row)));
  }

  /** The task with its attempt count, best gate and latest merge request's state. */
  #listed(task: StoredTask): ListedTask {
    const attempts = this.#sql
      .exec<AttemptRow>(
        "SELECT * FROM attempts WHERE task = ? AND state IN (SELECT value FROM json_each(?))",
        task.number,
        listedStates(ATTEMPT_STATES, undefined),
      )
      .map((row) => toAttempt(row));
    const gates = attempts.map((a) => this.runs.currentRun(attemptLine(a))?.result?.gate);
    // `passed` is best, then `failed`; GATES lists them in that order.
    return {
      ...task,
      attempt_count: attempts.length,
      best_gate: GATES.find((gate) => gates.includes(gate)) ?? null,
      merge_request_state: this.mergeRequests.latest(task.number)?.state ?? null,
    };
  }

  /**
   * Edits a task's title, body, attempt limit, selection policy, checks or metrics. The project owner
   * or the task's creator may, but only the owner may change its selection policy; who may is
   * checked before the checks and metrics are. While the task has an open vote its checks, metrics
   * and selection policy stay as they are. Changed definitions rescore each open attempt's head, so
   * every attempt is measured the same way; drafts are left alone.
   */
  async editTask(project: ProjectContext, actor: Actor, input: EditTaskInput): Promise<StoredTask> {
    this.#mayEditTask(project, actor, this.#task(input.task));
    const defining = input.checks !== undefined || input.metrics !== undefined;
    const config = defining ? await loadConfig(this.#repos, project.id) : null;

    // From here to the update nothing awaits; the task is read again, as the check above awaited,
    // and the checks and metrics it leaves out are taken from what's stored now.
    const current = this.#task(input.task);
    this.#mayEditTask(project, actor, current);
    const selection = storedSelection(input.selection === undefined ? current.selection : input.selection);
    const reselecting = selection !== storedSelection(current.selection);
    if (reselecting) this.#maySetSelection(project, actor);
    const edited = config === null ? current.definitions : editedDefinitions(input, current.definitions, config);
    const definitions = storedDefinitions(edited);
    const writers = checkWriters(
      edited.checks,
      current.definitions.checks,
      current.check_writers,
      this.#checkEditor(project, actor),
    );
    const redefining = definitions !== storedDefinitions(current.definitions);
    // A rescore could withdraw a candidate, and a new policy could end the vote's say.
    if ((reselecting || redefining) && this.votes.open(current.number) !== null) {
      throw invalidState(`${taskRef(current.number)} has an open vote; close it first`);
    }
    this.#sql.exec(
      `UPDATE tasks SET title = ?, body = ?, attempt_limit = ?, definitions = ?, selection = ?, check_writers = ?
       WHERE number = ?`,
      input.title ?? current.title,
      input.body ?? current.body,
      input.attemptLimit === undefined ? current.attempt_limit : input.attemptLimit,
      definitions,
      selection,
      JSON.stringify(writers),
      current.number,
    );
    if (redefining) {
      const open = this.#activeAttempts(current.number).filter((a) => a.state === "open");
      await Promise.all(open.map((attempt) => this.#scoreHead(project, actor, attempt, "rescore")));
    }
    return this.#task(current.number);
  }

  /**
   * Only the project owner sets a task's selection policy: a creator choosing their own could take a
   * selection the project gives to a vote.
   */
  #maySetSelection(project: ProjectContext, actor: Actor): void {
    if (actor.user.id !== project.owner) {
      throw new ServiceError("forbidden", "only the project owner may set a task's selection policy");
    }
  }

  #mayEditTask(project: ProjectContext, actor: Actor, current: StoredTask): void {
    this.#mayManageTask(project, actor, current);
    if (current.state === "obsolete") throw invalidState(`${taskRef(current.number)} is obsolete`);
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
    const rows = this.#sql.exec<AttemptRow>(
      "SELECT * FROM attempts WHERE task = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY number",
      input.task,
      listedStates(ATTEMPT_STATES, input.state),
    );
    return rows.map((row) => this.#toAttempt(row));
  }

  /** The attempt's scoring status, with its current result: the latest `done` run for its head. */
  getScoring(_project: ProjectContext, _actor: Actor, input: AttemptInput): AttemptScoringDetail {
    return this.#scoringDetail(this.#attempt(input));
  }

  /**
   * The task's arena: what the task defines over the project's config, its selection policy override
   * and open vote (with the actor's ballot), and every attempt, obsolete ones included, by number,
   * with its scoring and current result.
   */
  taskArena(
    _project: ProjectContext,
    actor: Actor,
    input: { task: number },
  ): {
    definitions: TaskDefinitions;
    selection: SelectionPolicy | null;
    vote: VoteDetail | null;
    attempts: (Omit<StoredAttempt, "scoring"> & { scoring: AttemptScoringDetail })[];
  } {
    const { definitions, selection } = this.#task(input.task);
    const open = this.votes.open(input.task);
    const attempts = this.#sql
      .exec<AttemptRow>("SELECT * FROM attempts WHERE task = ? ORDER BY number", input.task)
      .map((row) => this.#toAttempt(row))
      .map((a) => ({ ...a, scoring: this.#scoringDetail(a) }));
    return { definitions, selection, vote: open === null ? null : this.#voteDetail(open, actor), attempts };
  }

  /** The attempt's scoring status, with the run holding its current result. */
  #scoringDetail(attempt: StoredAttempt): AttemptScoringDetail {
    return { ...attempt.scoring, current: this.runs.currentRun(attemptLine(attempt)) };
  }

  /** The attempt's scoring runs, newest first, superseded and cancelled ones included. */
  listScoringRuns(_project: ProjectContext, _actor: Actor, input: AttemptInput): StoredRun[] {
    return this.runs.listRuns(attemptLine(this.#attempt(input))).toReversed();
  }

  /** One scoring run of the project, by id. */
  getScoringRun(_project: ProjectContext, _actor: Actor, input: { run: number }): StoredRun {
    const run = this.runs.getRun(input.run);
    if (run === null) throw new ServiceError("notFound", `no run ${input.run}`);
    return run;
  }

  /** A page of the project's runs on every line, newest first. Anyone signed in may read them. */
  listRuns(_project: ProjectContext, _actor: Actor, input: RunsQuery): RunsPage {
    return this.runs.listPage(input);
  }

  /**
   * Holds until the run is waiting for the owner or has ended, or `wait` seconds pass, then answers
   * with the run and whether it settled. A settled run answers at once; past the actor's user's cap
   * on waiting requests, an unsettled one answers at once, unsettled.
   */
  async waitForRun(
    project: ProjectContext,
    actor: Actor,
    input: { run: number; wait: number },
  ): Promise<StoredRun & { settled: boolean }> {
    const settled = () => runSettled(this.getScoringRun(project, actor, input));
    if (!settled()) await this.#waiters.wait(actor.user.id, settled, input.wait * 1000);
    return { ...this.getScoringRun(project, actor, input), settled: settled() };
  }

  /**
   * Cancels a queued, waiting or running run; the next drain stops one that had started. Only the
   * project owner may, and never a running `main` run, which may be deploying.
   */
  cancelRun(project: ProjectContext, actor: Actor, input: { run: number }): StoredRun {
    mayOwn(project, actor);
    return this.#sql.transaction(() => {
      const run = this.getScoringRun(project, actor, input);
      if (!cancellable(run))
        throw new ServiceError("invalidState", `run ${run.id} is ${run.status}; it can't be cancelled`);
      this.runs.cancel(run, "cancelled by the owner");
      return this.getScoringRun(project, actor, input);
    });
  }

  /**
   * Starts a run waiting for the owner, pinned to `sha`, the head they reviewed: it is queued again
   * as a trusted run, which holds the secrets it names. Only the project owner acting as themselves
   * may, so an agent steered by untrusted text can't. Refused unless the run still waits on `sha`
   * and its line hasn't moved on (for a held landing: its merge request still approves `sha` and may
   * join the queue, which it then does), and unless each secret the run's pipeline names under
   * `main`'s config as it is now has a value and is allowed in it. That's a fail-fast only: a
   * landing runs its merged tree's config, which `main`'s may not match, and its plan re-checks
   * every secret that names against the settings (`pipelinePlanned`).
   */
  async startRun(project: ProjectContext, actor: Actor, input: { run: number; sha: string }): Promise<StoredRun> {
    mayGrant(project, actor);
    this.#checkStartable(this.getScoringRun(project, actor, input), input.sha);
    const config = await loadConfig(this.#repos, project.id);
    return this.#sql.transaction(() => {
      // The run, its line or its merge request may have moved while the config was read.
      const run = this.getScoringRun(project, actor, input);
      this.#checkStartable(run, input.sha);
      for (const { step, secrets } of pipelineSecrets(config, run.pipeline)) {
        const refused = this.#secrets.sealedFor(secrets, run.pipeline);
        if ("error" in refused) throw invalidState(`can't start run ${run.id}: ${step}: ${refused.error}`);
      }
      const started = this.runs.start(run, actor);
      const mr = this.#landingMergeRequest(run);
      if (mr !== null) this.mergeRequests.enqueue(actor, mr);
      return started;
    });
  }

  /** Refuses to start `run` unless it waits for the owner on `sha`, and what it runs hasn't moved on. */
  #checkStartable(run: StoredRun, sha: string): void {
    if (run.status !== "waiting")
      throw invalidState(`run ${run.id} is ${run.status}; only a waiting run can be started`);
    const head = run.sha ?? run.merge_head;
    if (head !== sha) throw invalidState(`run ${run.id} waits on ${head ?? "no head"}, not ${sha}`);
    const mr = this.#landingMergeRequest(run);
    if (mr === null) {
      const now = this.runs.statusFor(run.line).sha;
      if (now !== sha)
        throw invalidState(`${run.line} moved on to ${now ?? "no head"} since run ${run.id} began to wait`);
    } else if (mr.approved_head !== sha || !this.#queueable(mr)) {
      throw invalidState(`${taskRef(mr.task)}'s merge request moved on since run ${run.id} began to wait`);
    }
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
    return this.verdicts.list(attemptKey(current)).map((v) => ({ ...v, superseded: v.head !== current.scoring.sha }));
  }

  /** Every attempt in the project, by task and then number, leaving out obsolete ones. For the ref list. */
  listProjectAttempts(_project: ProjectContext, _actor: Actor): StoredAttempt[] {
    return this.#sql
      .exec<AttemptRow>(
        "SELECT * FROM attempts WHERE state IN (SELECT value FROM json_each(?)) ORDER BY task, number",
        listedStates(ATTEMPT_STATES, undefined),
      )
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
   * Where a run's log named `name` may be stored in R2, in the order to try. A migrated run tries its
   * old key, then its line's: one still going at the migration stores the logs it hadn't yet under its
   * line. Anyone signed in may read a run's logs. An unknown run, or a name no log can have, is
   * `notFound`; whether the log itself exists is R2's.
   */
  runLogKeys(project: ProjectContext, actor: Actor, input: { run: number; name: string }): string[] {
    const run = this.getScoringRun(project, actor, input);
    if (!isLogName(input.name)) throw missingLog(input.run, input.name);
    const key = { project: project.id, line: run.line, run: run.id };
    const landing = this.runs.legacyLandingId(run.id);
    if (landing !== null && run.merge_attempt !== null && run.merge_head !== null) {
      const legacy = { project: project.id, attempt: run.merge_attempt, head: run.merge_head, landing };
      return [legacyLandingLogKey(legacy, input.name), logKey(key, input.name)];
    }
    if (!run.legacy_logs || run.sha === null) return [logKey(key, input.name)];
    return [legacyLogKey({ ...key, sha: run.sha }, input.name), logKey(key, input.name)];
  }

  /** open → draft: takes the attempt back out of consideration. Only its author may. */
  draftAttempt(_project: ProjectContext, actor: Actor, input: AttemptInput): StoredAttempt {
    return this.#sql.transaction(() => {
      const drafted = this.#authorMoves(actor, input, ["open"], "draft", "returnedToDraft");
      this.runs.cancelLine(attemptLine(drafted), "returned to draft");
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
   * attempt is open and its head moved; `PipelineRuns` skips a head it already covers. The
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
        this.runs.moveHead(attemptLine(current), head, pushBy(isMaintainer(project, actor)));
        return { scoring: null, mergeRequest, head };
      }
      return {
        scoring: this.#request(project, actor, current, head, "push", pushBy(isMaintainer(project, actor))),
        mergeRequest,
        head,
      };
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
   * (`authorizeTaskBranchPush`) and the origin accepted, asks for a `default` run of it on the task
   * branch's line (`t42`), and queues a follow of it for each active attempt. Returns those attempts'
   * references.
   */
  recordTaskBranchPush(project: ProjectContext, actor: Actor, input: { task: number; head: string }): string[] {
    return this.#sql.transaction(() => {
      this.#task(input.task);
      this.#sql.exec("UPDATE tasks SET task_head = ? WHERE number = ?", input.head, input.task);
      this.#sql.exec("UPDATE attempts SET contains_task_head = NULL WHERE task = ?", input.task);
      this.#journal(actor, "taskBranchPushed", input.task, null, { head: input.head });
      this.runs.request({
        project: project.id,
        line: taskRef(input.task),
        sha: input.head,
        trigger: "push",
        actor,
        pushedBy: pushBy(isMaintainer(project, actor)),
      });
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
          const recorded = this.runs.statusFor(attemptLine(attempt)).sha;
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

  /**
   * A follow's new head on the attempt's fork, recorded as a push by no user. A candidate in the
   * task's open vote pinned to the head the follow moved on from is pinned to the new one, with its
   * ballots: a follow isn't its author's push, so it doesn't withdraw it.
   */
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
    const vote = this.votes.open(attempt.task);
    const recorded = this.runs.statusFor(attemptLine(attempt)).sha;
    if (vote !== null && recorded !== null) this.votes.repin(vote.id, attempt.number, { from: recorded, to: after });
    this.#setFollow(attempt, { followed_head: after });
    this.#pushedToSource(null, attempt, after);
    if (attempt.state === "open") this.#request(project, null, attempt, after, "push", pushBy(false));
    else this.runs.moveHead(attemptLine(attempt), after, pushBy(false));
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
    if (this.runs.statusFor(attemptLine(row)).sha !== head) return null;
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
   * slot is free: a `main` run (a landing, say) goes first, and task-branch and attempt runs wait for
   * follows. A follow whose attempt ended is dropped, and one a claimed landing holds back waits.
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
        // A `main` run about to start goes before any follow.
        const main = this.runs.mainStartable() ? 1 : 0;
        if (RUN_CAP - this.runs.running() - this.follows.running() - main <= 0) break;
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
      unseen === null || unseen.reason === "newPush"
        ? null
        : { reason: unseen.reason, files: fileCount(this.#dequeueDetails(unseen)) };
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
      const scoring = this.#request(project, actor, attempt, input.head, "open", pushBy(isMaintainer(project, actor)));
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
   * the project owner (or their aliases) may; the creator may select their own attempt. Under the
   * `vote` selection policy, closing a vote selects instead.

   */
  async selectAttempt(project: ProjectContext, actor: Actor, input: AttemptInput): Promise<StoredMergeRequest> {
    const current = this.#attempt(input);
    const task = this.#task(current.task);
    this.#mayManageTask(project, actor, task);
    this.#checkSelectable(current);
    const config = await loadConfig(this.#repos, project.id);
    if (selectionPolicy(config, task.selection).policy === "vote") {
      throw invalidState(`${taskRef(task.number)} is selected by vote; open a vote and close it to select`);
    }
    const head = await this.#currentHead(project, current);
    const main = isOwnerAsThemselves(project, actor) ? OWNER_ACTS : mainSecrets(project.id, config);
    const { mr, closed } = this.#sql.transaction(() => {
      // The attempt, the task or its merge requests may have moved while the head was read.
      this.#checkSelectable(this.#attempt(current));
      return this.#select(project, actor, current, head, main);
    });
    await this.#archive(project, closed);
    return mr;
  }

  /**
   * Selection's row changes, in the caller's transaction: the merge request approving `head`, and
   * the task's other active attempts closed. The caller archives `closed` once it commits. `main`
   * is what `main` names when `actor` isn't the owner (see `#evaluate`).
   */
  #select(
    project: ProjectContext,
    actor: Actor,
    attempt: StoredAttempt,
    head: string,
    main: MainSecrets,
  ): { mr: StoredMergeRequest; closed: StoredAttempt[] } {
    const created = this.mergeRequests.select(actor, {
      task: attempt.task,
      attempt: attempt.number,
      head,
      byOwner: isOwnerAsThemselves(project, actor),
    });
    const others = this.#activeAttempts(attempt.task).filter((a) => a.number !== attempt.number);
    for (const other of others) this.#endAttempt(actor, other, "closed");
    return { mr: this.#evaluate(actor, created, main), closed: others };
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
    const main = isOwnerAsThemselves(project, actor) ? OWNER_ACTS : await this.#mainSecrets(project.id);
    return this.#sql.transaction(() => {
      const now = this.#openMergeRequest(task.number);
      if (now.id !== mr.id || now.state !== mr.state) {
        throw invalidState(`${taskRef(task.number)}'s merge request moved; try again`);
      }
      return this.#evaluate(
        actor,
        this.mergeRequests.approve(actor, now, head, isOwnerAsThemselves(project, actor)),
        main,
      );
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
   * The task's latest merge request's latest dequeue, with the details its landing's run holds: the
   * conflict, the steps that failed, or the error. Anyone signed in may read it. `notFound` when it
   * was never dequeued.
   */
  getDequeue(project: ProjectContext, actor: Actor, input: { task: number }): DequeueDetail {
    const mr = this.getMergeRequest(project, actor, input);
    const dequeue = mr.last_dequeue;
    if (dequeue === null) throw new ServiceError("notFound", `${taskRef(mr.task)} has never been dequeued`);
    return { reason: dequeue.reason, run: dequeue.run, at: dequeue.at, details: this.#dequeueDetails(dequeue) };
  }

  /** A dequeue's details, from its landing's run. */
  #dequeueDetails(dequeue: Dequeue): DequeueDetails | null {
    return dequeueDetails(dequeue, dequeue.run === null ? null : this.runs.getRun(dequeue.run));
  }

  /** The project's merge queue: the landing merge request first, then the queued ones, first in first out. */
  mergeQueue(_project: ProjectContext, _actor: Actor): StoredMergeRequest[] {
    return this.mergeRequests.queue();
  }

  // --- secrets ---------------------------------------------------------------------------------
  //
  // Maintainers, aliases included, read secrets' names and pipelines. Only the owner, acting as
  // themselves, sets, replaces, allows or deletes them, so an agent steered by untrusted text can't
  // grant one. Every change is journaled with its name and pipelines, never its value.

  /** The project's secrets, by name, without their values. */
  listSecrets(project: ProjectContext, actor: Actor): SecretSummary[] {
    mayMaintain(project, actor);
    return this.#secrets.list();
  }

  /** Sets a secret's value, its pipelines, or both. */
  async putSecret(
    project: ProjectContext,
    actor: Actor,
    input: SecretChange & { name: string },
  ): Promise<SecretSummary> {
    mayGrant(project, actor);
    const { name, ...change } = input;
    const secret = await this.#secrets.put(project.id, name, change);
    this.#record(actor, "secretSet", { name, pipelines: secret.pipelines });
    return secret;
  }

  /** Deletes a secret. */
  deleteSecret(project: ProjectContext, actor: Actor, input: { name: string }): void {
    mayGrant(project, actor);
    const secret = this.#secrets.delete(input.name);
    this.#record(actor, "secretDeleted", { name: secret.name, pipelines: secret.pipelines });
  }

  /**
   * For a running run's Workflow, before it starts any container: records the containers its plan
   * may start (`PipelineRuns.planned`), then checks the secrets each of its setups and checks names
   * (`named`) against the settings. A secret with no value or not allowed in the run's pipeline
   * refuses the run, naming the step and the secret. An untrusted run that names any secret waits
   * for the owner instead of starting, and a landing's merge request leaves the queue meanwhile; one
   * that names none, and a trusted one, go ahead.
   */
  pipelinePlanned(id: number, containers: readonly string[], named: readonly NamedSecrets[]): PlanVerdict {
    const verdict = this.#sql.transaction((): PlanVerdict => {
      this.runs.planned(id, containers);
      const run = this.runs.getRun(id);
      if (run === null) throw new Error(`no run ${id}`);
      // A newer head may have cancelled it meanwhile: it starts nothing.
      if (run.status !== "running") return { kind: "refused", error: `run ${id} is ${run.status}, not running` };
      for (const { step, secrets } of named) {
        const refused = this.#secrets.sealedFor(secrets, run.pipeline);
        if ("error" in refused) return { kind: "refused", error: `${step}: ${refused.error}` };
      }
      const names = [...new Set(named.flatMap((n) => n.secrets))];
      if (names.length === 0 || run.trusted) return { kind: "start" };
      if (!this.runs.wait(run, names)) return { kind: "refused", error: `run ${id} is no longer running` };
      // A landing no owner approved that names a secret was held for the owner before it joined the
      // queue, unless only its merged tree's config names one: it leaves the queue to wait for the
      // owner there, so it holds up no other landing.
      const mr = this.#landingMergeRequest(run);
      if (mr !== null) this.mergeRequests.holdForOwner(mr);
      return { kind: "waiting" };
    });
    // A run waiting for the owner has settled: `wait_for_run` answers.
    if (verdict.kind === "waiting") this.wakeWaiters();
    return verdict;
  }

  /**
   * For a trusted running run's step that starts a container: the sealed values of the secrets it
   * names, as the settings are now, or the first that's gone or no longer allowed in the run's
   * pipeline. Throws for a run that isn't trusted or running, which may hold none.
   */
  sealedSecretsFor(id: number, names: readonly string[]): ReturnType<Secrets["sealedFor"]> {
    const run = this.runs.getRun(id);
    if (run?.status !== "running" || !run.trusted) throw new Error(`run ${id} may hold no secrets`);
    return this.#secrets.sealedFor(names, run.pipeline);
  }

  // --- caches ----------------------------------------------------------------------------------
  //
  // A run's Workflow computes each cache's key hash before its containers start, then asks here where
  // each restores from and saves to: the scopes its line reads, and its own line's when the run is
  // trusted and no entry it reads matches. Entries it saved are recorded here; eviction deletes their
  // objects after every store call (`drain`) and on the Durable Object's alarm.

  /**
   * For a run's Workflow, before its containers start: for each cache key, the scope whose entry it
   * restores, marked used now, or null on a miss; and the scope a save goes to, which is the run's
   * own line's only when it's trusted, isn't an attempt's, and missed.
   */
  pipelineCaches(id: number, keys: readonly CacheKey[]): CacheLookup[] {
    return this.#cacheStore.lookup(id, keys);
  }

  /**
   * For a running run's Workflow, right before it saves an entry's object: whether it may, reserving
   * the key for it when it may. Only a trusted run saves, only to its own line's scope, and never over
   * an entry already there or another run's save of it, as entries are immutable.
   */
  pipelineCacheSaving(id: number, entry: Pick<CacheEntry, "scope" | "name" | "keyHash">): boolean {
    return this.#cacheStore.saving(id, entry);
  }

  /**
   * For a trusted running run's Workflow, once it saved an entry's object: records it in the index.
   * False when it isn't recorded: an entry for its key was saved first, or the run may not save there.
   */
  pipelineCacheSaved(id: number, entry: Pick<CacheEntry, "scope" | "name" | "keyHash" | "size">): boolean {
    return this.#cacheStore.saved(id, entry);
  }

  /** For a run's Workflow whose save of an entry it reserved failed: lets the key go for a later run. */
  pipelineCacheUnsaved(id: number, entry: Pick<CacheEntry, "scope" | "name" | "keyHash">): void {
    this.#cacheStore.unsaved(id, entry);
  }

  /** Deletes the objects of every evictable cache entry, then their rows; one that fails to delete stays for the next try. */
  async evictCaches(project: string): Promise<void> {
    await this.#cacheStore.evict(project);
  }

  // --- votes -----------------------------------------------------------------------------------
  //
  // Under the `vote` selection policy, a task's creator can make its selection by vote. Opening one
  // makes the task's passing attempts its candidates, each pinned to its head; `#candidateStanding`
  // says which still count. A withdrawn one can be added back once it passes at a new head. Each
  // user has one ballot, which their aliases share; the latest replaces the earlier. While a vote is
  // open the task's checks, metrics and selection policy can't change. Closing the vote selects the
  // candidate with the most ballots.

  /**
   * Opens a vote on the task among the attempts passing now, pinned to their heads, under the
   * eligibility of the task's selection policy, which must be `vote`. `deadline` (ISO 8601), if
   * given, is when ballots stop being taken. The task's creator or the project owner may.
   */
  async openVote(
    project: ProjectContext,
    actor: Actor,
    input: { task: number; deadline?: string | undefined },
  ): Promise<VoteDetail> {
    this.#mayManageTask(project, actor, this.#task(input.task));
    const config = await loadConfig(this.#repos, project.id);

    // From here to the vote nothing awaits, so two opens can't both pass.
    const task = this.#task(input.task);
    this.#mayManageTask(project, actor, task);
    this.#expect(task, ["open"], "open a vote on");
    const policy = selectionPolicy(config, task.selection);
    if (policy.policy !== "vote") {
      throw invalidState(`${taskRef(task.number)} is selected by its creator; its selection policy isn't vote`);
    }
    const deadline = input.deadline === undefined ? null : Date.parse(input.deadline);
    if (deadline !== null && !(deadline > this.#now().getTime())) {
      throw new ServiceError("invalidRequest", "deadline must be a time in the future");
    }
    if (this.mergeRequests.open(task.number) !== null) {
      throw invalidState(`${taskRef(task.number)} already has an open merge request`);
    }
    if (this.votes.open(task.number) !== null) throw invalidState(`${taskRef(task.number)} already has an open vote`);
    const at = this.#stamp();
    const candidates = this.#activeAttempts(task.number).flatMap((a) => {
      const head = this.#passingHead(a);
      return head === null ? [] : [{ attempt: a.number, head, added_at: at }];
    });
    if (candidates.length === 0) throw invalidState(`no attempt of ${taskRef(task.number)} is passing`);
    const vote = this.#sql.transaction(() => {
      const opened = this.votes.create(
        actor,
        {
          task: task.number,
          eligible: policy.eligible,
          deadline: deadline === null ? null : new Date(deadline).toISOString(),
          candidates,
        },
        at,
      );
      this.#journal(actor, "voteOpened", task.number, null, {
        candidates: candidates.map((c) => attemptRef(task.number, c.attempt)),
        eligible: policy.eligible,
      });
      return opened;
    });
    return this.#voteDetail(vote, actor);
  }

  /**
   * Casts the actor's ballot in the task's open vote for one of its candidates, replacing their
   * earlier one; an alias's ballot is its user's. Anyone the vote's eligibility lets in may, before
   * its deadline, except for their own attempt.
   */
  castVote(_project: ProjectContext, actor: Actor, input: AttemptInput): VoteDetail {
    const current = this.#attempt(input);
    this.#expect(this.#task(current.task), ["open"], "vote on");
    const vote = this.#openVote(current.task);
    if (vote.deadline !== null && Date.parse(vote.deadline) <= this.#now().getTime()) {
      throw invalidState(`${taskRef(vote.task)}'s vote stopped taking ballots at ${vote.deadline}`);
    }
    if (!mayVote(vote.eligible, actor.alias)) {
      throw new ServiceError("forbidden", `only ${ELIGIBLE_VOTERS[vote.eligible]} may vote on ${taskRef(vote.task)}`);
    }
    if (actor.user.id === current.author) {
      throw new ServiceError("forbidden", `the author of ${current.fork} can't vote for it`);
    }
    const candidate = this.#standing(vote, current);
    if (candidate === null) {
      throw invalidState(`${current.fork} isn't a candidate in ${taskRef(vote.task)}'s vote`);
    }
    this.#sql.transaction(() => {
      this.votes.cast(vote.id, {
        voter: actor.user.id,
        alias: actor.alias,
        attempt: current.number,
        head: candidate.head,
        at: this.#stamp(),
      });
      this.#journal(actor, "voteCast", current.task, current.number, { head: candidate.head });
    });
    return this.#voteDetail(vote, actor);
  }

  /**
   * Adds an attempt that is passing now to the task's open vote, pinned to its head: one that
   * started passing after the vote opened, or a withdrawn candidate passing again at a new head. The
   * task's creator or the project owner may.
   */
  addVoteCandidate(project: ProjectContext, actor: Actor, input: AttemptInput): VoteDetail {
    const current = this.#attempt(input);
    this.#mayManageTask(project, actor, this.#task(current.task));
    const vote = this.#openVote(current.task);
    const head = this.#passingHead(current);
    if (head === null) throw invalidState(`${current.fork} isn't passing`);
    if (this.#standing(vote, current) !== null) {
      throw invalidState(`${current.fork} is already a candidate in ${taskRef(vote.task)}'s vote`);
    }
    this.#sql.transaction(() => {
      this.votes.addCandidate(vote.id, { attempt: current.number, head, added_at: this.#stamp() });
      this.#journal(actor, "candidateAdded", current.task, current.number, { head });
    });
    return this.#voteDetail(vote, actor);
  }

  /**
   * Closes the task's open vote and selects its winner: the candidate with the most ballots, at the
   * head it was pinned to, as `selectAttempt` would. A tie goes to the task's creator (or the project
   * owner), who names one of the tied candidates as `attempt`. With every candidate withdrawn it
   * closes without a selection. Refused while a candidate's pinned head has no result yet (see
   * `#candidateStanding`); closing the task still closes it. The task's creator or the project owner
   * may.
   */
  async closeVote(
    project: ProjectContext,
    actor: Actor,
    input: { task: number; attempt?: number | undefined },
  ): Promise<{ vote: VoteDetail; selected: StoredMergeRequest | null }> {
    const task = this.#task(input.task);
    this.#mayManageTask(project, actor, task);
    const main = isOwnerAsThemselves(project, actor) ? OWNER_ACTS : await this.#mainSecrets(project.id);
    const { vote, mr, closed } = this.#sql.transaction(() => {
      const open = this.#openVote(task.number);
      const detail = this.#voteDetail(open, actor);
      const scoring = detail.candidates.filter((c) => c.being_scored).map((c) => attemptRef(task.number, c.attempt));
      if (scoring.length > 0) {
        throw invalidState(
          `${taskRef(task.number)}'s vote has candidates still being scored (${scoring.join(", ")}); ` +
            "close it once scoring finishes",
        );
      }
      const errored = detail.candidates.flatMap((c) =>
        c.errored_run === null ? [] : [`${attemptRef(task.number, c.attempt)} in run ${c.errored_run}`],
      );
      if (errored.length > 0) {
        throw invalidState(
          `${taskRef(task.number)}'s vote has candidates whose scoring errored (${errored.join(", ")}); ` +
            "rescore them, then close it",
        );
      }
      const winner = voteWinner(detail, input.attempt);
      const ended = this.#endVote(actor, open, winner);
      if (winner === null) return { vote: ended, mr: null, closed: [] };
      const source = this.#attempt({ task: task.number, number: winner.attempt });
      this.#checkSelectable(source);
      return { vote: ended, ...this.#select(project, actor, source, winner.head, main) };
    });
    await this.#archive(project, closed);
    return { vote: this.#voteDetail(vote, actor), selected: mr };
  }

  /** The task's latest vote, open or closed, with the actor's ballot. Anyone signed in may read it. */
  getVote(_project: ProjectContext, actor: Actor, input: { task: number }): VoteDetail {
    this.#task(input.task);
    const vote = this.votes.latest(input.task);
    if (vote === null) throw new ServiceError("notFound", `${taskRef(input.task)} has never had a vote`);
    return this.#voteDetail(vote, actor);
  }

  /** The attempt as a standing candidate of the vote: one not withdrawn. Null when it isn't one. */
  #standing(vote: StoredVote, attempt: StoredAttempt): StoredCandidate | null {
    const withdrawn = this.#withdrawn(vote.task);
    const found = this.votes.candidates(vote.id).find((c) => c.attempt === attempt.number);
    return found === undefined || withdrawn(found) ? null : found;
  }

  #openVote(task: number): StoredVote {
    const vote = this.votes.open(task);
    if (vote === null) throw invalidState(`${taskRef(task)} has no open vote`);
    return vote;
  }

  /**
   * Closes a vote with `winner`, or none, recording which candidates were withdrawn then, and
   * journals `voteClosed`; `actor` is null when it closes with its task.
   */
  #endVote(actor: Actor | null, vote: StoredVote, winner: StoredCandidate | null): StoredVote {
    const withdrawn = this.votes.candidates(vote.id).filter(this.#withdrawn(vote.task));
    const ended = this.votes.close(vote.id, actor, {
      winner: winner?.attempt ?? null,
      withdrawn: withdrawn.map((c) => c.attempt),
      at: this.#stamp(),
    });
    this.#journal(actor, "voteClosed", vote.task, null, {
      winner: winner === null ? null : attemptRef(vote.task, winner.attempt),
    });
    return ended;
  }

  /** The vote as the actor sees it: every candidate's tally, and their own ballot. */
  #voteDetail(vote: StoredVote, actor: Actor): VoteDetail {
    return this.votes.detail(vote, actor.user.id, this.#candidateStanding(vote.task));
  }

  /** Whether a candidate of a vote on `task` is withdrawn: `#candidateStanding` says it isn't standing. */
  #withdrawn(task: number): (candidate: StoredCandidate) => boolean {
    const standing = this.#candidateStanding(task);
    return (candidate) => standing(candidate).state !== "standing";
  }

  /**
   * Where a candidate of a vote on `task` stands, by the rule that adds one: standing while its
   * attempt is passing (`#passingHead`) at its pinned head. Withdrawn when its attempt isn't open,
   * its author pushed its head away from the pin (a follow moves the pin with it: `#followedTo`), or
   * that head's latest scoring failed the gate. While that head has no result yet it is out but not
   * withdrawn, and the vote can't close: `scoring` while its scoring (a follow's merge, or a
   * rescore) is queued or running, `errored` once it ended in error, which says nothing of the head,
   * until a rescore. Worked out when read, so a candidate force-pushed back to its pinned head and
   * passing there stands again, with its ballots.
   */
  #candidateStanding(task: number): (candidate: StoredCandidate) => CandidateStanding {
    return ({ attempt, head }) => {
      const current = this.#attemptRow({ task, number: attempt });
      const scored = current === undefined ? null : this.#scoredHead(current);
      if (scored?.sha !== head) return { state: "withdrawn" };
      if (scored.passed) return { state: "standing" };
      if (scored.status === "queued" || scored.status === "waiting" || scored.status === "running") {
        return { state: "scoring" };
      }
      const errored = scored.status === "errored" ? this.runs.scoredRun(attemptRef(task, attempt)) : null;
      return errored === null ? { state: "withdrawn" } : { state: "errored", run: errored };
    };
  }

  /** The head the attempt is passing at (see `#scoredHead`); null when it isn't passing. */
  #passingHead(attempt: AttemptInput & Pick<StoredAttempt, "state">): string | null {
    const scored = this.#scoredHead(attempt);
    return scored?.passed === true ? scored.sha : null;
  }

  /**
   * An open attempt's head, its latest scoring's status there, and whether it is passing there: that
   * scoring is done and its gate passed. Null when the attempt isn't open or has no head yet.
   */
  #scoredHead(
    attempt: AttemptInput & Pick<StoredAttempt, "state">,
  ): { sha: string; status: AttemptScoring["status"]; passed: boolean } | null {
    if (attempt.state !== "open") return null;
    const { sha, status } = this.runs.statusFor(attemptLine(attempt));
    if (sha === null) return null;
    const passed = status === "done" && this.runs.currentRun(attemptLine(attempt))?.result?.gate === "passed";
    return { sha, status, passed };
  }

  /**
   * Records how a pipeline run ended (see `PipelineRuns.finish`), then checks whether the merge
   * request its attempt is the source of can enter the queue. A landing's run that didn't land
   * dequeues its merge request instead. Returns whether the run was recorded.
   */
  pipelineFinished(run: number, report: RunReport, main: MainSecrets = UNKNOWN_MAIN): boolean {
    try {
      return this.#sql.transaction(() => {
        if (!this.runs.finish(run, report)) return false;
        const finished = this.runs.getRun(run);
        if (finished?.merge_request != null) {
          this.#landingEnded(finished);
          return true;
        }
        const mr = finished === null ? null : this.#sourceOf(finished);
        if (mr !== null) this.#evaluate(null, mr, main);
        return true;
      });
    } finally {
      this.wakeWaiters();
    }
  }

  /** The open merge request whose source attempt's line `run` ran on, if any. */
  #sourceOf(run: StoredRun): StoredMergeRequest | null {
    const attempt = parseAttemptRef(run.line);
    if (attempt === null) return null;
    const mr = this.mergeRequests.open(attempt.task);
    return mr?.attempt === attempt.number ? mr : null;
  }

  /**
   * Records a run's Workflow's report (see `pipelineFinished`). A landing that errored after its
   * `land` step claimed the push, without recording what it landed, may have pushed anyway (its
   * result lost after the push, say): when `main`'s head is its merge commit it is recorded as
   * landed first, so its merge request is merged, and never returns to `pending` to land twice.
   */
  async pipelineReported(run: number, report: RunReport): Promise<boolean> {
    const current = this.runs.getRun(run);
    const unrecorded = current?.status === "running" && current.land_claimed && current.sha === null;
    if (report.status === "errored" && unrecorded) {
      const sha = await this.landedOnMain(run);
      if (sha !== null) await this.pipelineLanded(run, sha);
    }
    // A merge request no owner approved may enter the queue once this run passes, unless `main` names secrets.
    const source = current === null ? null : this.#sourceOf(current);
    let main: MainSecrets = UNKNOWN_MAIN;
    if (source?.approved_by_owner === true) main = OWNER_ACTS;
    else if (current !== null && source !== null) main = await this.#mainSecrets(current.project);
    return this.pipelineFinished(run, report, main);
  }

  /** Records how a run ended from a report in the shape a Scoring Workflow gave (see `pipelineFinished`). */
  scoringFinished(run: number, outcome: ScoringOutcome): boolean {
    return this.pipelineFinished(run, runReport(outcome));
  }

  /**
   * For the merge queue: when nothing is landing, moves the front of the queue to `landing` and
   * returns it; otherwise null. `drain` queues its landing's run.
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
   * `failedChecks` or `errored`, naming the landing's run behind it, back to `pending` with its
   * approval kept. It requeues only on a new approval, or after a push and its approval.
   */
  dequeueMergeRequest(
    _project: ProjectContext,
    actor: Actor | null,
    { task, ...cause }: { task: number } & Extract<DequeueCause, { run: number }>,
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
  // A merge request's landing is a `main` run (spec #257, "Landing"). The Durable Object calls
  // `drain` after every store call and report. It cancels the landing's run of a merge request that
  // left the queue (a new push or a cancel), until its `land` step claims the push to main; then,
  // when nothing is landing, moves the front of the queue to `landing` and queues its run; then
  // starts follows and runs. `main` runs take a free slot first, and one runs at a time, so landings
  // and the deploys after them happen one after another. The run merges, runs the setups and checks
  // on the merged tree, claims the push (`claimLandingPush`), lands (`pipelineLanded`, which merges
  // the merge request), then runs the post-gate steps; a conflict, a failed gate or an error
  // dequeues the merge request instead, naming the run (`pipelineFinished`).

  /**
   * Deleting the project: cancels every run and follow not yet ended, terminating the Workflows of
   * those that had started and destroying their containers.
   */
  async stopAll(): Promise<void> {
    await this.runs.stopAll();
    const runner = this.#follow;
    const started = this.#sql.transaction(() => this.follows.stopAll());
    if (runner === null) return;
    await Promise.all(
      started.map(async (follow) => {
        const id = follow.instance_id ?? "";
        try {
          await (await runner.workflow.get(id)).terminate();
          await runner.teardown(id);
        } catch (error) {
          // It may already have finished, its container torn down by its own last step.
          console.warn({ event: "follow.stop_failed", instance_id: id, error: String(error) });
        }
      }),
    );
  }

  /** Cancels stale landings, queues the next one, starts queued follows, then drains the run queue. */
  async drain(project: string): Promise<void> {
    try {
      this.#sql.transaction(() => this.#drainLandings(project));
      await this.#drainFollows(project);
      await this.runs.drain();
      // A landing whose Workflow couldn't be started errored: its merge request leaves the queue, and
      // the next one's landing starts.
      if (this.#sql.transaction(() => this.#drainLandings(project))) await this.runs.drain();
      await this.#evictCachesSafely(project);
    } finally {
      this.wakeWaiters();
    }
  }

  /** Evicts cache entries without failing the drain: what isn't deleted now is next time. */
  async #evictCachesSafely(project: string): Promise<void> {
    try {
      await this.evictCaches(project);
    } catch (error) {
      console.error({ event: "cache.eviction_failed", project, error: String(error) });
    }
  }

  /**
   * For a landing's `land` step, right before it pushes: claims the push (again, for a retried
   * step), so the merge request can no longer be dequeued by a push or cancelled, and what the push
   * to main does is what gets recorded. False when its merge request left the queue: it must not push.
   */
  claimLandingPush(run: number): boolean {
    return this.#sql.transaction(() => {
      const current = this.runs.getRun(run);
      if (current?.merge_request == null || current.status !== "running") return false;
      if (!this.#landingCurrent(current)) return false;
      this.runs.claimLand(run);
      return true;
    });
  }

  /**
   * For a landing's run once its `land` step pushed `sha` to main: the landed sha becomes the run's
   * head and `main`'s, and the merge request is merged (its source attempt merged, its task closed,
   * its fork archived), journalling `mainAdvanced`. Its post-gate steps run after. Recorded once, in
   * one transaction before the archive, so a step retried after an interrupted archive finds it
   * recorded. Returns whether this call recorded it.
   */
  async pipelineLanded(run: number, sha: string): Promise<boolean> {
    try {
      const landed = this.#sql.transaction(() => {
        const current = this.runs.getRun(run);
        if (current?.merge_request == null || current.status !== "running" || !current.land_claimed) return null;
        if (current.sha !== null) return null;
        const mr = this.mergeRequests.get(current.merge_request);
        if (mr?.state !== "landing") return null;
        const { source } = this.#landRows(null, { task: mr.task, sha });
        this.runs.landed(current, sha);
        this.#journal(null, "mainAdvanced", mr.task, mr.attempt, {
          mergeRequest: taskRef(mr.task),
          head: mr.approved_head,
          sha,
          run,
        });
        return { project: current.project, source };
      });
      if (landed === null) return false;
      await this.#archive({ id: landed.project }, [landed.source]);
      return true;
    } finally {
      this.wakeWaiters();
    }
  }

  /**
   * `main`'s head when it is the landing's merge commit: a merge whose second parent is the approved
   * head. A landing whose `land` step lost its result after pushing reads it here, so it is recorded
   * as landed and its merge request never lands twice. Only landings write `main`, one at a time,
   * so nothing else can have put it there. A failed read throws, so the caller tries again.
   */
  async landedOnMain(run: number): Promise<string | null> {
    const current = this.runs.getRun(run);
    const mr = current?.merge_request == null ? null : this.mergeRequests.get(current.merge_request);
    if (current === null || mr === null) return null;
    const [tip] = await this.#repos.listCommits(originRepo(current.project), { ref: "main", limit: 1 });
    return tip !== undefined && tip.parents.length === 2 && tip.parents[1] === mr.approved_head ? tip.hash : null;
  }

  /**
   * A landing's run ended without landing (its `pipelineLanded` merged its merge request when it
   * did): a conflict, a failed gate or an error dequeues its merge request, naming the run, back to
   * `pending`, or to `needsReview` if its source moved meanwhile. One whose merge request already
   * left the queue changes nothing. In the caller's transaction.
   */
  #landingEnded(run: StoredRun): void {
    if (run.sha !== null || run.merge_request === null) return;
    const mr = this.mergeRequests.get(run.merge_request);
    if (mr?.state !== "landing") return;
    let reason: LandingDequeueReason = "errored";
    // A done landing that passed its gate yet recorded no landing errored: no step failed it.
    if (run.status === "done" && run.outcome?.landed === "conflict") reason = "conflict";
    else if (run.status === "done" && run.outcome?.gate !== "passed") reason = "failedChecks";
    const source = this.#attempt(sourceOf(mr));
    const moved = this.runs.statusFor(attemptLine(source)).sha !== mr.approved_head;
    this.mergeRequests.dequeue(null, mr, { reason, run: run.id }, moved ? "needsReview" : "pending");
  }

  /** A landing's run's merge request; null for any other run. */
  #landingMergeRequest(run: Pick<StoredRun, "merge_request">): StoredMergeRequest | null {
    return run.merge_request === null ? null : this.mergeRequests.get(run.merge_request);
  }

  /** Whether the landing's merge request is still open and landing. */
  #landingCurrent(run: StoredRun): boolean {
    const mr = this.#landingMergeRequest(run);
    return mr?.state === "landing";
  }

  /** Whether the landing's merge request is still in the queue: landing, or queued behind the one landing. */
  #inQueue(run: StoredRun): boolean {
    const mr = this.#landingMergeRequest(run);
    return mr?.state === "landing" || mr?.state === "queued";
  }

  /** Whether the merge request's landing has claimed its push to main. */
  #pushing(mr: StoredMergeRequest): boolean {
    if (mr.state !== "landing") return false;
    const run = this.runs.latestLanding(mr.id);
    return run?.status === "running" && run.land_claimed;
  }

  /**
   * Cancels each landing held for the owner whose merge request moved on (see `#releaseHeld`), and
   * each landing's run whose merge request left the queue, until it claims its push; then, when no
   * landing is queued or running but one that has landed (and runs its post-gate steps), moves the
   * front of the queue to `landing` and queues its run, unless the owner started one for it already.
   * A landing merge request whose run errored before it ran (its Workflow couldn't be started) is
   * dequeued first. Nothing lands without a runner to start runs. In the caller's
   * transaction; returns whether it changed anything.
   */
  #drainLandings(project: string): boolean {
    let changed = this.#releaseHeld();
    if (!this.#lands) return changed;
    for (const run of this.runs.liveLandings()) {
      if (run.land_claimed || this.#inQueue(run)) continue;
      this.runs.cancel(run, "its merge request left the queue");
      changed = true;
    }
    // A landing the owner started waits in the queue behind the one landing, and holds up none.
    if (this.runs.liveLandings().some((run) => run.sha === null && this.#landingCurrent(run))) return changed;
    for (const front of this.mergeRequests.queue()) {
      const last = front.state === "landing" ? this.runs.latestLanding(front.id) : null;
      if (last?.status === "errored") {
        this.#landingEnded(last);
        changed = true;
        continue;
      }
      // A merge request already landing with no run (one whose Landing Workflow was retired) gets one.
      const mr = front.state === "queued" ? this.mergeRequests.startLanding(null, front) : front;
      // One the owner started is its landing already.
      if (this.runs.latestLanding(mr.id)?.status === "queued") return true;
      this.runs.requestLanding({
        ...this.#landingRequest(project, mr),
        trusted: mr.approved_by_owner,
      });
      return true;
    }
    return changed;
  }

  /** What a landing's Workflow is told of its merge: the approved head, who approved it and who co-authored it. */
  #landingParams(run: StoredRun): LandingParams {
    const mr = this.#landingMergeRequest(run);
    if (mr === null) throw new Error(`run ${run.id} lands no merge request`);
    const coAuthors = this.#sql.exec<{ user: string; alias: string }>(
      `SELECT user_id AS user, alias FROM journal WHERE kind = 'pushed' AND task = ? AND attempt = ?
         AND user_id IS NOT NULL AND alias IS NOT NULL GROUP BY user_id, alias ORDER BY MIN(id)`,
      mr.task,
      mr.attempt,
    );
    return {
      task: mr.task,
      attempt: mr.attempt,
      title: this.#task(mr.task).title,
      head: mr.approved_head,
      approver: mr.approved_by,
      coAuthors: coAuthors.map(({ user, alias }) => ({ user, alias })),
      startedAt: run.created_at,
    };
  }

  // A Landing Workflow under way when landings became runs reports as it did, naming its landing's
  // old id, which its run keeps (`migrateLandings`). Once it resumes on the Pipeline Workflow's
  // code, it hands its landing back (`legacyLandingResumed`).

  /** For a Landing Workflow's land step, under its old code: `claimLandingPush` for its run. */
  claimLegacyLandingPush(landing: number): boolean {
    const run = this.runs.legacyLanding(landing);
    return run !== null && this.claimLandingPush(run.id);
  }

  /**
   * For a Landing Workflow ending under its old code: records its outcome on its run. One that
   * errored after claiming its push is landed when `main` holds its merge commit. Returns whether
   * it was recorded.
   */
  async legacyLandingFinished(landing: number, reported: LegacyLandingOutcome): Promise<boolean> {
    const run = this.runs.legacyLanding(landing);
    if (run?.status !== "running") return false;
    // A Workflow started before values were camelCase may still report `failedChecks`.
    const outcome = normaliseLandingOutcome(reported);
    let sha = outcome.kind === "landed" ? outcome.sha : null;
    if (outcome.kind === "errored" && run.land_claimed) sha = await this.landedOnMain(run.id);
    if (sha !== null) {
      // A landing no longer current may not land: its outcome is not recorded.
      if (!run.land_claimed && !this.claimLandingPush(run.id)) return false;
      await this.pipelineLanded(run.id, sha);
      return this.pipelineFinished(run.id, { status: "done", outcome: landedOutcome(sha) });
    }
    switch (outcome.kind) {
      case "landed": {
        return false;
      }
      case "conflict": {
        return this.pipelineFinished(run.id, { status: "done", outcome: conflictOutcome(outcome.details) });
      }
      case "failedChecks": {
        return this.pipelineFinished(run.id, { status: "done", outcome: legacyFailedOutcome(outcome.details) });
      }
      case "errored": {
        const { step, error } = outcome.details;
        return this.pipelineFinished(run.id, { status: "errored", error: `${step}: ${error}` });
      }
    }
  }

  /**
   * For a Landing Workflow resumed on the Pipeline Workflow's code, once its containers are gone:
   * one that had claimed its push and whose merge commit is on `main` landed; any other is let go,
   * and its merge request, still landing, gets a new landing's run at the next drain.
   */
  async legacyLandingResumed(landing: number): Promise<void> {
    const run = this.runs.legacyLanding(landing);
    if (run?.status !== "running") return;
    const sha = run.land_claimed ? await this.landedOnMain(run.id) : null;
    if (sha !== null) {
      await this.pipelineLanded(run.id, sha);
      this.pipelineFinished(run.id, { status: "done", outcome: landedOutcome(sha) });
      return;
    }
    this.#sql.transaction(() => this.runs.abandon(run, "its Landing Workflow was retired; the landing starts again"));
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

  /**
   * An attempt may be selected while it is open, on an open task with no open merge request and no
   * open vote.
   */
  #checkSelectable(attempt: StoredAttempt): void {
    this.#expect(attempt, ["open"], "select");
    this.#expect(this.#task(attempt.task), ["open"], "select an attempt of");
    if (this.mergeRequests.open(attempt.task) !== null) {
      throw invalidState(`${taskRef(attempt.task)} already has an open merge request`);
    }
    if (this.votes.open(attempt.task) !== null) {
      throw invalidState(`${taskRef(attempt.task)} has an open vote; close it to select its winner`);
    }
  }

  /** A task with an open merge request takes no new or reopened attempts. */
  #checkNoMergeRequest(task: number): void {
    if (this.mergeRequests.open(task) === null) return;
    throw invalidState(`${taskRef(task)} has an open merge request, so it takes no new attempts`);
  }

  /**
   * pending → queued when the merge request may join the queue (see `#queueable`). One no owner
   * approved whose `main` run would name a secret (`main`, which the caller read when the approver
   * isn't the owner) is held for the owner instead: its landing waits until the owner starts it,
   * which queues it as a trusted run. When the caller couldn't say what `main` names, it joins the
   * queue, and its landing's plan holds it for the owner if its merged tree names one; it stays held
   * at that head. Returns the merge request as it is afterwards.
   */
  #evaluate(actor: Actor | null, mr: StoredMergeRequest, main: MainSecrets = UNKNOWN_MAIN): StoredMergeRequest {
    this.#releaseHeld();
    if (!this.#queueable(mr)) return mr;
    if (!mr.approved_by_owner) {
      // A landing no owner approved holds no secret: one `main` would hand some waits for the owner,
      // and so does one whose plan found its merged tree's config names some (it began to run).
      const held = this.#heldLanding(mr);
      const heldAtPlan = held !== null && held.started_at !== null;
      if (main.kind !== "names" || heldAtPlan) {
        // Nothing says what `main` names, or its merged tree's config already said: the hold stands.
        if (held !== null) return mr;
      } else if (main.names.length > 0) {
        if (held === null) this.runs.holdLanding({ ...this.#landingRequest(main.project, mr), secrets: main.names });
        return mr;
      }
      if (held !== null) this.runs.cancel(held, "main names no secret any more");
    }
    return this.mergeRequests.enqueue(actor, mr);
  }

  /**
   * Whether a pending merge request may join the queue: it isn't held after a dequeue, its source
   * attempt is open, the approved head is still the attempt's head, and that head's latest scoring
   * run is done with a passing gate.
   */
  #queueable(mr: StoredMergeRequest): boolean {
    if (mr.state !== "pending" || this.mergeRequests.held(mr)) return false;
    const source = this.#attempt(sourceOf(mr));
    if (source.state !== "open") return false;
    const { status, sha } = this.runs.statusFor(attemptLine(source));
    if (sha !== mr.approved_head || status !== "done") return false;
    return this.runs.currentRun(attemptLine(source))?.result?.gate === "passed";
  }

  /** The merge request's landing held for the owner at its approved head, if it has one. */
  #heldLanding(mr: StoredMergeRequest): StoredRun | null {
    const run = this.runs.latestLanding(mr.id);
    return run?.status === "waiting" && run.merge_head === mr.approved_head ? run : null;
  }

  /**
   * Cancels each landing held for the owner whose merge request moved on: it left `pending`, was
   * approved at another head or by the owner, or is held after a dequeue. In the caller's
   * transaction; returns whether it cancelled any.
   */
  #releaseHeld(): boolean {
    let changed = false;
    for (const run of this.runs.heldLandings()) {
      const mr = this.#landingMergeRequest(run);
      const current =
        mr !== null && this.#queueable(mr) && !mr.approved_by_owner && mr.approved_head === run.merge_head;
      if (current) continue;
      this.runs.cancel(run, "its merge request moved on");
      changed = true;
    }
    return changed;
  }

  /** The secrets the `main` pipeline names under `main`'s config now (see `MainSecrets`). */
  async #mainSecrets(project: string): Promise<Extract<MainSecrets, { kind: "names" }>> {
    return mainSecrets(project, await loadConfig(this.#repos, project));
  }

  /** What a landing of the merge request is asked for with. */
  #landingRequest(project: string, mr: StoredMergeRequest): LandingRequest {
    return {
      project,
      mergeRequest: mr.id,
      head: mr.approved_head,
      attempt: attemptRef(mr.task, mr.attempt),
      approver: mr.approved_by,
    };
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
    const known = this.runs.statusFor(attemptLine(attempt)).sha;
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
    this.runs.cancelLine(attemptLine(attempt), "attempt merged");
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
    const scoring = this.runs.statusFor(attemptLine(row));
    return {
      ...toAttempt(row),
      scoring,
      verdicts: this.verdicts.summary(attemptKey(row), scoring.sha),
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
      scoredRun: this.runs.settledRun(attemptLine(input)),
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
    const readSince = this.runs.latestRunId(attemptLine(attempt));
    let head: string | null;
    try {
      const [commit] = await this.#repos.listCommits(forkRepo(project.id, attempt.fork), { ref: "main", limit: 1 });
      head = commit?.hash ?? null;
    } catch (error) {
      console.error({ event: "scoring.head_unreadable", attempt: attempt.fork, trigger, error: String(error) });
      return null;
    }
    return head === null
      ? null
      : this.#request(project, actor, attempt, head, trigger, { kind: "notAPush" }, readSince);
  }

  /** Asks for a run of the attempt's head `sha`; `pushedBy` as `ScoringRequestInput` takes it. */
  #request(
    project: ProjectId,
    actor: Actor | null,
    attempt: StoredAttempt,
    sha: string,
    trigger: ScoringTrigger,
    pushedBy: PushedBy,
    readSince?: number,
  ): ScoringRequest {
    return this.runs.request({
      project: project.id,
      line: attemptLine(attempt),
      sha,
      trigger,
      actor,
      pushedBy,
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

  /**
   * Moves a task to closed or obsolete, keeping the first close time and who closed it, and closes its
   * open vote without a selection, by nobody: the vote closed with its task.
   */
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
    // The task branch's line ends with its task: the caches it saved go.
    this.caches.endLine(taskRef(number));
    const vote = this.votes.open(number);
    if (vote !== null) this.#endVote(null, vote, null);
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
    this.runs.cancelLine(attemptLine(current), `attempt ${to}`);
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
      if (artifactsErrorCode(error) === "ALREADY_EXISTS") return false;
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
        const code = artifactsErrorCode(error);
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
    this.#record(actor, kind, detail, task, attempt);
  }

  /** Writes one journal entry, of a task or attempt when it names one. */
  #record(
    actor: Actor | null,
    kind: TaskEvent | MergeRequestEvent | ProjectEvent | "mainAdvanced",
    detail: Record<string, unknown>,
    task: number | null = null,
    attempt: number | null = null,
  ): void {
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
  "listRuns",
  "waitForRun",
  "cancelRun",
  "startRun",
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
  "openVote",
  "castVote",
  "addVoteCandidate",
  "closeVote",
  "getVote",
  "cancelMergeRequest",
  "getMergeRequest",
  "getDequeue",
  "mergeQueue",
  "listSecrets",
  "putSecret",
  "deleteSecret",
  "scoreNow",
  "rescore",
  "runLogKeys",
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
  const definitions = row.definitions === null ? NO_TASK_DEFINITIONS : upgradeDefinitions(row.definitions);
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
    definitions,
    check_writers:
      row.check_writers === null
        ? definitions.checks.map((check) => ({ name: check.name, user: row.creator, owner: false, at: 0 }))
        : (JSON.parse(row.check_writers) as CheckWriter[]),
    selection: row.selection === null ? null : (JSON.parse(row.selection) as SelectionPolicy),
  };
}

/**
 * A task's stored definitions, as JSON, in the current shape. Checks stored while a check could be
 * optional carry `required`, which is dropped: every check that runs must pass. Checks stored before
 * a check could wait for others have no `after`, and wait for none; those stored before checks used
 * caches have no `caches`, and use none. A task's check names no secrets and is in no group, and was
 * stored without either.
 */
function upgradeDefinitions(json: string): TaskDefinitions {
  const stored = { ...NO_TASK_DEFINITIONS, ...(JSON.parse(json) as Partial<TaskDefinitions>) };
  type StoredCheck = Omit<CheckConfig, "after" | "secrets" | "group" | "caches"> & {
    after?: string[];
    caches?: string[];
    required?: boolean;
  };
  const checks = (stored.checks as StoredCheck[]).map(
    ({ required: _required, after = [], caches = [], ...check }): CheckConfig => ({
      ...check,
      after,
      caches,
      secrets: [],
      group: null,
    }),
  );
  return { ...stored, checks };
}

/** A task's selection policy as stored: null to use the project's. */
function storedSelection(selection: SelectionPolicy | null): string | null {
  return selection === null ? null : JSON.stringify(selection);
}

/** A task's definitions as stored: null for none. */
function storedDefinitions(definitions: TaskDefinitions): string | null {
  const none = Object.values(definitions).every((list: unknown[]) => list.length === 0);
  return none ? null : JSON.stringify(definitions);
}

/**
 * A task's definitions after an edit: the checks and metrics it gave, with `current`'s for those it
 * left out, checked against the project's config on `main`.
 */
function editedDefinitions(
  input: TaskDefinitionsInput,
  current: TaskDefinitions,
  config: ConfigResult,
): TaskDefinitions {
  const checked = taskDefinitionsFrom(input, current, config);
  if ("error" in checked) throw new ServiceError("invalidRequest", checked.error);
  return checked.definitions;
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

/**
 * Throws unless `actor` owns the project, as themselves or under an alias. Kept apart from
 * `mayMaintain`: maintainers are only the owner for now, but owning stays the owner's alone once
 * a project has others.
 */
function mayOwn(project: ProjectContext, actor: Actor): void {
  if (actor.user.id !== project.owner) throw new ServiceError("forbidden", "only the project owner may");
}

/** Whether `actor` is one of the project's maintainers, as themselves or under an alias: for now, only its owner. */
function isMaintainer(project: ProjectContext, actor: Actor): boolean {
  return actor.user.id === project.owner;
}

/** Throws unless `actor` is one of the project's maintainers (see `isMaintainer`). */
function mayMaintain(project: ProjectContext, actor: Actor): void {
  if (!isMaintainer(project, actor)) throw new ServiceError("forbidden", "only the project's maintainers may");
}

function mainSecrets(project: string, config: ConfigResult): Extract<MainSecrets, { kind: "names" }> {
  return {
    kind: "names",
    project,
    names: [...new Set(pipelineSecrets(config, "main").flatMap((named) => named.secrets))],
  };
}

/**
 * Whether `actor` is the project owner acting as themselves, never under an alias: who may grant a
 * secret, start a waiting run or delete the project, and whose selection or approval trusts a landing.
 */
function isOwnerAsThemselves(project: ProjectContext, actor: Actor): boolean {
  return actor.user.id === project.owner && actor.alias === null;
}

/** Throws unless `actor` is the project owner acting as themselves (see `isOwnerAsThemselves`). */
export function mayGrant(project: ProjectContext, actor: Actor): void {
  if (!isOwnerAsThemselves(project, actor)) {
    throw new ServiceError("forbidden", "only the project owner, acting as themselves, may");
  }
}

/** The attempt's author, or one of their aliases, holds its claim. */
function mayAuthor(actor: Actor, current: StoredAttempt): void {
  if (actor.user.id !== current.author) throw new ServiceError("forbidden", `only the author of ${current.fork} may`);
}

/**
 * The vote's winner: the standing candidate with the most ballots. A tie is broken by `named`, one
 * of the tied candidates; `named`, if given, must be one of the leaders. Null when every candidate
 * is withdrawn.
 */
function voteWinner(vote: VoteDetail, named: number | undefined): CandidateTally | null {
  const leading = voteLeaders(vote.candidates);
  const refs = leading.map((c) => attemptRef(vote.task, c.attempt)).join(", ");
  if (named !== undefined) {
    const pick = leading.find((c) => c.attempt === named);
    if (pick === undefined) {
      const what = leading.length === 1 ? "the vote's winner" : "one of the tied candidates";
      throw new ServiceError("invalidRequest", `${attemptRef(vote.task, named)} isn't ${what}: ${refs}`);
    }
    return pick;
  }
  if (leading.length > 1) {
    throw new ServiceError("invalidRequest", `the vote is tied between ${refs}; name one as attempt to select it`);
  }
  return leading[0] ?? null;
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
