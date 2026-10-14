// Every name and value a client sees is camelCase (ADR 0002). Values stored before that were
// snake_case: scalar columns are rewritten once by `migrateValues`, and values inside JSON (a merge
// request's last dequeue, a run's result, a journal entry's detail) are left as stored and read
// through the normalisers here.

import type { Sql } from "./task-store.ts";

/** `needs_review` → `needsReview`, `fork-ready` → `forkReady`; a camelCase name is unchanged. */
export function camelCase(name: string): string {
  return name.replace(/[_-]([a-z0-9])/gu, (_, c: string) => c.toUpperCase());
}

/** An object with its own keys in camelCase, one level deep. */
export function camelKeys<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [camelCase(k), v])) as T;
}

type Loose = Record<string, unknown>;

/**
 * A stored dequeue (or landing outcome's details) with its enum values in camelCase: the reason, each
 * conflicting file's type and each failed check's outcome.
 */
export function normaliseDequeue<T extends { reason: string; details?: object | null }>(dequeue: T): T {
  const { details } = dequeue;
  return { ...dequeue, reason: camelCase(dequeue.reason), ...(details ? { details: normaliseDetails(details) } : {}) };
}

/** A landing outcome a Workflow reported, with its kind and details in camelCase. */
export function normaliseLandingOutcome<T extends { kind: string; details?: object }>(outcome: T): T {
  const { details } = outcome;
  return { ...outcome, kind: camelCase(outcome.kind), ...(details ? { details: normaliseDetails(details) } : {}) };
}

function normaliseDetails(details: object): Loose {
  const out: Loose = { ...details };
  if (Array.isArray(out.files)) {
    out.files = (out.files as Loose[]).map((f) => (typeof f.type === "string" ? { ...f, type: camelCase(f.type) } : f));
  }
  if (Array.isArray(out.checks)) out.checks = (out.checks as Loose[]).map(normaliseOutcome);
  return out;
}

function normaliseOutcome(check: Loose): Loose {
  return typeof check.outcome === "string" ? { ...check, outcome: camelCase(check.outcome) } : check;
}

/** A stored scoring result with each check's outcome in camelCase. */
export function normaliseResult<T extends { checks: unknown[] }>(result: T): T {
  return { ...result, checks: (result.checks as Loose[]).map(normaliseOutcome) };
}

/** Scalar columns whose stored values were snake_case, and the values to rewrite. */
const VALUE_COLUMNS: { table: string; column: string; values: string[] }[] = [
  { table: "merge_requests", column: "state", values: ["needs_review"] },
  { table: "pipeline_runs", column: "trigger", values: ["score_now"] },
];

/**
 * Rewrites values stored in snake_case to camelCase: merge request states, run triggers and every
 * journal event name. Idempotent; tables that don't exist yet are skipped.
 */
export function migrateValues(sql: Sql): void {
  const tables = new Set(
    sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name),
  );
  for (const { table, column, values } of VALUE_COLUMNS) {
    if (!tables.has(table)) continue;
    for (const value of values) {
      sql.exec(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, camelCase(value), value);
    }
  }
  if (tables.has("journal")) {
    const kinds = sql.exec<{ kind: string }>("SELECT DISTINCT kind FROM journal WHERE kind GLOB '*[_-]*'");
    for (const { kind } of kinds) sql.exec("UPDATE journal SET kind = ? WHERE kind = ?", camelCase(kind), kind);
  }
}
