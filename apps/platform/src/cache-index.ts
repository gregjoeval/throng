// The project's cache index: one row per cache entry in the `CACHES` bucket, in the project Durable
// Object's SQLite, and what eviction deletes. Entries are immutable: the first save of a key in a
// scope wins. A run reserves a key before it uploads its object (`reserve`), so two runs never write
// one object; the reservation becomes the entry once the object is saved (`record`), or goes when
// the save fails (`release`) or never finishes. Deleting an entry's object is I/O, which the Durable
// Object does after its store calls and on its alarm (`evictable`, then `remove` once the objects
// are gone).

import { CACHE_RESERVATION_MS, CACHE_UNUSED_MS, PROJECT_CACHE_BYTES } from "./caches.ts";
import type { CacheEntry } from "./caches.ts";
import { addColumns } from "./columns.ts";
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
  saving INTEGER,
  PRIMARY KEY (scope, name, key_hash)
)`;

/** A row of `cache_entries`: an entry, or while `saving` names a run, that run's reservation of its key. */
interface StoredCacheEntry {
  scope: string;
  name: string;
  key_hash: string;
  size: number;
  created_at: number;
  last_used_at: number;
  ended: number;
  saving: number | null;
}

type EntryKey = Pick<CacheEntry, "scope" | "name" | "keyHash">;

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
    addColumns(sql, "cache_entries", ["saving INTEGER"]);
  }

  /**
   * The first of `scopes` holding an entry for the cache `name` under `keyHash`, marking that entry
   * used now; null when none does. An entry whose line ended is never restored.
   */
  find(scopes: readonly string[], name: string, keyHash: string): string | null {
    for (const scope of scopes) {
      const [row] = this.#sql.exec<StoredCacheEntry>(
        `UPDATE cache_entries SET last_used_at = ?
         WHERE scope = ? AND name = ? AND key_hash = ? AND ended = 0 AND saving IS NULL
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

  /**
   * Reserves the key for the run `run` to save its object under, unless an entry has it or another
   * run that `saving` says still saves holds it: the first save wins, and only one run at a time
   * writes an entry's object. The run holding it may take it again, as its retried step does; a run
   * that ended (cancelled by a newer head, say) gives it up. Returns whether `run` holds it.
   */
  reserve(entry: EntryKey, run: number, saving: (holder: number) => boolean): boolean {
    const [row] = this.#sql.exec<Pick<StoredCacheEntry, "saving">>(
      "SELECT saving FROM cache_entries WHERE scope = ? AND name = ? AND key_hash = ?",
      entry.scope,
      entry.name,
      entry.keyHash,
    );
    if (row !== undefined && (row.saving === null || (row.saving !== run && saving(row.saving)))) return false;
    const at = this.#ms();
    this.#sql.exec(
      `INSERT INTO cache_entries (scope, name, key_hash, size, created_at, last_used_at, saving)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT DO UPDATE SET created_at = excluded.created_at, last_used_at = excluded.last_used_at,
         saving = excluded.saving`,
      entry.scope,
      entry.name,
      entry.keyHash,
      at,
      at,
      run,
    );
    return true;
  }

  /**
   * Records an entry saved now: the reservation `run` holds becomes it, or with no row for the key it
   * is added. Another run's reservation or an entry already there is left as it is: the first save
   * wins. Returns whether it recorded it.
   */
  record(entry: EntryKey & Pick<CacheEntry, "size">, run: number | null = null): boolean {
    const at = this.#ms();
    const inserted = this.#sql.exec(
      `INSERT INTO cache_entries (scope, name, key_hash, size, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET size = excluded.size, created_at = excluded.created_at,
         last_used_at = excluded.last_used_at, saving = NULL
       WHERE saving = ?
       RETURNING 1`,
      entry.scope,
      entry.name,
      entry.keyHash,
      entry.size,
      at,
      at,
      run,
    );
    return inserted.length > 0;
  }

  /** Drops the reservation `run` holds on the key, once its save failed, so a later run may save it. */
  release(entry: EntryKey, run: number): void {
    this.#sql.exec(
      "DELETE FROM cache_entries WHERE scope = ? AND name = ? AND key_hash = ? AND saving = ?",
      entry.scope,
      entry.name,
      entry.keyHash,
      run,
    );
  }

  /** Marks the entries a line saved for deletion, as the line has ended: its task closed or went obsolete. */
  endLine(line: string): void {
    this.#sql.exec("UPDATE cache_entries SET ended = 1 WHERE scope = ?", line);
  }

  /** Every entry, oldest first; a key reserved but not yet saved isn't one. */
  list(): CacheEntry[] {
    return this.#sql
      .exec<StoredCacheEntry>("SELECT * FROM cache_entries WHERE saving IS NULL ORDER BY created_at, scope, name")
      .map(toEntry);
  }

  /**
   * The entries to delete now: every entry of a line that ended; every entry unused for
   * `CACHE_UNUSED_MS`, except `main`'s latest entry of each cache; then, while the rest are over
   * `PROJECT_CACHE_BYTES` together, the least recently used, task branches' before `main`'s. A
   * reservation whose save never finished within `CACHE_RESERVATION_MS` goes too, with any object
   * it left.
   */
  evictable(): CacheEntry[] {
    const rows = this.#sql.exec<StoredCacheEntry>("SELECT * FROM cache_entries");
    const now = this.#ms();
    const kept = mainLatest(rows);
    const doomed = rows.filter((row) =>
      row.saving === null
        ? row.ended === 1 || (!kept.has(row) && row.last_used_at <= now - CACHE_UNUSED_MS)
        : row.created_at <= now - CACHE_RESERVATION_MS,
    );
    const left = rows
      .filter((row) => row.saving === null && !doomed.includes(row))
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
   * When the next entry falls unused, or reservation goes stale, as a time in ms, for the alarm that
   * evicts it; null when none will (`main`'s latest entry of each cache never does).
   */
  nextUnused(): number | null {
    const rows = this.#sql.exec<StoredCacheEntry>("SELECT * FROM cache_entries");
    const kept = mainLatest(rows);
    const unused = rows
      .filter((row) => !kept.has(row))
      .map((row) => (row.saving === null ? row.last_used_at + CACHE_UNUSED_MS : row.created_at + CACHE_RESERVATION_MS));
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
function mainLatest(rows: readonly StoredCacheEntry[]): Set<StoredCacheEntry> {
  const latest = new Map<string, StoredCacheEntry>();
  for (const row of rows) {
    if (row.scope !== MAIN_LINE || row.ended === 1 || row.saving !== null) continue;
    const known = latest.get(row.name);
    if (known === undefined || row.created_at > known.created_at) latest.set(row.name, row);
  }
  return new Set(latest.values());
}

function toEntry(row: StoredCacheEntry): CacheEntry {
  return {
    scope: row.scope,
    name: row.name,
    keyHash: row.key_hash,
    size: row.size,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
