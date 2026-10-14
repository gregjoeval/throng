// Deleting a project: removing it and everything it holds for good. The owner's API route and the e2e
// suite's cleanup both delete through `deleteProject`.

import { CACHE_PREFIX } from "./caches.ts";
import { LOG_PREFIX } from "./logs.ts";
import { parseRepoName } from "./repos.ts";
import type { Repos } from "./repos.ts";
import type { Database } from "./users.ts";

/** R2 deletes at most this many keys per call. */
const R2_DELETE_BATCH = 1000;

/** The part of an R2 bucket deleting a project needs: listing keys under a prefix, and deleting them. */
export interface ObjectBucket {
  list: (options: {
    prefix: string;
    cursor?: string;
  }) => Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete: (keys: string[]) => Promise<void>;
}

/** Where a project's data lives outside D1 and its repos. */
export interface ProjectStorage {
  logs: ObjectBucket;
  caches: ObjectBucket;
  /** Stops the project Durable Object's running work and deletes all of its storage. */
  destroy: (projectId: string) => Promise<void>;
}

async function noStorage(): Promise<never> {
  throw new Error("this service was built without project storage");
}

/** Storage for a service that never deletes a project: any use of it throws. */
export const NO_PROJECT_STORAGE: ProjectStorage = {
  logs: { list: noStorage, delete: noStorage },
  caches: { list: noStorage, delete: noStorage },
  destroy: noStorage,
};

/**
 * Deletes project `id` and everything it holds: its Durable Object (stopping its runs first), its
 * logs and cache entries in R2, its repos, and last its D1 row, with its projected tasks and attempts.
 * The id is kept in `deleted_projects`, so no new project draws it.
 * Each step can run again, and the row goes last, so a call that fails partway leaves the project
 * in place for another call to finish. Until the row goes, the alarm may still publish: its rows
 * land, and go with the project's.
 */
export async function deleteProject(db: Database, repos: Repos, storage: ProjectStorage, id: string): Promise<void> {
  await storage.destroy(id);
  await deleteUnder(storage.logs, `${LOG_PREFIX}${id}/`);
  await deleteUnder(storage.caches, `${CACHE_PREFIX}${id}/`);
  const names = await repos.list(`${id}-`);
  await Promise.all(names.filter((name) => parseRepoName(name)?.project === id).map((name) => repos.delete(name)));
  await db.prepare("INSERT OR IGNORE INTO deleted_projects (id) VALUES (?)").bind(id).first();
  await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).first();
}

async function deleteUnder(bucket: ObjectBucket, prefix: string): Promise<void> {
  // Listed in full first, so deleting never shifts a page still to be listed.
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
}
