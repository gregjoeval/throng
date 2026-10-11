import type { FailureStage } from "./scripts";
import { DurableObject } from "cloudflare:workers";
import { CHECK_ROLES, sandboxName } from "./grants";
import { reposFor } from "./artifacts";
import type { ScoringParams, ScoringRequest } from "./scoring";
import { parseAttemptRef, runTaskMethod, TaskStore, type Sql, type TaskOutcome } from "./task-store";

/** What the check Workflow is started with: a scoring run's params. */
export type CheckParams = ScoringParams;

export type CheckOutcome =
  | { kind: "landed"; mainSha: string }
  | { kind: "failed"; stage: FailureStage | "rebase-test"; output: string }
  | { kind: "bounced"; files: string[]; diff: string }
  | { kind: "error"; message: string };

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
        workflow: env.CHECK,
        teardown: async (instanceId) => {
          await Promise.all(CHECK_ROLES.map((role) => env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()));
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

  /** Called by the check Workflow when it finishes. Reports from a cancelled run are discarded. */
  async checkFinished(
    params: CheckParams & { instanceId: string },
    outcome: CheckOutcome,
    timings: Record<string, number>,
  ): Promise<void> {
    const status = outcome.kind === "error" ? "errored" : "done";
    this.#tasks.scoring.finish(params.run, status, { instanceId: params.instanceId, outcome, timings });
    // Landing pushes to the origin's `main`; that internal push notifies the project here.
    if (outcome.kind === "landed") this.#log("main_advanced", { sha: outcome.mainSha, attempt: params.attempt });
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
