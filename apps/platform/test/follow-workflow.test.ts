// The Follow Workflow's steps against fake bindings: it claims the push, runs the follow script in
// its trusted container, tears it down and reports. `cloudflare:workers` and the Artifacts binding
// are stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import type { FollowOutcome, FollowParams } from "../src/follows.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { result, runOnce } from "./support/workflow-runs.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async (_name: string, scope: string) => ({ token: `t-${scope}`, scope, expiresAt: "" }),
  }),
}));

const { FollowWorkflow } = await importWorkerModule<{
  FollowWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<FollowOutcome | null> };
}>("follow-workflow");

const params: FollowParams = {
  project: "abc123",
  follow: 7,
  task: 1,
  attempt: 2,
  taskHead: "a".repeat(40),
  startedAt: 1_700_000_000_000,
};
const MERGED = { kind: "merged", before: "b".repeat(40), head: "c".repeat(40) } as const;

/** Runs a follow whose claim answers `claimed`, recording what each binding was asked. */
async function follow(claimed: boolean) {
  const events: string[] = [];
  const scripts: string[] = [];
  const sizes: SandboxSize[] = [];
  const reported: [number, FollowOutcome][] = [];
  const env = {
    SANDBOX: {
      getByName: (name: string) => ({
        run: async (script: string, { size }: { size: SandboxSize }) => {
          events.push(`run ${name}`);
          scripts.push(script);
          sizes.push(size);
          return result(MERGED);
        },
        destroy: async () => void events.push(`destroy ${name}`),
      }),
    },
    PROJECT: {
      getByName: () => ({
        claimFollowPush: async (id: number) => {
          events.push(`claim ${id}`);
          return claimed;
        },
        followFinished: async (id: number, outcome: FollowOutcome) => {
          events.push("report");
          reported.push([id, outcome]);
        },
      }),
    },
  };
  const outcome = await new FollowWorkflow({}, env).run(
    { payload: params, instanceId: "abc123-t1a2-follow-7" },
    runOnce,
  );
  return { events, scripts, sizes, reported, outcome };
}

describe("FollowWorkflow", () => {
  it("claims the push, merges in its own follow container with fork write, tears it down and reports", async () => {
    const { events, scripts, reported, outcome } = await follow(true);
    expect(outcome).toEqual(MERGED);
    expect(events).toEqual([
      "claim 7",
      "run abc123-t1a2-follow-7/follow",
      "destroy abc123-t1a2-follow-7/follow",
      "report",
    ]);
    expect(reported).toEqual([[7, MERGED]]);
    expect(scripts[0]).toContain("abc123-t1a2.git");
    expect(scripts[0]).toContain("Throng-Attempt: t1a2");
  });

  it("starts its trusted container at lite, whatever the project's Sandbox size", async () => {
    const { sizes } = await follow(true);
    expect(sizes).toEqual(["lite"]);
  });

  it("runs and reports nothing when its claim is refused", async () => {
    const { events, outcome } = await follow(false);
    expect(outcome).toBeNull();
    expect(events).toEqual(["claim 7", "destroy abc123-t1a2-follow-7/follow"]);
  });
});
