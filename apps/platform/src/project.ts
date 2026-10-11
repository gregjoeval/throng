import { DurableObject } from "cloudflare:workers";
import { sandboxName, SCORING_ROLES } from "./grants";
import { reposFor } from "./artifacts";
import type { ScoringOutcome, ScoringRequest, StoredRun } from "./scoring";
import { parseAttemptRef, runTaskMethod, TaskStore, type Sql, type TaskOutcome } from "./task-store";

export interface JournalEntry {
  id: number;
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * One per project: the source of truth for its tasks and attempts (`task-store.ts`), with their
 * rows, per-project counters and journal events for every transition, and for its scoring runs
 * (`scoring.ts`). After every store call it drains the scoring queue, starting and stopping runs.
 * The journal also records the hops the e2e suite reads timings back from.
 */
export class ProjectCoordinator extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #tasks: TaskStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    const sql: Sql = {
      exec: <T>(query: string, ...bindings: unknown[]) =>
        ctx.storage.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as T[],
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    this.#tasks = new TaskStore({
      sql,
      repos: reposFor(env),
      scoring: {
        workflow: env.SCORING,
        teardown: async (instanceId) => {
          await Promise.all(
            SCORING_ROLES.map((role) => env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()),
          );
        },
      },
    });
  }

  /** Runs one task or attempt operation (a `TaskStore` method) for the services in `tasks.ts`. */
  async tasks(method: string, args: unknown[]): Promise<TaskOutcome> {
    const outcome = await runTaskMethod(this.#tasks, method, args);
    await this.#drain();
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
    await this.#drain();
    return request;
  }

  /** Spike-only: one scoring run, with its result, for the e2e suite. */
  spikeRun(id: number): StoredRun | null {
    return this.#tasks.scoring.getRun(id);
  }

  /** Called by a run's Scoring Workflow when it ends. Reports from a superseded or cancelled run are discarded. */
  async scoringFinished(run: number, outcome: ScoringOutcome): Promise<void> {
    this.#tasks.scoring.finish(run, outcome);
    await this.#drain();
  }

  journal(since = 0): JournalEntry[] {
    return this.#sql
      .exec<{ id: number; at: number; kind: string; detail: string }>(
        "SELECT id, at, kind, detail FROM journal WHERE id > ? ORDER BY id",
        since,
      )
      .toArray()
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  }

  /** Records a hop the caller observed (repo created, fork ready) so one journal holds the whole run. */
  note(kind: string, detail: Record<string, unknown>): void {
    this.#log(kind, detail);
  }

  /** Starts and stops scoring runs; a failure here never fails the call that triggered it. */
  async #drain(): Promise<void> {
    try {
      await this.#tasks.scoring.drain();
    } catch (cause) {
      console.error({ event: "scoring.drain_failed", error: String(cause) });
    }
  }

  #log(kind: string, detail: Record<string, unknown>): void {
    console.log({ event: `project.${kind}`, ...detail });
    this.#sql.exec("INSERT INTO journal (at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }
}
