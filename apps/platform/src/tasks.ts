// The task and attempt services. Each resolves `owner/project` through D1, then runs the state
// machine in the project's Durable Object (`task-store.ts`), where the permission checks sit next
// to the state they guard. Answers carry users as `{id, handle}`, resolved from D1 at read time.

import { ServiceError } from "./errors.ts";
import { resolveProject } from "./projects.ts";
import type { CheckResult, ScoringResult } from "./results.ts";
import type { DequeueReason, StoredMergeRequest } from "./merge-requests.ts";
import { headAttemptRef, type AttemptScoring, type ScoringRequest, type StoredRun } from "./scoring.ts";
import {
  attemptRef,
  parseAttemptRef,
  parseTaskRef,
  taskRef,
  type AttemptInput,
  type AttemptScoringDetail,
  type AttemptState,
  type ProjectContext,
  type StoredAttempt,
  type StoredTask,
  type TaskMethod,
  type TaskOutcome,
  type TaskState,
  type TaskStore,
} from "./task-store.ts";
import type { Actor } from "./tokens.ts";
import type { Database } from "./users.ts";

/** A project's Durable Object, as the services call it: one store method per call. */
export interface TaskBackend {
  call(method: TaskMethod, args: unknown[]): Promise<TaskOutcome>;
}

export interface TaskServiceDeps {
  db: Database;
  /** The backend for a project id: its Durable Object in production, an in-process store in tests. */
  backend: (projectId: string) => TaskBackend;
}

export interface UserRef {
  id: string;
  handle: string;
}

export interface Task extends Omit<StoredTask, "creator" | "closed_by"> {
  ref: string;
  creator: UserRef;
  closed_by: UserRef | null;
}

export interface Attempt extends Omit<StoredAttempt, "author"> {
  ref: string;
  author: UserRef;
}

/** Who approved or created a merge request: a user, and the agent they acted under. */
export interface ActorRef extends UserRef {
  agent: string | null;
}

/** A merge request as the API shows it. Its latest dequeue's details are read separately. */
export interface MergeRequest {
  /** The task, `t42`, which also names its merge request. */
  task: string;
  /** The source attempt, `t42a3`. */
  attempt: string;
  state: StoredMergeRequest["state"];
  approved_head: string;
  approved_by: ActorRef;
  approved_at: string;
  queued_at: string | null;
  position: number | null;
  last_dequeue: { reason: DequeueReason; at: string } | null;
  merge_sha: string | null;
  merged_at: string | null;
  created_at: string;
  created_by: ActorRef;
}

/** One entry of a project's merge queue. */
export interface MergeQueueEntry {
  position: number;
  task: string;
  attempt: string;
  state: StoredMergeRequest["state"];
}

/** A scoring run as the API shows it. */
export interface ScoringRun {
  id: number;
  /** The attempt it scores, `t42a3`. */
  ref: string;
  sha: string;
  trigger: StoredRun["trigger"];
  status: StoredRun["status"];
  /** Who asked for it, or null when no user did. */
  requested_by: UserRef | null;
  agent: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** A scoring run with how it ended: its result once `done`, its error once `errored`. */
export interface RunDetail extends ScoringRun {
  /** Whether its head is no longer the attempt's current head. */
  superseded: boolean;
  error: string | null;
  result: PublicResult | null;
}

/** A result as answers carry it, its field names in snake_case like the rest of the API. */
export interface PublicResult extends Omit<ScoringResult, "checks" | "builtin"> {
  checks: (Omit<CheckResult, "durationMs"> & { duration_ms: number })[];
  builtin: { files_changed: number; additions: number; deletions: number; duration_ms: number };
}

/**
 * An attempt's current result: the latest `done` run for its current head, with the run it came
 * from and every check's metrics in one map (metric names are unique per project).
 */
export interface CurrentResult extends PublicResult {
  run: number;
  finished_at: string;
  metrics: Record<string, number>;
}

/** An attempt's scoring status for polling, with its current result once its head has one. */
export interface ScoringStatus extends AttemptScoring {
  result?: CurrentResult;
}

/** One attempt in a task's arena, obsolete or not: its state lets a UI filter. */
export interface ArenaAttempt extends ScoringStatus {
  ref: string;
  state: AttemptState;
  author: UserRef;
}

/** A task's arena: the current result of every attempt in it. */
export interface TaskArena {
  task: string;
  attempts: ArenaAttempt[];
}

/** What asking for scoring did: queued a run, or why not, with the run that covers the head. */
export interface ScoringAnswer {
  queued: boolean;
  reason: string | null;
  run: ScoringRun;
}

interface ProjectPath {
  owner: string;
  project: string;
}

type TaskPath = ProjectPath & { task: string };
type AttemptPath = ProjectPath & { attempt: string };

type StoreArgs<K extends TaskMethod> = Parameters<TaskStore[K]>;
type StoreResult<K extends TaskMethod> = Awaited<ReturnType<TaskStore[K]>>;

/** The task and attempt services. Any signed-in actor may read any project's tasks in P0. */
export function taskService({ db, backend }: TaskServiceDeps) {
  async function project(path: ProjectPath): Promise<ProjectContext> {
    const found = await resolveProject(db, path.owner, path.project);
    if (found === null) throw new ServiceError("not_found", `no project ${path.owner}/${path.project}`);
    return { id: found.id, owner: found.owner.id };
  }

  async function invoke<K extends TaskMethod>(method: K, ...args: StoreArgs<K>): Promise<StoreResult<K>> {
    const [ctx] = args as unknown as [ProjectContext];
    const outcome = await backend(ctx.id).call(method, args);
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message);
    return outcome.value as StoreResult<K>;
  }

  const tasks = async (list: StoredTask[]) => {
    const users = await handles(
      db,
      list.flatMap((t) => [t.creator, t.closed_by]),
    );
    return list.map((t) => publicTask(t, users));
  };
  const attempts = async (list: StoredAttempt[]) => {
    const users = await handles(
      db,
      list.map((a) => a.author),
    );
    return list.map((a) => publicAttempt(a, users));
  };

  /** A task transition: resolves the project and task reference, then runs `method`. */
  const taskMove =
    (method: "closeTask" | "reopenTask" | "obsoleteTask" | "restoreTask") =>
    async (actor: Actor, input: TaskPath): Promise<Task> =>
      one(await invoke(method, await project(input), actor, { task: taskNumber(input.task) }), tasks);

  /** An attempt transition: resolves the project and attempt reference, then runs `method`. */
  const attemptMove =
    (
      method: "openAttempt" | "draftAttempt" | "closeAttempt" | "reopenAttempt" | "obsoleteAttempt" | "restoreAttempt",
    ) =>
    async (actor: Actor, input: AttemptPath): Promise<Attempt> =>
      one(await invoke(method, await project(input), actor, attemptRefOf(input.attempt)), attempts);

  /** A scoring request: resolves the project and attempt reference, then runs `method`. */
  const scoringRequest =
    (method: "scoreNow" | "rescore") =>
    async (actor: Actor, input: AttemptPath): Promise<ScoringAnswer> => {
      const request = await invoke(method, await project(input), actor, attemptRefOf(input.attempt));
      return publicScoring(request, await handles(db, [request.run.user_id]));
    };

  const mergeRequest = async (mr: StoredMergeRequest): Promise<MergeRequest> =>
    publicMergeRequest(mr, await handles(db, [mr.approved_by.user, mr.created_by.user]));

  /** A merge request action on a task: resolves the project and task reference, then runs `method`. */
  const mergeRequestMove =
    (method: "approveMergeRequest" | "cancelMergeRequest" | "getMergeRequest") =>
    async (actor: Actor, input: TaskPath): Promise<MergeRequest> =>
      mergeRequest(await invoke(method, await project(input), actor, { task: taskNumber(input.task) }));

  return {
    /** Creates an open task; the caller's human is its creator. Any signed-in user may. */
    async createTask(
      actor: Actor,
      input: ProjectPath & { title: string; body?: string | undefined; attempt_limit?: number | null | undefined },
    ): Promise<Task> {
      const { title, body, attempt_limit } = input;
      return one(await invoke("createTask", await project(input), actor, { title, body, attempt_limit }), tasks);
    },

    async getTask(actor: Actor, input: TaskPath): Promise<Task> {
      return one(await invoke("getTask", await project(input), actor, { task: taskNumber(input.task) }), tasks);
    },

    /** The project's tasks; obsolete ones only when `state` is `obsolete`. */
    async listTasks(actor: Actor, input: ProjectPath & { state?: TaskState | undefined }): Promise<Task[]> {
      return tasks(await invoke("listTasks", await project(input), actor, { state: input.state }));
    },

    /** Edits a task. The project owner or the task's creator may. */
    async editTask(
      actor: Actor,
      input: TaskPath & {
        title?: string | undefined;
        body?: string | undefined;
        attempt_limit?: number | null | undefined;
      },
    ): Promise<Task> {
      const { title, body, attempt_limit } = input;
      const edit = { task: taskNumber(input.task), title, body, attempt_limit };
      return one(await invoke("editTask", await project(input), actor, edit), tasks);
    },

    closeTask: taskMove("closeTask"),
    reopenTask: taskMove("reopenTask"),
    obsoleteTask: taskMove("obsoleteTask"),
    restoreTask: taskMove("restoreTask"),

    /** Creates `count` draft attempts, each with its own fork. Any signed-in user may. */
    async createAttempts(
      actor: Actor,
      input: TaskPath & { count?: number | undefined; note?: string | undefined },
    ): Promise<Attempt[]> {
      const create = { task: taskNumber(input.task), count: input.count, note: input.note };
      return attempts(await invoke("createAttempts", await project(input), actor, create));
    },

    async getAttempt(actor: Actor, input: AttemptPath): Promise<Attempt> {
      return one(await invoke("getAttempt", await project(input), actor, attemptRefOf(input.attempt)), attempts);
    },

    /** A task's attempts; obsolete ones only when `state` is `obsolete`. */
    async listAttempts(actor: Actor, input: TaskPath & { state?: AttemptState | undefined }): Promise<Attempt[]> {
      const list = { task: taskNumber(input.task), state: input.state };
      return attempts(await invoke("listAttempts", await project(input), actor, list));
    },

    /** Edits an attempt's note. Only its author (or their agents) may. */
    async editAttempt(actor: Actor, input: AttemptPath & { note: string }): Promise<Attempt> {
      const edit = { ...attemptRefOf(input.attempt), note: input.note };
      return one(await invoke("editAttempt", await project(input), actor, edit), attempts);
    },

    openAttempt: attemptMove("openAttempt"),
    draftAttempt: attemptMove("draftAttempt"),
    closeAttempt: attemptMove("closeAttempt"),
    reopenAttempt: attemptMove("reopenAttempt"),
    obsoleteAttempt: attemptMove("obsoleteAttempt"),
    restoreAttempt: attemptMove("restoreAttempt"),

    /** Scores a draft attempt's head now. Only its author (or their agents) may. */
    scoreNow: scoringRequest("scoreNow"),
    /** Scores an open attempt's head again. Its author, the task's creator or the project owner may. */
    rescore: scoringRequest("rescore"),

    /** The R2 key of a run's log. An unknown run or log name is `not_found`. */
    async runLogKey(actor: Actor, input: ProjectPath & { run: number; name: string }): Promise<string> {
      return invoke("runLogKey", await project(input), actor, { run: input.run, name: input.name });
    },

    /** The attempt's scoring status and current result. Any signed-in user may read it. */
    async getScoring(actor: Actor, input: AttemptPath): Promise<ScoringStatus> {
      return scoringStatus(await invoke("getScoring", await project(input), actor, attemptRefOf(input.attempt)));
    },

    /**
     * The task's arena: every attempt, obsolete ones included, by number, with its state and
     * current result. Any signed-in user may read it.
     */
    async taskArena(actor: Actor, input: TaskPath): Promise<TaskArena> {
      const number = taskNumber(input.task);
      const list = await invoke("taskArena", await project(input), actor, { task: number });
      const users = await handles(
        db,
        list.map((a) => a.author),
      );
      return {
        task: taskRef(number),
        attempts: list.map(({ scoring, fork, state, author }) => ({
          ref: fork,
          state,
          author: userRef(author, users),
          ...scoringStatus(scoring),
        })),
      };
    },

    /** The attempt's scoring runs, newest first. Any signed-in user may read them. */
    async listScoringRuns(actor: Actor, input: AttemptPath): Promise<RunDetail[]> {
      const runs = await invoke("listScoringRuns", await project(input), actor, attemptRefOf(input.attempt));
      const users = await handles(
        db,
        runs.map((r) => r.user_id),
      );
      return runs.map((r) => runDetail(r, users));
    },

    /** One of the project's scoring runs. Any signed-in user may read it. */
    async getScoringRun(actor: Actor, input: ProjectPath & { run: number }): Promise<RunDetail> {
      const run = await invoke("getScoringRun", await project(input), actor, { run: input.run });
      return runDetail(run, await handles(db, [run.user_id]));
    },

    /**
     * Hands an active attempt to the user with handle `to`, who becomes its author. Only its
     * author (or their agents) may. An unknown handle is `not_found`; handing it to its own author
     * is `invalid_request`.
     */
    async handOffAttempt(actor: Actor, input: AttemptPath & { to: string }): Promise<Attempt> {
      const ref = attemptRefOf(input.attempt);
      const ctx = await project(input);
      const to = await db.prepare("SELECT id FROM users WHERE handle = ?").bind(input.to).first<{ id: string }>();
      if (to === null) throw new ServiceError("not_found", `no user ${input.to}`);
      return one(await invoke("handOffAttempt", ctx, actor, { ...ref, to: to.id }), attempts);
    },

    /**
     * Selects one of the task's open attempts as its merge request, approving its current head and
     * closing the task's other active attempts. The task's creator or the project owner may.
     */
    async selectAttempt(actor: Actor, input: TaskPath & { attempt: string }): Promise<MergeRequest> {
      const task = taskNumber(input.task);
      const ref = attemptRefOf(input.attempt);
      if (ref.task !== task) {
        throw new ServiceError("invalid_request", `${input.attempt} is not an attempt of ${taskRef(task)}`);
      }
      return mergeRequest(await invoke("selectAttempt", await project(input), actor, ref));
    },

    /** Approves the source attempt's current head. The task's creator or the project owner may. */
    approveMergeRequest: mergeRequestMove("approveMergeRequest"),
    /** Cancels the task's open merge request. The task's creator or the project owner may. */
    cancelMergeRequest: mergeRequestMove("cancelMergeRequest"),
    /** The task's latest merge request. Any signed-in user may read it. */
    getMergeRequest: mergeRequestMove("getMergeRequest"),

    /** The project's merge queue, front first. Any signed-in user may read it. */
    async mergeQueue(actor: Actor, input: ProjectPath): Promise<MergeQueueEntry[]> {
      const queue = await invoke("mergeQueue", await project(input), actor);
      return queue.map((mr) => ({
        position: mr.position ?? 0,
        task: taskRef(mr.task),
        attempt: attemptRef(mr.task, mr.attempt),
        state: mr.state,
      }));
    },
  };
}

export type TaskService = ReturnType<typeof taskService>;

/** Renders one item with a renderer for lists. */
async function one<T, U>(item: T, render: (list: T[]) => Promise<U[]>): Promise<U> {
  return (await render([item]))[0] as U;
}

/** A task reference (`t42` or `42`) as its number. */
function taskNumber(ref: string): number {
  const number = parseTaskRef(ref);
  if (number === null) throw new ServiceError("invalid_request", `not a task reference: ${ref}`);
  return number;
}

/** An attempt reference (`t42a3`) as its task and attempt numbers. */
function attemptRefOf(ref: string): AttemptInput {
  const parsed = parseAttemptRef(ref);
  if (parsed === null) throw new ServiceError("invalid_request", `not an attempt reference: ${ref}`);
  return parsed;
}

/** Handles for user ids, read from D1 in one query. */
async function handles(db: Database, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT id, handle FROM users WHERE id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<UserRef>();
  return new Map(results.map((u) => [u.id, u.handle]));
}

function userRef(id: string, users: Map<string, string>): UserRef {
  return { id, handle: users.get(id) ?? id };
}

function publicTask(t: StoredTask, users: Map<string, string>): Task {
  return {
    ...t,
    ref: taskRef(t.number),
    creator: userRef(t.creator, users),
    closed_by: t.closed_by === null ? null : userRef(t.closed_by, users),
  };
}

function publicAttempt(a: StoredAttempt, users: Map<string, string>): Attempt {
  return { ...a, ref: a.fork, author: userRef(a.author, users) };
}

function actorRef(acted: { user: string; agent: string | null }, users: Map<string, string>): ActorRef {
  return { ...userRef(acted.user, users), agent: acted.agent };
}

function publicMergeRequest(mr: StoredMergeRequest, users: Map<string, string>): MergeRequest {
  return {
    task: taskRef(mr.task),
    attempt: attemptRef(mr.task, mr.attempt),
    state: mr.state,
    approved_head: mr.approved_head,
    approved_by: actorRef(mr.approved_by, users),
    approved_at: mr.approved_at,
    queued_at: mr.queued_at,
    position: mr.position,
    last_dequeue: mr.last_dequeue === null ? null : { reason: mr.last_dequeue.reason, at: mr.last_dequeue.at },
    merge_sha: mr.merge_sha,
    merged_at: mr.merged_at,
    created_at: mr.created_at,
    created_by: actorRef(mr.created_by, users),
  };
}

function publicScoring(request: ScoringRequest, users: Map<string, string>): ScoringAnswer {
  return {
    queued: request.queued,
    reason: request.queued ? null : request.reason,
    run: publicRun(request.run, users),
  };
}

function publicRun(run: StoredRun, users: Map<string, string>): ScoringRun {
  return {
    id: run.id,
    ref: headAttemptRef(run),
    sha: run.sha,
    trigger: run.trigger,
    status: run.status,
    requested_by: run.user_id === null ? null : userRef(run.user_id, users),
    agent: run.agent,
    created_at: new Date(run.created_at).toISOString(),
    started_at: iso(run.started_at),
    finished_at: iso(run.finished_at),
  };
}

function runDetail(run: StoredRun, users: Map<string, string>): RunDetail {
  const result = run.result === null ? null : publicResult(run.result);
  return { ...publicRun(run, users), superseded: run.superseded, error: run.error, result };
}

function publicResult({ checks, builtin, ...result }: ScoringResult): PublicResult {
  return {
    ...result,
    checks: checks.map(({ durationMs, ...check }) => ({ ...check, duration_ms: durationMs })),
    builtin: {
      files_changed: builtin.filesChanged,
      additions: builtin.additions,
      deletions: builtin.deletions,
      duration_ms: builtin.durationMs,
    },
  };
}

/** An attempt's scoring status for polling, with its current result once its head has one. */
function scoringStatus({ current, ...status }: AttemptScoringDetail): ScoringStatus {
  return current === null ? status : { ...status, result: currentResult(current) };
}

function currentResult(run: StoredRun): CurrentResult {
  if (run.result === null || run.finished_at === null) throw new Error(`run ${run.id} is done without a result`);
  const metrics = Object.assign({}, ...run.result.checks.map((c) => c.metrics)) as Record<string, number>;
  const result = publicResult(run.result);
  return { ...result, run: run.id, finished_at: new Date(run.finished_at).toISOString(), metrics };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
