import type { FailureStage } from "./scripts";
import { DurableObject } from "cloudflare:workers";
import type { PushRoute } from "./events";
import { CHECK_ROLES, sandboxName } from "./grants";
import { reposFor } from "./artifacts";
import { forkRepo } from "./repos";
import { runTaskMethod, TaskStore, type Sql, type TaskOutcome } from "./task-store";

/** Most Sandboxes one project may run at once. */
export const SANDBOX_CAP = 3;

export interface CheckParams {
  project: string;
  attempt: string;
  sha: string;
}

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

interface CheckRow extends Record<string, SqlStorageValue> {
  instance_id: string;
  attempt: string;
  sha: string;
  status: string;
}

/**
 * One per project: the inbox for its push events. Dedupes deliveries on (repo, sha), keeps at most
 * one live check per attempt (a newer push cancels the older check), and caps concurrent Sandboxes.
 * It also keeps a journal of every hop so the e2e suite can read timings back.
 *
 * It is also the source of truth for the project's tasks and attempts (`task-store.ts`): their
 * rows, their per-project counters, and journal events for every transition.
 */
export class ProjectCoordinator extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #tasks: TaskStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (repo TEXT, sha TEXT, at INTEGER, PRIMARY KEY (repo, sha));
      CREATE TABLE IF NOT EXISTS checks (
        instance_id TEXT PRIMARY KEY, attempt TEXT, sha TEXT, status TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pending (attempt TEXT PRIMARY KEY, sha TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, detail TEXT
      );
    `);
    const sql: Sql = {
      exec: <T>(query: string, ...bindings: unknown[]) =>
        ctx.storage.sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as T[],
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    this.#tasks = new TaskStore({ sql, repos: reposFor(env) });
  }

  /** Runs one task or attempt operation (a `TaskStore` method) for the services in `tasks.ts`. */
  async tasks(method: string, args: unknown[]): Promise<TaskOutcome> {
    return runTaskMethod(this.#tasks, method, args);
  }

  async receive(route: PushRoute, ingest: { startedAt: number; instanceId: string }): Promise<void> {
    if (route.kind === "ignored" || route.push === null) return;
    const { push } = route;
    const timing = { emittedAt: push.emittedAt, ingestStartedAt: ingest.startedAt };

    const seen = this.#sql.exec("SELECT 1 FROM deliveries WHERE repo = ? AND sha = ?", push.repo, push.after);
    if (seen.toArray().length > 0) {
      this.#log("duplicate", { repo: push.repo, sha: push.after, ingest: ingest.instanceId });
      return;
    }
    this.#sql.exec("INSERT INTO deliveries VALUES (?, ?, ?)", push.repo, push.after, Date.now());

    if (route.kind === "main-advanced") {
      this.#log("main-advanced", { sha: push.after, before: push.before, ...timing });
      return;
    }

    this.#log("attempt-pushed", { attempt: route.attempt, sha: push.after, ...timing });
    await this.#cancelLive(route.attempt, push.after);
    this.#sql.exec("INSERT OR REPLACE INTO pending VALUES (?, ?, ?)", route.attempt, push.after, Date.now());
    await this.#drain(route.project);
  }

  /** Called by the check Workflow when it finishes. Reports from a cancelled check are discarded. */
  async checkFinished(
    params: CheckParams & { instanceId: string },
    outcome: CheckOutcome,
    timings: Record<string, number>,
  ): Promise<void> {
    const { instanceId, project } = params;
    const row = this.#check(instanceId);
    if (row === undefined) return;
    if (row.status !== "running") {
      this.#log("stale-result", { instanceId, attempt: row.attempt, sha: row.sha, outcome: outcome.kind });
      return;
    }
    this.#sql.exec("UPDATE checks SET status = ? WHERE instance_id = ?", outcome.kind, instanceId);
    this.#log("check-finished", { instanceId, attempt: row.attempt, sha: row.sha, outcome, timings });
    await this.#drain(project);
  }

  journal(since = 0): JournalEntry[] {
    return this.#sql
      .exec<{ id: number; at: number; kind: string; detail: string }>(
        "SELECT * FROM journal WHERE id > ? ORDER BY id",
        since,
      )
      .toArray()
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  }

  /** Records a hop the caller observed (repo created, fork ready) so one journal holds the whole run. */
  note(kind: string, detail: Record<string, unknown>): void {
    this.#log(kind, detail);
  }

  async #cancelLive(attempt: string, newSha: string): Promise<void> {
    const live = this.#sql
      .exec<CheckRow>("SELECT * FROM checks WHERE attempt = ? AND status = 'running'", attempt)
      .toArray();
    for (const check of live) {
      this.#sql.exec("UPDATE checks SET status = 'cancelled' WHERE instance_id = ?", check.instance_id);
      try {
        const instance = await this.env.CHECK.get(check.instance_id);
        await instance.terminate();
        await Promise.all(
          CHECK_ROLES.map((role) => this.env.SANDBOX.getByName(sandboxName(check.instance_id, role)).destroy()),
        );
        this.#log("check-cancelled", { instanceId: check.instance_id, sha: check.sha, supersededBy: newSha });
      } catch (cause) {
        // The check may already have finished; its result is discarded either way.
        this.#log("check-cancel-failed", { instanceId: check.instance_id, error: String(cause) });
      }
    }
  }

  async #drain(project: string): Promise<void> {
    const running = this.#sql.exec("SELECT 1 FROM checks WHERE status = 'running'").toArray().length;
    const free = SANDBOX_CAP - running;
    if (free <= 0) return;
    const next = this.#sql
      .exec<{ attempt: string; sha: string }>("SELECT attempt, sha FROM pending ORDER BY at LIMIT ?", free)
      .toArray();
    for (const { attempt, sha } of next) {
      this.#sql.exec("DELETE FROM pending WHERE attempt = ?", attempt);
      const instanceId = `${forkRepo(project, attempt)}-${sha.slice(0, 12)}`;
      const params: CheckParams = { project, attempt, sha };
      try {
        await this.env.CHECK.create({ id: instanceId, params });
      } catch (cause) {
        // A redelivered event can race a dedupe miss; an existing instance id means it already runs.
        this.#log("check-create-failed", { instanceId, error: String(cause) });
        continue;
      }
      this.#sql.exec(
        "INSERT OR REPLACE INTO checks VALUES (?, ?, ?, 'running', ?)",
        instanceId,
        attempt,
        sha,
        Date.now(),
      );
      this.#log("check-started", { instanceId, attempt, sha });
    }
    const waiting = this.#sql.exec("SELECT 1 FROM pending").toArray().length;
    if (waiting > 0) this.#log("backpressure", { waiting, cap: SANDBOX_CAP });
  }

  #check(instanceId: string): CheckRow | undefined {
    return this.#sql.exec<CheckRow>("SELECT * FROM checks WHERE instance_id = ?", instanceId).toArray()[0];
  }

  #log(kind: string, detail: Record<string, unknown>): void {
    console.log({ event: `project.${kind}`, ...detail });
    this.#sql.exec("INSERT INTO journal (at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }
}
