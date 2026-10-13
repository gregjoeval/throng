// Projects: a codebase with one origin repo, owned by a user and addressed as `owner/project` by
// handles. The opaque id names the project's repos (`<id>-main`), so handles can change freely.
//
// Route logic lives here, in services taking `(actor, input)` with their permission checks, so the
// REST API and later MCP share it.

import { ServiceError } from "./errors.ts";
import type { PreviewWorkers } from "./preview-workers.ts";
import { originRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";
import type { Actor } from "./tokens.ts";
import { randomId } from "./users.ts";
import type { Database } from "./users.ts";

export const PROJECT_ID_LENGTH = 6;
export const MAX_PROJECT_HANDLE = 40;
/** Lowercase letters and digits in runs joined by single dashes, like user handles. */
export const PROJECT_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const MAX_ID_ATTEMPTS = 20;

export interface Project {
  id: string;
  handle: string;
  owner: { id: string; handle: string };
  createdAt: string;
}

export interface ProjectDeps {
  db: Database;
  repos: Repos;
  /** Each project's own preview Worker, created with the project. */
  previewWorkers: PreviewWorkers;
  /** Draws a project id; tests pass their own to force collisions. */
  newId?: () => string;
}

/** An opaque project id: 6 lowercase alphanumeric characters. */
export function randomProjectId(): string {
  return randomId(PROJECT_ID_LENGTH);
}

/** Whether `handle` is a valid project handle. */
export function isProjectHandle(handle: string): boolean {
  return handle.length <= MAX_PROJECT_HANDLE && PROJECT_HANDLE.test(handle);
}

interface ProjectRow {
  id: string;
  handle: string;
  owner_id: string;
  owner_handle: string;
  created_at: string;
}

const SELECT_PROJECT = `SELECT p.id, p.handle, p.created_at, u.id AS owner_id, u.handle AS owner_handle
  FROM projects p JOIN users u ON u.id = p.owner_id`;

function project(row: ProjectRow): Project {
  return {
    id: row.id,
    handle: row.handle,
    owner: { id: row.owner_id, handle: row.owner_handle },
    createdAt: row.created_at,
  };
}

/**
 * The project addressed as `owner/project` by handles, or null when either handle is unknown. It
 * only reads D1 and knows nothing about HTTP, so the git proxy resolves its remotes with it too.
 */
export async function resolveProject(db: Database, owner: string, handle: string): Promise<Project | null> {
  const row = await db
    .prepare(`${SELECT_PROJECT} WHERE u.handle = ? AND p.handle = ?`)
    .bind(owner, handle)
    .first<ProjectRow>();
  return row === null ? null : project(row);
}

/** The project services. Every signed-in actor may create projects and read any project in P0. */
export function projectService({ db, repos, previewWorkers, newId = randomProjectId }: ProjectDeps) {
  return {
    /**
     * Creates a project owned by the actor's user, its origin repo with `main` as the default branch,
     * and its preview Worker. Both are created before the row, so a failure creating either leaves no
     * project behind.
     */
    async create(actor: Actor, input: { handle: string }): Promise<Project> {
      const owner = actor.user;
      if (!isProjectHandle(input.handle)) throw new ServiceError("invalidRequest", `invalid project handle`);
      if ((await resolveProject(db, owner.handle, input.handle)) !== null) throw duplicate(owner.handle, input.handle);

      const id = await createOrigin(db, repos, newId);
      let row: ProjectRow | null;
      // Only a Worker this call made is rolled back: one already there may be another environment's.
      let createdWorker = false;
      try {
        createdWorker = await previewWorkers.ensure(id);
        row = await db
          .prepare(
            `INSERT INTO projects (id, owner_id, handle) VALUES (?, ?, ?)
             RETURNING id, handle, created_at, owner_id, ? AS owner_handle`,
          )
          .bind(id, owner.id, input.handle, owner.handle)
          .first<ProjectRow>();
        if (row === null) throw new Error("project insert returned no row");
      } catch (error) {
        await repos.delete(originRepo(id)).catch((deleteError: unknown) => {
          console.error({ event: "project.orphan_repo", repo: originRepo(id), error: String(deleteError) });
        });
        if (createdWorker) {
          await previewWorkers.delete(id).catch((deleteError: unknown) => {
            console.error({ event: "project.orphan_preview_worker", project: id, error: String(deleteError) });
          });
        }
        // Another request took the handle between the check and the insert.
        if (/UNIQUE constraint failed: projects\.(owner_id|handle)/u.test(String(error))) {
          throw duplicate(owner.handle, input.handle);
        }
        throw error;
      }
      console.log({ event: "project.created", project: id, owner: owner.id, alias: actor.alias });
      return project(row);
    },

    /** The projects owned by the actor's user, by handle. */
    async list(actor: Actor): Promise<Project[]> {
      const { results } = await db
        .prepare(`${SELECT_PROJECT} WHERE p.owner_id = ? ORDER BY p.handle`)
        .bind(actor.user.id)
        .all<ProjectRow>();
      return results.map(project);
    },

    /** The project at `owner/project`. Any signed-in actor may read any project in P0. */
    async get(_actor: Actor, input: { owner: string; project: string }): Promise<Project> {
      const found = await resolveProject(db, input.owner, input.project);
      if (found === null) throw new ServiceError("notFound", `no project ${input.owner}/${input.project}`);
      return found;
    },
  };
}

export type ProjectService = ReturnType<typeof projectService>;

function duplicate(owner: string, handle: string): ServiceError {
  return new ServiceError("conflict", `project ${owner}/${handle} already exists`);
}

/**
 * Draws a fresh project id and creates its origin repo, drawing again when the id is taken by a
 * project or (say, left over from a failed creation) by a repo.
 */
async function createOrigin(db: Database, repos: Repos, newId: () => string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = newId();
    if ((await db.prepare("SELECT 1 FROM projects WHERE id = ?").bind(id).first()) !== null) continue;
    try {
      await repos.create(originRepo(id), { defaultBranch: "main" });
      return id;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ALREADY_EXISTS") throw error;
    }
  }
  throw new Error("could not draw an unused project id");
}
