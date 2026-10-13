// The Landing Workflow's steps against fake bindings: which containers it runs and destroys, and
// when, and the size and access the `check` container starts with. `cloudflare:workers` and the
// Artifacts binding are stubbed; each step runs once.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../src/config.ts";
import type { SandboxSize } from "../src/config.ts";
import type { LandingOutcome, LandingParams } from "../src/landing.ts";
import { MISSING_LOG_EXIT } from "../src/logs.ts";
import type { OutboundAccess } from "../src/network.ts";
import { NPMRC_PATH } from "../src/npmrc.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { PASSED, result, runOnce } from "./support/workflow-runs.ts";

/** Every `readFile` the landing makes, the files each `repo@ref` holds by path, and `main`'s sha. */
const artifacts = vi.hoisted(() => ({
  reads: [] as { repo: string; ref: string; path: string }[],
  files: new Map<string, Record<string, string>>(),
  main: "b".repeat(40),
}));

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async () => ({ token: "t", scope: "read", expiresAt: "" }),
    listCommits: async (repo: string) => (repo === "abc123-main" ? [{ hash: artifacts.main }] : []),
    readFile: async (repo: string, { ref, path }: { ref: string; path: string }) => {
      artifacts.reads.push({ repo, ref, path });
      const text = artifacts.files.get(`${repo}@${ref}`)?.[path];
      return text === undefined ? null : new Blob([text]);
    },
  }),
}));

const { LandingWorkflow } = await importWorkerModule<{
  LandingWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<LandingOutcome | null> };
}>("landing-workflow");

const HEAD = "a".repeat(40);
const MAIN = artifacts.main;
/** Where the origin's `main` is read: at its sha. */
const ORIGIN_MAIN = `abc123-main@${MAIN}`;
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

/** A merged tree's config with one required check. */
const REQUIRED = "checks:\n  - { name: test, command: npm test }\n";

beforeEach(() => {
  artifacts.reads.length = 0;
  artifacts.files.clear();
  // Only the origin's `main` has a config: it sets the Sandbox size.
  artifacts.files.set(ORIGIN_MAIN, { [CONFIG_PATH]: "sandbox: { size: standard-2 }\n" });
});

/**
 * Runs a landing whose merge is clean, the merged tree holding `config` (none by default), recording
 * each container's runs and destroys, the size each script, and each log read, asked its container
 * for, and the access each of the `check` container's runs asked for.
 */
async function land(config: string | null = null): Promise<{
  events: string[];
  sizes: [string | undefined, SandboxSize][];
  logReads: [string | undefined, SandboxSize][];
  checkAccess: OutboundAccess[];
  outcome: LandingOutcome | null;
}> {
  const events: string[] = [];
  const sizes: [string | undefined, SandboxSize][] = [];
  const logReads: [string | undefined, SandboxSize][] = [];
  const checkAccess: OutboundAccess[] = [];
  const sandbox = (name: string) => {
    const role = name.split("/").at(-1);
    return {
      run: async (script: string, { size, access }: { size: SandboxSize; access: OutboundAccess }) => {
        // Reading a log back: the step wrote none.
        if (script.includes("f=logs/")) {
          logReads.push([role, size]);
          return { exitCode: MISSING_LOG_EXIT, stdout: "", stderr: "" };
        }
        sizes.push([role, size]);
        events.push(`run ${role}`);
        if (role !== "check") return result({ kind: "landed", sha: MERGE });
        checkAccess.push(access);
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
  return { events, sizes, logReads, checkAccess, outcome };
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
    const merged = `sandbox: { size: standard-4 }\n${REQUIRED}`;
    const { events, sizes, outcome } = await land(merged);
    expect(outcome).toEqual({ kind: "landed", sha: MERGE });
    expect(events.filter((e) => e === "run check")).toHaveLength(2);
    expect(sizes.filter(([role]) => role === "check").map(([, size]) => size)).toEqual(["standard-2", "standard-2"]);
    expect(sizes.filter(([role]) => role === "land")).toEqual([["land", "lite"]]);
  });

  it("reads the retest's logs back at lite, so a lost container isn't restarted at the project's size", async () => {
    const { logReads } = await land(REQUIRED);
    expect(logReads).toEqual([["check", "lite"]]);
  });

  it("gives the check container main's .npmrc registries, for both the conflict check and the retest", async () => {
    artifacts.files.set(ORIGIN_MAIN, { [NPMRC_PATH]: "@acme:registry=https://npm.acme.dev/\n" });
    artifacts.files.set("abc123-t1a1@main", { [NPMRC_PATH]: "registry=https://evil.example.com/\n" });
    const { outcome, checkAccess } = await land(REQUIRED);
    expect(outcome).toEqual({ kind: "landed", sha: MERGE });
    // The conflict check starts the container, so its access is what the retest runs under.
    expect(checkAccess.map((access) => access.registries)).toEqual([
      ["registry.npmjs.org", "npm.acme.dev"],
      ["registry.npmjs.org", "npm.acme.dev"],
    ]);
    // Read from the origin's main only: never the fork, and never the merged tree.
    expect(artifacts.reads.filter((read) => read.path === NPMRC_PATH)).toEqual([
      { repo: "abc123-main", ref: MAIN, path: NPMRC_PATH },
    ]);
  });

  it("gives the check container main's network.allow, for both the conflict check and the retest, never the merged tree's", async () => {
    artifacts.files.set(ORIGIN_MAIN, { [CONFIG_PATH]: "network: { allow: [api.example.com] }\n" });
    artifacts.files.set("abc123-t1a1@main", { [CONFIG_PATH]: "network: { allow: [fork.example.com] }\n" });
    const merged = `network: { allow: [evil.example.com] }\n${REQUIRED}`;
    const { outcome, checkAccess } = await land(merged);
    expect(outcome).toEqual({ kind: "landed", sha: MERGE });
    expect(checkAccess.map((access) => access.allow)).toEqual([["api.example.com"], ["api.example.com"]]);
  });

  it("reads main's config and .npmrc once each, from the one commit main is at", async () => {
    artifacts.files.set(ORIGIN_MAIN, {
      [CONFIG_PATH]: "sandbox: { size: standard-2 }\nnetwork: { allow: [api.example.com] }\n",
      [NPMRC_PATH]: "@acme:registry=https://npm.acme.dev/\n",
    });
    const { checkAccess, sizes } = await land(REQUIRED);
    expect(artifacts.reads).toEqual([
      { repo: "abc123-main", ref: MAIN, path: CONFIG_PATH },
      { repo: "abc123-main", ref: MAIN, path: NPMRC_PATH },
    ]);
    expect(sizes.filter(([role]) => role === "check").map(([, size]) => size)).toEqual(["standard-2", "standard-2"]);
    expect(checkAccess.at(-1)).toMatchObject({
      registries: ["registry.npmjs.org", "npm.acme.dev"],
      allow: ["api.example.com"],
    });
  });

  it("gives the check container only the npm registry when main has no .npmrc", async () => {
    const { checkAccess } = await land();
    expect(checkAccess.map((access) => access.registries)).toEqual([["registry.npmjs.org"]]);
  });
});
