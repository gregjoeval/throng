// Scoring requests and the queue that turns them into Scoring Workflow runs. See the spec's "When
// scoring runs" section. The task store decides when an attempt's head should be scored and calls
// `request`; the queue keeps one pipeline run per request in the project Durable Object's SQLite,
// keyed on its line (`t42a3` for an attempt; see "Lines and the run key" in #257):
//
// - a head that is already queued or running isn't queued again, and one with a `done` run isn't
//   either, unless the request is a rescore. A rescore of a running head queues one follow-up
//   behind it, since the running run may have read the task's definitions before they changed;
// - a newer head on a line cancels its queued or running run, so newest head wins;
// - one run per line runs at a time, and at most `SCORING_CAP` runs are running per project, less
//   the slot the merge queue's landing holds (it counts toward the cap and goes first); the rest
//   wait, oldest first.
//
// It also tracks each line's head, moved by every push and scoring request, so a result for an
// older head is superseded and the attempt's `scoring` status is about its current head.
//
// `request` only writes rows, so it can sit inside the store's transactions. Starting and stopping
// Workflows is I/O, done by `drain`, which the Durable Object runs after every store call.

import { normaliseResult } from "./casing.ts";
import { addColumns, renameColumns } from "./columns.ts";
import { forkRepo } from "./repos.ts";
import { upgradeResult } from "./results.ts";
import type { ScoringResult, StoredResult } from "./results.ts";
import { runOutcome, scoringResult } from "./run-outcome.ts";
import type { RunOutcome } from "./run-outcome.ts";
import { isAttemptRef, parseAttemptRef, parseTaskRef } from "./task-refs.ts";
import type { Sql } from "./task-store.ts";
import type { Actor } from "./tokens.ts";

/** Most Sandbox-holding runs (scoring runs and the landing) one project may have running at once. */
export const SCORING_CAP = 3;

export const SCORING_TRIGGERS = ["open", "push", "scoreNow", "rescore"] as const;
/** A run is `waiting` while it needs the owner to start it, and holds no slot meanwhile. */
export const RUN_STATUSES = ["queued", "waiting", "running", "done", "cancelled", "errored"] as const;
export type ScoringTrigger = (typeof SCORING_TRIGGERS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Whether the run rests until someone acts: it ended, or it waits for the owner. What `wait_for_run` waits for. */
export function runSettled(run: Pick<StoredRun, "status">): boolean {
  return run.status !== "queued" && run.status !== "running";
}

/** How many runs one page of a project's runs lists unless asked, and at most. */
export const DEFAULT_RUNS_PAGE = 50;
export const MAX_RUNS_PAGE = 100;
/** What a runs listing's `line` may name besides a task or attempt line: `tasks` is every line but `main`. */
export const LINE_GROUPS = ["main", "tasks"] as const;

/** Whether `line` is something a runs listing can filter by: `main`, `tasks`, a task (`t42`) or an attempt (`t42a3`). */
export function isLineFilter(line: string): boolean {
  if ((LINE_GROUPS as readonly string[]).includes(line) || isAttemptRef(line)) return true;
  return line.startsWith("t") && parseTaskRef(line) !== null;
}

/** Which of a project's runs a page lists: newest first, older than `before` when given. */
export interface RunsQuery {
  /** A line (`t42`, `t42a3`), `main`, or `tasks` for every line but `main`; every line when absent. */
  line?: string | undefined;
  status?: RunStatus | undefined;
  /** A run id: only runs older than it, as a previous page's `next` gives. */
  before?: number | undefined;
  limit: number;
}

/** A page of runs, newest first, and the `before` of the next page; null on the last. */
export interface RunsPage {
  runs: StoredRun[];
  next: number | null;
}

/**
 * Whether the owner may cancel the run: while it is queued or waiting, or running on any line but
 * `main`, whose running run may be deploying.
 */
export function cancellable(run: Pick<StoredRun, "status" | "pipeline">): boolean {
  return run.status === "queued" || run.status === "waiting" || (run.status === "running" && run.pipeline !== "main");
}

export const PIPELINES = ["default", "main"] as const;
export type Pipeline = (typeof PIPELINES)[number];

/** The line whose runs run the `main` pipeline. */
const MAIN_LINE = "main";

/** The pipeline a line runs, which comes from the line and never from the tree: `main` runs `main`, every other line `default`. */
export function pipelineFor(line: string): Pipeline {
  return line === MAIN_LINE ? "main" : "default";
}

/** What a Pipeline Workflow is started with. */
export interface PipelineParams {
  project: string;
  /** The line the run runs on: `t42a3` for an attempt. */
  line: string;
  sha: string;
  /** The run's id, which its report back names. */
  run: number;
}

/**
 * What the project answers a run's plan: start it, it waits for the owner (it started nothing), or
 * it's refused before anything runs, saying why.
 */
export type PlanVerdict = { kind: "start" } | { kind: "waiting" } | { kind: "refused"; error: string };

/** What a run's Workflow reports when it ends: its outcome, or the error that ended it. */
export type RunReport = { status: "done"; outcome: RunOutcome } | { status: "errored"; error: string };

/**
 * What a Scoring Workflow reported, before each step's outcome was a run's: an attempt's scoring
 * result. Reports in this shape are still taken, from a run whose Workflow ran the old code.
 */
export type ScoringOutcome = { status: "done"; result: ScoringResult } | { status: "errored"; error: string };

/** A report in the old shape as a run's report. */
export function runReport(outcome: ScoringOutcome): RunReport {
  return outcome.status === "done" ? { status: "done", outcome: runOutcome(outcome.result) } : outcome;
}

/** An attempt's scoring status: its current head's latest run that wasn't cancelled, or `none`. */
export const ATTEMPT_SCORING_STATUSES = [
  "none",
  "queued",
  "waiting",
  "running",
  "done",
  "errored",
] as const satisfies readonly (RunStatus | "none")[];

/**
 * An attempt's scoring, for polling: the status of its current head's latest run (`none` when the
 * head has no run, or its run was cancelled), and the head it applies to (null before any push).
 */
export interface AttemptScoring {
  status: (typeof ATTEMPT_SCORING_STATUSES)[number];
  sha: string | null;
}

/** The part of a Workflow binding the queue uses; tests pass a fake. */
export interface PipelineWorkflowBinding {
  create: (options: { id: string; params: PipelineParams }) => Promise<unknown>;
  get: (id: string) => Promise<{ terminate: () => Promise<void> }>;
}

export interface ScoringRunner {
  workflow: PipelineWorkflowBinding;
  /**
   * Destroys a run's Sandboxes once its Workflow is stopped, and lets go of its snapshot:
   * `containers` are the ones its plan named, none when it was stopped before it planned.
   */
  teardown: (instanceId: string, containers: readonly string[]) => Promise<void>;
}

/** A pipeline run, as the project stores it. */
export interface StoredRun {
  id: number;
  /** The project id. */
  project: string;
  /** The line it runs on: `t42a3` for an attempt. */
  line: string;
  /** The head it runs. */
  sha: string;
  pipeline: Pipeline;
  trigger: ScoringTrigger;
  /** The merge request a landing runs for; null for any other run. */
  merge_request: number | null;
  /** The requesting user's id, or null for a request no user made. */
  user_id: string | null;
  alias: string | null;
  /** Whether it may hold the secrets its pipeline allows. */
  trusted: boolean;
  status: RunStatus;
  /** The Workflow instance id. */
  instance_id: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** The run's outcome, once it is `done`. */
  outcome: RunOutcome | null;
  /** The slice of its outcome an attempt's scoring reads, once it is `done`. */
  result: ScoringResult | null;
  /** The error that ended it, once it is `errored`. */
  error: string | null;
  /** Whether its head is no longer its line's current head. */
  superseded: boolean;
  /** Whether it stored its logs before runs were keyed on their line: under its head (`legacyLogKey`). */
  legacy_logs: boolean;
}

interface RunRow extends Omit<
  StoredRun,
  "pipeline" | "trigger" | "status" | "trusted" | "outcome" | "result" | "superseded" | "legacy_logs"
> {
  pipeline: string;
  trigger: string;
  status: string;
  trusted: number;
  outcome: string | null;
  superseded: number;
  legacy_logs: number;
  torn_down: number;
  /** The containers the run's plan named (JSON), once its Workflow planned them. */
  containers: string | null;
}

export interface ScoringRequestInput {
  /** The project id. */
  project: string;
  line: string;
  sha: string;
  trigger: ScoringTrigger;
  actor: Actor | null;
  /**
   * Whether the project's owner (as themselves or under an alias) pushed `sha`, which makes its run
   * trusted; null when the request isn't a push, so the run is trusted as the head's push was.
   */
  ownersPush: boolean | null;
  /**
   * The newest run id on the line when the caller began reading `sha`. A run queued since then
   * came from a push recorded meanwhile, whose head is at least as new as `sha`, so the request
   * yields to it rather than replace it.
   */
  readSince?: number | undefined;
}

/** What a request did: queued a run, or why it didn't, with the run that already covers the head. */
export type ScoringRequest = { queued: true; run: StoredRun } | { queued: false; reason: string; run: StoredRun };

const SCHEMA = [
  // `sha` is null only for a landing's run until it lands; every run this queue writes has its head.
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  line TEXT NOT NULL,
  sha TEXT,
  pipeline TEXT NOT NULL,
  trigger TEXT NOT NULL,
  merge_request INTEGER,
  user_id TEXT,
  alias TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  outcome TEXT,
  error TEXT,
  instance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  torn_down INTEGER NOT NULL DEFAULT 0,
  superseded INTEGER NOT NULL DEFAULT 0,
  legacy_logs INTEGER NOT NULL DEFAULT 0
)`,
  "CREATE INDEX IF NOT EXISTS pipeline_runs_line ON pipeline_runs (line, id)",
  // Each line's current head: what its pushes and run requests last moved it to.
  `CREATE TABLE IF NOT EXISTS pipeline_heads (
  line TEXT PRIMARY KEY,
  sha TEXT NOT NULL
)`,
];
/** Columns `pipeline_runs` gained after its first version, which a table that old lacks. */
const PIPELINE_RUN_COLUMNS = ["containers TEXT"];
/** Columns `pipeline_heads` gained after its first version: whether the owner pushed the head. */
const PIPELINE_HEAD_COLUMNS = ["owners_push INTEGER NOT NULL DEFAULT 0"];
/** Columns `scoring_runs` gained after its first version, which a table that old lacks. */
const SCORING_RUN_COLUMNS = ["result TEXT", "error TEXT", "superseded INTEGER NOT NULL DEFAULT 0"];
/** `scoring_runs` columns named before an actor's alias was called an alias. */
const SCORING_RUN_RENAMES = [["agent", "alias"]] as const;
/** An attempt's line from its `task` and `attempt` columns: `t42a3`, as `attemptRef` makes it. */
const ATTEMPT_LINE_SQL = "'t' || task || 'a' || attempt";

/**
 * Moves the tables runs were kept in before they were keyed on their line into `pipeline_runs` and
 * `pipeline_heads`. Each attempt's runs and head move to its line; its runs keep their ids, which URLs
 * and log keys name, and their stored results, which are upgraded on read; and they ran `default`.
 */
function migrateScoringRuns(sql: Sql): void {
  const tables = new Set(
    sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name),
  );
  sql.transaction(() => {
    if (tables.has("scoring_runs")) {
      renameColumns(sql, "scoring_runs", SCORING_RUN_RENAMES);
      addColumns(sql, "scoring_runs", SCORING_RUN_COLUMNS);
      sql.exec(
        `INSERT INTO pipeline_runs (id, project, line, sha, pipeline, trigger, user_id, alias, status, outcome, error,
           instance_id, created_at, started_at, finished_at, torn_down, superseded, legacy_logs)
         SELECT id, project, ${ATTEMPT_LINE_SQL}, sha, 'default', trigger, user_id, alias, status, result, error,
           instance_id, created_at, started_at, finished_at, torn_down, superseded, 1
         FROM scoring_runs`,
      );
      sql.exec("DROP TABLE scoring_runs");
    }
    if (tables.has("scoring_heads")) {
      sql.exec(`INSERT INTO pipeline_heads (line, sha) SELECT ${ATTEMPT_LINE_SQL}, sha FROM scoring_heads`);
      sql.exec("DROP TABLE scoring_heads");
    }
  });
}

export interface ScoringQueueDeps {
  sql: Sql;
  /** Starts and stops runs; without one, runs stay queued. */
  runner?: ScoringRunner | null | undefined;
  now?: () => Date;
  /** Sandbox slots under the cap held for something else (the merge queue's landing), so runs don't take them. */
  reserved?: () => number;
}

/** One project's pipeline runs, and the queue that starts them. */
export class ScoringQueue {
  readonly #sql: Sql;
  readonly #runner: ScoringRunner | null;
  readonly #now: () => Date;
  readonly #reserved: () => number;

  constructor({ sql, runner = null, now = () => new Date(), reserved = () => 0 }: ScoringQueueDeps) {
    this.#sql = sql;
    this.#runner = runner;
    this.#now = now;
    this.#reserved = reserved;
    for (const statement of SCHEMA) sql.exec(statement);
    addColumns(sql, "pipeline_runs", PIPELINE_RUN_COLUMNS);
    addColumns(sql, "pipeline_heads", PIPELINE_HEAD_COLUMNS);
    migrateScoringRuns(sql);
  }

  /**
   * Records that the line's head is now `sha`, marking runs for every other head superseded, and
   * whether the owner pushed it (`ownersPush`; null keeps what was recorded for the same head, and
   * says no for a new one). Pushes call it whether or not they ask for a run, so a draft's result is
   * superseded too.
   */
  moveHead(line: string, sha: string, ownersPush: boolean | null): void {
    this.#sql.transaction(() => {
      this.#sql.exec(
        `INSERT INTO pipeline_heads (line, sha, owners_push) VALUES (?, ?, ?)
         ON CONFLICT (line) DO UPDATE SET
           owners_push = CASE WHEN ? IS NOT NULL THEN excluded.owners_push
                              WHEN sha = excluded.sha THEN owners_push ELSE 0 END,
           sha = excluded.sha`,
        line,
        sha,
        ownersPush === true ? 1 : 0,
        ownersPush === null ? null : 1,
      );
      this.#sql.exec("UPDATE pipeline_runs SET superseded = (sha != ?) WHERE line = ?", sha, line);
    });
  }

  /** The line's scoring status, about its current head. */
  statusFor(line: string): AttemptScoring {
    const [head] = this.#sql.exec<{ sha: string }>("SELECT sha FROM pipeline_heads WHERE line = ?", line);
    if (head === undefined) return { status: "none", sha: null };
    const [run] = this.#sql.exec<{ status: string }>(
      `SELECT status FROM pipeline_runs WHERE line = ? AND sha = ? AND status != 'cancelled'
       ORDER BY id DESC LIMIT 1`,
      line,
      head.sha,
    );
    return { status: (run?.status as AttemptScoring["status"] | undefined) ?? "none", sha: head.sha };
  }

  /**
   * The line's current result: the latest `done` run for its current head, or null. Results for
   * older heads are superseded and never current.
   */
  currentRun(line: string): StoredRun | null {
    const [row] = this.#sql.exec<RunRow>(
      `SELECT r.* FROM pipeline_runs r JOIN pipeline_heads h ON h.line = r.line AND h.sha = r.sha
       WHERE r.line = ? AND r.status = 'done' ORDER BY r.id DESC LIMIT 1`,
      line,
    );
    return row === undefined ? null : toRun(row);
  }

  /** The newest `done` or `errored` run of the line's current head, or null when that head has none. */
  scoredRun(line: string): number | null {
    const [row] = this.#sql.exec<{ id: number }>(
      `SELECT r.id FROM pipeline_runs r JOIN pipeline_heads h ON h.line = r.line AND h.sha = r.sha
       WHERE r.line = ? AND r.status IN ('done', 'errored') ORDER BY r.id DESC LIMIT 1`,
      line,
    );
    return row?.id ?? null;
  }

  /**
   * Asks for the line's head `sha` to be run. Checks no permission: the task store has already
   * decided the request is allowed.
   */
  request(input: ScoringRequestInput): ScoringRequest {
    return this.#sql.transaction(() => {
      this.moveHead(input.line, input.sha, input.ownersPush);
      const live = this.#sql
        .exec<RunRow>(
          "SELECT * FROM pipeline_runs WHERE line = ? AND status IN ('queued', 'waiting', 'running') ORDER BY id",
          input.line,
        )
        .map(toRun);
      const same = live.filter((r) => r.sha === input.sha);
      const queued = same.find((r) => r.status === "queued");
      if (queued !== undefined) return { queued: false, reason: "already queued", run: queued };
      const waiting = same.find((r) => r.status === "waiting");
      if (waiting !== undefined) return { queued: false, reason: "waiting for the owner", run: waiting };
      const running = same.find((r) => r.status === "running");
      if (running !== undefined && input.trigger !== "rescore") {
        return { queued: false, reason: "already running", run: running };
      }
      if (input.readSince !== undefined) {
        const [newer] = this.#sql.exec<RunRow>(
          "SELECT * FROM pipeline_runs WHERE line = ? AND id > ? ORDER BY id DESC",
          input.line,
          input.readSince,
        );
        if (newer !== undefined) return { queued: false, reason: "a newer push is queued", run: toRun(newer) };
      }
      // Whatever happens to this head, runs for older heads are superseded now.
      for (const older of live.filter((r) => r.sha !== input.sha)) this.#cancel(older, { superseded_by: input.sha });
      if (input.trigger !== "rescore") {
        const [done] = this.#sql.exec<RunRow>(
          "SELECT * FROM pipeline_runs WHERE line = ? AND sha = ? AND status = 'done' ORDER BY id DESC",
          input.line,
          input.sha,
        );
        if (done !== undefined) return { queued: false, reason: "already scored", run: toRun(done) };
      }

      // A run is trusted when the owner pushed its head, as recorded just now or with the head's push.
      const [row] = this.#sql.exec<RunRow>(
        `INSERT INTO pipeline_runs
           (project, line, sha, pipeline, trigger, user_id, alias, trusted, status, instance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT owners_push FROM pipeline_heads WHERE line = ?), 'queued', '', ?)
         RETURNING *`,
        input.project,
        input.line,
        input.sha,
        pipelineFor(input.line),
        input.trigger,
        input.actor?.user.id ?? null,
        input.actor?.alias ?? null,
        input.line,
        this.#ms(),
      );
      if (row === undefined) throw new Error("pipeline run insert returned no row");
      // The id makes the instance id unique, so a rescore of a head gets its own Workflow.
      const instanceId = `${forkRepo(input.project, row.line)}-${input.sha.slice(0, 12)}-${row.id}`;
      this.#sql.exec("UPDATE pipeline_runs SET instance_id = ? WHERE id = ?", instanceId, row.id);
      const run = toRun({ ...row, instance_id: instanceId });
      this.#journal("scoringQueued", run, { trigger: input.trigger });
      return { queued: true, run };
    });
  }

  /**
   * Cancels the line's queued and running runs, because its attempt ended or went back to draft and
   * is no longer considered; the next `drain` stops any that had started.
   */
  cancelLine(line: string, reason: string): void {
    this.#sql.transaction(() => {
      const live = this.#sql
        .exec<RunRow>("SELECT * FROM pipeline_runs WHERE line = ? AND status IN ('queued', 'waiting', 'running')", line)
        .map(toRun);
      for (const run of live) this.#cancel(run, { reason });
    });
  }

  /** How many runs are running, each holding a Sandbox slot. */
  running(): number {
    const [{ n } = { n: 0 }] = this.#sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pipeline_runs WHERE status = 'running'",
    );
    return n;
  }

  /** The newest run id on the line, or 0; what a request's `readSince` compares against. */
  latestRunId(line: string): number {
    const [row] = this.#sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM pipeline_runs WHERE line = ?", line);
    return row?.id ?? 0;
  }

  /**
   * Stops cancelled runs that had started, then starts queued runs while there are free slots; a
   * run queued behind its line's running run (a rescore) waits for it to end. Rows are claimed before
   * any await, so drains that overlap never start or stop a run twice.
   */
  async drain(): Promise<void> {
    if (this.#runner === null) return;
    const runner = this.#runner;

    const stopping = this.#sql.transaction(() => {
      const rows = this.#sql.exec<RunRow>(
        "SELECT * FROM pipeline_runs WHERE status = 'cancelled' AND started_at IS NOT NULL AND torn_down = 0",
      );
      for (const run of rows) this.#sql.exec("UPDATE pipeline_runs SET torn_down = 1 WHERE id = ?", run.id);
      return rows;
    });
    await Promise.all(stopping.map((row) => this.#stop(runner, row)));

    const starting = this.#sql.transaction(() => {
      const free = SCORING_CAP - this.running() - this.#reserved();
      if (free <= 0) return [];
      const rows = this.#sql
        .exec<RunRow>(
          `SELECT * FROM pipeline_runs q WHERE status = 'queued' AND NOT EXISTS (
             SELECT 1 FROM pipeline_runs r WHERE r.status = 'running' AND r.line = q.line
           ) ORDER BY id LIMIT ?`,
          free,
        )
        .map(toRun);
      for (const run of rows) {
        this.#sql.exec("UPDATE pipeline_runs SET status = 'running', started_at = ? WHERE id = ?", this.#ms(), run.id);
        this.#journal("scoringStarted", run, { instanceId: run.instance_id });
      }
      return rows;
    });
    await Promise.all(starting.map((run) => this.#start(runner, run)));

    const [{ n: waiting } = { n: 0 }] = this.#sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pipeline_runs WHERE status = 'queued'",
    );
    if (waiting > 0) console.log({ event: "scoring.backpressure", waiting, cap: SCORING_CAP });
  }

  /**
   * Records the containers a running run's Workflow planned, before it starts any, so stopping it
   * destroys each one.
   */
  planned(id: number, containers: readonly string[]): void {
    this.#sql.exec("UPDATE pipeline_runs SET containers = ? WHERE id = ?", JSON.stringify(containers), id);
  }

  /**
   * Hands a running run to the owner: it is `waiting` until they start it, holding no slot. Its
   * Workflow ends having started no container, so there is nothing to stop. False when it wasn't
   * running (a newer head cancelled it meanwhile).
   */
  wait(run: StoredRun, secrets: readonly string[]): boolean {
    const [row] = this.#sql.exec<RunRow>(
      "UPDATE pipeline_runs SET status = 'waiting', torn_down = 1 WHERE id = ? AND status = 'running' RETURNING *",
      run.id,
    );
    if (row !== undefined) this.#journal("scoringWaiting", run, { secrets });
    return row !== undefined;
  }

  /**
   * Records how a running run ended, from its Workflow's report: a `done` run keeps its outcome and
   * journals `scored` with the gate and a summary, an `errored` one its error. A report for a run
   * that is no longer running (superseded by a newer head, or cancelled) is discarded. Returns
   * whether it was recorded.
   */
  finish(id: number, report: RunReport): boolean {
    return this.#sql.transaction(() => {
      const run = this.getRun(id);
      if (run === null) return false;
      if (run.status !== "running") {
        console.log({ event: "scoring.discarded_result", run: id, status: run.status });
        return false;
      }
      const at = this.#ms();
      if (report.status === "done") {
        this.#sql.exec(
          "UPDATE pipeline_runs SET status = 'done', outcome = ?, finished_at = ? WHERE id = ?",
          JSON.stringify(report.outcome),
          at,
          id,
        );
        this.#journal("scored", run, { gate: report.outcome.gate, summary: summarize(scoringResult(report.outcome)) });
      } else {
        this.#sql.exec(
          "UPDATE pipeline_runs SET status = 'errored', error = ?, finished_at = ? WHERE id = ?",
          report.error,
          at,
          id,
        );
        this.#journal("scoringErrored", run, { error: report.error });
      }
      return true;
    });
  }

  getRun(id: number): StoredRun | null {
    const [row] = this.#sql.exec<RunRow>("SELECT * FROM pipeline_runs WHERE id = ?", id);
    return row === undefined ? null : toRun(row);
  }

  /** A page of the project's runs, newest first, filtered by line and status. */
  listPage({ line, status, before, limit }: RunsQuery): RunsPage {
    const rows = this.#sql
      .exec<RunRow>(
        `SELECT * FROM pipeline_runs
         WHERE (? IS NULL OR line = ? OR (? = 'tasks' AND line != ?))
           AND (? IS NULL OR status = ?) AND (? IS NULL OR id < ?)
         ORDER BY id DESC LIMIT ?`,
        ...[line, line, line, MAIN_LINE, status, status, before, before].map((v) => v ?? null),
        limit + 1,
      )
      .map(toRun);
    const runs = rows.slice(0, limit);
    return { runs, next: rows.length > limit ? (runs.at(-1)?.id ?? null) : null };
  }

  /** Cancels a run because the owner asked; the next `drain` stops it if it had started. */
  cancel(run: StoredRun, reason: string): void {
    this.#cancel(run, { reason });
  }

  /** A line's runs, oldest first. */
  listRuns(line: string): StoredRun[] {
    return this.#sql.exec<RunRow>("SELECT * FROM pipeline_runs WHERE line = ? ORDER BY id", line).map(toRun);
  }

  async #start(runner: ScoringRunner, run: StoredRun): Promise<void> {
    const params: PipelineParams = { project: run.project, line: run.line, sha: run.sha, run: run.id };
    try {
      await runner.workflow.create({ id: run.instance_id, params });
    } catch (error) {
      this.#sql.exec(
        "UPDATE pipeline_runs SET status = 'errored', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        String(error),
        this.#ms(),
        run.id,
      );
      this.#journal("scoringErrored", run, { error: String(error) });
      return;
    }
    // A newer head may have cancelled the run while its Workflow was being created.
    const [now] = this.#sql.exec<RunRow>("SELECT * FROM pipeline_runs WHERE id = ?", run.id);
    if (now?.status === "cancelled") {
      this.#sql.exec("UPDATE pipeline_runs SET torn_down = 1 WHERE id = ?", run.id);
      await this.#stop(runner, now);
    }
  }

  /** Terminates a cancelled run's Workflow, then destroys the containers it planned and lets go of its snapshot. */
  async #stop(runner: ScoringRunner, run: RunRow): Promise<void> {
    try {
      const instance = await runner.workflow.get(run.instance_id);
      await instance.terminate();
      const containers = run.containers === null ? [] : (JSON.parse(run.containers) as string[]);
      await runner.teardown(run.instance_id, containers);
    } catch (error) {
      // The run may already have finished; its report is discarded either way.
      console.warn({ event: "scoring.stop_failed", instance_id: run.instance_id, error: String(error) });
    }
  }

  #cancel(run: StoredRun, detail: Record<string, unknown>): void {
    this.#sql.exec("UPDATE pipeline_runs SET status = 'cancelled', finished_at = ? WHERE id = ?", this.#ms(), run.id);
    this.#journal("scoringCancelled", run, detail);
  }

  #journal(kind: string, run: StoredRun, extra: Record<string, unknown>): void {
    const detail = { ref: run.line, run: run.id, sha: run.sha, ...extra };
    const attempt = parseAttemptRef(run.line);
    this.#sql.exec(
      "INSERT INTO journal (at, kind, detail, user_id, alias, task, attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.#ms(),
      kind,
      JSON.stringify(detail),
      run.user_id,
      run.alias,
      attempt?.task ?? null,
      attempt?.number ?? null,
    );
  }

  #ms(): number {
    return this.#now().getTime();
  }
}

function toRun(row: RunRow): StoredRun {
  const { torn_down: _tornDown, containers: _containers, ...run } = row;
  const outcome = row.outcome === null ? null : storedOutcome(row.outcome);
  return {
    ...run,
    pipeline: row.pipeline as Pipeline,
    trigger: row.trigger as ScoringTrigger,
    status: row.status as RunStatus,
    trusted: row.trusted === 1,
    outcome,
    result: outcome === null ? null : scoringResult(outcome),
    superseded: row.superseded === 1,
    legacy_logs: row.legacy_logs === 1,
  };
}

/**
 * A stored outcome in the current shape. A run stored before outcomes had steps kept a scoring result,
 * perhaps one from before runs kept logs (it has none); it is upgraded to the current result first.
 */
function storedOutcome(json: string): RunOutcome {
  const stored = JSON.parse(json) as RunOutcome | (Partial<Pick<ScoringResult, "logs">> & StoredResult);
  if ("steps" in stored) return stored;
  return runOutcome(upgradeResult(normaliseResult({ ...stored, logs: stored.logs ?? [] })));
}

/**
 * A result in a few words for the journal: `no checks configured`, `2 passed, 1 failed`, `config invalid`.
 * It counts the config's checks only, not Throng's own.
 */
export function summarize(result: ScoringResult): string {
  if (result.config.kind === "invalid") return "config invalid";
  const checks = result.checks.filter((check) => check.source !== "platform");
  if (checks.length === 0) return "no checks configured";
  const counts = new Map<string, number>();
  for (const check of checks) counts.set(check.outcome, (counts.get(check.outcome) ?? 0) + 1);
  return [...counts].map(([outcome, n]) => `${n} ${outcome.replace("_", " ")}`).join(", ");
}
