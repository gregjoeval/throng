// The Scoring Workflow's steps against fake bindings: the size each container starts at, and the
// size its stored logs record. `cloudflare:workers`, the Artifacts binding and the base lookup are
// stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import type { ScoringOutcome, ScoringParams } from "../src/scoring.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { PASSED, result, runOnce } from "./support/workflow-runs.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

/** The config on the origin's `main`, and on the attempt's own head, which scoring must never read. */
const MAIN_CONFIG = "sandbox: { size: standard-2 }\nchecks:\n  - { name: test, command: npm test }\n";
const HEAD_CONFIG = "sandbox: { size: standard-4 }\nchecks:\n  - { name: test, command: npm test }\n";
/** What `main` holds for the scoring run under way. */
const configs = { main: MAIN_CONFIG };

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async () => ({ token: "t", scope: "read", expiresAt: "" }),
    // No commits to pin `main` to, so it's read as `main`; the `.npmrc` read gets the config, and adds nothing.
    listCommits: async () => [],
    readFile: async (repo: string) => ({ text: async () => (repo === "abc123-main" ? configs.main : HEAD_CONFIG) }),
  }),
}));
vi.mock("../src/base", () => ({ attemptBase: async () => null }));

const { ScoringWorkflow } = await importWorkerModule<{
  ScoringWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<ScoringOutcome> };
}>("workflows");

const params: ScoringParams = { project: "abc123", attempt: "t1a1", sha: "a".repeat(40), run: 7 };

/** A task definition whose check clashes with `main`'s, making the run's merged config invalid. */
const CLASHING = { checks: [{ name: "test", command: "npm test", timeoutMs: 1000, source: "task" }] };

/**
 * Scores a head whose one check passes, under `main`'s config and the
 * task's definitions, recording the size each script ran at (log reads apart) and the stored logs.
 */
async function score({ main = MAIN_CONFIG, definitions = {} }: { main?: string; definitions?: object } = {}) {
  configs.main = main;
  const sizes: [string | undefined, SandboxSize][] = [];
  const logReads: [string | undefined, SandboxSize][] = [];
  const stored = new Map<string, string>();
  const keys: string[] = [];
  const env = {
    SANDBOX: {
      getByName: (name: string) => {
        const role = name.split("/").at(-1);
        return {
          run: async (script: string, { size }: { size: SandboxSize }) => {
            if (script.includes("f=logs/")) {
              logReads.push([role, size]);
              return { exitCode: 0, stdout: `${role} log\n`, stderr: "" };
            }
            sizes.push([role, size]);
            return result(PASSED);
          },
          destroy: async () => {},
        };
      },
    },
    PROJECT: {
      getByName: () => ({
        definitionsOf: async () => ({ checks: [], metrics: [], ...definitions }),
        scoringFinished: async () => {},
      }),
    },
    LOGS: {
      put: async (key: string, value: string) => {
        keys.push(key);
        stored.set(key.split("/").at(-1) ?? key, value);
      },
    },
  };
  const outcome = await new ScoringWorkflow({}, env).run({ payload: params, instanceId: "abc123-t1a1-7" }, runOnce);
  return { sizes, logReads, stored, keys, outcome };
}

describe("ScoringWorkflow", () => {
  it("starts only the score container, at main's Sandbox size, never the head's", async () => {
    const { sizes, outcome } = await score();
    expect(outcome.status).toBe("done");
    expect(sizes).toEqual([["score", "standard-2"]]);
  });

  it("starts at main's Sandbox size when the task's definitions clash with main's config", async () => {
    const main = "sandbox: { size: lite }\nchecks:\n  - { name: test, command: npm test }\n";
    const { sizes, outcome } = await score({ main, definitions: CLASHING });
    expect(outcome.status === "done" ? outcome.result.gate : outcome.status).toBe("failed");
    expect(sizes).toEqual([["score", "lite"]]);
  });

  it("reads each log back at lite, so a lost container isn't restarted at the project's size", async () => {
    const { logReads } = await score();
    expect(logReads).toEqual([["score", "lite"]]);
  });

  it("stores each log under the run's line and id", async () => {
    const { keys } = await score();
    expect(keys).toEqual(["logs/abc123/t1a1/7/test.log"]);
  });

  it("records the size in each log it stores", async () => {
    const { stored, outcome } = await score();
    expect(outcome.status === "done" ? outcome.result.logs : []).toEqual(["test"]);
    expect(stored.get("test.log")).toBe("score log\n== throng ==\nsandbox: standard-2\n");
  });
});
