// The Follow Workflow's steps against fake bindings: it claims the push, runs the follow script in
// its trusted container, tears it down and reports. `cloudflare:workers` and the Artifacts binding
// are stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { FollowOutcome, FollowParams } from "../src/follows.ts";
import { RESULT_PREFIX } from "../src/scripts.ts";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async (_name: string, scope: string) => ({ token: `t-${scope}`, scope, expiresAt: "" }),
  }),
}));

// Imported by a computed path: the module is Worker code, which this project's Node typecheck can't
// follow (`cloudflare:workers`), so it is typed here by what the test calls.
const WORKFLOW_MODULE = "../src/follow-workflow.ts";
const { FollowWorkflow } = (await import(WORKFLOW_MODULE)) as {
  FollowWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<FollowOutcome | null> };
};

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
  const reported: [number, FollowOutcome][] = [];
  const env = {
    SANDBOX: {
      getByName: (name: string) => ({
        run: async (script: string) => {
          events.push(`run ${name}`);
          scripts.push(script);
          return { exitCode: 0, stdout: `${RESULT_PREFIX}${JSON.stringify(MERGED)}\n`, stderr: "" };
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
  const step = { do: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => Promise<unknown>)() };
  const outcome = await new FollowWorkflow({}, env).run({ payload: params, instanceId: "abc123-t1a2-follow-7" }, step);
  return { events, scripts, reported, outcome };
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

  it("runs and reports nothing when its claim is refused", async () => {
    const { events, outcome } = await follow(false);
    expect(outcome).toBeNull();
    expect(events).toEqual(["claim 7", "destroy abc123-t1a2-follow-7/follow"]);
  });
});
