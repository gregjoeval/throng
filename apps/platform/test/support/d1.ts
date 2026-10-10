import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Database, Statement } from "../../src/users.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** A D1-shaped database over in-memory SQLite, with every migration applied, so tests run the real SQL. */
export function testDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const statement = (sql: string, values: SQLInputValue[]): Statement => ({
    bind: (...next) => statement(sql, next as SQLInputValue[]),
    first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[] }),
  });
  return { prepare: (sql) => statement(sql, []) };
}
