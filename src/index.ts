import { Hono } from "hono";
import { forkName } from "./events";

export { ProjectCoordinator } from "./project";
export { CheckSandbox, GitAuth } from "./sandbox";
export { CheckWorkflow, IngestWorkflow } from "./workflows";

const FORK_READY_TIMEOUT_MS = 60_000;
const PUSH_TOKEN_TTL_SECONDS = 60 * 60;

const app = new Hono<{ Bindings: Env }>();

// Spike-only control plane; the real product API is backlog.
app.use("/spike/*", async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${c.env.SPIKE_TOKEN}`) return c.text("Unauthorized", 401);
  await next();
});

/** Creates the canonical repo and returns a write token so the caller can push the fixture. */
app.post("/spike/projects/:project", async (c) => {
  const project = c.req.param("project");
  const began = Date.now();
  const repo = await c.env.ARTIFACTS.create(project, { setDefaultBranch: "main" });
  const createMs = Date.now() - began;
  await c.env.PROJECT.getByName(project).note("repo-created", { project, createMs });
  return c.json({ remote: repo.remote, token: repo.token, createMs });
});

/** Forks the canonical repo for an attempt, waits until the fork is usable, and mints a write token. */
app.post("/spike/projects/:project/attempts/:attempt", async (c) => {
  const project = c.req.param("project");
  const name = forkName(project, c.req.param("attempt"));
  const began = Date.now();
  {
    using canonical = await c.env.ARTIFACTS.get(project);
    await canonical.fork(name, { defaultBranchOnly: true });
  }
  const forkMs = Date.now() - began;

  let polls = 0;
  for (;;) {
    polls++;
    try {
      using fork = await c.env.ARTIFACTS.get(name);
      const info = await fork.info();
      const readyMs = Date.now() - began;
      const token = await fork.createToken("write", PUSH_TOKEN_TTL_SECONDS);
      await c.env.PROJECT.getByName(project).note("fork-ready", { name, forkMs, readyMs, polls });
      return c.json({ remote: info.remote, token: token.plaintext, forkMs, readyMs, polls });
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
  using repo = await c.env.ARTIFACTS.get(c.req.param("name"));
  const [head] = await repo.log({ ref: c.req.query("ref") ?? "main", limit: 1 });
  return c.json({ sha: head?.hash ?? null, message: head?.message ?? null });
});

app.post("/spike/repos/:name/read-token", async (c) => {
  using repo = await c.env.ARTIFACTS.get(c.req.param("name"));
  const token = await repo.createToken("read", PUSH_TOKEN_TTL_SECONDS);
  return c.json({ token: token.plaintext });
});

app.delete("/spike/repos/:name", async (c) => {
  return c.json({ deleted: await c.env.ARTIFACTS.delete(c.req.param("name")) });
});

app.onError((err, c) => {
  console.error({ event: "http.error", path: c.req.path, error: String(err), code: (err as { code?: string }).code });
  return c.json({ error: String(err), code: (err as { code?: string }).code ?? null }, 500);
});

export default app;
