// The Scoring Workflow's steps against fake bindings: the size each container starts at, and the
// size its stored logs record. `cloudflare:workers`, the Artifacts binding, the base lookup and the
// preview Workers are stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import type { ScoringOutcome, ScoringParams } from "../src/scoring.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { PASSED, result, runOnce } from "./support/workflow-runs.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

/** The config on the origin's `main`, and on the attempt's own head, which scoring must never read. */
const MAIN_CONFIG = "sandbox: { size: standard-2 }\npreview: {}\nchecks:\n  - { name: test, command: npm test }\n";
const HEAD_CONFIG = "sandbox: { size: standard-4 }\npreview: {}\nchecks:\n  - { name: test, command: npm test }\n";

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async () => ({ token: "t", scope: "read", expiresAt: "" }),
    readFile: async (repo: string) => ({ text: async () => (repo === "abc123-main" ? MAIN_CONFIG : HEAD_CONFIG) }),
  }),
}));
vi.mock("../src/base", () => ({ attemptBase: async () => null }));
vi.mock("../src/preview-workers", () => ({ previewWorkersFor: () => ({ ensure: async () => {} }) }));

const { ScoringWorkflow } = await importWorkerModule<{
  ScoringWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<ScoringOutcome> };
}>("workflows");

const params: ScoringParams = { project: "abc123", attempt: "t1a1", sha: "a".repeat(40), run: 7 };

/** Scores a head whose one check passes and whose Preview deploys, recording sizes and stored logs. */
async function score() {
  const sizes: [string | undefined, SandboxSize][] = [];
  const stored = new Map<string, string>();
  const env = {
    CF_ACCOUNT_ID: "acct",
    SANDBOX: {
      getByName: (name: string) => {
        const role = name.split("/").at(-1);
        return {
          run: async (script: string, { size }: { size: SandboxSize }) => {
            sizes.push([role, size]);
            if (script.includes("f=logs/")) return { exitCode: 0, stdout: `${role} log\n`, stderr: "" };
            return role === "score" ? result(PASSED) : result({ ok: true, url: "https://preview.invalid" });
          },
          destroy: async () => {},
        };
      },
    },
    PROJECT: {
      getByName: () => ({ definitionsOf: async () => ({ checks: [], metrics: [] }), scoringFinished: async () => {} }),
    },
    LOGS: { put: async (key: string, value: string) => void stored.set(key.split("/").at(-1) ?? key, value) },
  };
  const outcome = await new ScoringWorkflow({}, env).run({ payload: params, instanceId: "abc123-t1a1-7" }, runOnce);
  return { sizes, stored, outcome };
}

describe("ScoringWorkflow", () => {
  it("starts the score and preview containers at main's Sandbox size, never the head's", async () => {
    const { sizes, outcome } = await score();
    expect(outcome.status).toBe("done");
    expect(new Set(sizes.map(([role]) => role))).toEqual(new Set(["score", "preview"]));
    expect(new Set(sizes.map(([, size]) => size))).toEqual(new Set(["standard-2"]));
  });

  it("records the size in each log it stores", async () => {
    const { stored, outcome } = await score();
    expect(outcome.status === "done" ? outcome.result.logs : []).toEqual(["test", "preview.deploy"]);
    expect(stored.get("test.log")).toBe("score log\n== throng ==\nsandbox: standard-2\n");
    expect(stored.get("preview.deploy.log")).toBe("preview log\n== throng ==\nsandbox: standard-2\n");
  });
});
