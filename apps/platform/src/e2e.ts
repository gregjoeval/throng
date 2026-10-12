// The e2e suite's way into a deployed Worker (`scripts/e2e.ts`), under `/e2e/*`. The suite has no
// Access session, so it can't mint its first Throng token; it seeds an origin's `main` around the git
// proxy; it reads scoring runs and the journal back for timings; and it deletes everything a run
// made. Every project it makes is named with `E2E_PROJECT_PREFIX`, and these routes refuse any
// project or repo without it, so they can never reach a real project.

import { Hono } from "hono";
import type { Context } from "hono";
import { camelKeys } from "./casing.ts";
import { LOG_PREFIX } from "./logs.ts";
import { projectService } from "./projects.ts";
import type { Project } from "./projects.ts";
import { forkRepo, originRepo, parseRepoName } from "./repos.ts";
import type { Repos } from "./repos.ts";
import { mintToken, revokeToken } from "./tokens.ts";
import { userForEmail } from "./users.ts";
import type { Database, User } from "./users.ts";

/** The e2e suite's user. `.invalid` never resolves, so nothing is ever sent to it. */
export const E2E_EMAIL = "e2e@throng.invalid";
/** A second e2e user, for what the first can't do to its own attempts: posting a verdict, say. */
export const E2E_REVIEWER_EMAIL = "e2e-reviewer@throng.invalid";
/** Every e2e project id starts with this; a run adds its own prefix after it. */
export const E2E_PROJECT_PREFIX = "e2e";
/** Long enough for a whole e2e run. */
const E2E_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const ORIGIN_TOKEN_TTL_SECONDS = 60 * 60;
const PUSH_TOKEN_TTL_SECONDS = 60 * 60;
const FORK_READY_TIMEOUT_MS = 60_000;
/** R2 deletes at most this many keys per call. */
const R2_DELETE_BATCH = 1000;

/** The aliases the e2e routes mint tokens for: a plain lowercase name. */
const E2E_ALIAS = /^[a-z0-9-]{1,40}$/u;

/**
 * Mints a Throng token for the e2e user (or another, by `email`), under `alias` if given, creating the
 * user on first use.
 */
export async function e2eToken(
  db: Database,
  now: Date,
  email = E2E_EMAIL,
  alias: string | null = null,
): Promise<{ token: string; id: string; user: User }> {
  const user = await userForEmail(db, email);
  const { plaintext, token } = await mintToken(db, {
    userId: user.id,
    alias,
    ttlSeconds: E2E_TOKEN_TTL_SECONDS,
    now,
  });
  return { token: plaintext, id: token.id, user };
}

/**
 * Creates a project owned by the e2e user whose id and handle are both `id`, and returns a write
 * token for its origin. The git proxy refuses pushes to the origin's `main`, so the suite seeds it
 * straight through Artifacts with that token.
 */
export async function e2eProject(
  db: Database,
  repos: Repos,
  id: string,
): Promise<{ project: Project; remote: string; token: string }> {
  const user = await userForEmail(db, E2E_EMAIL);
  const project = await projectService({ db, repos, newId: () => id }).create({ user, alias: null }, { handle: id });
  const [origin, { token }] = await Promise.all([
    repos.get(originRepo(id)),
    repos.mintToken(originRepo(id), "write", ORIGIN_TOKEN_TTL_SECONDS),
  ]);
  return { project, remote: origin.remote, token };
}

/** Whether `name` is an e2e project id or a run's prefix of one. */
export function isE2eName(name: string): boolean {
  return name.startsWith(E2E_PROJECT_PREFIX) && /^[a-z0-9]+$/u.test(name);
}

/** Whether the repo `name` belongs to an e2e project. */
function e2eRepo(name: string): boolean {
  const parsed = parseRepoName(name);
  return parsed !== null && isE2eName(parsed.project);
}

/** The part of the logs R2 bucket cleanup needs. */
export interface LogBucket {
  list: (options: {
    prefix: string;
    cursor?: string;
  }) => Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete: (keys: string[]) => Promise<void>;
}

/** The project Durable Object's calls the e2e routes make. */
export interface E2eProjectStub {
  note: (kind: string, detail: Record<string, unknown>) => Promise<void> | void;
  journal: (since: number) => Promise<unknown>;
  /** Queues scoring of a commit pushed straight to an attempt's fork. */
  score: (project: string, attempt: string, sha: string) => Promise<unknown>;
  /** One scoring run, or null. */
  run: (id: number) => Promise<unknown>;
  /** Deletes all of the project's Durable Object storage. */
  destroy: () => Promise<void>;
}

export interface E2eDeps<E> {
  db: (env: E) => Database;
  repos: (env: E) => Repos;
  logs: (env: E) => LogBucket;
  project: (env: E, id: string) => E2eProjectStub;
  /** The bearer secret every route needs (the Worker's `SPIKE_TOKEN`). */
  secret: (env: E) => string;
}

/**
 * Deletes everything an e2e project made: its D1 row (nothing else in D1 refers to a project), its
 * Durable Object's storage, its logs in R2, and its repos.
 */
export async function deleteE2eProject<E>(deps: E2eDeps<E>, env: E, id: string): Promise<void> {
  if (!isE2eName(id)) throw new Error(`not an e2e project: ${id}`);
  const repos = deps.repos(env);
  const owner = await userForEmail(deps.db(env), E2E_EMAIL);
  await deps
    .db(env)
    .prepare("DELETE FROM projects WHERE id = ? AND owner_id = ? RETURNING id")
    .bind(id, owner.id)
    .first();
  await deps.project(env, id).destroy();
  await deleteLogs(deps.logs(env), `${LOG_PREFIX}${id}/`);
  const names = await repos.list(`${id}-`);
  await Promise.all(names.filter((name) => parseRepoName(name)?.project === id).map((name) => repos.delete(name)));
}

async function deleteLogs(logs: LogBucket, prefix: string): Promise<void> {
  // Listed in full first, so deleting never shifts a page still to be listed.
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await logs.list(cursor === undefined ? { prefix } : { prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) await logs.delete(keys.slice(i, i + R2_DELETE_BATCH));
}

/** The e2e project ids under `prefix`: those with a D1 row, and those with repos left. */
async function e2eProjectsUnder<E>(deps: E2eDeps<E>, env: E, prefix: string): Promise<string[]> {
  const owner = await userForEmail(deps.db(env), E2E_EMAIL);
  const { results } = await deps
    .db(env)
    .prepare("SELECT id FROM projects WHERE owner_id = ? AND substr(id, 1, ?) = ?")
    .bind(owner.id, prefix.length, prefix)
    .all<{ id: string }>();
  const fromRepos = (await deps.repos(env).list(prefix)).map((name) => parseRepoName(name)?.project);
  const ids = new Set([...results.map((r) => r.id), ...fromRepos]);
  return [...ids].filter((id): id is string => id !== undefined && id.startsWith(prefix)).toSorted();
}

/** The `/e2e/*` routes, behind the bearer secret. */
export function e2eRoutes<E extends object>(deps: E2eDeps<E>) {
  const app = new Hono<{ Bindings: E }>().basePath("/e2e");
  const refused = (c: Context<{ Bindings: E }>, what: string) =>
    c.json({ error: `${what} doesn't start with the e2e prefix ${E2E_PROJECT_PREFIX}` }, 400);

  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${deps.secret(c.env)}`) return c.text("Unauthorized", 401);
    await next();
  });
  app.use("/projects/:project/*", async (c, next) => {
    if (!isE2eName(c.req.param("project") ?? "")) return refused(c, "the project");
    await next();
  });
  app.use("/repos/:name/*", async (c, next) => {
    if (!e2eRepo(c.req.param("name") ?? "")) return refused(c, "the repo");
    await next();
  });

  /**
   * A Throng token for the e2e user, for the product API (`/api`) and the git proxy (`/git`). With
   * `?as=reviewer`, one for the second e2e user instead; with `?alias=claude`, one that acts under
   * that alias, as an agent's would.
   */
  app.post("/token", async (c) => {
    const as = c.req.query("as");
    if (as !== undefined && as !== "reviewer") return c.json({ error: `no e2e user ${as}` }, 400);
    const alias = c.req.query("alias") ?? null;
    if (alias !== null && !E2E_ALIAS.test(alias)) return c.json({ error: `not an e2e alias: ${alias}` }, 400);
    const email = as === "reviewer" ? E2E_REVIEWER_EMAIL : E2E_EMAIL;
    const { token, id, user } = await e2eToken(deps.db(c.env), new Date(), email, alias);
    return c.json({ token, id, user: { id: user.id, handle: user.handle } });
  });

  /** Revokes one of the e2e users' tokens: the run's own, when it ends. */
  app.delete("/tokens/:id", async (c) => {
    const db = deps.db(c.env);
    for (const email of [E2E_EMAIL, E2E_REVIEWER_EMAIL]) {
      const user = await userForEmail(db, email);
      const revoked = await revokeToken(db, { userId: user.id, id: c.req.param("id"), now: new Date() });
      if (revoked !== null) return c.json({ revoked: revoked.id });
    }
    return c.json({ error: "no such token" }, 404);
  });

  /**
   * Creates a real project owned by the e2e user, whose id and handle are both `:project`, and
   * returns a write token for its origin so the caller can push the fixture to `main`.
   */
  app.post("/projects/:project", async (c) => {
    const project = c.req.param("project");
    if (!isE2eName(project)) return refused(c, "the project");
    const began = Date.now();
    const made = await e2eProject(deps.db(c.env), deps.repos(c.env), project);
    const createMs = Date.now() - began;
    await deps.project(c.env, project).note("repoCreated", { project, createMs });
    return c.json({ remote: made.remote, token: made.token, createMs, owner: made.project.owner.handle });
  });

  /** Deletes everything one e2e project made. */
  app.delete("/projects/:project", async (c) => {
    const project = c.req.param("project");
    if (!isE2eName(project)) return refused(c, "the project");
    await deleteE2eProject(deps, c.env, project);
    return c.json({ deleted: [project] });
  });

  /** Deletes every e2e project under a run's prefix, including those a failed or cancelled run left. */
  app.delete("/projects", async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    if (!isE2eName(prefix)) return refused(c, "the prefix");
    const ids = await e2eProjectsUnder(deps, c.env, prefix);
    for (const id of ids) await deleteE2eProject(deps, c.env, id);
    return c.json({ deleted: ids });
  });

  /** Forks the origin for an attempt (`t1a1`), waits until the fork is usable, and mints a write token. */
  app.post("/projects/:project/attempts/:attempt", async (c) => {
    const project = c.req.param("project");
    const name = forkRepo(project, c.req.param("attempt"));
    const repos = deps.repos(c.env);
    const began = Date.now();
    await repos.fork(originRepo(project), name);
    const forkMs = Date.now() - began;

    let polls = 0;
    for (;;) {
      polls++;
      try {
        const fork = await repos.get(name);
        const readyMs = Date.now() - began;
        const { token } = await repos.mintToken(name, "write", PUSH_TOKEN_TTL_SECONDS);
        await deps.project(c.env, project).note("forkReady", { name, forkMs, readyMs, polls });
        return c.json({ remote: fork.remote, token, forkMs, readyMs, polls });
      } catch (error) {
        if (Date.now() - began > FORK_READY_TIMEOUT_MS) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  /**
   * Queues scoring of `sha`, which the caller pushed straight to an attempt's fork (`t1a1`). Pushes
   * through the git proxy queue scoring themselves; the suite's scoring scenarios bypass it.
   */
  app.post("/projects/:project/attempts/:attempt/score", async (c) => {
    const sha = c.req.query("sha");
    if (sha === undefined) return c.json({ error: "sha is required" }, 400);
    const project = c.req.param("project");
    return c.json(await deps.project(c.env, project).score(project, c.req.param("attempt"), sha));
  });

  /** One scoring run of the project, with its result once it is done. */
  app.get("/projects/:project/runs/:run", async (c) => {
    const run = await deps.project(c.env, c.req.param("project")).run(Number(c.req.param("run")));
    return run === null ? c.json({ error: "no such run" }, 404) : c.json(camelKeys(run));
  });

  app.get("/projects/:project/journal", async (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return c.json(await deps.project(c.env, c.req.param("project")).journal(since));
  });

  /** Names of the repos starting with `prefix`, so a run can find what it created. */
  app.get("/repos", async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    if (!isE2eName(prefix)) return refused(c, "the prefix");
    return c.json(await deps.repos(c.env).list(prefix));
  });

  /** Head of a repo's branch, read through the binding (no clone). */
  app.get("/repos/:name/head", async (c) => {
    const ref = c.req.query("ref") ?? "main";
    const [head] = await deps.repos(c.env).listCommits(c.req.param("name"), { ref, limit: 1 });
    return c.json({ sha: head?.hash ?? null, message: head?.message ?? null });
  });

  app.get("/repos/:name/log", async (c) => {
    const ref = c.req.query("ref") ?? "main";
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    return c.json(await deps.repos(c.env).listCommits(c.req.param("name"), { ref, limit }));
  });

  /**
   * Copies a ref between repos the way closing and reopening an attempt does (`Repos.copyRef`), so
   * the suite can check the Worker-side git client against real Artifacts.
   */
  app.post("/repos/:name/copy-ref", async (c) => {
    const [fromRef, to, toRef] = [c.req.query("fromRef"), c.req.query("to"), c.req.query("toRef")];
    if (fromRef === undefined || to === undefined || toRef === undefined) {
      return c.json({ error: "fromRef, to and toRef are required" }, 400);
    }
    if (!e2eRepo(to)) return refused(c, "the target repo");
    const sha = await deps.repos(c.env).copyRef({ from: c.req.param("name"), fromRef, to, toRef });
    return c.json({ sha });
  });

  return app;
}
