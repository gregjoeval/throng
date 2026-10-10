import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Repos } from "../../src/repos.ts";
import { runTaskMethod, TaskStore, type Sql } from "../../src/task-store.ts";
import type { TaskBackend } from "../../src/tasks.ts";

/** `Sql` over in-memory SQLite, standing in for a Durable Object's storage. */
export function testSql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    db,
    exec: <T>(query: string, ...bindings: unknown[]) => db.prepare(query).all(...(bindings as SQLInputValue[])) as T[],
    transaction: <T>(fn: () => T): T => {
      const savepoint = `s${depth++}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
        throw err;
      } finally {
        depth--;
      }
    },
  };
}

/**
 * One `TaskStore` per project id, run in-process like the Durable Object would. Arguments and
 * results are structured-cloned, as RPC would, so nothing leaks across by reference.
 */
export function testTaskBackends(repos: Repos, now?: () => Date) {
  const stores = new Map<string, { store: TaskStore; sql: ReturnType<typeof testSql> }>();
  const open = (projectId: string) => {
    let found = stores.get(projectId);
    if (found === undefined) {
      const sql = testSql();
      found = { store: new TaskStore(now === undefined ? { sql, repos } : { sql, repos, now }), sql };
      stores.set(projectId, found);
    }
    return found;
  };
  const store = (projectId: string): TaskStore => open(projectId).store;
  /** The project's SQLite, for reading back what the store wrote (its journal, say). */
  const sql = (projectId: string) => open(projectId).sql;
  const backend = (projectId: string): TaskBackend => ({
    call: async (method, args) => structuredClone(await runTaskMethod(store(projectId), method, structuredClone(args))),
  });
  return { backend, store, sql };
}
