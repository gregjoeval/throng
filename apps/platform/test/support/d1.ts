import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { BatchDatabase, Statement } from "../../src/users.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
/** D1 refuses a statement with more bound parameters than this. */
const MAX_BOUND_PARAMETERS = 100;

/**
 * A D1-shaped database over in-memory SQLite, with every migration applied, so tests run the real SQL
 * within D1's limits.
 */
export function testDatabase(): BatchDatabase {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  /** Each statement's SQL and values, for `batch` to run. */
  const bound = new WeakMap<Statement, { sql: string; values: SQLInputValue[] }>();
  const statement = (sql: string, values: SQLInputValue[]): Statement => {
    const made: Statement = {
      bind: (...next) => {
        if (next.length > MAX_BOUND_PARAMETERS) throw new Error(`D1: too many SQL variables (${next.length})`);
        return statement(sql, next as SQLInputValue[]);
      },
      first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
    };
    bound.set(made, { sql, values });
    return made;
  };
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          const found = bound.get(s);
          if (found === undefined) throw new Error("not a statement of this database");
          return { results: db.prepare(found.sql).all(...found.values) };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
