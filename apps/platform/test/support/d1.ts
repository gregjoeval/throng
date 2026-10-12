import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { Database, Statement } from "../../src/users.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
/** D1 refuses a statement with more bound parameters than this. */
const MAX_BOUND_PARAMETERS = 100;

/** A D1-shaped database over in-memory SQLite, with every migration applied, so tests run the real SQL
 * within D1's limits. */
export function testDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const statement = (sql: string, values: SQLInputValue[]): Statement => ({
    bind: (...next) => {
      if (next.length > MAX_BOUND_PARAMETERS) throw new Error(`D1: too many SQL variables (${next.length})`);
      return statement(sql, next as SQLInputValue[]);
    },
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
  });
  return { prepare: (sql) => statement(sql, []) };
}
