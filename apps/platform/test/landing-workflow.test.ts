// The Landing Workflow's steps against fake bindings: which containers it runs and destroys, and
// when. `cloudflare:workers` and the Artifacts binding are stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import type { LandingOutcome, LandingParams } from "../src/landing.ts";
import { MISSING_LOG_EXIT } from "../src/logs.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { PASSED, result, runOnce } from "./support/workflow-runs.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async () => ({ token: "t", scope: "read", expiresAt: "" }),
    // Only the origin's `main` has a config: it sets the Sandbox size.
    readFile: async (repo: string, { ref }: { ref: string }) =>
      repo === "abc123-main" && ref === "main" ? { text: async () => "sandbox: { size: standard-2 }\n" } : null,
  }),
}));

const { LandingWorkflow } = await importWorkerModule<{
  LandingWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<LandingOutcome | null> };
}>("landing-workflow");

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

/**
 * Runs a landing whose merge is clean, the merged tree holding `config` (none by default), recording
 * each container's runs and destroys, and the size each script, and each log read, asked its
 * container for.
 */
async function land(config: string | null = null): Promise<{
  events: string[];
  sizes: [string | undefined, SandboxSize][];
  logReads: [string | undefined, SandboxSize][];
  outcome: LandingOutcome | null;
}> {
  const events: string[] = [];
  const sizes: [string | undefined, SandboxSize][] = [];
  const logReads: [string | undefined, SandboxSize][] = [];
  const sandbox = (name: string) => {
    const role = name.split("/").at(-1);
    return {
      run: async (script: string, { size }: { size: SandboxSize }) => {
        // Reading a log back: the step wrote none.
        if (script.includes("f=logs/")) {
          logReads.push([role, size]);
          return { exitCode: MISSING_LOG_EXIT, stdout: "", stderr: "" };
        }
        sizes.push([role, size]);
        events.push(`run ${role}`);
        if (role !== "check") return result({ kind: "landed", sha: MERGE });
        if (script.includes("THRONG_OUTPUT")) return result(PASSED);
        return result({ main: MAIN, clean: true, base: MAIN, output: `${TREE}\0`, remerges: [], config });
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
  const workflow = new LandingWorkflow({}, env);
  const outcome = await workflow.run({ payload: params, instanceId: "abc123-t1a1-landing-1" }, runOnce);
  return { events, sizes, logReads, outcome };
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

  it("starts the check container at main's Sandbox size, though the merged tree sets another, and land at lite", async () => {
    const merged = "sandbox: { size: standard-4 }\nchecks:\n  - { name: test, command: npm test }\n";
    const { events, sizes, outcome } = await land(merged);
    expect(outcome).toEqual({ kind: "landed", sha: MERGE });
    expect(events.filter((e) => e === "run check")).toHaveLength(2);
    expect(sizes.filter(([role]) => role === "check").map(([, size]) => size)).toEqual(["standard-2", "standard-2"]);
    expect(sizes.filter(([role]) => role === "land")).toEqual([["land", "lite"]]);
  });

  it("reads the retest's logs back at lite, so a lost container isn't restarted at the project's size", async () => {
    const { logReads } = await land("checks:\n  - { name: test, command: npm test }\n");
    expect(logReads).toEqual([["check", "lite"]]);
  });
});
