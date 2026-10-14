import { WorkerEntrypoint } from "cloudflare:workers";
import type { ApiOptions } from "./api";
import { publicApp, webApp } from "./app";
import { reposFor } from "./artifacts";
import { e2eRoutes } from "./e2e";
import { gitRoutes } from "./git-proxy";
import type { GitProxyOptions } from "./git-proxy";

export { ProjectCoordinator } from "./project";
export { RunSandbox, OutboundAuth } from "./sandbox";
export { PipelineWorkflow } from "./pipeline-workflow";
export { LandingWorkflow } from "./landing-workflow";
export { FollowWorkflow } from "./follow-workflow";

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

// The e2e suite's routes (`scripts/e2e.ts`), behind the `E2E_TOKEN` bearer secret.
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
        score: (project, attempt, sha) => stub.e2eScore(project, attempt, sha),
        run: (run) => stub.e2eRun(run),
        destroy: () => stub.destroy(),
      };
    },
    secret: (env) => env.E2E_TOKEN,
  }),
);

app.onError((err, c) => {
  console.error({ event: "http.error", path: c.req.path, error: String(err), code: (err as { code?: string }).code });
  return c.json({ error: String(err), code: (err as { code?: string }).code ?? null }, 500);
});

export default app;
