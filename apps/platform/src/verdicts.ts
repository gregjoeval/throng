// Verdicts: a reviewer's recommendation on one head of an attempt, kept in the project Durable
// Object's SQLite. One verdict per (attempt, head, reviewer), where the reviewer is the human; a
// new post for the same head replaces it. Verdicts are advisory: nothing here touches the gate,
// the score or the queue. The task store checks who may post and journals it.

import type { Sql } from "./task-store.ts";

export const VERDICT_RECOMMENDATIONS = ["merge", "revise", "reject"] as const;
export type VerdictRecommendation = (typeof VERDICT_RECOMMENDATIONS)[number];

/** The longest verdict body, in characters: 64 KB, like task bodies and attempt notes. */
export const MAX_VERDICT_BODY = 65_536;

export interface StoredVerdict {
  task: number;
  attempt: number;
  head: string;
  /** The reviewer's user id. */
  reviewer: string;
  /** The agent alias they posted under, if any. */
  agent: string | null;
  recommendation: VerdictRecommendation;
  body: string;
  at: string;
}

/** An attempt's verdicts on its current head, counted by recommendation. */
export interface VerdictSummary extends Record<VerdictRecommendation, number> {
  /** The current head; null before any push. */
  head: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS verdicts (
    task INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    head TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    agent TEXT,
    recommendation TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (task, attempt, head, reviewer)
  )`,
];

interface AttemptKey {
  task: number;
  attempt: number;
}

/** One project's verdicts. */
export class Verdicts {
  readonly #sql: Sql;

  constructor({ sql }: { sql: Sql }) {
    this.#sql = sql;
    for (const statement of SCHEMA) sql.exec(statement);
  }

  /** Stores a verdict, replacing the reviewer's earlier one on the same head. */
  put(verdict: StoredVerdict): void {
    this.#sql.exec(
      `INSERT INTO verdicts (task, attempt, head, reviewer, agent, recommendation, body, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task, attempt, head, reviewer) DO UPDATE SET
         agent = excluded.agent, recommendation = excluded.recommendation, body = excluded.body, at = excluded.at`,
      verdict.task,
      verdict.attempt,
      verdict.head,
      verdict.reviewer,
      verdict.agent,
      verdict.recommendation,
      verdict.body,
      verdict.at,
    );
  }

  /** The attempt's verdicts on every head, oldest first. */
  list({ task, attempt }: AttemptKey): StoredVerdict[] {
    return this.#sql.exec<StoredVerdict>(
      "SELECT * FROM verdicts WHERE task = ? AND attempt = ? ORDER BY at, rowid",
      task,
      attempt,
    );
  }

  /** The attempt's verdicts on `head`, counted by recommendation. */
  summary({ task, attempt }: AttemptKey, head: string | null): VerdictSummary {
    const summary: VerdictSummary = { head, merge: 0, revise: 0, reject: 0 };
    if (head === null) return summary;
    const rows = this.#sql.exec<{ recommendation: VerdictRecommendation; count: number }>(
      `SELECT recommendation, COUNT(*) AS count FROM verdicts WHERE task = ? AND attempt = ? AND head = ?
       GROUP BY recommendation`,
      task,
      attempt,
      head,
    );
    for (const { recommendation, count } of rows) summary[recommendation] = count;
    return summary;
  }
}
