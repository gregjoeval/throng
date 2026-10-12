// The Landing Workflow's steps against fake bindings: which containers it runs and destroys, and
// when. `cloudflare:workers` and the Artifacts binding are stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { LandingOutcome, LandingParams } from "../src/landing.ts";
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
    mintToken: async () => ({ token: "t", scope: "read", expiresAt: "" }),
  }),
}));

// Imported by a computed path: the module is Worker code, which this project's Node typecheck can't
// follow (`cloudflare:workers`), so it is typed here by what the test calls.
const WORKFLOW_MODULE = "../src/landing-workflow.ts";
const { LandingWorkflow } = (await import(WORKFLOW_MODULE)) as {
  LandingWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<LandingOutcome | null> };
};

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const TREE = "c".repeat(40);
const MERGE = "d".repeat(40);

const params: LandingParams = {
  project: "abc123",
  landing: 1,
  task: 1,
  attempt: 1,
  title: "Do it",
  head: HEAD,
  approver: { user: "ada00001", alias: null },
  coAuthors: [],
  startedAt: 1_700_000_000_000,
};

const result = (value: unknown) => ({ exitCode: 0, stdout: `${RESULT_PREFIX}${JSON.stringify(value)}\n`, stderr: "" });

/** Runs a landing whose merge is clean with no config, recording each container's runs and destroys. */
async function land(): Promise<{ events: string[]; outcome: LandingOutcome | null }> {
  const events: string[] = [];
  const sandbox = (name: string) => {
    const role = name.split("/").at(-1);
    return {
      run: async () => {
        events.push(`run ${role}`);
        return role === "check"
          ? result({ main: MAIN, clean: true, base: MAIN, output: `${TREE}\0`, remerges: [], config: null })
          : result({ kind: "landed", sha: MERGE });
      },
      destroy: async () => void events.push(`destroy ${role}`),
    };
  };
  const env = {
    SANDBOX: { getByName: sandbox },
    PROJECT: {
      getByName: () => ({
        claimLandingPush: async () => true,
        landingFinished: async () => void events.push("report"),
      }),
    },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: "ada00001", handle: "ada" }] }) }) }) },
  };
  const step = { do: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => Promise<unknown>)() };
  const workflow = new LandingWorkflow({}, env);
  const outcome = await workflow.run({ payload: params, instanceId: "abc123-t1a1-landing-1" }, step);
  return { events, outcome };
}

describe("LandingWorkflow", () => {
  it("destroys the check container before the land step, so one landing container is alive at a time", async () => {
    const { events, outcome } = await land();
    expect(outcome).toEqual({ kind: "landed", sha: MERGE });
    expect(events.indexOf("destroy check")).toBeGreaterThan(events.indexOf("run check"));
    expect(events.indexOf("destroy check")).toBeLessThan(events.indexOf("run land"));
    // Teardown still destroys both at the end, then the outcome is reported.
    expect(events.slice(-3)).toEqual(["destroy check", "destroy land", "report"]);
  });
});
