// The caller's tasks and attempts across every project, read from the D1 projection that each
// project's Durable Object publishes to (`projection.ts`). They trail the Durable Objects by one
// alarm, usually seconds, but up to `MAX_PROJECTION_RETRY_MS` while D1 is failing; and a project's
// tasks from before the projection existed show up only after its next call. Nothing that writes
// reads them.

import type { StoredProjectedAttempt, StoredProjectedTask } from "./projection.ts";
import { projectsById } from "./projects.ts";
import type { Project } from "./projects.ts";
import { attemptRef, taskRef } from "./task-refs.ts";
import { ATTEMPT_STATES, listedStates, TASK_STATES } from "./task-store.ts";
import type { AttemptState, TaskState } from "./task-store.ts";
import type { UserRef } from "./tasks.ts";
import type { Actor } from "./tokens.ts";
import type { Database } from "./users.ts";

/** How many items a page of a listing holds unless it asks for fewer, and the most it may ask for. */
export const DEFAULT_LISTING_PAGE = 50;
export const MAX_LISTING_PAGE = 100;

/** Which page of a listing to read: skip `offset` items, then take at most `limit`. */
export interface ListingPage {
  offset: number;
  limit: number;
}

/** A task in a listing across projects. */
export interface MyTask {
  project: Project;
  ref: string;
  number: number;
  title: string;
  state: TaskState;
  creator: UserRef;
  createdAt: string;
  closedAt: string | null;
}

/** An attempt in a listing across projects. */
export interface MyAttempt {
  project: Project;
  ref: string;
  task: { ref: string; number: number; title: string };
  number: number;
  state: AttemptState;
  author: UserRef;
  createdAt: string;
  closedAt: string | null;
}

interface TaskListingRow extends StoredProjectedTask {
  creator_handle: string;
}

interface AttemptListingRow extends StoredProjectedAttempt {
  task_title: string;
  author_handle: string;
}

/**
 * The caller's tasks and attempts, newest first, a page at a time; `next` is the next page's offset,
 * or null on the last. Obsolete ones are left out unless `state` asks for them, and so are rows whose
 * project is gone.
 */
export function myListings({ db }: { db: Database }) {
  /**
   * One page of `rows` (read with one row past `page.limit`, to tell whether another page follows),
   * each with its project. A row whose project went after the read is left out.
   */
  async function withProjects<R extends { project_id: string }>(
    rows: R[],
    page: ListingPage,
  ): Promise<{ rows: [R, Project][]; next: number | null }> {
    const shown = rows.slice(0, page.limit);
    const projects = await projectsById(
      db,
      shown.map((row) => row.project_id),
    );
    return {
      rows: shown.flatMap((row) => {
        const project = projects.get(row.project_id);
        return project === undefined ? [] : [[row, project] as [R, Project]];
      }),
      next: rows.length > page.limit ? page.offset + page.limit : null,
    };
  }

  return {
    /** The tasks the caller's user created. */
    async tasks(
      actor: Actor,
      input: ListingPage & { state?: TaskState | undefined },
    ): Promise<{ tasks: MyTask[]; next: number | null }> {
      const { results } = await db
        .prepare(
          `SELECT t.*, c.handle AS creator_handle
           FROM projected_tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN users c ON c.id = t.creator_id
           WHERE t.creator_id = ? AND t.state IN (SELECT value FROM json_each(?))
           ORDER BY t.created_at DESC, t.project_id, t.number DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(actor.user.id, listedStates(TASK_STATES, input.state), input.limit + 1, input.offset)
        .all<TaskListingRow>();
      const page = await withProjects(results, input);
      const tasks = page.rows.map(([row, project]) => ({
        project,
        ref: taskRef(row.number),
        number: row.number,
        title: row.title,
        state: row.state,
        creator: { id: row.creator_id, handle: row.creator_handle },
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
      return { tasks, next: page.next };
    },

    /** The attempts the caller's user authors. */
    async attempts(
      actor: Actor,
      input: ListingPage & { state?: AttemptState | undefined },
    ): Promise<{ attempts: MyAttempt[]; next: number | null }> {
      // A task is published before its attempts, so its row is in D1 whenever theirs is.
      const { results } = await db
        .prepare(
          `SELECT a.*, t.title AS task_title, u.handle AS author_handle
           FROM projected_attempts a
           JOIN projected_tasks t ON t.project_id = a.project_id AND t.number = a.task
           JOIN projects p ON p.id = a.project_id
           JOIN users u ON u.id = a.author_id
           WHERE a.author_id = ? AND a.state IN (SELECT value FROM json_each(?))
           ORDER BY a.created_at DESC, a.project_id, a.task DESC, a.number DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(actor.user.id, listedStates(ATTEMPT_STATES, input.state), input.limit + 1, input.offset)
        .all<AttemptListingRow>();
      const page = await withProjects(results, input);
      const attempts = page.rows.map(([row, project]) => ({
        project,
        ref: attemptRef(row.task, row.number),
        task: { ref: taskRef(row.task), number: row.task, title: row.task_title },
        number: row.number,
        state: row.state,
        author: { id: row.author_id, handle: row.author_handle },
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
      return { attempts, next: page.next };
    },
  };
}
