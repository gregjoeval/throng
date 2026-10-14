import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { FollowRunner } from "../../src/follows.ts";
import type { Repos } from "../../src/repos.ts";
import type { PipelineRunner } from "../../src/scoring.ts";
import { keyringFrom } from "../../src/secrets.ts";
import { runTaskMethod, TaskStore } from "../../src/task-store.ts";
import type { Sql } from "../../src/task-store.ts";
import type { TaskBackend } from "../../src/tasks.ts";

/** The keyring every test backend seals secrets under: one key, `test`. */
export const TEST_KEYRING = keyringFrom(JSON.stringify({ current: "test", keys: { test: btoa("k".repeat(32)) } }));

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
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
}

/**
 * One `TaskStore` per project id, run in-process like the Durable Object would. Arguments and
 * results are structured-cloned, as RPC would, so nothing leaks across by reference. Pass a
 * `scoring` runner to let tests start runs, landings included, with `store(id).drain(id)`, and a
 * `follow` one to let it start follows of task branches.
 */
export function testTaskBackends(repos: Repos, now?: () => Date, scoring?: PipelineRunner, follow?: FollowRunner) {
  const stores = new Map<string, { store: TaskStore; sql: ReturnType<typeof testSql> }>();
  const open = (projectId: string) => {
    let found = stores.get(projectId);
    if (found === undefined) {
      const sql = testSql();
      found = {
        store: new TaskStore({
          sql,
          repos,
          runner: scoring,
          follow,
          keyring: TEST_KEYRING,
          ...(now === undefined ? {} : { now }),
        }),
        sql,
      };
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
