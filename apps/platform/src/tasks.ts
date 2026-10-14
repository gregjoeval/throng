// The task and attempt services. Each resolves `owner/project` through D1, then runs the state
// machine in the project's Durable Object (`task-store.ts`), where the permission checks sit next
// to the state they guard. Answers carry users as `{id, handle}`, resolved from D1 at read time.

import { currentBase, readTaskBranch } from "./base.ts";
import type { Base } from "./base.ts";
import { loadConfig, namedSecrets, selectionPolicy } from "./config.ts";
import type { CheckConfig, MetricConfig, SelectionPolicy, VoteEligibility } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { attemptRemote } from "./git-remotes.ts";
import type { ProjectPath } from "./git-remotes.ts";
import type { DequeueDetails } from "./landing.ts";
import type { DequeueReason, StoredMergeRequest } from "./merge-requests.ts";
import type { Pipeline } from "./pipelines.ts";
import { resolveProject } from "./projects.ts";
import type { Repos } from "./repos.ts";
import type { Gate, ScoringResult } from "./results.ts";
import type { RunOutcome, RunStep } from "./run-outcome.ts";
import { cancellable, runSettled } from "./scoring.ts";
import type { AttemptScoring, RunsQuery, ScoringRequest, StoredRun } from "./scoring.ts";
import { secretUses } from "./secrets.ts";
import type { SecretChange, SecretSummary, SecretUse } from "./secrets.ts";
import { NO_TASK_DEFINITIONS, taskDefinitionsFrom, withTask } from "./task-definitions.ts";
import type { TaskDefinitions, TaskDefinitionsInput } from "./task-definitions.ts";
import { attemptRef, parseAttemptRef, parseTaskRef, taskRef } from "./task-refs.ts";
import type {
  AttemptInput,
  AttemptMergeRequest,
  AttemptScoringDetail,
  AttemptState,
  ProjectContext,
  StoredAttempt,
  StoredTask,
  TaskMethod,
  TaskOutcome,
  TaskState,
  TaskStore,
  VerdictDetail,
} from "./task-store.ts";
import { isActive } from "./task-store.ts";
import type { Actor } from "./tokens.ts";
import type { Database } from "./users.ts";
import type { VerdictRecommendation, VerdictSummary } from "./verdicts.ts";
import type { VoteDetail, VoteState } from "./votes.ts";
import type { WaitCondition } from "./waiters.ts";

/** A project's Durable Object, as the services call it: one store method per call. */
export interface TaskBackend {
  call: (method: TaskMethod, args: unknown[]) => Promise<TaskOutcome>;
}

export interface TaskServiceDeps {
  db: Database;
  /** Read for each active attempt's base in the arena. */
  repos: Repos;
  /** The backend for a project id: its Durable Object in production, an in-process store in tests. */
  backend: (projectId: string) => TaskBackend;
  /** The platform's origin (`https://<host>`), which attempts' git remotes are under. */
  origin: string;
}

export interface UserRef {
  id: string;
  handle: string;
}

/** A task as the API shows it. */
export interface Task {
  ref: string;
  number: number;
  title: string;
  body: string;
  creator: UserRef;
  state: TaskState;
  createdAt: string;
  closedAt: string | null;
  closedBy: UserRef | null;
  attemptLimit: number | null;
  /** Its own checks, run after the project's; empty by default. */
  checks: CheckConfig[];
  /** Its own metrics, read after the project's; empty by default. */
  metrics: MetricConfig[];
  /** The head of its task branch (`refs/tasks/t42` in the origin), or null when it has none. */
  taskBranch: TaskBranch | null;
  /** Overrides the project's selection policy; null to use the project's. */
  selection: SelectionPolicy | null;
}

export interface TaskBranch {
  sha: string;
  /** How many of its commits `main` doesn't have yet: they land with the selected attempt. */
  commits: number;
}

/** A task as the task list shows it, with what its row summarises. */
export interface ListedTask extends Task {
  /** Its attempts, obsolete ones left out. */
  attemptCount: number;
  /** The best gate among those attempts' current results: `passed` beats `failed`; null when none has one. */
  bestGate: Gate | null;
  /** Its latest merge request's state, or null when it has none. */
  mergeRequestState: StoredMergeRequest["state"] | null;
}

/** An attempt as the API shows it. */
/** What every view of an attempt shows beside its state: its alias, where it came from, whether it needs update, its verdicts. */
interface AttemptStanding {
  /** The alias its author started it under; null when they acted as themselves, or after a hand-off. */
  alias: string | null;
  /** The attempt of the same task it was copied from when it was started; absent when it wasn't. Never its base. */
  forkedFrom?: string;
  /** Its task branch moved and merging it in conflicted; its author merges it to clear this. */
  needsUpdate: boolean;
  verdicts: VerdictSummary;
}

export interface Attempt extends AttemptStanding {
  ref: string;
  task: number;
  number: number;
  author: UserRef;
  state: AttemptState;
  fork: string;
  /** The attempt's git remote, its fork: `https://<host>/git/<owner>/<project>/t42a3.git`. */
  remote: string;
  branch: string | null;
  note: string;
  createdAt: string;
  closedAt: string | null;
  mergedSha: string | null;
  archivedSha: string | null;
  scoring: AttemptScoring;
  mergeRequest: { state: AttemptMergeRequest["state"]; lastDequeue: { reason: DequeueReason } | null } | null;
}

/** An attempt a wait answered with, and whether what it watched changed. */
export interface WaitedAttempt extends Attempt {
  changed: boolean;
}

/** A reviewer's verdict on one head of an attempt, as the API shows it. */
export interface Verdict {
  reviewer: UserRef;
  /** The alias the reviewer posted under, if any. */
  alias: string | null;
  head: string;
  recommendation: VerdictRecommendation;
  body: string;
  at: string;
  /** Whether its head is no longer the attempt's current head. */
  superseded: boolean;
}

/** Who approved or created a merge request: a user, and the alias they acted under. */
export interface ActorRef extends UserRef {
  alias: string | null;
}

/** A merge request as the API shows it. Its latest dequeue's details are read separately. */
export interface MergeRequest {
  /** The task, `t42`, which also names its merge request. */
  task: string;
  /** The source attempt, `t42a3`. */
  attempt: string;
  state: StoredMergeRequest["state"];
  approvedHead: string;
  approvedBy: ActorRef;
  approvedAt: string;
  queuedAt: string | null;
  position: number | null;
  /** Why it last left the queue, when, and the landing's run behind it (null for a new push or a cancel). */
  lastDequeue: { reason: DequeueReason; run: number | null; at: string } | null;
  mergeSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  createdBy: ActorRef;
}

/** A task's vote as the API shows it, with each candidate's tally and the caller's own ballot. */
export interface Vote {
  task: string;
  state: VoteState;
  eligible: VoteEligibility;
  deadline: string | null;
  openedBy: ActorRef;
  openedAt: string;
  closedBy: ActorRef | null;
  closedAt: string | null;
  /** The attempt it selected, `t42a3`, once closed with a selection. */
  winner: string | null;
  candidates: {
    attempt: string;
    head: string;
    addedAt: string;
    votes: number;
    withdrawn: boolean;
    beingScored: boolean;
    erroredRun: number | null;
  }[];
  myBallot: { attempt: string; head: string; alias: string | null; at: string } | null;
}

/** A closed vote, and the merge request it selected, if it selected one. */
export interface ClosedVote {
  vote: Vote;
  mergeRequest: MergeRequest | null;
}

/**
 * A merge request's latest dequeue, the landing's run behind it, and the details that run holds:
 * the conflict, the steps that failed, or the error. Null run and details for a new push or a cancel.
 */
export interface MergeRequestDequeue {
  reason: DequeueReason;
  run: number | null;
  at: string;
  details: DequeueDetails | null;
}

/** One entry of a project's merge queue. */
export interface MergeQueueEntry {
  position: number;
  task: string;
  attempt: string;
  state: StoredMergeRequest["state"];
}

/** A pipeline run as the API lists it. */
export interface Run {
  id: number;
  /** The line it runs on: `t42a3`, `t42` or `main`. */
  line: string;
  pipeline: Pipeline;
  /** The head it runs; null for a landing until it lands. */
  sha: string | null;
  trigger: StoredRun["trigger"];
  status: StoredRun["status"];
  /** Whether it may hold the secrets its pipeline allows. */
  trusted: boolean;
  /** Who asked for it, or null when no user did. */
  requestedBy: UserRef | null;
  alias: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Whether its head is no longer its line's current head. */
  superseded: boolean;
  /** Its gate once `done`, else null. */
  gate: Gate | null;
  /** Whether the project owner may cancel it now. */
  cancellable: boolean;
}

/** A run with how it ended: its outcome (and the slice scoring reads) once `done`, its error once `errored`. */
export interface RunDetail extends Run {
  error: string | null;
  outcome: PublicRunOutcome | null;
  result: ScoringResult | null;
}

/** A run's outcome as the API shows it: each step says which checks it waited for. */
export interface PublicRunOutcome extends Omit<RunOutcome, "steps"> {
  steps: (RunStep & { after: string[] })[];
}

/** A page of a project's runs, newest first, with the cursor of the next. */
export interface RunsList {
  runs: Run[];
  /** The next page's `cursor`; null on the last page. */
  next: number | null;
}

/** A run after a wait, and whether it is done or waiting for the owner. */
export interface WaitedRun extends RunDetail {
  settled: boolean;
}

/** An attempt's current result: the latest `done` run for its current head, with the run it came from. */
export interface CurrentResult extends ScoringResult {
  run: number;
  finishedAt: string;
}

/** An attempt's scoring status for polling, with its current result once its head has one. */
export interface ScoringStatus extends AttemptScoring {
  result?: CurrentResult;
}

/** One attempt in a task's arena, obsolete or not: its state lets a UI filter. */
export interface ArenaAttempt extends ScoringStatus, AttemptStanding {
  ref: string;
  state: AttemptState;
  author: UserRef;
  /** An active attempt's base at its current head, scored or not (`currentBase`); null otherwise. */
  base: Base | null;
}

/** A task's arena: the current result of every attempt in it. */
export interface TaskArena {
  task: string;
  /**
   * Every metric a run of the task's attempts would read: the config on `origin/main`'s, then the
   * task's, each with its `source`; none when they don't merge into a valid config.
   */
  metrics: MetricConfig[];
  /** The selection policy in effect: the task's override, else the config on `origin/main`'s. */
  selection: SelectionPolicy;
  /** The task's open vote, or null when it has none. */
  vote: Vote | null;
  attempts: ArenaAttempt[];
}

/** What asking for scoring did: queued a run, or why not, with the run that covers the head. */
export interface ScoringAnswer {
  queued: boolean;
  reason: string | null;
  run: Run;
}

type TaskPath = ProjectPath & { task: string };
type AttemptPath = ProjectPath & { attempt: string };

type StoreArgs<K extends TaskMethod> = Parameters<TaskStore[K]>;
type StoreResult<K extends TaskMethod> = Awaited<ReturnType<TaskStore[K]>>;

/** The task and attempt services. Any signed-in actor may read any project's tasks in P0. */
export function taskService({ db, repos, backend, origin }: TaskServiceDeps) {
  async function project(path: ProjectPath): Promise<ProjectContext> {
    const found = await resolveProject(db, path.owner, path.project);
    if (found === null) throw new ServiceError("notFound", `no project ${path.owner}/${path.project}`);
    return { id: found.id, owner: found.owner.id };
  }

  async function invoke<K extends TaskMethod>(method: K, ...args: StoreArgs<K>): Promise<StoreResult<K>> {
    const [ctx] = args as unknown as [ProjectContext];
    const outcome = await backend(ctx.id).call(method, args);
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message);
    return outcome.value as StoreResult<K>;
  }

  /**
   * A new task's checks and metrics as a request gave them, checked against the project's config on
   * `main`; none when it gave neither. Anyone may create a task; an edit's are checked by the store,
   * after who may edit.
   */
  async function newTaskDefinitions(ctx: ProjectContext, input: TaskDefinitionsInput): Promise<TaskDefinitions> {
    if (input.checks === undefined && input.metrics === undefined) return NO_TASK_DEFINITIONS;
    const checked = taskDefinitionsFrom(input, NO_TASK_DEFINITIONS, await loadConfig(repos, ctx.id));
    if ("error" in checked) throw new ServiceError("invalidRequest", checked.error);
    return checked.definitions;
  }

  /** Renders tasks of project `ctx`, each with its task branch read from the origin. */
  const tasks = (ctx: ProjectContext) => async (list: StoredTask[]) => {
    const [users, branches] = await Promise.all([
      handles(
        db,
        list.flatMap((t) => [t.creator, t.closed_by]),
      ),
      Promise.all(list.map((t) => readTaskBranch(repos, ctx.id, t.number))),
    ]);
    return list.map((t, i) => publicTask(t, users, branches[i] ?? null));
  };
  /** Renders attempts of the project at `path`, each with its git remote. */
  const attempts = (path: ProjectPath) => async (list: StoredAttempt[]) => {
    const users = await handles(
      db,
      list.map((a) => a.author),
    );
    return list.map((a) => publicAttempt(a, users, attemptRemote(origin, path, a.fork)));
  };

  /** A task transition: resolves the project and task reference, then runs `method`. */
  const taskMove =
    (method: "closeTask" | "reopenTask" | "obsoleteTask" | "restoreTask") =>
    async (actor: Actor, input: TaskPath): Promise<Task> => {
      const ctx = await project(input);
      return one(await invoke(method, ctx, actor, { task: taskNumber(input.task) }), tasks(ctx));
    };

  /** An attempt transition: resolves the project and attempt reference, then runs `method`. */
  const attemptMove =
    (
      method: "openAttempt" | "draftAttempt" | "closeAttempt" | "reopenAttempt" | "obsoleteAttempt" | "restoreAttempt",
    ) =>
    async (actor: Actor, input: AttemptPath): Promise<Attempt> =>
      one(await invoke(method, await project(input), actor, attemptRefOf(input.attempt)), attempts(input));

  /** A scoring request: resolves the project and attempt reference, then runs `method`. */
  const scoringRequest =
    (method: "scoreNow" | "rescore") =>
    async (actor: Actor, input: AttemptPath): Promise<ScoringAnswer> => {
      const request = await invoke(method, await project(input), actor, attemptRefOf(input.attempt));
      return publicScoring(request, await handles(db, [request.run.user_id]));
    };

  const mergeRequest = async (mr: StoredMergeRequest): Promise<MergeRequest> =>
    publicMergeRequest(mr, await handles(db, [mr.approved_by.user, mr.created_by.user]));

  const vote = async (v: VoteDetail): Promise<Vote> =>
    publicVote(v, await handles(db, [v.opened_by.user, v.closed_by?.user ?? null]));

  /** A vote action naming one of the task's attempts: resolves the project and references, then runs `method`. */
  const voteFor =
    (method: "castVote" | "addVoteCandidate") =>
    async (actor: Actor, input: TaskPath & { attempt: string }): Promise<Vote> =>
      vote(await invoke(method, await project(input), actor, attemptOfTask(input)));

  /** A merge request action on a task: resolves the project and task reference, then runs `method`. */
  const mergeRequestMove =
    (method: "approveMergeRequest" | "cancelMergeRequest" | "getMergeRequest") =>
    async (actor: Actor, input: TaskPath): Promise<MergeRequest> =>
      mergeRequest(await invoke(method, await project(input), actor, { task: taskNumber(input.task) }));

  return {
    /** Creates an open task; the caller's user is its creator. Any signed-in user may. */
    async createTask(
      actor: Actor,
      input: ProjectPath &
        TaskDefinitionsInput & {
          title: string;
          body?: string | undefined;
          attemptLimit?: number | null | undefined;
          selection?: SelectionPolicy | null | undefined;
        },
    ): Promise<Task> {
      const { title, body, attemptLimit, selection } = input;
      const ctx = await project(input);
      const definitions = await newTaskDefinitions(ctx, input);
      const create = { title, body, attemptLimit, selection, ...definitions };
      return one(await invoke("createTask", ctx, actor, create), tasks(ctx));
    },

    async getTask(actor: Actor, input: TaskPath): Promise<Task> {
      const ctx = await project(input);
      return one(await invoke("getTask", ctx, actor, { task: taskNumber(input.task) }), tasks(ctx));
    },

    /** The project's tasks; obsolete ones only when `state` is `obsolete`. */
    async listTasks(actor: Actor, input: ProjectPath & { state?: TaskState | undefined }): Promise<ListedTask[]> {
      const ctx = await project(input);
      const list = await invoke("listTasks", ctx, actor, { state: input.state });
      const shown = await tasks(ctx)(list);
      return list.map((t, i) => ({
        ...(shown[i] as Task),
        attemptCount: t.attempt_count,
        bestGate: t.best_gate,
        mergeRequestState: t.merge_request_state,
      }));
    },

    /** Edits a task. The project owner or the task's creator may. */
    async editTask(
      actor: Actor,
      input: TaskPath &
        TaskDefinitionsInput & {
          title?: string | undefined;
          body?: string | undefined;
          attemptLimit?: number | null | undefined;
          selection?: SelectionPolicy | null | undefined;
        },
    ): Promise<Task> {
      const { title, body, attemptLimit, selection } = input;
      const ctx = await project(input);
      // The store checks the checks and metrics itself, once it has checked who may edit the task.
      const { checks, metrics } = input;
      const edit = { task: taskNumber(input.task), title, body, attemptLimit, selection, checks, metrics };
      return one(await invoke("editTask", ctx, actor, edit), tasks(ctx));
    },

    closeTask: taskMove("closeTask"),
    reopenTask: taskMove("reopenTask"),
    obsoleteTask: taskMove("obsoleteTask"),
    restoreTask: taskMove("restoreTask"),

    /** Creates `count` draft attempts, each with its own fork. Any signed-in user may. */
    async createAttempts(
      actor: Actor,
      input: TaskPath & { count?: number | undefined; note?: string | undefined; from?: string | undefined },
    ): Promise<Attempt[]> {
      const create = {
        task: taskNumber(input.task),
        count: input.count,
        note: input.note,
        from: input.from === undefined ? undefined : attemptRefOf(input.from),
      };
      return attempts(input)(await invoke("createAttempts", await project(input), actor, create));
    },

    async getAttempt(actor: Actor, input: AttemptPath): Promise<Attempt> {
      return one(await invoke("getAttempt", await project(input), actor, attemptRefOf(input.attempt)), attempts(input));
    },

    /**
     * Holds until what `until` watches on the attempt changes, or `wait` seconds pass (see
     * `TaskStore.waitForAttempt`), then answers with the attempt and whether it changed. Waits live
     * in the project's Durable Object's memory, so a deploy or an eviction drops them: one dropped
     * answers with the attempt as it is now, unchanged, and the caller waits again.
     */
    async waitForAttempt(
      actor: Actor,
      input: AttemptPath & { wait: number; until: WaitCondition },
    ): Promise<WaitedAttempt> {
      const ctx = await project(input);
      const ref = attemptRefOf(input.attempt);
      try {
        const { changed, ...attempt } = await invoke("waitForAttempt", ctx, actor, {
          ...ref,
          wait: input.wait,
          until: input.until,
        });
        return { ...(await one(attempt, attempts(input))), changed };
      } catch (error) {
        if (!droppedByReset(error)) throw error;
        return { ...(await one(await invoke("getAttempt", ctx, actor, ref), attempts(input))), changed: false };
      }
    },

    /** A task's attempts; obsolete ones only when `state` is `obsolete`. */
    async listAttempts(actor: Actor, input: TaskPath & { state?: AttemptState | undefined }): Promise<Attempt[]> {
      const list = { task: taskNumber(input.task), state: input.state };
      return attempts(input)(await invoke("listAttempts", await project(input), actor, list));
    },

    /** Edits an attempt's note. Only its author (or their aliases) may. */
    async editAttempt(actor: Actor, input: AttemptPath & { note: string }): Promise<Attempt> {
      const edit = { ...attemptRefOf(input.attempt), note: input.note };
      return one(await invoke("editAttempt", await project(input), actor, edit), attempts(input));
    },

    openAttempt: attemptMove("openAttempt"),
    draftAttempt: attemptMove("draftAttempt"),
    closeAttempt: attemptMove("closeAttempt"),
    reopenAttempt: attemptMove("reopenAttempt"),
    obsoleteAttempt: attemptMove("obsoleteAttempt"),
    restoreAttempt: attemptMove("restoreAttempt"),

    /** Scores a draft attempt's head now. Only its author (or their aliases) may. */
    scoreNow: scoringRequest("scoreNow"),
    /** Scores an open attempt's head again. Its author, the task's creator or the project owner may. */
    rescore: scoringRequest("rescore"),

    /** The R2 keys a run's log may be under, in the order to try. An unknown run or log name is `notFound`. */
    async runLogKeys(actor: Actor, input: ProjectPath & { run: number; name: string }): Promise<string[]> {
      return invoke("runLogKeys", await project(input), actor, { run: input.run, name: input.name });
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
      const ctx = await project(input);
      const arena = await invoke("taskArena", ctx, actor, { task: number });
      const { definitions, attempts: list } = arena;
      const [users, bases, config] = await Promise.all([
        handles(
          db,
          list.map((a) => a.author),
        ),
        Promise.all(list.map(({ fork, state }) => (isActive(state) ? currentBase(repos, ctx.id, fork) : null))),
        loadConfig(repos, ctx.id),
      ]);
      const merged = withTask(config, definitions);
      return {
        task: taskRef(number),
        metrics: merged.kind === "valid" ? merged.config.metrics : [],
        selection: selectionPolicy(config, arena.selection),
        vote: arena.vote === null ? null : await vote(arena.vote),
        attempts: list.map(({ scoring, fork, state, author, alias, verdicts, forked_from, needs_update }, i) => ({
          ref: fork,
          state,
          author: userRef(author, users),
          alias,
          ...scoringStatus(scoring),
          base: bases[i] ?? null,
          ...forkedFrom(forked_from),
          needsUpdate: needs_update,
          verdicts,
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

    /** One of the project's runs, with its outcome. Any signed-in user may read it. */
    async getScoringRun(actor: Actor, input: ProjectPath & { run: number }): Promise<RunDetail> {
      const run = await invoke("getScoringRun", await project(input), actor, { run: input.run });
      return runDetail(run, await handles(db, [run.user_id]));
    },

    /** A page of the project's runs on every line, newest first. Any signed-in user may read them. */
    async listRuns(
      actor: Actor,
      input: ProjectPath & Omit<RunsQuery, "before"> & { cursor?: number | undefined },
    ): Promise<RunsList> {
      const { line, status, cursor, limit } = input;
      const page = await invoke("listRuns", await project(input), actor, { line, status, before: cursor, limit });
      return { runs: await publicRuns(db, page.runs), next: page.next };
    },

    /**
     * Holds until the run is done (or ended otherwise) or waits for the owner, or `wait` seconds
     * pass, then answers with the run and whether it settled. A deploy drops waits in flight: one
     * dropped answers with the run as it is now.
     */
    async waitForRun(actor: Actor, input: ProjectPath & { run: number; wait: number }): Promise<WaitedRun> {
      const ctx = await project(input);
      try {
        const { settled, ...run } = await invoke("waitForRun", ctx, actor, { run: input.run, wait: input.wait });
        return { ...runDetail(run, await handles(db, [run.user_id])), settled };
      } catch (error) {
        if (!droppedByReset(error)) throw error;
        const run = await invoke("getScoringRun", ctx, actor, { run: input.run });
        return { ...runDetail(run, await handles(db, [run.user_id])), settled: runSettled(run) };
      }
    },

    /** Cancels a run that can be cancelled. Only the project owner may. */
    async cancelRun(actor: Actor, input: ProjectPath & { run: number }): Promise<RunDetail> {
      const run = await invoke("cancelRun", await project(input), actor, { run: input.run });
      return runDetail(run, await handles(db, [run.user_id]));
    },

    /**
     * Hands an active attempt to the user with handle `to`, who becomes its author. Only its
     * author (or their aliases) may. An unknown handle is `notFound`; handing it to its own author
     * is `invalidRequest`.
     */
    async handOffAttempt(actor: Actor, input: AttemptPath & { to: string }): Promise<Attempt> {
      const ref = attemptRefOf(input.attempt);
      const ctx = await project(input);
      const to = await db.prepare("SELECT id FROM users WHERE handle = ?").bind(input.to).first<{ id: string }>();
      if (to === null) throw new ServiceError("notFound", `no user ${input.to}`);
      return one(await invoke("handOffAttempt", ctx, actor, { ...ref, to: to.id }), attempts(input));
    },

    /**
     * Posts the actor's verdict on the attempt's current head, replacing their earlier one on it.
     * Anyone but the attempt's author (or their aliases) may, while it is active or merged.
     */
    async postVerdict(
      actor: Actor,
      input: AttemptPath & { recommendation: VerdictRecommendation; body: string },
    ): Promise<Verdict> {
      const post = { ...attemptRefOf(input.attempt), recommendation: input.recommendation, body: input.body };
      const verdict = await invoke("postVerdict", await project(input), actor, post);
      return publicVerdict(verdict, await handles(db, [verdict.reviewer]));
    },

    /** The attempt's verdicts on every head, oldest first. Any signed-in user may read them. */
    async listVerdicts(actor: Actor, input: AttemptPath): Promise<Verdict[]> {
      const list = await invoke("listVerdicts", await project(input), actor, attemptRefOf(input.attempt));
      const users = await handles(
        db,
        list.map((v) => v.reviewer),
      );
      return list.map((v) => publicVerdict(v, users));
    },

    /**
     * Selects one of the task's open attempts as its merge request, approving its current head and
     * closing the task's other active attempts. The task's creator or the project owner may.
     */
    async selectAttempt(actor: Actor, input: TaskPath & { attempt: string }): Promise<MergeRequest> {
      return mergeRequest(await invoke("selectAttempt", await project(input), actor, attemptOfTask(input)));
    },

    /** Approves the source attempt's current head. The task's creator or the project owner may. */
    approveMergeRequest: mergeRequestMove("approveMergeRequest"),
    /** Cancels the task's open merge request. The task's creator or the project owner may. */
    cancelMergeRequest: mergeRequestMove("cancelMergeRequest"),
    /** The task's latest merge request. Any signed-in user may read it. */
    getMergeRequest: mergeRequestMove("getMergeRequest"),

    /** The task's merge request's latest dequeue, with the details its run holds. Any signed-in user may read it. */
    async getDequeue(actor: Actor, input: TaskPath): Promise<MergeRequestDequeue> {
      return invoke("getDequeue", await project(input), actor, { task: taskNumber(input.task) });
    },

    /**
     * Opens a vote on the task among its passing attempts, under the `vote` selection policy, with an
     * optional deadline for ballots. The task's creator or the project owner may.
     */
    async openVote(actor: Actor, input: TaskPath & { deadline?: string | undefined }): Promise<Vote> {
      const open = { task: taskNumber(input.task), deadline: input.deadline };
      return vote(await invoke("openVote", await project(input), actor, open));
    },

    /** Casts the actor's ballot for a candidate, replacing their earlier one. Not for their own attempt. */
    castVote: voteFor("castVote"),
    /** Adds an attempt passing now to the open vote. The task's creator or the project owner may. */
    addVoteCandidate: voteFor("addVoteCandidate"),

    /**
     * Closes the task's open vote, selecting the candidate with the most ballots; `attempt` breaks a
     * tie. The task's creator or the project owner may.
     */
    async closeVote(actor: Actor, input: TaskPath & { attempt?: string | undefined }): Promise<ClosedVote> {
      const task = taskNumber(input.task);
      const tieBreak =
        input.attempt === undefined ? undefined : attemptOfTask({ task: input.task, attempt: input.attempt });
      const closed = await invoke("closeVote", await project(input), actor, { task, attempt: tieBreak?.number });
      const mr = closed.selected;
      return { vote: await vote(closed.vote), mergeRequest: mr === null ? null : await mergeRequest(mr) };
    },

    /** The task's latest vote, open or closed. Any signed-in user may read it. */
    async getVote(actor: Actor, input: TaskPath): Promise<Vote> {
      return vote(await invoke("getVote", await project(input), actor, { task: taskNumber(input.task) }));
    },

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

    /**
     * The project's secrets by name, with their pipelines and last change, never their values; and
     * where `main`'s config names secrets, flagging any with no value or not allowed where it runs.
     */
    async listSecrets(actor: Actor, input: ProjectPath): Promise<{ secrets: SecretSummary[]; uses: SecretUse[] }> {
      const ctx = await project(input);
      const secrets = await invoke("listSecrets", ctx, actor);
      const config = await loadConfig(repos, ctx.id);
      return { secrets, uses: secretUses(config.kind === "valid" ? namedSecrets(config.config) : [], secrets) };
    },

    /** Sets a secret's value, its pipelines, or both. */
    async putSecret(actor: Actor, input: ProjectPath & SecretChange & { name: string }): Promise<SecretSummary> {
      const { name, value, pipelines } = input;
      return invoke("putSecret", await project(input), actor, { name, value, pipelines });
    },

    async deleteSecret(actor: Actor, input: ProjectPath & { name: string }): Promise<void> {
      await invoke("deleteSecret", await project(input), actor, { name: input.name });
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
  if (number === null) throw new ServiceError("invalidRequest", `not a task reference: ${ref}`);
  return number;
}

/** An attempt reference (`t42a3`) that must name an attempt of the task `task` (`t42`). */
function attemptOfTask(input: { task: string; attempt: string }): AttemptInput {
  const task = taskNumber(input.task);
  const ref = attemptRefOf(input.attempt);
  if (ref.task !== task) {
    throw new ServiceError("invalidRequest", `${input.attempt} is not an attempt of ${taskRef(task)}`);
  }
  return ref;
}

/** An attempt reference (`t42a3`) as its task and attempt numbers. */
function attemptRefOf(ref: string): AttemptInput {
  const parsed = parseAttemptRef(ref);
  if (parsed === null) throw new ServiceError("invalidRequest", `not an attempt reference: ${ref}`);
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

function publicTask(t: StoredTask, users: Map<string, string>, taskBranch: TaskBranch | null): Task {
  return {
    ref: taskRef(t.number),
    number: t.number,
    title: t.title,
    body: t.body,
    creator: userRef(t.creator, users),
    state: t.state,
    createdAt: t.created_at,
    closedAt: t.closed_at,
    closedBy: t.closed_by === null ? null : userRef(t.closed_by, users),
    attemptLimit: t.attempt_limit,
    checks: t.definitions.checks,
    metrics: t.definitions.metrics,
    taskBranch,
    selection: t.selection,
  };
}

/** `forkedFrom` for an attempt copied from another, and nothing for one that wasn't. */
/**
 * Whether a call to a Durable Object failed because the object was reset (a deploy, or an eviction)
 * while it ran: the runtime marks such errors `durableObjectReset`, or `retryable`.
 */
function droppedByReset(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const marked = error as Error & { durableObjectReset?: unknown; retryable?: unknown };
  return marked.durableObjectReset === true || marked.retryable === true;
}

function forkedFrom(source: string | null): { forkedFrom?: string } {
  return source === null ? {} : { forkedFrom: source };
}

function publicAttempt(a: StoredAttempt, users: Map<string, string>, remote: string): Attempt {
  const mr = a.merge_request;
  return {
    ref: a.fork,
    task: a.task,
    number: a.number,
    author: userRef(a.author, users),
    alias: a.alias,
    state: a.state,
    fork: a.fork,
    remote,
    branch: a.branch,
    note: a.note,
    createdAt: a.created_at,
    closedAt: a.closed_at,
    mergedSha: a.merged_sha,
    archivedSha: a.archived_sha,
    ...forkedFrom(a.forked_from),
    needsUpdate: a.needs_update,
    scoring: a.scoring,
    mergeRequest: mr === null ? null : { state: mr.state, lastDequeue: mr.last_dequeue },
    verdicts: a.verdicts,
  };
}

function publicVerdict(v: VerdictDetail, users: Map<string, string>): Verdict {
  return {
    reviewer: userRef(v.reviewer, users),
    alias: v.alias,
    head: v.head,
    recommendation: v.recommendation,
    body: v.body,
    at: v.at,
    superseded: v.superseded,
  };
}

function actorRef(acted: { user: string; alias: string | null }, users: Map<string, string>): ActorRef {
  return { ...userRef(acted.user, users), alias: acted.alias };
}

function publicMergeRequest(mr: StoredMergeRequest, users: Map<string, string>): MergeRequest {
  return {
    task: taskRef(mr.task),
    attempt: attemptRef(mr.task, mr.attempt),
    state: mr.state,
    approvedHead: mr.approved_head,
    approvedBy: actorRef(mr.approved_by, users),
    approvedAt: mr.approved_at,
    queuedAt: mr.queued_at,
    position: mr.position,
    lastDequeue:
      mr.last_dequeue === null
        ? null
        : { reason: mr.last_dequeue.reason, run: mr.last_dequeue.run, at: mr.last_dequeue.at },
    mergeSha: mr.merge_sha,
    mergedAt: mr.merged_at,
    createdAt: mr.created_at,
    createdBy: actorRef(mr.created_by, users),
  };
}

function publicVote(v: VoteDetail, users: Map<string, string>): Vote {
  const ref = (attempt: number) => attemptRef(v.task, attempt);
  const ballot = v.ballot;
  return {
    task: taskRef(v.task),
    state: v.state,
    eligible: v.eligible,
    deadline: v.deadline,
    openedBy: actorRef(v.opened_by, users),
    openedAt: v.opened_at,
    closedBy: v.closed_by === null ? null : actorRef(v.closed_by, users),
    closedAt: v.closed_at,
    winner: v.winner === null ? null : ref(v.winner),
    candidates: v.candidates.map((c) => ({
      attempt: ref(c.attempt),
      head: c.head,
      addedAt: c.added_at,
      votes: c.votes,
      withdrawn: c.withdrawn,
      beingScored: c.being_scored,
      erroredRun: c.errored_run,
    })),
    myBallot:
      ballot === null ? null : { attempt: ref(ballot.attempt), head: ballot.head, alias: ballot.alias, at: ballot.at },
  };
}

function publicScoring(request: ScoringRequest, users: Map<string, string>): ScoringAnswer {
  return {
    queued: request.queued,
    reason: request.queued ? null : request.reason,
    run: publicRun(request.run, users),
  };
}

function publicRun(run: StoredRun, users: Map<string, string>): Run {
  return {
    id: run.id,
    line: run.line,
    pipeline: run.pipeline,
    sha: run.sha,
    trigger: run.trigger,
    status: run.status,
    trusted: run.trusted,
    requestedBy: run.user_id === null ? null : userRef(run.user_id, users),
    alias: run.alias,
    createdAt: new Date(run.created_at).toISOString(),
    startedAt: iso(run.started_at),
    finishedAt: iso(run.finished_at),
    superseded: run.superseded,
    gate: run.outcome?.gate ?? null,
    cancellable: cancellable(run),
  };
}

function runDetail(run: StoredRun, users: Map<string, string>): RunDetail {
  const outcome =
    run.outcome === null
      ? null
      : { ...run.outcome, steps: run.outcome.steps.map((step) => ({ ...step, after: step.after ?? [] })) };
  return { ...publicRun(run, users), error: run.error, outcome, result: run.result };
}

/** Runs as the API lists them, with the users who asked for them. */
async function publicRuns(db: Database, runs: StoredRun[]): Promise<Run[]> {
  const users = await handles(
    db,
    runs.map((r) => r.user_id),
  );
  return runs.map((r) => publicRun(r, users));
}

/** An attempt's scoring status for polling, with its current result once its head has one. */
function scoringStatus({ current, ...status }: AttemptScoringDetail): ScoringStatus {
  return current === null ? status : { ...status, result: currentResult(current) };
}

function currentResult(run: StoredRun): CurrentResult {
  if (run.result === null || run.finished_at === null) throw new Error(`run ${run.id} is done without a result`);
  return { ...run.result, run: run.id, finishedAt: new Date(run.finished_at).toISOString() };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
