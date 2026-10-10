import { WorkerEntrypoint } from "cloudflare:workers";
import type { ApiOptions } from "./api";
import { publicApp, webApp } from "./app";
import { reposFor } from "./artifacts";
import { gitAuth } from "./auth";
import { forkRepo, originRepo } from "./repos";

export { ProjectCoordinator } from "./project";
export { CheckSandbox, OutboundAuth } from "./sandbox";
export { CheckWorkflow, IngestWorkflow } from "./workflows";

const FORK_READY_TIMEOUT_MS = 60_000;
const PUSH_TOKEN_TTL_SECONDS = 60 * 60;

// The API is typed against the bindings it reads; at runtime its env is this Worker's.
const apiOptions: ApiOptions = {
  repos: (env) => reposFor(env as Env),
  tasks: (env) => (projectId) => ({
    call: (method, args) => (env as Env).PROJECT.getByName(projectId).tasks(method, args),
  }),
};

// The public hostname. It refuses forwarded identities; see `./app.ts`.
const app = publicApp<Env>(apiOptions);

const web = webApp<Env>(apiOptions);

/**
 * throng-web's way in: its `PLATFORM` service binding targets this entrypoint by name. Named
 * entrypoints are reachable only through bindings, never the public hostname, so this is the one
 * place a forwarded Access identity is trusted. It serves `/api` only.
 */
export class WebEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return web.fetch(request, this.env, this.ctx);
  }
}

// The git proxy lands later; every `/git/*` request already needs a Throng token.
app.use("/git/*", gitAuth());

// Spike-only control plane; the real product API is backlog.
app.use("/spike/*", async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${c.env.SPIKE_TOKEN}`) return c.text("Unauthorized", 401);
  await next();
});

/** Creates the project's origin and returns a write token so the caller can push the fixture. */
app.post("/spike/projects/:project", async (c) => {
  const project = c.req.param("project");
  const began = Date.now();
  const repo = await reposFor(c.env).create(originRepo(project));
  const createMs = Date.now() - began;
  await c.env.PROJECT.getByName(project).note("repo-created", { project, createMs });
  return c.json({ remote: repo.remote, token: repo.token, createMs });
});

/** Forks the origin for an attempt (`t1a1`), waits until the fork is usable, and mints a write token. */
app.post("/spike/projects/:project/attempts/:attempt", async (c) => {
  const project = c.req.param("project");
  const name = forkRepo(project, c.req.param("attempt"));
  const repos = reposFor(c.env);
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
      await c.env.PROJECT.getByName(project).note("fork-ready", { name, forkMs, readyMs, polls });
      return c.json({ remote: fork.remote, token, forkMs, readyMs, polls });
    } catch (cause) {
      if (Date.now() - began > FORK_READY_TIMEOUT_MS) throw cause;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

app.get("/spike/projects/:project/journal", async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  return c.json(await c.env.PROJECT.getByName(c.req.param("project")).journal(since));
});

/** Head of a repo's branch, read through the binding (no clone). */
app.get("/spike/repos/:name/head", async (c) => {
  const ref = c.req.query("ref") ?? "main";
  const [head] = await reposFor(c.env).listCommits(c.req.param("name"), { ref, limit: 1 });
  return c.json({ sha: head?.hash ?? null, message: head?.message ?? null });
});

// Read-only views a file/commit browser could use. All through the binding; nothing is cloned.

app.get("/spike/repos/:name/log", async (c) => {
  const ref = c.req.query("ref") ?? "main";
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  return c.json(await reposFor(c.env).listCommits(c.req.param("name"), { ref, limit }));
});

/** Directory listing at `path` (repo root by default) for a ref. */
app.get("/spike/repos/:name/tree", async (c) => {
  const ref = c.req.query("ref") ?? "main";
  const path = c.req.query("path") ?? "";
  const tree = await reposFor(c.env).readTree(c.req.param("name"), { ref, path });
  if (tree === null) return c.json({ error: `no directory ${path || "/"} at ${ref}` }, 404);
  return c.json({ ref, ...tree });
});

app.get("/spike/repos/:name/file", async (c) => {
  const path = c.req.query("path");
  if (path === undefined) return c.json({ error: "path is required" }, 400);
  const blob = await reposFor(c.env).readFile(c.req.param("name"), { ref: c.req.query("ref") ?? "main", path });
  if (blob === null) return c.json({ error: `no file ${path}` }, 404);
  return new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } });
});

app.post("/spike/repos/:name/read-token", async (c) => {
  const { token } = await reposFor(c.env).mintToken(c.req.param("name"), "read", PUSH_TOKEN_TTL_SECONDS);
  return c.json({ token });
});

/** Names of the repos starting with `prefix`, so a spike run can find everything it created. */
app.get("/spike/repos", async (c) => {
  const prefix = c.req.query("prefix") ?? "";
  if (prefix === "") return c.json({ error: "prefix is required" }, 400);
  return c.json(await reposFor(c.env).list(prefix));
});

app.delete("/spike/repos/:name", async (c) => {
  return c.json({ deleted: await reposFor(c.env).delete(c.req.param("name")) });
});

app.onError((err, c) => {
  console.error({ event: "http.error", path: c.req.path, error: String(err), code: (err as { code?: string }).code });
  return c.json({ error: String(err), code: (err as { code?: string }).code ?? null }, 500);
});

export default app;
