import { WorkerEntrypoint } from "cloudflare:workers";
import type { ApiOptions } from "./api";
import { publicApp, webApp } from "./app";
import { reposFor } from "./artifacts";
import { walk } from "./browse";
import { gitRoutes, type GitProxyOptions } from "./git-proxy";
import { e2eRoutes } from "./e2e";

export { ProjectCoordinator } from "./project";
export { RunSandbox, OutboundAuth } from "./sandbox";
export { ScoringWorkflow } from "./workflows";
export { LandingWorkflow } from "./landing-workflow";

const PUSH_TOKEN_TTL_SECONDS = 60 * 60;

// The API and the git proxy are typed against the bindings they read; at runtime their env is this Worker's.
const apiOptions: GitProxyOptions & Pick<ApiOptions, "logs"> = {
  repos: (env) => reposFor(env as Env),
  tasks: (env) => (projectId) => ({
    call: (method, args) => (env as Env).PROJECT.getByName(projectId).tasks(method, args),
  }),
  logs: (env) => (env as Env).LOGS,
};

// The public hostname. It refuses forwarded identities; see `./app.ts`.
const app = publicApp<Env>(apiOptions);
app.route("/git", gitRoutes(apiOptions));

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

// The e2e suite's routes (`scripts/e2e.ts`). Their bearer secret keeps its old name, SPIKE_TOKEN, so
// no deployment or CI secret has to change.
app.route(
  "/",
  e2eRoutes<Env>({
    db: (env) => env.DB,
    repos: (env) => reposFor(env),
    logs: (env) => ({
      list: (options) => env.LOGS.list(options),
      delete: (keys) => env.LOGS.delete(keys),
    }),
    project: (env, id) => {
      const stub = env.PROJECT.getByName(id);
      return {
        note: (kind, detail) => stub.note(kind, detail),
        journal: (since) => stub.journal(since),
        score: (project, attempt, sha) => stub.spikeScore(project, attempt, sha),
        run: (run) => stub.spikeRun(run),
        destroy: () => stub.destroy(),
      };
    },
    secret: (env) => env.SPIKE_TOKEN,
  }),
);

// Spike-only control plane, not used by the e2e suite.
app.use("/spike/*", async (c, next) => {
  if (c.req.header("Authorization") !== `Bearer ${c.env.SPIKE_TOKEN}`) return c.text("Unauthorized", 401);
  await next();
});

// Read-only views a file/commit browser could use. All through the binding; nothing is cloned.

/** Directory listing at `path` (repo root by default) for a ref. */
app.get("/spike/repos/:name/tree", async (c) => {
  const ref = c.req.query("ref") ?? "main";
  const path = c.req.query("path") ?? "";
  const name = c.req.param("name");
  const repos = reposFor(c.env);
  const [head] = await repos.listCommits(name, { ref, limit: 1 });
  const dir = head === undefined ? null : await walk(repos, name, head.treeHash, path);
  const entries = dir?.type === "tree" ? await repos.readTree(name, dir.hash) : null;
  if (head === undefined || dir === null || entries === null) {
    return c.json({ error: `no directory ${path || "/"} at ${ref}` }, 404);
  }
  return c.json({ ref, commit: head.hash, tree: dir.hash, entries });
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

app.onError((err, c) => {
  console.error({ event: "http.error", path: c.req.path, error: String(err), code: (err as { code?: string }).code });
  return c.json({ error: String(err), code: (err as { code?: string }).code ?? null }, 500);
});

export default app;
