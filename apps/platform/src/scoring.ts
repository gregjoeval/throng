// Scoring requests and the queue that turns them into Scoring Workflow runs. See the spec's "When
// scoring runs" section. The task store decides when an attempt's head should be scored and calls
// `request`; the queue keeps one record per run in the project Durable Object's SQLite:
//
// - a head that is already queued or running isn't queued again, and one with a `done` run isn't
//   either, unless the request is a rescore;
// - a newer head for an attempt cancels its queued or running run, so newest head wins;
// - at most `SCORING_CAP` runs are running per project; the rest wait, oldest first.
//
// It also tracks each attempt's head, moved by every push and scoring request, so a result for an
// older head is superseded and the attempt's `scoring` status is about its current head.
//
// `request` only writes rows, so it can sit inside the store's transactions. Starting and stopping
// Workflows is I/O, done by `drain`, which the Durable Object runs after every store call.

import { forkRepo } from "./repos.ts";
import type { ScoringResult } from "./results.ts";
import { attemptRef, type Sql } from "./task-store.ts";
import type { Actor } from "./tokens.ts";

/** Most scoring runs one project may have running (each holds a Sandbox) at once. */
export const SCORING_CAP = 3;

export const SCORING_TRIGGERS = ["open", "push", "score_now", "rescore"] as const;
export const RUN_STATUSES = ["queued", "running", "done", "cancelled", "errored"] as const;
export type ScoringTrigger = (typeof SCORING_TRIGGERS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What a Scoring Workflow is started with. */
export interface ScoringParams {
  project: string;
  /** The attempt, `t42a3`. */
  attempt: string;
  sha: string;
  /** The run's id, which its report back names. */
  run: number;
}

/** What a run's Workflow reports when it ends: its result, or the error that ended it. */
export type ScoringOutcome = { status: "done"; result: ScoringResult } | { status: "errored"; error: string };

/** An attempt's scoring status: its current head's latest run that wasn't cancelled, or `none`. */
export const ATTEMPT_SCORING_STATUSES = ["none", "queued", "running", "done", "errored"] as const satisfies readonly (
  | RunStatus
  | "none"
)[];

/**
 * An attempt's scoring, for polling: the status of its current head's latest run (`none` when the
 * head has no run, or its run was cancelled), and the head it applies to (null before any push).
 */
export interface AttemptScoring {
  status: (typeof ATTEMPT_SCORING_STATUSES)[number];
  sha: string | null;
}

/** The part of a Workflow binding the queue uses; tests pass a fake. */
export interface ScoringWorkflow {
  create(options: { id: string; params: ScoringParams }): Promise<unknown>;
  get(id: string): Promise<{ terminate(): Promise<void> }>;
}

export interface ScoringRunner {
  workflow: ScoringWorkflow;
  /** Destroys a run's Sandboxes once its Workflow is stopped. */
  teardown(instanceId: string): Promise<void>;
}

/** An attempt's head, as scoring names it. */
export interface ScoredHead {
  /** The project id. */
  project: string;
  task: number;
  /** The attempt's number within its task. */
  attempt: number;
  sha: string;
}

/** The attempt a head belongs to, as scoring keys its runs. */
export type ScoredAttempt = Pick<ScoredHead, "task" | "attempt">;

/** The attempt a head belongs to, `t42a3`. */
export function headAttemptRef(head: ScoredAttempt): string {
  return attemptRef(head.task, head.attempt);
}

export interface StoredRun extends ScoredHead {
  id: number;
  trigger: ScoringTrigger;
  /** The requesting user's id, or null for a request no user made. */
  user_id: string | null;
  agent: string | null;
  status: RunStatus;
  /** The Workflow instance id. */
  instance_id: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** The run's result, once it is `done`. */
  result: ScoringResult | null;
  /** The error that ended it, once it is `errored`. */
  error: string | null;
  /** Whether its head is no longer the attempt's current head. */
  superseded: boolean;
}

interface RunRow extends Omit<StoredRun, "trigger" | "status" | "result" | "superseded"> {
  trigger: string;
  status: string;
  result: string | null;
  superseded: number;
  torn_down: number;
}

export interface ScoringRequestInput extends ScoredHead {
  trigger: ScoringTrigger;
  actor: Actor | null;
  /**
   * The newest run id for the attempt when the caller began reading `sha` from its fork. A run
   * queued since then came from a push recorded meanwhile, whose head is at least as new as
   * `sha`, so the request yields to it rather than replace it.
   */
  readSince?: number | undefined;
}

/** What a request did: queued a run, or why it didn't, with the run that already covers the head. */
export type ScoringRequest = { queued: true; run: StoredRun } | { queued: false; reason: string; run: StoredRun };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scoring_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  task INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  sha TEXT NOT NULL,
  trigger TEXT NOT NULL,
  user_id TEXT,
  agent TEXT,
  status TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  torn_down INTEGER NOT NULL DEFAULT 0
)`,
  // Each attempt's current head: what its pushes and scoring requests last moved it to.
  `CREATE TABLE IF NOT EXISTS scoring_heads (
  task INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (task, attempt)
)`,
];
/** Columns added to `scoring_runs` after its first version. */
const RUN_COLUMNS = ["result TEXT", "error TEXT", "superseded INTEGER NOT NULL DEFAULT 0"];

export interface ScoringQueueDeps {
  sql: Sql;
  /** Starts and stops runs; without one, runs stay queued. */
  runner?: ScoringRunner | null | undefined;
  now?: () => Date;
}

/** One project's scoring runs, and the queue that starts them. */
export class ScoringQueue {
  readonly #sql: Sql;
  readonly #runner: ScoringRunner | null;
  readonly #now: () => Date;

  constructor({ sql, runner = null, now = () => new Date() }: ScoringQueueDeps) {
    this.#sql = sql;
    this.#runner = runner;
    this.#now = now;
    for (const statement of SCHEMA) sql.exec(statement);
    const columns = new Set(sql.exec<{ name: string }>("PRAGMA table_info(scoring_runs)").map((c) => c.name));
    for (const column of RUN_COLUMNS) {
      if (!columns.has(column.split(" ")[0] ?? "")) sql.exec(`ALTER TABLE scoring_runs ADD COLUMN ${column}`);
    }
  }

  /**
   * Records that the attempt's head is now `sha`, marking runs for every other head superseded.
   * Pushes call it whether or not they ask for scoring, so a draft's result is superseded too.
   */
  moveHead({ task, attempt, sha }: ScoredAttempt & Pick<ScoredHead, "sha">): void {
    this.#sql.transaction(() => {
      this.#sql.exec(
        `INSERT INTO scoring_heads (task, attempt, sha) VALUES (?, ?, ?)
         ON CONFLICT (task, attempt) DO UPDATE SET sha = excluded.sha`,
        task,
        attempt,
        sha,
      );
      this.#sql.exec(
        "UPDATE scoring_runs SET superseded = (sha != ?) WHERE task = ? AND attempt = ?",
        sha,
        task,
        attempt,
      );
    });
  }

  /** The attempt's scoring status, about its current head. */
  statusFor({ task, attempt }: ScoredAttempt): AttemptScoring {
    const [head] = this.#sql.exec<{ sha: string }>(
      "SELECT sha FROM scoring_heads WHERE task = ? AND attempt = ?",
      task,
      attempt,
    );
    if (head === undefined) return { status: "none", sha: null };
    const [run] = this.#sql.exec<{ status: string }>(
      `SELECT status FROM scoring_runs WHERE task = ? AND attempt = ? AND sha = ? AND status != 'cancelled'
       ORDER BY id DESC LIMIT 1`,
      task,
      attempt,
      head.sha,
    );
    return { status: (run?.status as AttemptScoring["status"] | undefined) ?? "none", sha: head.sha };
  }

  /**
   * The attempt's current result: the latest `done` run for its current head, or null. Results for
   * older heads are superseded and never current.
   */
  currentRun({ task, attempt }: ScoredAttempt): StoredRun | null {
    const [row] = this.#sql.exec<RunRow>(
      `SELECT r.* FROM scoring_runs r JOIN scoring_heads h ON h.task = r.task AND h.attempt = r.attempt AND h.sha = r.sha
       WHERE r.task = ? AND r.attempt = ? AND r.status = 'done' ORDER BY r.id DESC LIMIT 1`,
      task,
      attempt,
    );
    return row === undefined ? null : toRun(row);
  }

  /**
   * Asks for the attempt's head `sha` to be scored. Checks no permission: the task store has
   * already decided the request is allowed.
   */
  request(input: ScoringRequestInput): ScoringRequest {
    return this.#sql.transaction(() => {
      this.moveHead(input);
      const live = this.#sql
        .exec<RunRow>(
          "SELECT * FROM scoring_runs WHERE task = ? AND attempt = ? AND status IN ('queued', 'running') ORDER BY id",
          input.task,
          input.attempt,
        )
        .map(toRun);
      const same = live.find((r) => r.sha === input.sha);
      if (same !== undefined) return { queued: false, reason: `already ${same.status}`, run: same };
      if (input.readSince !== undefined) {
        const [newer] = this.#sql.exec<RunRow>(
          "SELECT * FROM scoring_runs WHERE task = ? AND attempt = ? AND id > ? ORDER BY id DESC",
          input.task,
          input.attempt,
          input.readSince,
        );
        if (newer !== undefined) return { queued: false, reason: "a newer push is queued", run: toRun(newer) };
      }
      // Whatever happens to this head, runs for older heads are superseded now.
      for (const older of live) this.#cancel(older, { superseded_by: input.sha });
      if (input.trigger !== "rescore") {
        const [done] = this.#sql.exec<RunRow>(
          "SELECT * FROM scoring_runs WHERE task = ? AND attempt = ? AND sha = ? AND status = 'done' ORDER BY id DESC",
          input.task,
          input.attempt,
          input.sha,
        );
        if (done !== undefined) return { queued: false, reason: "already scored", run: toRun(done) };
      }

      const [row] = this.#sql.exec<RunRow>(
        `INSERT INTO scoring_runs (project, task, attempt, sha, trigger, user_id, agent, status, instance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', '', ?) RETURNING *`,
        input.project,
        input.task,
        input.attempt,
        input.sha,
        input.trigger,
        input.actor?.user.id ?? null,
        input.actor?.agent ?? null,
        this.#ms(),
      );
      if (row === undefined) throw new Error("scoring run insert returned no row");
      // The id makes the instance id unique, so a rescore of a head gets its own Workflow.
      const instanceId = `${forkRepo(input.project, headAttemptRef(row))}-${input.sha.slice(0, 12)}-${row.id}`;
      this.#sql.exec("UPDATE scoring_runs SET instance_id = ? WHERE id = ?", instanceId, row.id);
      const run = toRun({ ...row, instance_id: instanceId });
      this.#journal("scoring_queued", run, { trigger: input.trigger });
      return { queued: true, run };
    });
  }

  /**
   * Cancels the attempt's queued and running runs, because it ended or went back to draft and is
   * no longer considered; the next `drain` stops any that had started.
   */
  cancelAttempt({ task, attempt }: ScoredAttempt, reason: string): void {
    this.#sql.transaction(() => {
      const live = this.#sql
        .exec<RunRow>(
          "SELECT * FROM scoring_runs WHERE task = ? AND attempt = ? AND status IN ('queued', 'running')",
          task,
          attempt,
        )
        .map(toRun);
      for (const run of live) this.#cancel(run, { reason });
    });
  }

  /** The newest run id for the attempt, or 0; what a request's `readSince` compares against. */
  latestRunId({ task, attempt }: ScoredAttempt): number {
    const [row] = this.#sql.exec<{ id: number | null }>(
      "SELECT MAX(id) AS id FROM scoring_runs WHERE task = ? AND attempt = ?",
      task,
      attempt,
    );
    return row?.id ?? 0;
  }

  /**
   * Stops cancelled runs that had started, then starts queued runs while there are free slots.
   * Rows are claimed before any await, so drains that overlap never start or stop a run twice.
   */
  async drain(): Promise<void> {
    if (this.#runner === null) return;
    const runner = this.#runner;

    const stopping = this.#sql.transaction(() => {
      const rows = this.#sql
        .exec<RunRow>(
          "SELECT * FROM scoring_runs WHERE status = 'cancelled' AND started_at IS NOT NULL AND torn_down = 0",
        )
        .map(toRun);
      for (const run of rows) this.#sql.exec("UPDATE scoring_runs SET torn_down = 1 WHERE id = ?", run.id);
      return rows;
    });
    await Promise.all(stopping.map((run) => this.#stop(runner, run)));

    const starting = this.#sql.transaction(() => {
      const [{ n } = { n: 0 }] = this.#sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM scoring_runs WHERE status = 'running'",
      );
      const free = SCORING_CAP - n;
      if (free <= 0) return [];
      const rows = this.#sql
        .exec<RunRow>("SELECT * FROM scoring_runs WHERE status = 'queued' ORDER BY id LIMIT ?", free)
        .map(toRun);
      for (const run of rows) {
        this.#sql.exec("UPDATE scoring_runs SET status = 'running', started_at = ? WHERE id = ?", this.#ms(), run.id);
        this.#journal("scoring_started", run, { instance_id: run.instance_id });
      }
      return rows;
    });
    await Promise.all(starting.map((run) => this.#start(runner, run)));

    const [{ n: waiting } = { n: 0 }] = this.#sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM scoring_runs WHERE status = 'queued'",
    );
    if (waiting > 0) console.log({ event: "scoring.backpressure", waiting, cap: SCORING_CAP });
  }

  /**
   * Records how a running run ended, from its Workflow's report: a `done` run keeps its result and
   * journals `scored` with the gate and a summary, an `errored` one its error. A report for a run
   * that is no longer running (superseded by a newer head, or cancelled) is discarded. Returns
   * whether it was recorded.
   */
  finish(id: number, outcome: ScoringOutcome): boolean {
    return this.#sql.transaction(() => {
      const run = this.getRun(id);
      if (run === null) return false;
      if (run.status !== "running") {
        console.log({ event: "scoring.discarded_result", run: id, status: run.status });
        return false;
      }
      const at = this.#ms();
      if (outcome.status === "done") {
        this.#sql.exec(
          "UPDATE scoring_runs SET status = 'done', result = ?, finished_at = ? WHERE id = ?",
          JSON.stringify(outcome.result),
          at,
          id,
        );
        this.#journal("scored", run, { gate: outcome.result.gate, summary: summarize(outcome.result) });
      } else {
        this.#sql.exec(
          "UPDATE scoring_runs SET status = 'errored', error = ?, finished_at = ? WHERE id = ?",
          outcome.error,
          at,
          id,
        );
        this.#journal("scoring_errored", run, { error: outcome.error });
      }
      return true;
    });
  }

  getRun(id: number): StoredRun | null {
    const [row] = this.#sql.exec<RunRow>("SELECT * FROM scoring_runs WHERE id = ?", id);
    return row === undefined ? null : toRun(row);
  }

  /** An attempt's runs, oldest first. */
  listRuns({ task, attempt }: ScoredAttempt): StoredRun[] {
    return this.#sql
      .exec<RunRow>("SELECT * FROM scoring_runs WHERE task = ? AND attempt = ? ORDER BY id", task, attempt)
      .map(toRun);
  }

  async #start(runner: ScoringRunner, run: StoredRun): Promise<void> {
    const params: ScoringParams = {
      project: run.project,
      attempt: headAttemptRef(run),
      sha: run.sha,
      run: run.id,
    };
    try {
      await runner.workflow.create({ id: run.instance_id, params });
    } catch (cause) {
      this.#sql.exec(
        "UPDATE scoring_runs SET status = 'errored', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        String(cause),
        this.#ms(),
        run.id,
      );
      this.#journal("scoring_errored", run, { error: String(cause) });
      return;
    }
    // A newer head may have cancelled the run while its Workflow was being created.
    const now = this.getRun(run.id);
    if (now?.status === "cancelled") {
      this.#sql.exec("UPDATE scoring_runs SET torn_down = 1 WHERE id = ?", run.id);
      await this.#stop(runner, now);
    }
  }

  async #stop(runner: ScoringRunner, run: StoredRun): Promise<void> {
    try {
      const instance = await runner.workflow.get(run.instance_id);
      await instance.terminate();
      await runner.teardown(run.instance_id);
    } catch (cause) {
      // The run may already have finished; its report is discarded either way.
      console.warn({ event: "scoring.stop_failed", instance_id: run.instance_id, error: String(cause) });
    }
  }

  #cancel(run: StoredRun, detail: Record<string, unknown>): void {
    this.#sql.exec("UPDATE scoring_runs SET status = 'cancelled', finished_at = ? WHERE id = ?", this.#ms(), run.id);
    this.#journal("scoring_cancelled", run, detail);
  }

  #journal(kind: string, run: StoredRun, extra: Record<string, unknown>): void {
    const detail = { ref: headAttemptRef(run), run: run.id, sha: run.sha, ...extra };
    this.#sql.exec(
      "INSERT INTO journal (at, kind, detail, user_id, agent, task, attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.#ms(),
      kind,
      JSON.stringify(detail),
      run.user_id,
      run.agent,
      run.task,
      run.attempt,
    );
  }

  #ms(): number {
    return this.#now().getTime();
  }
}

function toRun(row: RunRow): StoredRun {
  const { torn_down: _tornDown, ...run } = row;
  return {
    ...run,
    trigger: row.trigger as ScoringTrigger,
    status: row.status as RunStatus,
    result: row.result === null ? null : (JSON.parse(row.result) as ScoringResult),
    superseded: row.superseded === 1,
  };
}

/** A result in a few words for the journal: `no checks configured`, `2 passed, 1 failed`, `config invalid`. */
export function summarize(result: ScoringResult): string {
  if (result.config.kind === "invalid") return "config invalid";
  if (result.checks.length === 0) return "no checks configured";
  const counts = new Map<string, number>();
  for (const check of result.checks) counts.set(check.outcome, (counts.get(check.outcome) ?? 0) + 1);
  return [...counts].map(([outcome, n]) => `${n} ${outcome.replace("_", " ")}`).join(", ");
}
