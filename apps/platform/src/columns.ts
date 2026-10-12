// Column migrations for the Durable Object tables, which have no migration files: each store brings
// a table from any earlier shape to its current one when it starts. Both helpers are idempotent.

import type { Sql } from "./task-store.ts";

/** The names of `table`'s columns; empty when the table doesn't exist. */
function columnNames(sql: Sql, table: string): Set<string> {
  return new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
}

/** Adds each of `columns` (`name TYPE`) that `table` lacks. */
export function addColumns(sql: Sql, table: string, columns: readonly string[]): void {
  const names = columnNames(sql, table);
  for (const column of columns) {
    if (!names.has(column.split(" ")[0] ?? "")) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
}

/** Renames each `[from, to]` column that `table` still has under its old name. */
export function renameColumns(sql: Sql, table: string, renames: readonly (readonly [string, string])[]): void {
  const names = columnNames(sql, table);
  for (const [from, to] of renames) {
    if (names.has(from)) sql.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
}
