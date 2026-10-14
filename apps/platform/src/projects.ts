// Projects: a codebase with one origin repo, owned by a user and addressed as `owner/project` by
// handles. The opaque id names the project's repos (`<id>-main`), so handles can change freely.
//
// Route logic lives here, in services taking `(actor, input)` with their permission checks, so the
// REST API and later MCP share it.

import { ServiceError } from "./errors.ts";
import { checkSourceUrl, importError, resolveSource } from "./import-source.ts";
import type { SourceUrl } from "./import-source.ts";
import { artifactsErrorCode, originRepo, stagingRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";
import type { Actor } from "./tokens.ts";
import { randomId } from "./users.ts";
import type { Database } from "./users.ts";

export const PROJECT_ID_LENGTH = 6;
export const MAX_PROJECT_HANDLE = 40;
/** Lowercase letters and digits in runs joined by single dashes, like user handles. */
export const PROJECT_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const MAX_ID_ATTEMPTS = 20;
const MAIN = "main";

export interface Project {
  id: string;
  handle: string;
  owner: { id: string; handle: string };
  /** The public git URL the project was imported from, or null when it started empty. */
  source: string | null;
  createdAt: string;
}

/** A checked source and the default branch its host advertised, which the origin's `main` starts from. */
interface ResolvedSource {
  url: SourceUrl;
  branch: string;
}

export interface ProjectDeps {
  db: Database;
  repos: Repos;
  /** Asks a source's host for its default branch; the global `fetch` by default. */
  fetch?: typeof fetch | undefined;
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
  source: string | null;
  created_at: string;
}

const SELECT_PROJECT = `SELECT p.id, p.handle, p.source, p.created_at, u.id AS owner_id, u.handle AS owner_handle
  FROM projects p JOIN users u ON u.id = p.owner_id`;

function project(row: ProjectRow): Project {
  return {
    id: row.id,
    handle: row.handle,
    owner: { id: row.owner_id, handle: row.owner_handle },
    source: row.source,
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

/** The projects with the given ids, by id; an unknown id is left out. */
export async function projectsById(db: Database, ids: readonly string[]): Promise<Map<string, Project>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  // One bound JSON array, not one parameter per id: D1 binds at most 100 parameters to a statement.
  const { results } = await db
    .prepare(`${SELECT_PROJECT} WHERE p.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(unique))
    .all<ProjectRow>();
  return new Map(results.map((row) => [row.id, project(row)]));
}

/** The project services. Every signed-in actor may create projects and read any project in P0. */
export function projectService({
  db,
  repos,
  fetch: fetcher = (input, init) => fetch(input, init),
  newId = randomProjectId,
}: ProjectDeps) {
  return {
    /**
     * Creates a project owned by the actor's user and its origin repo with `main` as the default
     * branch. The repo is created before the row, so a failure creating either leaves no project behind.
     * With a `source`, the origin starts as a copy of the source's default branch,
     * renamed `main`, with its full history. The copy is made once, inline, and never refreshed.
     */
    async create(actor: Actor, input: { handle: string; source?: { url: string } | undefined }): Promise<Project> {
      const owner = actor.user;
      if (!isProjectHandle(input.handle)) throw new ServiceError("invalidRequest", `invalid project handle`);
      const checked = input.source === undefined ? null : checkSourceUrl(input.source.url);
      if ((await resolveProject(db, owner.handle, input.handle)) !== null) throw duplicate(owner.handle, input.handle);

      // Before anything is created, so a private or missing source fails with nothing to undo.
      const source = checked === null ? null : await resolveSource(fetcher, checked);
      // Where the source's redirects, if any, ended: what is imported and kept.
      const url = source?.url ?? null;
      const id = await createOrigin(db, repos, newId, source);
      let row: ProjectRow | null;
      try {
        row = await db
          .prepare(
            `INSERT INTO projects (id, owner_id, handle, source) VALUES (?, ?, ?, ?)
             RETURNING id, handle, source, created_at, owner_id, ? AS owner_handle`,
          )
          .bind(id, owner.id, input.handle, url, owner.handle)
          .first<ProjectRow>();
        if (row === null) throw new Error("project insert returned no row");
      } catch (error) {
        await deleteOrphan(repos, originRepo(id));
        // Another request took the handle between the check and the insert.
        if (/UNIQUE constraint failed: projects\.(owner_id|handle)/u.test(String(error))) {
          throw duplicate(owner.handle, input.handle);
        }
        throw error;
      }
      console.log({ event: "project.created", project: id, owner: owner.id, alias: actor.alias, source: url });
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
 * Draws a fresh project id and creates its origin repo, empty or imported from `source`, drawing
 * again when the id is taken by a project or (say, left over from a failed creation) by a repo.
 */
async function createOrigin(
  db: Database,
  repos: Repos,
  newId: () => string,
  source: ResolvedSource | null,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = newId();
    if ((await db.prepare("SELECT 1 FROM projects WHERE id = ?").bind(id).first()) !== null) continue;
    try {
      if (source === null) await repos.create(originRepo(id), { defaultBranch: MAIN });
      else await importOrigin(repos, id, source);
      return id;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
  }
  throw new Error("could not draw an unused project id");
}

/**
 * Imports `source` as project `id`'s origin, its default branch as `main`. Artifacts imports a
 * branch under its own name and nothing can repoint `HEAD` afterwards (#223 §2), so a source whose
 * default isn't `main` lands in a staging repo, and its branch is copied to `main` in an origin
 * created empty. The staging repo is deleted whatever happens. On failure nothing of the import is
 * left; `ALREADY_EXISTS` on the origin's name is thrown as is, for the caller to draw another id.
 *
 * A staging repo already there is a leftover of an earlier creation under this id that died before
 * deleting it: this call now holds the id (it just created the origin, and no project row has it), so
 * the leftover is deleted rather than letting it fail the import and waste the id.
 */
async function importOrigin(repos: Repos, id: string, source: ResolvedSource): Promise<void> {
  const origin = originRepo(id);
  if (source.branch === MAIN) {
    try {
      await repos.import(origin, source);
    } catch (error) {
      // A name already taken is someone else's repo; anything else may have left a partial import.
      if (!alreadyExists(error)) await deleteOrphan(repos, origin);
      throw importError(error, source.url);
    }
    return;
  }
  await repos.create(origin, { defaultBranch: MAIN });
  const staging = stagingRepo(id);
  await repos.delete(staging).catch(() => false);
  try {
    try {
      await repos.import(staging, source);
    } catch (error) {
      throw importError(error, source.url);
    }
    const fromRef = `refs/heads/${source.branch}`;
    const head = await repos.copyRef({ from: staging, fromRef, to: origin, toRef: `refs/heads/${MAIN}` });
    if (head === null) throw new Error(`the import of ${source.url} has no ${fromRef}`);
  } catch (error) {
    await deleteOrphan(repos, origin);
    throw error;
  } finally {
    await deleteOrphan(repos, staging);
  }
}

function alreadyExists(error: unknown): boolean {
  return artifactsErrorCode(error) === "ALREADY_EXISTS";
}

/** Deletes a repo no project keeps, made by this call. A failure is logged, never thrown. */
async function deleteOrphan(repos: Repos, name: string): Promise<void> {
  await repos.delete(name).catch((error: unknown) => {
    console.error({ event: "project.orphan_repo", repo: name, error: String(error) });
  });
}
