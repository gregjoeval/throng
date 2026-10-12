import { DurableObject } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { camelKeys } from "./casing";
import type { FollowOutcome } from "./follows";
import { LANDING_ROLES, sandboxName, SCORING_ROLES } from "./grants";
import type { SandboxRole } from "./grants";
import type { LandingOutcome } from "./landing";
import type { ScoringOutcome, ScoringRequest, StoredRun } from "./scoring";
import { parseAttemptRef } from "./task-refs";
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

export interface JournalEntry {
  id: number;
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * One per project: the source of truth for its tasks and attempts (`task-store.ts`), with their
 * rows, per-project counters and journal events for every transition, and for its scoring runs
 * (`scoring.ts`), merge requests and the landings of its merge queue. After every store call and
 * report it drains: stopping and starting Landing Workflows, starting Follow Workflows, then scoring runs.
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
    const teardown = (roles: readonly SandboxRole[]) => async (instanceId: string) => {
      await Promise.all(roles.map((role) => env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()));
    };
    this.#tasks = new TaskStore({
      sql,
      repos: reposFor(env),
      scoring: { workflow: env.SCORING, teardown: teardown(SCORING_ROLES) },
      landing: { workflow: env.LANDING, teardown: teardown(LANDING_ROLES) },
      follow: { workflow: env.FOLLOW },
    });
  }

  /** Runs one task or attempt operation (a `TaskStore` method) for the services in `tasks.ts`. */
  async tasks(method: string, args: unknown[]): Promise<TaskOutcome> {
    const outcome = await runTaskMethod(this.#tasks, method, args);
    await this.#drain((args[0] as ProjectContext | undefined)?.id);
    return outcome;
  }

  /**
   * Spike-only: queues scoring of a commit pushed straight to an attempt's fork, outside the git
   * proxy, for the e2e suite. The spike's attempts have no task rows, so no trigger rules apply.
   */
  async spikeScore(project: string, attempt: string, sha: string): Promise<ScoringRequest> {
    const ref = parseAttemptRef(attempt);
    if (ref === null) throw new Error(`not an attempt: ${attempt}`);
    const request = this.#tasks.scoring.request({
      project,
      task: ref.task,
      attempt: ref.number,
      sha,
      trigger: "push",
      actor: null,
    });
    await this.#drain(project);
    return request;
  }

  /** Spike-only: one scoring run, with its result, for the e2e suite. */
  spikeRun(id: number): StoredRun | null {
    return this.#tasks.scoring.getRun(id);
  }

  /** Called by a run's Scoring Workflow when it ends. Reports from a superseded or cancelled run are discarded. */
  async scoringFinished(run: number, outcome: ScoringOutcome): Promise<void> {
    this.#tasks.scoringFinished(run, outcome);
    await this.#drain(this.#tasks.scoring.getRun(run)?.project);
  }

  /**
   * Called by a Landing Workflow's land step right before it pushes to `main`. False when its merge
   * request has left the queue: it must not push.
   */
  claimLandingPush(landing: number): boolean {
    return this.#tasks.claimLandingPush(landing);
  }

  /**
   * Called by a Landing Workflow when it ends. The landing push is internal: this records it
   * (`mainAdvanced`) and never scores or creates anything from it. Then the next landing starts.
   * Reports from a stopped landing are discarded.
   */
  async landingFinished(landing: number, outcome: LandingOutcome): Promise<void> {
    try {
      await this.#tasks.landingFinished(landing, outcome);
    } finally {
      await this.#drain(this.#tasks.landings.get(landing)?.project);
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
   * or after a failure. A project's tasks only change through calls that name it, so its id is known
   * whenever anything is pending.
   */
  override async alarm(): Promise<void> {
    if (this.#project === null) return;
    const next = await this.#tasks.projection.publish(batchDatabase(this.env.DB), this.#project);
    if (next !== null) await this.ctx.storage.setAlarm(Date.now() + next);
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
   * Starts and stops landings and scoring runs; a failure here never fails the call that triggered
   * it. Landings need the project's id, which every call names (a project's DO is named by it), and
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
    if (this.#tasks.projection.hasChanges() && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  #log(kind: string, detail: Record<string, unknown>): void {
    console.log({ event: `project.${kind}`, ...detail });
    this.#sql.exec("INSERT INTO journal (at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }
}
