// A blob's size in bytes. `readTree` gives none, so the blob is read for it, and the size is cached by
// the blob's hash: a blob never changes. Shared by directory listings and a commit's languages.

import type { DiffCache } from "./diff.ts";
import type { Repos } from "./repos.ts";

/** Blob reads for sizes run at most this many at a time. A blob may be tens of MB, so few. */
export const SIZE_CONCURRENCY = 2;
/** How long a blob's size stays cached. A blob never changes, so this only bounds the cache. */
const SIZE_CACHE_SECONDS = 30 * 24 * 60 * 60;

/** A blob's bytes in `repo`, or null when it has no such blob. Kept in `cache`, keyed by the hash. */
export function blobSizer(repos: Repos, cache: DiffCache | undefined) {
  return async (repo: string, hash: string): Promise<number | null> => {
    const key = new Request(`https://blob-size.throng.invalid/${hash}`);
    const hit = await cache?.match(key);
    if (hit !== undefined) return Number(await hit.text());
    const size = (await repos.readBlob(repo, hash))?.size ?? null;
    if (size !== null) {
      const headers = { "Cache-Control": `public, max-age=${SIZE_CACHE_SECONDS}` };
      await cache?.put(key, new Response(String(size), { headers }));
    }
    return size;
  };
}
