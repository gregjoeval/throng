// `cloudflare:workers` for Worker code under test in Node: each base class only keeps the `ctx` and
// `env` it was made with, as the runtime's do. Mock it with
// `vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"))`.

class Entrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const DurableObject = Entrypoint;
export const WorkerEntrypoint = Entrypoint;
export const WorkflowEntrypoint = Entrypoint;
