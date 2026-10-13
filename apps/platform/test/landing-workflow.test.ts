// The Landing Workflow's steps against fake bindings: which containers it runs and destroys, and
// when, and what the `check` container may reach. `cloudflare:workers` and the Artifacts binding are
// stubbed; each step runs once.

import { describe, expect, it, vi } from "vitest";
import type { LandingOutcome, LandingParams } from "../src/landing.ts";
import type { OutboundAccess } from "../src/network.ts";
import { NPMRC_PATH } from "../src/npmrc.ts";
import { RESULT_PREFIX } from "../src/scripts.ts";

/** Every `readFile` the landing makes, and the `.npmrc` each `repo@ref` holds. */
const artifacts = vi.hoisted(() => ({
  reads: [] as { repo: string; ref: string; path: string }[],
  npmrc: new Map<string, string>(),
}));

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
    readFile: async (repo: string, { ref, path }: { ref: string; path: string }) => {
      artifacts.reads.push({ repo, ref, path });
      const text = path === ".npmrc" ? artifacts.npmrc.get(`${repo}@${ref}`) : undefined;
      return text === undefined ? null : new Blob([text]);
    },
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
/** The retest's raw score when the merged tree's one required check passed. */
const RETEST_PASSED = {
  base: null,
  shortstat: "",
  builtinMs: 0,
  setupFailed: null,
  checks: [{ exit: 0, durationMs: 1, metrics: {} }],
};

/**
 * Runs a landing whose merge is clean, with the merged tree's `config` (none by default), recording
 * each container's runs and destroys, and the access each of the `check` container's runs asked for.
 */
async function land(
  config: string | null = null,
): Promise<{ events: string[]; outcome: LandingOutcome | null; checkAccess: OutboundAccess[] }> {
  const events: string[] = [];
  const checkAccess: OutboundAccess[] = [];
  const sandbox = (name: string) => {
    const role = name.split("/").at(-1);
    return {
      run: async (script: string, { access }: { access: OutboundAccess }) => {
        if (script.includes("f=logs/")) return { exitCode: 0, stdout: "log\n", stderr: "" };
        events.push(`run ${role}`);
        if (role !== "check") return result({ kind: "landed", sha: MERGE });
        checkAccess.push(access);
        return checkAccess.length === 1
          ? result({ main: MAIN, clean: true, base: MAIN, output: `${TREE}\0`, remerges: [], config })
          : result(RETEST_PASSED);
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
    LOGS: { put: async () => {} },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: "ada00001", handle: "ada" }] }) }) }) },
  };
  const step = { do: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => Promise<unknown>)() };
  const workflow = new LandingWorkflow({}, env);
  const outcome = await workflow.run({ payload: params, instanceId: "abc123-t1a1-landing-1" }, step);
  return { events, outcome, checkAccess };
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

  it("gives the check container main's .npmrc registries, for both the conflict check and the retest", async () => {
    artifacts.reads.length = 0;
    artifacts.npmrc.clear();
    artifacts.npmrc.set("abc123-main@main", "@acme:registry=https://npm.acme.dev/\n");
    artifacts.npmrc.set("abc123-t1a1@main", "registry=https://evil.example.com/\n");
    const required = "checks:\n  - { name: test, command: npm test }\n";
    const { outcome, checkAccess } = await land(required);
    expect(outcome).toEqual({ kind: "landed", sha: MERGE });
    // The conflict check starts the container, so its access is what the retest runs under.
    expect(checkAccess.map((access) => access.registries)).toEqual([
      ["registry.npmjs.org", "npm.acme.dev"],
      ["registry.npmjs.org", "npm.acme.dev"],
    ]);
    // Read from the origin's main only: never the fork, and never the merged tree.
    expect(artifacts.reads).toEqual([{ repo: "abc123-main", ref: "main", path: NPMRC_PATH }]);
  });

  it("gives the check container only the npm registry when main has no .npmrc", async () => {
    artifacts.npmrc.clear();
    const { checkAccess } = await land();
    expect(checkAccess.map((access) => access.registries)).toEqual([["registry.npmjs.org"]]);
  });
});
