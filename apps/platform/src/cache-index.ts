// The project's cache index: one row per cache entry in the `CACHES` bucket, in the project Durable
// Object's SQLite, and what eviction deletes. Entries are immutable: the first save of a key in a
// scope wins. Deleting an entry's object is I/O, which the Durable Object does after its store calls
// and on its alarm (`evictable`, then `remove` once the objects are gone).

import { CACHE_UNUSED_MS, PROJECT_CACHE_BYTES } from "./caches.ts";
import type { CacheEntry } from "./caches.ts";
import { MAIN_LINE } from "./scoring.ts";
import type { Sql } from "./task-store.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, name, key_hash)
)`;

interface EntryRow {
  scope: string;
  name: string;
  key_hash: string;
  size: number;
  created_at: number;
  last_used_at: number;
  ended: number;
}

export interface CacheIndexDeps {
  sql: Sql;
  now?: () => Date;
}

/** A project's cache entries, and which of them eviction deletes. */
export class CacheIndex {
  readonly #sql: Sql;
  readonly #now: () => Date;

  constructor({ sql, now = () => new Date() }: CacheIndexDeps) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(SCHEMA);
  }

  /**
   * The first of `scopes` holding an entry for the cache `name` under `keyHash`, marking that entry
   * used now; null when none does. An entry whose line ended is never restored.
   */
  find(scopes: readonly string[], name: string, keyHash: string): string | null {
    for (const scope of scopes) {
      const [row] = this.#sql.exec<EntryRow>(
        `UPDATE cache_entries SET last_used_at = ? WHERE scope = ? AND name = ? AND key_hash = ? AND ended = 0
         RETURNING *`,
        this.#ms(),
        scope,
        name,
        keyHash,
      );
      if (row !== undefined) return scope;
    }
    return null;
  }

  /** Whether the index has an entry for the key in its scope, whether or not its line ended. */
  has(entry: Pick<CacheEntry, "scope" | "name" | "keyHash">): boolean {
    const rows = this.#sql.exec(
      "SELECT 1 FROM cache_entries WHERE scope = ? AND name = ? AND key_hash = ?",
      entry.scope,
      entry.name,
      entry.keyHash,
    );
    return rows.length > 0;
  }

  /** Records an entry saved now, unless one is already there: the first save wins. Returns whether it recorded it. */
  record(entry: Pick<CacheEntry, "scope" | "name" | "keyHash" | "size">): boolean {
    const at = this.#ms();
    const inserted = this.#sql.exec(
      `INSERT INTO cache_entries (scope, name, key_hash, size, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING 1`,
      entry.scope,
      entry.name,
      entry.keyHash,
      entry.size,
      at,
      at,
    );
    return inserted.length > 0;
  }

  /** Marks the entries a line saved for deletion, as the line has ended: its task closed or went obsolete. */
  endLine(line: string): void {
    this.#sql.exec("UPDATE cache_entries SET ended = 1 WHERE scope = ?", line);
  }

  /** Every entry, oldest first. */
  list(): CacheEntry[] {
    return this.#sql.exec<EntryRow>("SELECT * FROM cache_entries ORDER BY created_at, scope, name").map(toEntry);
  }

  /**
   * The entries to delete now: every entry of a line that ended; every entry unused for
   * `CACHE_UNUSED_MS`, except `main`'s latest entry of each cache; then, while the rest are over
   * `PROJECT_CACHE_BYTES` together, the least recently used, task branches' before `main`'s.
   */
  evictable(): CacheEntry[] {
    const rows = this.#sql.exec<EntryRow>("SELECT * FROM cache_entries");
    const now = this.#ms();
    const kept = mainLatest(rows);
    const doomed = rows.filter(
      (row) => row.ended === 1 || (!kept.has(row) && row.last_used_at <= now - CACHE_UNUSED_MS),
    );
    const left = rows
      .filter((row) => !doomed.includes(row))
      .toSorted(
        (a, b) => Number(a.scope === MAIN_LINE) - Number(b.scope === MAIN_LINE) || a.last_used_at - b.last_used_at,
      );
    let total = left.reduce((sum, row) => sum + row.size, 0);
    for (const row of left) {
      if (total <= PROJECT_CACHE_BYTES) break;
      doomed.push(row);
      total -= row.size;
    }
    return doomed.map(toEntry);
  }

  /**
   * When the next entry falls unused, as a time in ms, for the alarm that evicts it; null when no
   * entry will (`main`'s latest of each cache never does).
   */
  nextUnused(): number | null {
    const rows = this.#sql.exec<EntryRow>("SELECT * FROM cache_entries");
    const kept = mainLatest(rows);
    const unused = rows.filter((row) => !kept.has(row)).map((row) => row.last_used_at + CACHE_UNUSED_MS);
    return unused.length === 0 ? null : Math.min(...unused);
  }

  /** Removes entries from the index, once their objects are deleted. */
  remove(entries: readonly Pick<CacheEntry, "scope" | "name" | "keyHash">[]): void {
    this.#sql.transaction(() => {
      for (const entry of entries) {
        this.#sql.exec(
          "DELETE FROM cache_entries WHERE scope = ? AND name = ? AND key_hash = ?",
          entry.scope,
          entry.name,
          entry.keyHash,
        );
      }
    });
  }

  #ms(): number {
    return this.#now().getTime();
  }
}

/** `main`'s latest entry of each cache, which is never deleted for going unused. */
function mainLatest(rows: readonly EntryRow[]): Set<EntryRow> {
  const latest = new Map<string, EntryRow>();
  for (const row of rows) {
    if (row.scope !== MAIN_LINE || row.ended === 1) continue;
    const known = latest.get(row.name);
    if (known === undefined || row.created_at > known.created_at) latest.set(row.name, row);
  }
  return new Set(latest.values());
}

function toEntry(row: EntryRow): CacheEntry {
  return {
    scope: row.scope,
    name: row.name,
    keyHash: row.key_hash,
    size: row.size,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
