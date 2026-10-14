import { DurableObject } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import type { CacheEntry, CacheKey, CacheLookup } from "./caches";
import { camelKeys } from "./casing";
import type { NamedSecrets } from "./config";
import type { FollowOutcome } from "./follows";
import type { LegacyLandingOutcome } from "./landing";
import { teardownPipeline } from "./pipeline-workflow";
import type { PlanVerdict, RunReport, ScoringOutcome, ScoringRequest, StoredRun } from "./scoring";
import { keyringFrom } from "./secrets";
import type { SealedSecret, SecretRefusal } from "./secrets";
import type { TaskDefinitions } from "./task-definitions";
import { attemptRef, parseAttemptRef } from "./task-refs";
import { runTaskMethod, TaskStore } from "./task-store";
import type { ProjectContext, Sql, TaskOutcome } from "./task-store";
import type { BatchDatabase } from "./users";

/**
 * D1 as the projection's `BatchDatabase`. Every statement it batches came from this `prepare`, so it
 * is D1's own.
 */
function batchDatabase(db: D1Database): BatchDatabase {
  return { prepare: (sql) => db.prepare(sql), batch: (statements) => db.batch(statements as D1PreparedStatement[]) };
}

/** Where the project's id is kept, for alarms, which carry no call that names it. */
const PROJECT_KEY = "project";
/** How long the alarm waits to delete cache entries again after deleting them failed. */
const EVICTION_RETRY_MS = 60 * 60_000;

export interface JournalEntry {
  id: number;
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * One per project: the source of truth for its tasks and attempts (`task-store.ts`), with their
 * rows, per-project counters and journal events for every transition, and for its pipeline runs
 * (`scoring.ts`), merge requests and the landings of its merge queue, which are `main` runs. After
 * every store call and report it drains: queueing and cancelling landings, starting Follow
 * Workflows, then starting and stopping pipeline runs.
 * Then, when its tasks or attempts changed, an alarm publishes them to the D1 projection, trying
 * again until it lands. The journal also records the hops the e2e suite reads timings back from.
 */
export class ProjectCoordinator extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #tasks: TaskStore;
  #project: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#project = ctx.storage.kv.get<string>(PROJECT_KEY) ?? null;
    const sql: Sql = {
      exec: <T>(query: string, ...bindings: unknown[]) =>
        ctx.storage.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as T[],
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    this.#tasks = new TaskStore({
      sql,
      repos: reposFor(env),
      scoring: {
        workflow: env.PIPELINE,
        teardown: (instanceId, containers) => teardownPipeline(env.SANDBOX, instanceId, containers),
      },
      follow: { workflow: env.FOLLOW },
      keyring: keyringFrom(env.SECRETS_KEYRING),
      cacheObjects: env.CACHES,
    });
  }

  /** Runs one task or attempt operation (a `TaskStore` method) for the services in `tasks.ts`. */
  async tasks(method: string, args: unknown[]): Promise<TaskOutcome> {
    const outcome = await runTaskMethod(this.#tasks, method, args);
    await this.#drain((args[0] as ProjectContext | undefined)?.id);
    return outcome;
  }

  /**
   * For the e2e routes only: queues scoring of a commit pushed straight to an attempt's fork, outside
   * the git proxy. The forks those routes make have no task rows, so no trigger rules apply. The
   * suite pushes as the e2e user, who owns every e2e project, so the push is the owner's.
   */
  async e2eScore(project: string, attempt: string, sha: string): Promise<ScoringRequest> {
    const ref = parseAttemptRef(attempt);
    if (ref === null) throw new Error(`not an attempt: ${attempt}`);
    const request = this.#tasks.scoring.request({
      project,
      line: attemptRef(ref.task, ref.number),
      sha,
      trigger: "push",
      actor: null,
      ownersPush: true,
    });
    await this.#drain(project);
    return request;
  }

  /** For the e2e routes only: one scoring run, with its result. */
  e2eRun(id: number): StoredRun | null {
    return this.#tasks.scoring.getRun(id);
  }

  /** Called by a run's Pipeline Workflow when it starts: what the task defines over the project's config. */
  definitionsOf(task: number): TaskDefinitions {
    return this.#tasks.definitionsOf(task);
  }

  /**
   * Called by a run's Pipeline Workflow before it starts any container: the containers its plan may
   * start, so cancelling it destroys them all, and the secrets its setups and checks name. Says
   * whether it may start (see `TaskStore.pipelinePlanned`); a run that now waits for the owner frees
   * its slot for the next. A Workflow from before runs named secrets gives none.
   */
  async pipelinePlanned(run: number, containers: string[], named: NamedSecrets[] = []): Promise<PlanVerdict> {
    const verdict = this.#tasks.pipelinePlanned(run, containers, named);
    if (verdict.kind === "waiting") await this.#drain(this.#tasks.scoring.getRun(run)?.project);
    return verdict;
  }

  /**
   * Called by a trusted run's Pipeline Workflow in the step that starts a container: the sealed values
   * of the secrets it names, or why one can't be had (see `TaskStore.sealedSecretsFor`). The step opens
   * them; they're never persisted.
   */
  pipelineSecrets(run: number, names: string[]): { sealed: SealedSecret[] } | SecretRefusal {
    return this.#tasks.sealedSecretsFor(run, names);
  }

  /**
   * Called by a run's Pipeline Workflow before its containers start, with each cache's key hash:
   * where each restores from and saves to (see `TaskStore.pipelineCaches`).
   */
  pipelineCaches(run: number, keys: CacheKey[]): CacheLookup[] {
    return this.#tasks.pipelineCaches(run, keys);
  }

  /** Called by a run's Pipeline Workflow right before it saves a cache entry: whether it may (see `TaskStore.pipelineCacheSaving`). */
  pipelineCacheSaving(run: number, entry: Pick<CacheEntry, "scope" | "name" | "keyHash">): boolean {
    return this.#tasks.pipelineCacheSaving(run, entry);
  }

  /** Called by a run's Pipeline Workflow once it saved a cache entry: records it in the index. */
  async pipelineCacheSaved(
    run: number,
    entry: Pick<CacheEntry, "scope" | "name" | "keyHash" | "size">,
  ): Promise<boolean> {
    const recorded = this.#tasks.pipelineCacheSaved(run, entry);
    // A new entry may take the project over its cap, and falls unused in time.
    await this.#drain(this.#tasks.scoring.getRun(run)?.project);
    return recorded;
  }

  /** Called by a run's Pipeline Workflow when a save it was let make failed: lets the key go (see `TaskStore.pipelineCacheUnsaved`). */
  pipelineCacheUnsaved(run: number, entry: Pick<CacheEntry, "scope" | "name" | "keyHash">): void {
    this.#tasks.pipelineCacheUnsaved(run, entry);
  }

  /** Called by a run's Pipeline Workflow when it ends. Reports from a superseded or cancelled run are discarded. */
  async pipelineFinished(run: number, report: RunReport): Promise<void> {
    try {
      await this.#tasks.pipelineReported(run, report);
    } finally {
      await this.#drain(this.#tasks.scoring.getRun(run)?.project);
    }
  }

  /**
   * Called by a run's Workflow that started under the Scoring Workflow's code and reports in its
   * shape. Kept while such a run may still report.
   */
  async scoringFinished(run: number, outcome: ScoringOutcome): Promise<void> {
    this.#tasks.scoringFinished(run, outcome);
    await this.#drain(this.#tasks.scoring.getRun(run)?.project);
  }

  /**
   * Called by a landing's Pipeline Workflow in its `land` step, right before it pushes to `main`.
   * False when its merge request has left the queue: it must not push.
   */
  claimLand(run: number): boolean {
    return this.#tasks.claimLandingPush(run);
  }

  /**
   * Called by a landing's Pipeline Workflow once its `land` step pushed `sha`: the run's head is
   * now `sha`, and its merge request is merged. The push is the run's own: it asks for no other run.
   */
  async pipelineLanded(run: number, sha: string): Promise<void> {
    try {
      await this.#tasks.pipelineLanded(run, sha);
    } finally {
      await this.#drain(this.#tasks.scoring.getRun(run)?.project);
    }
  }

  /** Called by a landing's Pipeline Workflow whose `land` step lost its result: `main`'s head when it is the landing's merge commit. */
  async landedOnMain(run: number): Promise<string | null> {
    return this.#tasks.landedOnMain(run);
  }

  /**
   * Called by a Landing Workflow's land step under its old code, right before it pushes to `main`.
   * Kept while one may still be under way. False when its merge request has left the queue.
   */
  claimLandingPush(landing: number): boolean {
    return this.#tasks.claimLegacyLandingPush(landing);
  }

  /**
   * Called by a Landing Workflow ending under its old code: records its outcome on its landing's
   * run. Kept while one may still be under way.
   */
  async landingFinished(landing: number, outcome: LegacyLandingOutcome): Promise<void> {
    try {
      await this.#tasks.legacyLandingFinished(landing, outcome);
    } finally {
      await this.#drain(this.#tasks.scoring.legacyLanding(landing)?.project);
    }
  }

  /**
   * Called by a Landing Workflow that resumed on the Pipeline Workflow's code, its containers gone:
   * its landing lands again as a run (see `TaskStore.legacyLandingResumed`).
   */
  async legacyLandingResumed(landing: number): Promise<void> {
    try {
      await this.#tasks.legacyLandingResumed(landing);
    } finally {
      await this.#drain(this.#tasks.scoring.legacyLanding(landing)?.project);
    }
  }

  /**
   * Called by a Follow Workflow right before it merges a task branch into an attempt's fork. False
   * when it must not push: the attempt ended, or a landing of its merge request is pushing to main.
   */
  claimFollowPush(follow: number): boolean {
    return this.#tasks.claimFollowPush(follow);
  }

  /** Called by a Follow Workflow when it ends: records the attempt's new head, or marks it needs update. */
  async followFinished(follow: number, outcome: FollowOutcome): Promise<void> {
    try {
      await this.#tasks.followFinished(follow, outcome);
    } finally {
      await this.#drain(this.#tasks.follows.get(follow)?.project);
    }
  }

  journal(since = 0): JournalEntry[] {
    return (
      this.#sql
        .exec<{ id: number; at: number; kind: string; detail: string }>(
          "SELECT id, at, kind, detail FROM journal WHERE id > ? ORDER BY id",
          since,
        )
        .toArray()
        // Entries written before ADR 0002 keep their snake_case detail keys; read them in camelCase.
        .map((r) => ({ ...r, detail: camelKeys(JSON.parse(r.detail) as Record<string, unknown>) }))
    );
  }

  /**
   * Publishes changed tasks and attempts to the D1 projection, setting itself again while some remain
   * or after a failure, and evicts the cache entries due, setting itself again for the next to fall
   * unused. A project's tasks and caches only change through calls that name it, so its id is known
   * whenever anything is pending.
   */
  override async alarm(): Promise<void> {
    if (this.#project === null) return;
    const project = this.#project;
    const [next] = await Promise.all([
      this.#tasks.projection.publish(batchDatabase(this.env.DB), project),
      this.#tasks.evictCaches(project).catch((error: unknown) => {
        console.error({ event: "cache.eviction_failed", project, error: String(error) });
      }),
    ]);
    // Entries still due failed to delete: they're tried again later rather than at once.
    const caches =
      this.#tasks.caches.evictable().length > 0 ? Date.now() + EVICTION_RETRY_MS : this.#tasks.caches.nextUnused();
    const due = [next === null ? null : Date.now() + next, caches].filter((at): at is number => at !== null);
    if (due.length > 0) await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...due)));
  }

  /** E2e cleanup only: deletes all of this project's storage, so nothing of an e2e run is left. */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Records a hop the caller observed (repo created, fork ready) so one journal holds the whole run. */
  note(kind: string, detail: Record<string, unknown>): void {
    this.#log(kind, detail);
  }

  /**
   * Queues and cancels landings, and starts and stops runs; a failure here never fails the call that
   * triggered it. Landings need the project's id, which every call names (a project's DO is named by it), and
   * is stored once for calls that can't tell, and for alarms. Then sets the alarm that publishes any
   * pending change to the projection, unless one is already set.
   */
  async #drain(project: string | undefined): Promise<void> {
    if (project !== undefined && project !== this.#project) {
      this.#project = project;
      this.ctx.storage.kv.put(PROJECT_KEY, project);
    }
    try {
      if (this.#project === null) await this.#tasks.scoring.drain();
      else await this.#tasks.drain(this.#project);
    } catch (error) {
      console.error({ event: "project.drain_failed", error: String(error) });
    }
    // An alarm already set publishes these changes too. One more than a moment away is a retry backing
    // off after D1 failed, up to `MAX_PROJECTION_RETRY_MS`: these changes wait for it, as they would
    // fail too until D1 is back.
    const alarm = await this.ctx.storage.getAlarm();
    if (this.#tasks.projection.hasChanges() && alarm === null) {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    // The alarm also evicts each cache entry once it falls unused.
    const unused = this.#tasks.caches.nextUnused();
    if (unused !== null && (alarm === null || alarm > unused)) await this.ctx.storage.setAlarm(unused);
  }

  #log(kind: string, detail: Record<string, unknown>): void {
    console.log({ event: `project.${kind}`, ...detail });
    this.#sql.exec("INSERT INTO journal (at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }
}
