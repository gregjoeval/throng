// The caller's tasks and attempts across every project, read from the D1 projection that each
// project's Durable Object publishes to (`projection.ts`). They trail the Durable Objects by a
// moment, and nothing that writes reads them.

import type { StoredProjectedAttempt, StoredProjectedTask } from "./projection.ts";
import { projectsById } from "./projects.ts";
import type { Project } from "./projects.ts";
import { attemptRef, taskRef } from "./task-refs.ts";
import type { AttemptState, TaskState } from "./task-store.ts";
import type { UserRef } from "./tasks.ts";
import type { Actor } from "./tokens.ts";
import type { Database } from "./users.ts";

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

/** The caller's tasks and attempts, newest first. Obsolete ones are left out unless `state` asks for them. */
export function myListings({ db }: { db: Database }) {
  /** Reads `rows`' projects, leaving out any row whose project is gone. */
  async function withProjects<R extends { project_id: string }>(rows: R[]): Promise<[R, Project][]> {
    const projects = await projectsById(
      db,
      rows.map((row) => row.project_id),
    );
    return rows.flatMap((row) => {
      const project = projects.get(row.project_id);
      return project === undefined ? [] : [[row, project] as [R, Project]];
    });
  }

  return {
    /** The tasks the caller's user created. */
    async tasks(actor: Actor, input: { state?: TaskState | undefined }): Promise<MyTask[]> {
      const filter = stateFilter("t", input.state);
      const { results } = await db
        .prepare(
          `SELECT t.*, c.handle AS creator_handle
           FROM projected_tasks t JOIN users c ON c.id = t.creator_id
           WHERE t.creator_id = ? AND ${filter.clause}
           ORDER BY t.created_at DESC, t.project_id, t.number DESC`,
        )
        .bind(actor.user.id, ...filter.params)
        .all<TaskListingRow>();
      return (await withProjects(results)).map(([row, project]) => ({
        project,
        ref: taskRef(row.number),
        number: row.number,
        title: row.title,
        state: row.state,
        creator: { id: row.creator_id, handle: row.creator_handle },
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
    },

    /** The attempts the caller's user authors. */
    async attempts(actor: Actor, input: { state?: AttemptState | undefined }): Promise<MyAttempt[]> {
      const filter = stateFilter("a", input.state);
      // A task is published before its attempts, so its row is in D1 whenever theirs is.
      const { results } = await db
        .prepare(
          `SELECT a.*, t.title AS task_title, u.handle AS author_handle
           FROM projected_attempts a
           JOIN projected_tasks t ON t.project_id = a.project_id AND t.number = a.task
           JOIN users u ON u.id = a.author_id
           WHERE a.author_id = ? AND ${filter.clause}
           ORDER BY a.created_at DESC, a.project_id, a.task DESC, a.number DESC`,
        )
        .bind(actor.user.id, ...filter.params)
        .all<AttemptListingRow>();
      return (await withProjects(results)).map(([row, project]) => ({
        project,
        ref: attemptRef(row.task, row.number),
        task: { ref: taskRef(row.task), number: row.task, title: row.task_title },
        number: row.number,
        state: row.state,
        author: { id: row.author_id, handle: row.author_handle },
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
    },
  };
}

/** Obsolete rows are left out of a listing, as from a project's own, unless its `state` asks for them. */
function stateFilter(table: string, state: string | undefined): { clause: string; params: string[] } {
  return state === undefined
    ? { clause: `${table}.state != 'obsolete'`, params: [] }
    : { clause: `${table}.state = ?`, params: [state] };
}
