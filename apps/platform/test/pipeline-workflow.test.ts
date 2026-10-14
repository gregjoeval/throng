// The Pipeline Workflow's steps against fake bindings: which containers start, from what, with what
// grants and variables; how setups, `after` and the snapshot's fallback decide what runs; and what
// it reports. `cloudflare:workers`, the Artifacts binding and the base lookup are stubbed. Each
// container's script is answered by what the test says that setup or check does.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import type { OutboundAccess } from "../src/network.ts";
import type { RunOutcome } from "../src/run-outcome.ts";
import type { PipelineParams, RunReport } from "../src/scoring.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { result } from "./support/workflow-runs.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

/** The config on the origin's `main` for the run under way. */
const configs = { main: "" };

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async (name: string, access: string) => ({ token: `${access}:${name}`, scope: access, expiresAt: "" }),
    // No commits to pin `main` to, so it's read as `main`; the `.npmrc` read gets the config, and adds nothing.
    listCommits: async () => [],
    readFile: async (repo: string) => ({ text: async () => (repo === "abc123-main" ? configs.main : "") }),
  }),
}));
vi.mock("../src/base", () => ({ attemptBase: async () => null }));

interface Snapshot {
  id: string;
  size: number;
}

interface SandboxNamespace {
  getByName: (name: string) => { destroy: () => Promise<void>; releaseSnapshot: () => void };
}

const { PipelineWorkflow, teardownPipeline } = await importWorkerModule<{
  PipelineWorkflow: new (ctx: unknown, env: unknown) => { run: (event: unknown, step: unknown) => Promise<RunReport> };
  teardownPipeline: (sandboxes: SandboxNamespace, instanceId: string, containers: readonly string[]) => Promise<void>;
}>("pipeline-workflow");

const INSTANCE = "abc123-t1a1-7";
const params: PipelineParams = { project: "abc123", line: "t1a1", sha: "a".repeat(40), run: 7 };
const SNAPSHOT: Snapshot = { id: "snap-1", size: 1000 };

/** A config with two setups and four checks: `lint` and `test` wait for nothing, `build` for both, `smoke` for `build`. */
const CONFIG = `sandbox: { size: standard-2 }
setup:
  - { name: deps, command: npm ci }
  - { name: gen, command: npm run gen }
checks:
  - { name: lint, command: npm run lint }
  - { name: test, command: npm test }
  - { name: build, command: npm run build, after: [lint, test] }
  - { name: smoke, command: npm run smoke, after: build }
`;

/** What a fake run's containers do: each setup's and check's exit, and how the snapshot behaves. */
interface Behaviour {
  config?: string;
  setups?: Record<string, number>;
  checks?: Record<string, number>;
  /** What `snapshot()` gives: a snapshot, null (as under `wrangler dev`) or an error. */
  snapshot?: Snapshot | null | Error;
  /** How many restores fail before one works, per container. */
  failedRestores?: number;
  /** A check whose container fails as infrastructure on every try. */
  broken?: string;
  /** The params the Workflow was started with; a run started by the Scoring Workflow's code named its line `attempt`. */
  payload?: unknown;
}

interface Started {
  /** How the container came up: restored from a snapshot, or from the image. */
  from: "snapshot" | "image";
  access: OutboundAccess;
  size: SandboxSize;
  env: Record<string, string> | undefined;
}

/** Runs the Workflow against fake bindings, recording each container's start, the order things happened and the report. */
async function pipeline(behaviour: Behaviour = {}) {
  configs.main = behaviour.config ?? CONFIG;
  const started = new Map<string, Started>();
  const events: string[] = [];
  const restores = new Map<string, number>();
  const stored = new Map<string, string>();
  const running = new Set<string>();
  let planned: string[] | null = null;
  let report: RunReport | null = null;
  const env = {
    SANDBOX: {
      getByName: (name: string) => {
        const container = name.slice(INSTANCE.length + 1);
        return {
          restore: async (snapshot: Snapshot) => {
            const tries = (restores.get(container) ?? 0) + 1;
            restores.set(container, tries);
            events.push(`restore ${container} ${snapshot.id}`);
            if (tries <= (behaviour.failedRestores ?? 0)) return false;
            running.add(container);
            started.set(container, { from: "snapshot", access: {} as OutboundAccess, size: "lite", env: undefined });
            return true;
          },
          run: async (
            script: string,
            options: { access: OutboundAccess; size: SandboxSize; env?: Record<string, string> },
          ) => {
            if (script.includes("f=logs/")) {
              const log = /f=logs\/([^\n]+)\.log/u.exec(script)?.[1] ?? "";
              return { exitCode: 0, stdout: `${container} ${log}\n`, stderr: "" };
            }
            const from = started.get(container)?.from ?? "image";
            started.set(container, { from, access: options.access, size: options.size, env: options.env });
            running.add(container);
            events.push(`run ${container}`);
            if (container === "setup") {
              let failed = false;
              const setups = setupNamesOf(configs.main).map((setup) => {
                if (failed) return { exit: null, durationMs: 0 };
                const exit = behaviour.setups?.[setup] ?? 0;
                failed = exit !== 0;
                return { exit, durationMs: 5 };
              });
              return result({ base: null, shortstat: " 1 file changed, 1 insertion(+)", builtinMs: 1, setups });
            }
            const check = container.slice("check:".length);
            if (check === behaviour.broken) return { exitCode: 11, stdout: "", stderr: "checkout failed" };
            return result({
              exit: behaviour.checks?.[check] ?? 0,
              durationMs: 3,
              metrics: {},
              setupsRerun: from === "image",
            });
          },
          snapshot: async () => {
            events.push(`snapshot ${container}`);
            if (behaviour.snapshot instanceof Error) throw behaviour.snapshot;
            return behaviour.snapshot === undefined ? SNAPSHOT : behaviour.snapshot;
          },
          releaseSnapshot: () => void events.push(`release ${container}`),
          destroy: async () => {
            if (running.delete(container)) events.push(`destroy ${container}`);
          },
        };
      },
    },
    PROJECT: {
      getByName: () => ({
        definitionsOf: async () => ({ checks: [], metrics: [] }),
        pipelinePlanned: async (_run: number, containers: string[]) => {
          planned = containers;
          events.push("plan");
        },
        pipelineFinished: async (_run: number, finished: RunReport) => {
          report = finished;
          events.push("report");
        },
      }),
    },
    LOGS: {
      put: async (key: string, value: string) => void stored.set(key, value),
    },
  };
  const returned = await new PipelineWorkflow({}, env).run(
    { payload: behaviour.payload ?? params, instanceId: INSTANCE },
    { do: stepDo },
  );
  return { started, events, stored, planned: planned as string[] | null, report: report as RunReport | null, returned };
}

/** The setups' names in a config, in order. */
function setupNamesOf(config: string): string[] {
  const setup = /setup:\n((?: {2}- .*\n)+)/u.exec(config)?.[1] ?? "";
  return [...setup.matchAll(/name: (\w+)/gu)].map((m) => m[1] ?? "");
}

/** A step that runs `fn`, trying again on failure up to its config's retry limit, as Workflows does. */
async function stepDo(_name: string, ...rest: unknown[]): Promise<unknown> {
  const fn = rest.at(-1) as () => Promise<unknown>;
  const retries = rest.length > 1 ? ((rest[0] as { retries?: { limit: number } }).retries?.limit ?? 0) : 0;
  for (let tries = 0; ; tries += 1) {
    try {
      return await fn();
    } catch (error) {
      if (tries === retries) throw error;
    }
  }
}

/** The run's outcome, which a run that wasn't `done` doesn't have. */
function outcomeOf(report: RunReport | null): RunOutcome {
  if (report?.status !== "done") throw new Error(`run ${report?.status ?? "never reported"}`);
  return report.outcome;
}

/** Each step's name, outcome and notes, in run order. */
const steps = (outcome: RunOutcome) => outcome.steps.map((s) => [s.name, s.kind, s.outcome]);

describe("PipelineWorkflow", () => {
  it("runs the setups in one container, snapshots it, then each check in its own container restored from it", async () => {
    const { started, events, report } = await pipeline();
    expect([...started.keys()].toSorted()).toEqual(["check:build", "check:lint", "check:smoke", "check:test", "setup"]);
    expect(started.get("setup")?.from).toBe("image");
    for (const check of ["lint", "test", "build", "smoke"])
      expect(started.get(`check:${check}`)?.from).toBe("snapshot");
    // The setup container is snapshotted, then gone before any check starts.
    expect(events.indexOf("snapshot setup")).toBeGreaterThan(events.indexOf("run setup"));
    expect(events.indexOf("destroy setup")).toBeLessThan(events.indexOf("restore check:lint snap-1"));
    expect(steps(outcomeOf(report))).toEqual([
      ["_diff", "check", "passed"],
      ["deps", "setup", "passed"],
      ["gen", "setup", "passed"],
      ["lint", "check", "passed"],
      ["test", "check", "passed"],
      ["build", "check", "passed"],
      ["smoke", "check", "passed"],
    ]);
    expect(outcomeOf(report).gate).toBe("passed");
  });

  it("starts a check only once every check it waits for passed", async () => {
    const { events } = await pipeline();
    const ran = (check: string) => events.indexOf(`run check:${check}`);
    expect(ran("build")).toBeGreaterThan(ran("lint"));
    expect(ran("build")).toBeGreaterThan(ran("test"));
    expect(ran("smoke")).toBeGreaterThan(ran("build"));
  });

  it("skips a check whose wait didn't pass, and everything waiting on it, saying why", async () => {
    const { started, report } = await pipeline({ checks: { test: 1 } });
    expect(started.has("check:build")).toBeFalsy();
    expect(started.has("check:smoke")).toBeFalsy();
    const outcome = outcomeOf(report);
    expect(outcome.steps.filter((s) => s.kind === "check").map((s) => [s.name, s.outcome, s.notes])).toEqual([
      ["_diff", "passed", []],
      ["lint", "passed", []],
      ["test", "failed", []],
      ["build", "skipped", ["skipped: waits for test, which failed"]],
      ["smoke", "skipped", ["skipped: waits for build, which was skipped"]],
    ]);
    expect(outcome.gate).toBe("failed");
  });

  it("reports each check's after", async () => {
    const { report } = await pipeline();
    expect(
      outcomeOf(report)
        .steps.filter((s) => s.kind === "check")
        .map((s) => [s.name, s.after]),
    ).toEqual([
      ["_diff", undefined],
      ["lint", []],
      ["test", []],
      ["build", ["lint", "test"]],
      ["smoke", ["build"]],
    ]);
  });

  it("stops the run at a failed setup: no snapshot, no check", async () => {
    const { started, events, report } = await pipeline({ setups: { deps: 2 } });
    expect([...started.keys()]).toEqual(["setup"]);
    expect(events).not.toContain("snapshot setup");
    const outcome = outcomeOf(report);
    expect(outcome.steps.map((s) => [s.name, s.outcome, s.notes])).toEqual([
      ["_diff", "passed", []],
      ["deps", "failed", []],
      ["gen", "skipped", ["skipped: setup deps failed"]],
      ["lint", "skipped", ["skipped: setup deps failed"]],
      ["test", "skipped", ["skipped: setup deps failed"]],
      ["build", "skipped", ["skipped: setup deps failed"]],
      ["smoke", "skipped", ["skipped: setup deps failed"]],
    ]);
    expect(outcome.gate).toBe("failed");
  });

  it("retries a failed restore once, then starts the check's container from the image to re-run the setups", async () => {
    const once = await pipeline({ failedRestores: 1 });
    expect(once.started.get("check:lint")?.from).toBe("snapshot");
    expect(once.events.filter((e) => e === "restore check:lint snap-1")).toHaveLength(2);

    const twice = await pipeline({ failedRestores: 2 });
    expect(twice.events.filter((e) => e === "restore check:lint snap-1")).toHaveLength(2);
    expect(twice.started.get("check:lint")?.from).toBe("image");
    const lint = outcomeOf(twice.report).steps.find((s) => s.name === "lint");
    expect(lint).toMatchObject({
      outcome: "passed",
      notes: ["setups re-run in this check's container: it couldn't start from the setups' snapshot"],
    });
  });

  it.each([
    ["under wrangler dev, which takes no snapshot", null],
    ["when the snapshot fails", new Error("snapshot failed")],
  ])("runs every check from the image, re-running the setups, %s", async (_, snapshot) => {
    const { started, events, report } = await pipeline({ snapshot });
    expect(events.some((e) => e.startsWith("restore"))).toBeFalsy();
    for (const check of ["lint", "test", "build", "smoke"]) expect(started.get(`check:${check}`)?.from).toBe("image");
    expect(outcomeOf(report).steps.find((s) => s.name === "test")?.notes).toEqual([
      "setups re-run in this check's container: the run took no snapshot of them",
    ]);
  });

  it("names every container after the instance, and plans them all before starting one", async () => {
    const { events, planned } = await pipeline();
    expect(planned).toEqual([
      `${INSTANCE}/setup`,
      `${INSTANCE}/check:lint`,
      `${INSTANCE}/check:test`,
      `${INSTANCE}/check:build`,
      `${INSTANCE}/check:smoke`,
    ]);
    expect(events.indexOf("plan")).toBeLessThan(events.indexOf("run setup"));
  });

  it("gives every container one read grant on the fork, never a write grant, and main's network", async () => {
    const config = `network:\n  allow: [api.example.com]\nsetup:\n  - { name: deps, command: npm ci }\nchecks:\n  - { name: test, command: npm test }\n`;
    const { started } = await pipeline({ config, snapshot: null });
    for (const container of ["setup", "check:test"]) {
      const access = started.get(container)?.access;
      expect(access?.grants).toEqual([
        { remote: "https://artifacts.invalid/abc123-t1a1.git", token: "read:abc123-t1a1", access: "read" },
      ]);
      expect(access).toMatchObject({ registries: ["registry.npmjs.org"], allow: ["api.example.com"] });
    }
  });

  it("starts every container at main's Sandbox size", async () => {
    const { started } = await pipeline({ snapshot: null });
    expect([...started.values()].map((s) => s.size)).toEqual(Array(5).fill("standard-2"));
  });

  it("gives every container the run's THRONG_ variables", async () => {
    const { started } = await pipeline();
    const context = {
      THRONG_PROJECT: "abc123",
      THRONG_PIPELINE: "default",
      THRONG_LINE: "t1a1",
      THRONG_SHA: "a".repeat(40),
      THRONG_RUN: "7",
    };
    for (const container of started.values()) expect(container.env).toEqual(context);
  });

  it("stores each step's log under the run's line and id, with its notes", async () => {
    const { stored, report } = await pipeline({ checks: { test: 1 } });
    expect([...stored.keys()].toSorted()).toEqual([
      "logs/abc123/t1a1/7/lint.log",
      "logs/abc123/t1a1/7/setup.1.log",
      "logs/abc123/t1a1/7/setup.2.log",
      "logs/abc123/t1a1/7/test.log",
    ]);
    expect(stored.get("logs/abc123/t1a1/7/test.log")).toBe("check:test test\n== throng ==\nsandbox: standard-2\n");
    expect(outcomeOf(report).steps.map((s) => [s.name, s.log])).toEqual([
      ["_diff", null],
      ["deps", "setup.1"],
      ["gen", "setup.2"],
      ["lint", "lint"],
      ["test", "test"],
      ["build", null],
      ["smoke", null],
    ]);
  });

  it("reports each step's outcome and duration, and the diff, to the project", async () => {
    const { report, returned } = await pipeline();
    expect(returned).toEqual(report);
    const outcome = outcomeOf(report);
    expect(outcome.steps.map((s) => [s.name, s.durationMs])).toEqual([
      ["_diff", 1],
      ["deps", 5],
      ["gen", 5],
      ["lint", 3],
      ["test", 3],
      ["build", 3],
      ["smoke", 3],
    ]);
    expect(outcome.metrics["_diff.additions"]).toMatchObject({ value: 1 });
    expect(outcome.metrics["test"]).toMatchObject({ type: "enum", value: "passed" });
  });

  it("destroys every container and releases the snapshot when the run ends", async () => {
    const { events } = await pipeline();
    expect(events.slice(-2)).toEqual(["release setup", "report"]);
    expect(events.filter((e) => e.startsWith("destroy")).toSorted()).toEqual([
      "destroy check:build",
      "destroy check:lint",
      "destroy check:smoke",
      "destroy check:test",
      "destroy setup",
    ]);
  });

  it("ends the run errored when a check's container keeps failing, after the other checks settle", async () => {
    const { report, events } = await pipeline({ broken: "lint" });
    expect(report).toMatchObject({ status: "errored", error: expect.stringContaining("checkout failed") });
    expect(events).toContain("run check:test");
    expect(events.slice(-2)).toEqual(["release setup", "report"]);
  });

  it("resumes a run the Scoring Workflow's code started, whose params named its line attempt", async () => {
    const { line, ...rest } = params;
    const { started, report } = await pipeline({ payload: { ...rest, attempt: line } });
    expect(report?.status).toBe("done");
    expect(started.get("setup")?.env?.["THRONG_LINE"]).toBe("t1a1");
  });

  it("runs a config with no checks: the diff only, in the setup container, which isn't snapshotted", async () => {
    const { started, events, report } = await pipeline({ config: "" });
    expect([...started.keys()]).toEqual(["setup"]);
    expect(events).not.toContain("snapshot setup");
    expect(steps(outcomeOf(report))).toEqual([["_diff", "check", "passed"]]);
    expect(outcomeOf(report).gate).toBe("passed");
  });
});

describe("teardownPipeline", () => {
  it("destroys every planned container, the setup one and an old run's score container, then releases the snapshot", async () => {
    const events: string[] = [];
    const sandboxes: SandboxNamespace = {
      getByName: (name) => ({
        destroy: async () => void events.push(`destroy ${name}`),
        releaseSnapshot: () => void events.push(`release ${name}`),
      }),
    };
    await teardownPipeline(sandboxes, "i", ["i/setup", "i/check:a", "i/check:b"]);
    expect(events.slice(0, -1).toSorted()).toEqual([
      "destroy i/check:a",
      "destroy i/check:b",
      "destroy i/score",
      "destroy i/setup",
    ]);
    expect(events.at(-1)).toBe("release i/setup");
  });
});
