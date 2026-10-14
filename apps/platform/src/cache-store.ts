/**
 * What a run's Workflow asks of the project's caches, and their eviction: where each cache restores
 * from and saves to, whether a save may go ahead, and deleting evictable entries' objects. The
 * index rows live in `CacheIndex`; this decides, from the run asking, what the run may do with them.
 */

import type { CacheIndex } from "./cache-index.ts";
import { cacheObjectKey, restoreScopes, saveScope } from "./caches.ts";
import type { CacheEntry, CacheKey, CacheLookup } from "./caches.ts";
import type { StoredRun } from "./scoring.ts";
import type { Sql } from "./task-store.ts";

type EntryKey = Pick<CacheEntry, "scope" | "name" | "keyHash">;

/** The part of the `CACHES` R2 bucket eviction uses; tests pass a fake. */
export interface CacheObjects {
  delete: (keys: string[]) => Promise<void>;
}

/** Most keys one R2 `delete` takes. */
const MAX_DELETE_KEYS = 1000;

export interface CacheStoreDeps {
  sql: Pick<Sql, "transaction">;
  index: CacheIndex;
  /** Deletes entries' objects; without one, nothing is evicted. */
  objects: CacheObjects | null;
  /** The run with id `id`, as far as its caches need it; null when there is none. */
  run: (id: number) => Pick<StoredRun, "status" | "trusted" | "line"> | null;
}

export class CacheStore {
  readonly #sql: CacheStoreDeps["sql"];
  readonly #index: CacheIndex;
  readonly #objects: CacheObjects | null;
  readonly #run: CacheStoreDeps["run"];

  constructor({ sql, index, objects, run }: CacheStoreDeps) {
    this.#sql = sql;
    this.#index = index;
    this.#objects = objects;
    this.#run = run;
  }

  /** See `TaskStore.pipelineCaches`. */
  lookup(id: number, keys: readonly CacheKey[]): CacheLookup[] {
    const run = this.#run(id);
    if (run === null) throw new Error(`no run ${id}`);
    const scopes = restoreScopes(run.line);
    const own = saveScope(run.line);
    return this.#sql.transaction(() =>
      keys.map((key): CacheLookup => {
        const restore = this.#index.find(scopes, key.name, key.keyHash);
        if (restore !== null || own === null) return { ...key, restore, save: null };
        if (!run.trusted) return { ...key, restore, save: null, unsaved: "this run isn't trusted" };
        return { ...key, restore, save: own };
      }),
    );
  }

  /** See `TaskStore.pipelineCacheSaving`. */
  saving(id: number, entry: EntryKey): boolean {
    return (
      this.#maySave(id, entry) && this.#index.reserve(entry, id, (holder) => this.#run(holder)?.status === "running")
    );
  }

  /** See `TaskStore.pipelineCacheSaved`. */
  saved(id: number, entry: EntryKey & Pick<CacheEntry, "size">): boolean {
    return this.#maySave(id, entry) && this.#index.record(entry, id);
  }

  /** See `TaskStore.pipelineCacheUnsaved`. */
  unsaved(id: number, entry: EntryKey): void {
    this.#index.release(entry, id);
  }

  /** Deletes the objects of every evictable cache entry, then their rows; one that fails to delete stays for the next try. */
  async evict(project: string): Promise<void> {
    if (this.#objects === null) return;
    const entries = this.#index.evictable();
    for (let i = 0; i < entries.length; i += MAX_DELETE_KEYS) {
      const batch = entries.slice(i, i + MAX_DELETE_KEYS);
      await this.#objects.delete(batch.map((entry) => cacheObjectKey(project, entry)));
      this.#index.remove(batch);
      for (const entry of batch) console.log({ event: "cache.evicted", project, ...entry });
    }
  }

  /** Only a trusted running run saves, and only to its own line's scope. */
  #maySave(id: number, entry: Pick<CacheEntry, "scope">): boolean {
    const run = this.#run(id);
    return run?.status === "running" && run.trusted && saveScope(run.line) === entry.scope;
  }
}
