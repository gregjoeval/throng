// The Pipeline Workflow's steps against fake bindings: which containers start, from what, with what
// grants and variables; how setups, `after` and the snapshot's fallback decide what runs; and what
// it reports. `cloudflare:workers`, the Artifacts binding and the base lookup are stubbed. Each
// container's script is answered by what the test says that setup or check does. The project's
// secrets are sealed under a test keyring; every container prints each secret it holds, in every
// form masking hides, into its log, its metrics and any error.

import { describe, expect, it, vi } from "vitest";
import type { CacheKey, CacheRestore, CacheSave } from "../src/caches.ts";
import type { NamedSecrets, SandboxSize } from "../src/config.ts";
import type { OutboundAccess } from "../src/network.ts";
import type { TreeEntry } from "../src/repos.ts";
import type { RunOutcome } from "../src/run-outcome.ts";
import type { LandingRunParams, PipelineParams, PlanVerdict, RunReport } from "../src/scoring.ts";
import { mergeCheckoutSha } from "../src/scripts.ts";
import type { LandResult } from "../src/scripts.ts";
import { keyringFrom, sealSecret } from "../src/secrets.ts";
import { importWorkerModule } from "./support/worker-module.ts";
import { result } from "./support/workflow-runs.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

/**
 * The config on the origin's `main` for the run under way, the one it runs under (the merged
 * tree's, for a landing), and the head's lockfile's blob id, which keys its caches.
 */
const configs = { main: "", run: "", lockfile: "lock-1" as string | null, treeReads: [] as string[] };

vi.mock("../src/artifacts", () => ({
  reposFor: () => ({
    get: async (name: string) => ({ name, remote: `https://artifacts.invalid/${name}.git` }),
    mintToken: async (name: string, access: string) => ({ token: `${access}:${name}`, scope: access, expiresAt: "" }),
    // No commits to pin `main` to, so it's read as `main`; the `.npmrc` read gets the config, and adds nothing.
    listCommits: async () => [],
    readFile: async (repo: string) => ({ text: async () => (repo === "abc123-main" ? configs.main : "") }),
    // The head's tree holds the lockfile, unless it's null.
    readCommit: async (_repo: string, hash: string) => ({ hash, treeHash: "root" }),
    readTree: async (repo: string, hash: string) => {
      configs.treeReads.push(`${repo} ${hash}`);
      const lock = configs.lockfile;
      if (lock === "unreadable") return null;
      return lock === null ? [] : [{ name: "pnpm-lock.yaml", mode: "100644", hash: lock, type: "blob" }];
    },
  }),
}));
vi.mock("../src/base", () => ({ lineBase: async () => null }));

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
  /** A container whose script fails as infrastructure this many times, after it ran. */
  flaky?: { container: string; times: number };
  /** The params the Workflow was started with; a run started by the Scoring Workflow's code named its line `attempt`. */
  payload?: unknown;
  /** The project's secrets with values, by name. */
  secrets?: Record<string, string>;
  /** Secrets gone from the settings by the time a step loads them, though the plan found them. */
  gone?: string[];
  /** How many loads of the run's secrets find those in `gone` still there; none by default. */
  goneAfter?: number;
  /** What the project answers the plan: start, by default. */
  verdict?: PlanVerdict;
  /** Each post-gate step's command's exit. */
  postGate?: Record<string, number>;
  /** A post-gate step whose container fails as infrastructure this many times while being readied. */
  unready?: { step: string; times: number };
  /** A post-gate step whose container is lost once readied, before its command runs, this many times. */
  lost?: { step: string; times: number };
  /** A post-gate step whose command's container fails as infrastructure once the command started. */
  brokenStep?: string;
  /** Steps a run that started under older code already finished, by name: what Workflows kept of each. */
  replayed?: Record<string, unknown>;
  /** Secrets each container prints besides those it holds, by container: what a setup left in the snapshot. */
  prints?: Record<string, string[]>;
  /** For a landing: what its `merge` and `land` do, and what the project answers it. */
  landing?: LandingBehaviour;
  /** What the project answers for each cache: the scope it restores from and saves to; neither by default. */
  cacheLookup?: Record<string, { restore: string | null; save: string | null; unsaved?: string }>;
  /** How restoring a cache into a container goes, by cache name; restored by default. */
  cacheRestore?: Record<string, CacheRestore>;
  /** How saving a cache goes, by cache name; saved by default. */
  cacheSave?: Record<string, CacheSave>;
  /** The keys the project already has an entry for: a save of one is refused. */
  cacheEntries?: string[];
  /** The head's lockfile blob, which keys the caches; null when it has none, `unreadable` when its tree is missing. */
  lockfile?: string | null;
}

/** What a landing's own containers do, and what the project answers it. */
interface LandingBehaviour {
  /** The merged tree's config; `Behaviour.config` by default. */
  merged?: string | null;
  /** Its `merge` conflicts in `README.md`. */
  conflict?: boolean;
  /** What `land` reports, or `broken` for a container that keeps failing; landed at `LANDED` by default. */
  land?: LandResult | "broken";
  /** Whether the project lets it claim the push: true by default. */
  claimed?: boolean;
  /** What the project finds on `main` after `land` failed. */
  onMain?: string | null;
  /** The trees its merge made, by hash; by default the merged tree alone, holding the lockfile `merged-lock`. */
  trees?: Record<string, TreeEntry[]>;
}

/** `main` as a landing merges onto it, the tree the merge gives, and the commit `land` pushes. */
const MAIN_SHA = "m".repeat(40);
const TREE = "c".repeat(40);
const LANDED = "d".repeat(40);

/** The keyring the project's secrets are sealed under, as `SECRETS_KEYRING` holds it. */
const KEYRING = JSON.stringify({ current: "k1", keys: { k1: btoa("k".repeat(32)) } });

/** A secret's value with characters its base64 and URL encoding both change. */
const DEPLOY = "dep/loy+tok=en&more?";
const NPM = "npm-token-0123456789";
const PROD = "prod token/for main=1";

/** Every form of `value` masking hides: itself, its base64 with and without padding, and its URL encoding. */
function forms(value: string): string[] {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  return [value, base64, base64.replace(/=+$/u, ""), encodeURIComponent(value)];
}

/** The secrets a container's env holds: everything but the run's `THRONG_*` variables. */
function heldIn(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([name, value]) => (name.startsWith("THRONG_") ? [] : [value]));
}

/** The secrets an env holds, by name: everything but the run's `THRONG_*` variables. */
function secretsOf(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !name.startsWith("THRONG_")));
}

/** What a container prints of the secrets it holds: each in every form. */
const leak = (values: string[]) => values.flatMap(forms).join(" ");

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

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
  const merged = behaviour.landing?.merged;
  configs.run = merged === undefined ? configs.main : (merged ?? "");
  configs.lockfile = behaviour.lockfile === undefined ? "lock-1" : behaviour.lockfile;
  configs.treeReads = [];
  /** Each cache call: `restore <container> <key>`, `save <container> <key>`, `saved <key> <size>`, in order. */
  const cacheCalls: string[] = [];
  /** The cache keys the project was asked to look up. */
  const looked: CacheKey[][] = [];
  const started = new Map<string, Started>();
  const events: string[] = [];
  const restores = new Map<string, number>();
  const stored = new Map<string, string>();
  const running = new Set<string>();
  /** What the Workflow persists: its params, each step's name and config, and what each step returned or threw. */
  const persisted: unknown[] = [behaviour.payload ?? params];
  const held = new Map<string, string[]>();
  /** The env each post-gate step's command ran with, by container. */
  const commandEnvs = new Map<string, Record<string, string> | undefined>();
  const loads: string[][] = [];
  /** How many times each post-gate step's container was readied, and each command that ran, in order. */
  const readied = new Map<string, number>();
  /** How many times each post-gate step's readied container was lost. */
  const lostTimes = new Map<string, number>();
  /** How many times each flaky container's script failed. */
  const flakes = new Map<string, number>();
  /** What a container prints of secrets: those it holds, and any its behaviour says it finds on disk. */
  const printed = (container: string) => [...(held.get(container) ?? []), ...(behaviour.prints?.[container] ?? [])];
  const commands: string[] = [];
  let planned: string[] | null = null;
  let named: NamedSecrets[] | null = null;
  let report: RunReport | null = null;
  const landed: string[] = [];
  const keyring = keyringFrom(KEYRING);
  const env = {
    SECRETS_KEYRING: KEYRING,
    SANDBOX: {
      getByName: (name: string) => {
        const container = name.slice(INSTANCE.length + 1);
        const box = {
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
              const leaked = printed(container).length > 0 ? `${leak(printed(container))}\n` : "";
              return { exitCode: 0, stdout: `${container} ${log}\n${leaked}`, stderr: "" };
            }
            const from = started.get(container)?.from ?? "image";
            // A post-gate step's command runs in the container its ready step started, as it started.
            const command = container.startsWith("step:") && !script.includes("touch step.ready");
            if (command) {
              // Its command gets its env as it runs, on top of whatever the container held when readied.
              commandEnvs.set(container, options.env);
              held.set(container, [...(held.get(container) ?? []), ...heldIn(options.env)]);
            } else {
              started.set(container, { from, access: options.access, size: options.size, env: options.env });
              held.set(container, heldIn(options.env));
            }
            running.add(container);
            events.push(`run ${container}`);
            if (behaviour.flaky?.container === container && (flakes.get(container) ?? 0) < behaviour.flaky.times) {
              flakes.set(container, (flakes.get(container) ?? 0) + 1);
              return { exitCode: 12, stdout: "", stderr: "lost its connection" };
            }
            if (container === "merge") {
              if (behaviour.landing?.conflict === true) {
                const entries = ["1", "2", "3"].map((stage) => `100644 ${stage.repeat(40)} ${stage}\tREADME.md`);
                const output = [TREE, ...entries, "", ""].join("\0");
                return result({
                  main: MAIN_SHA,
                  clean: false,
                  base: "b".repeat(40),
                  output,
                  remerges: [],
                  config: null,
                });
              }
              const config = configs.run === "" ? null : configs.run;
              const lockfile = { name: "pnpm-lock.yaml", mode: "100644", hash: "merged-lock", type: "blob" };
              return result({
                main: MAIN_SHA,
                clean: true,
                base: "b".repeat(40),
                output: `${TREE}\0`,
                remerges: [],
                config,
                trees: behaviour.landing?.trees ?? { [TREE]: [lockfile] },
              });
            }
            if (container === "land") {
              const land = behaviour.landing?.land ?? { kind: "landed", sha: LANDED };
              if (land === "broken") return { exitCode: 13, stdout: "", stderr: "push failed" };
              commands.push("land");
              return result(land);
            }
            if (container.startsWith("step:")) {
              const postGate = container.slice("step:".length);
              if (!command) {
                const unready = behaviour.unready?.step === postGate ? behaviour.unready : null;
                const tries = (readied.get(postGate) ?? 0) + 1;
                readied.set(postGate, tries);
                if (unready !== null && tries <= unready.times)
                  return { exitCode: 10, stdout: "", stderr: "fetch failed" };
                return result({ setupsRerun: from === "image" });
              }
              commands.push(postGate);
              if (behaviour.brokenStep === postGate) {
                return { exitCode: 0, stdout: "", stderr: `deploy crashed ${leak(printed(container))}` };
              }
              return result({ exit: behaviour.postGate?.[postGate] ?? 0, durationMs: 4 });
            }
            if (container === "setup") {
              let failed = false;
              const setups = setupNamesOf(configs.run).map((setup) => {
                if (failed) return { exit: null, durationMs: 0 };
                const exit = behaviour.setups?.[setup] ?? 0;
                failed = exit !== 0;
                return { exit, durationMs: 5 };
              });
              return result({ base: null, shortstat: " 1 file changed, 1 insertion(+)", builtinMs: 1, setups });
            }
            const check = container.slice("check:".length);
            const values = printed(container);
            if (check === behaviour.broken) {
              return { exitCode: 11, stdout: "", stderr: `checkout failed ${leak(values)}` };
            }
            return result({
              exit: behaviour.checks?.[check] ?? 0,
              durationMs: 3,
              metrics: values.length === 0 ? {} : { leaked: { value: leak(values) } },
              setupsRerun: from === "image",
            });
          },
          snapshot: async () => {
            events.push(`snapshot ${container}`);
            if (behaviour.snapshot instanceof Error) throw behaviour.snapshot;
            return behaviour.snapshot === undefined ? SNAPSHOT : behaviour.snapshot;
          },
          image: async () => "registry.cloudflare.com/acct/throng:abc",
          restoreCache: async (key: string): Promise<CacheRestore> => {
            cacheCalls.push(`restore ${container} ${key}`);
            if (!running.has(container)) {
              running.add(container);
              started.set(container, { from: "image", access: {} as OutboundAccess, size: "lite", env: undefined });
            }
            const cache = key.split("/")[3] ?? "";
            return behaviour.cacheRestore?.[cache] ?? { kind: "restored", bytes: 2_000_000, ms: 1500 };
          },
          saveCache: async (key: string): Promise<CacheSave> => {
            cacheCalls.push(`save ${container} ${key}`);
            const cache = key.split("/")[3] ?? "";
            return behaviour.cacheSave?.[cache] ?? { kind: "saved", bytes: 3_000_000, ms: 2500 };
          },
          releaseSnapshot: () => void events.push(`release ${container}`),
          destroy: async () => {
            if (running.delete(container)) events.push(`destroy ${container}`);
          },
        };
        return {
          ...box,
          // A post-gate step's command runs only in the container its ready step left running.
          runIfRunning: async (script: string, options: { env?: Record<string, string> }) => {
            const postGate = container.slice("step:".length);
            if (behaviour.lost?.step === postGate && (lostTimes.get(postGate) ?? 0) < behaviour.lost.times) {
              lostTimes.set(postGate, (lostTimes.get(postGate) ?? 0) + 1);
              running.delete(container);
            }
            if (!running.has(container)) return null;
            return box.run(script, { access: {} as OutboundAccess, size: "lite", ...options });
          },
        };
      },
    },
    PROJECT: {
      getByName: () => ({
        runDefinitions: async () => ({ checks: [], metrics: [] }),
        pipelinePlanned: async (_run: number, containers: string[], secrets: NamedSecrets[]) => {
          planned = containers;
          named = secrets;
          events.push("plan");
          return behaviour.verdict ?? { kind: "start" };
        },
        pipelineSecrets: async (_run: number, names: string[]) => {
          loads.push(names);
          const sealed = [];
          for (const name of names) {
            const value = behaviour.secrets?.[name];
            const gone = behaviour.gone?.includes(name) === true && loads.length > (behaviour.goneAfter ?? 0);
            if (value === undefined || gone) {
              return { secret: name, error: `secret ${name} has no value in the project settings` };
            }
            const { ciphertext, iv, keyId } = await sealSecret(keyring, "abc123", name, value);
            sealed.push({ name, ciphertext: encode(ciphertext), iv: encode(iv), keyId });
          }
          return { sealed };
        },
        pipelineCaches: async (_run: number, keys: CacheKey[]) => {
          looked.push(keys);
          return keys.map((key) => ({
            ...key,
            ...(behaviour.cacheLookup?.[key.name] ?? { restore: null, save: null }),
          }));
        },
        pipelineCacheSaving: async (_run: number, entry: { scope: string; name: string }) =>
          !(behaviour.cacheEntries ?? []).includes(`${entry.scope}/${entry.name}`),
        pipelineCacheSaved: async (_run: number, entry: { scope: string; name: string; size: number }) => {
          cacheCalls.push(`saved ${entry.scope}/${entry.name} ${entry.size}`);
          return true;
        },
        pipelineCacheUnsaved: async (_run: number, entry: { scope: string; name: string }) =>
          void cacheCalls.push(`unsaved ${entry.scope}/${entry.name}`),
        pipelineFinished: async (_run: number, finished: RunReport) => {
          report = finished;
          events.push("report");
        },
        claimLand: async () => {
          events.push("claim");
          return behaviour.landing?.claimed ?? true;
        },
        pipelineLanded: async (_run: number, sha: string) => {
          landed.push(sha);
          events.push("landed");
        },
        landedOnMain: async () => behaviour.landing?.onMain ?? null,
        legacyLandingResumed: async (landing: number) => void events.push(`resumed ${landing}`),
      }),
    },
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: "ada00001", handle: "ada" }] }) }) }),
    },
    LOGS: {
      put: async (key: string, value: string) => void stored.set(key, value),
    },
  };
  const returned = await new PipelineWorkflow({}, env).run(
    { payload: behaviour.payload ?? params, instanceId: INSTANCE },
    { do: recordingStepDo(persisted, behaviour.replayed) },
  );
  return {
    started,
    events,
    stored,
    persisted,
    loads,
    commandEnvs,
    commands,
    readied,
    planned: planned as string[] | null,
    named: named as NamedSecrets[] | null,
    report: report as RunReport | null,
    returned,
    landed,
    cacheCalls,
    looked,
  };
}

/** The setups' names in a config, in order. */
function setupNamesOf(config: string): string[] {
  const setup = /setup:\n((?: {2}- .*\n)+)/u.exec(config)?.[1] ?? "";
  return [...setup.matchAll(/name: (\w+)/gu)].map((m) => m[1] ?? "");
}

/**
 * A step that runs `fn`, trying again on failure up to its config's retry limit, as Workflows does,
 * recording into `persisted` what Workflows would keep: its name, its config, and what each try
 * returned or threw.
 */
function recordingStepDo(persisted: unknown[], replayed: Record<string, unknown> = {}) {
  return async (name: string, ...rest: unknown[]): Promise<unknown> => {
    if (name in replayed) return replayed[name];
    const fn = rest.at(-1) as () => Promise<unknown>;
    const config = rest.length > 1 ? (rest[0] as { retries?: { limit: number } }) : {};
    persisted.push(name, config);
    for (let tries = 0; ; tries += 1) {
      try {
        const returned = await fn();
        persisted.push(returned);
        return returned;
      } catch (error) {
        persisted.push(error instanceof Error ? error.message : String(error));
        if (tries === (config.retries?.limit ?? 0)) throw error;
      }
    }
  };
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

  it("starts a retried setup's or check's container afresh, never on what a failed try left", async () => {
    const check = await pipeline({ flaky: { container: "check:lint", times: 1 } });
    expect(check.events.filter((e) => e.endsWith("check:lint snap-1") || e.endsWith(" check:lint"))).toEqual([
      "restore check:lint snap-1",
      "run check:lint",
      "destroy check:lint",
      "restore check:lint snap-1",
      "run check:lint",
      "destroy check:lint",
    ]);
    expect(outcomeOf(check.report).steps.find((s) => s.name === "lint")?.notes).toEqual([]);

    const setup = await pipeline({ flaky: { container: "setup", times: 1 } });
    expect(setup.events.filter((e) => e.endsWith(" setup"))).toEqual([
      "run setup",
      "destroy setup",
      "run setup",
      "snapshot setup",
      "destroy setup",
      "release setup",
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

/** A config whose one setup and one check each name a secret, and whose other check names none. */
const SECRET_CONFIG = `setup:
  - { name: deps, command: npm ci, secrets: [NPM_TOKEN] }
checks:
  - { name: lint, command: npm run lint }
  - { name: deploy, command: npm run deploy, secrets: [DEPLOY_TOKEN], after: lint }
`;
const SECRETS = { NPM_TOKEN: NPM, DEPLOY_TOKEN: DEPLOY, PROD_TOKEN: PROD };
const secretsRun = (behaviour: Behaviour = {}) => pipeline({ config: SECRET_CONFIG, secrets: SECRETS, ...behaviour });

/**
 * A config whose setup names a secret, and whose `main` names one for all its post-gate steps,
 * which `deploy` adds its own to. Its check names none.
 */
const STEP_SECRET_CONFIG = `setup:
  - { name: deps, command: npm ci, secrets: [NPM_TOKEN] }
checks:
  - { name: lint, command: npm run lint }
pipelines:
  main:
    secrets: [PROD_TOKEN]
    steps:
      - { name: migrate, command: npm run migrate }
      - { name: deploy, command: npm run deploy, secrets: [DEPLOY_TOKEN] }
`;
const stepSecretsRun = (behaviour: Behaviour = {}) =>
  pipeline({ config: STEP_SECRET_CONFIG, secrets: SECRETS, payload: { ...params, line: "main" }, ...behaviour });

/** Whether `text` holds any form of any secret. */
const leaks = (text: string) => [DEPLOY, NPM, PROD].flatMap(forms).some((form) => text.includes(form));

describe("PipelineWorkflow secrets", () => {
  it("names the secrets each setup and check names in its plan, by name only", async () => {
    const { named } = await secretsRun();
    expect(named).toEqual([
      { step: "setup deps", secrets: ["NPM_TOKEN"] },
      { step: "check deploy", secrets: ["DEPLOY_TOKEN"] },
    ]);
  });

  it("gives each container of a trusted run only the secrets named for it, loaded as it starts", async () => {
    const { started, loads, events } = await secretsRun();
    expect(secretsOf(started.get("setup")?.env)).toEqual({ NPM_TOKEN: NPM });
    expect(secretsOf(started.get("check:lint")?.env)).toEqual({});
    expect(secretsOf(started.get("check:deploy")?.env)).toEqual({ DEPLOY_TOKEN: DEPLOY });
    expect(started.get("check:deploy")?.env).toMatchObject({ THRONG_RUN: "7" });
    // Loaded per container, not for the run; a check restored from the setups' snapshot loads theirs
    // only to mask them, as the snapshot may hold them.
    expect(loads).toEqual([["NPM_TOKEN"], ["NPM_TOKEN"], ["DEPLOY_TOKEN", "NPM_TOKEN"]]);
    expect(events.indexOf("run setup")).toBeGreaterThan(events.indexOf("plan"));
  });

  it("gives a check that re-runs the setups the setups' secrets too", async () => {
    const { started } = await secretsRun({ snapshot: null });
    expect(heldIn(started.get("check:lint")?.env)).toEqual([NPM]);
    expect(heldIn(started.get("check:deploy")?.env).toSorted()).toEqual([DEPLOY, NPM].toSorted());
  });

  it("masks what each container held in its stored log, its metric values and its errors", async () => {
    const { stored, persisted } = await secretsRun();
    const deployLog = stored.get("logs/abc123/t1a1/7/deploy.log") ?? "";
    expect(deployLog).toContain("***");
    expect(stored.get("logs/abc123/t1a1/7/setup.1.log")).toContain("***");
    for (const log of stored.values()) expect(leaks(log)).toBeFalsy();
    const deploy = persisted[persisted.indexOf("check deploy") + 2] as { metrics: Record<string, { value: string }> };
    expect(deploy.metrics["leaked"]?.value).toMatch(/^\*\*\*( \*\*\*)+$/u);

    const broken = await secretsRun({ broken: "deploy" });
    expect(broken.report).toMatchObject({ status: "errored", error: expect.stringContaining("checkout failed ***") });
    expect(leaks(JSON.stringify(broken.report))).toBeFalsy();
  });

  it("masks the setups' secrets in what a container restored from their snapshot prints, never giving it them", async () => {
    const { started, stored, persisted, commandEnvs } = await stepSecretsRun({
      prints: { "check:lint": [NPM], "step:deploy": [NPM] },
    });
    expect(secretsOf(started.get("check:lint")?.env)).toEqual({});
    expect(secretsOf(started.get("step:deploy")?.env)).toEqual({});
    expect(secretsOf(commandEnvs.get("step:deploy"))).toEqual({ PROD_TOKEN: PROD, DEPLOY_TOKEN: DEPLOY });
    expect(stored.get("logs/abc123/main/7/lint.log")).toContain("***");
    for (const log of stored.values()) expect(leaks(log)).toBeFalsy();
    expect(leaks(JSON.stringify(persisted))).toBeFalsy();
  });

  it("persists no secret in any step's params or results, raw, base64 or URL-encoded", async () => {
    for (const behaviour of [{}, { snapshot: null }, { broken: "deploy" }, { gone: ["DEPLOY_TOKEN"] }]) {
      const { persisted, report, returned, started } = await secretsRun(behaviour);
      // The containers did hold them; only the Workflow's own record must not.
      expect(heldIn(started.get("setup")?.env)).toContain(NPM);
      expect(leaks(JSON.stringify([persisted, report, returned]))).toBeFalsy();
    }
    // And `main`'s post-gate steps, readied in one step and run in the next.
    for (const behaviour of [
      {},
      { snapshot: null },
      { gone: ["DEPLOY_TOKEN"], goneAfter: 2 },
      { lost: { step: "deploy", times: 1 } },
      { brokenStep: "deploy" },
      { unready: { step: "deploy", times: 1 } },
      { postGate: { migrate: 1 } },
    ]) {
      const { persisted, report, returned, commandEnvs } = await stepSecretsRun(behaviour);
      expect(heldIn(commandEnvs.get("step:migrate"))).toEqual([PROD]);
      expect(leaks(JSON.stringify([persisted, report, returned]))).toBeFalsy();
    }
  });

  it("names main's post-gate steps' secrets in its plan, its pipeline's added to each step's, by name only", async () => {
    const { named } = await stepSecretsRun();
    expect(named).toEqual([
      { step: "setup deps", secrets: ["NPM_TOKEN"] },
      { step: "step migrate", secrets: ["PROD_TOKEN"], pipeline: "main" },
      { step: "step deploy", secrets: ["PROD_TOKEN", "DEPLOY_TOKEN"], pipeline: "main" },
    ]);
    // A task branch runs `default`, which has no post-gate steps: main's secrets are never named there.
    const branch = await stepSecretsRun({ payload: { ...params, line: "t1" } });
    expect(branch.named).toEqual([{ step: "setup deps", secrets: ["NPM_TOKEN"] }]);
    expect(branch.loads).toEqual([["NPM_TOKEN"], ["NPM_TOKEN"]]);
  });

  it("gives each post-gate step's command only its own secrets, loaded as it starts, never its ready step", async () => {
    const { started, commandEnvs, loads, events } = await stepSecretsRun();
    // Main's secrets reach neither the setups nor the checks.
    expect(secretsOf(started.get("setup")?.env)).toEqual({ NPM_TOKEN: NPM });
    expect(secretsOf(started.get("check:lint")?.env)).toEqual({});
    // Readied from the snapshot, the container holds nothing until its command runs.
    expect(secretsOf(started.get("step:migrate")?.env)).toEqual({});
    expect(secretsOf(started.get("step:deploy")?.env)).toEqual({});
    expect(secretsOf(commandEnvs.get("step:migrate"))).toEqual({ PROD_TOKEN: PROD });
    expect(secretsOf(commandEnvs.get("step:deploy"))).toEqual({ PROD_TOKEN: PROD, DEPLOY_TOKEN: DEPLOY });
    expect(commandEnvs.get("step:deploy")).toMatchObject({ THRONG_PIPELINE: "main", THRONG_RUN: "7" });
    // The setups' secrets are loaded beside them only to mask them: the snapshot may hold them.
    expect(loads).toEqual([
      ["NPM_TOKEN"],
      ["NPM_TOKEN"],
      ["NPM_TOKEN"],
      ["PROD_TOKEN", "NPM_TOKEN"],
      ["NPM_TOKEN"],
      ["PROD_TOKEN", "DEPLOY_TOKEN", "NPM_TOKEN"],
    ]);
    expect(events.indexOf("run step:deploy")).toBeGreaterThan(events.indexOf("destroy step:migrate"));
  });

  it("gives a post-gate step's container that re-runs the setups their secrets, and its command only its own", async () => {
    const { started, commandEnvs, stored } = await stepSecretsRun({ snapshot: null });
    expect(heldIn(started.get("step:migrate")?.env)).toEqual([NPM]);
    expect(heldIn(commandEnvs.get("step:migrate"))).toEqual([PROD]);
    // The setups' output in the step's log is masked too.
    const log = stored.get("logs/abc123/main/7/step.migrate.log") ?? "";
    expect(log).toContain("***");
    expect(leaks(log)).toBeFalsy();
  });

  it("masks what a post-gate step held in its stored log and its errors", async () => {
    const { stored } = await stepSecretsRun();
    const log = stored.get("logs/abc123/main/7/step.deploy.log") ?? "";
    expect(log).toMatch(/^step:deploy step\.deploy\n\*\*\*( \*\*\*)+\n/u);
    for (const text of stored.values()) expect(leaks(text)).toBeFalsy();

    const broken = await stepSecretsRun({ brokenStep: "deploy" });
    expect(broken.report).toMatchObject({
      status: "errored",
      error: expect.stringContaining("step deploy gave no result (exit 0): deploy crashed ***"),
    });
    expect(leaks(JSON.stringify(broken.report))).toBeFalsy();
  });

  it("fails a post-gate step whose secret is gone as its command starts, naming it, and runs none after it", async () => {
    // Found by the loads of the setup, the check, migrate's ready step and its command; gone by deploy's.
    const { commands, events, report } = await stepSecretsRun({ gone: ["PROD_TOKEN"], goneAfter: 4 });
    expect(commands).toEqual(["migrate"]);
    expect(events).toContain("destroy step:deploy");
    const outcome = outcomeOf(report);
    expect(outcome.steps.filter((s) => s.kind === "step").map((s) => [s.name, s.outcome, s.notes])).toEqual([
      ["migrate", "passed", []],
      ["deploy", "errored", ["secret PROD_TOKEN has no value in the project settings"]],
    ]);
    expect(report?.status).toBe("done");
  });

  it("fails a post-gate step whose container can't re-run the setups for a secret gone, naming it", async () => {
    const { commands, readied, report } = await stepSecretsRun({ snapshot: null, gone: ["NPM_TOKEN"], goneAfter: 2 });
    expect(commands).toEqual([]);
    expect(readied.get("migrate")).toBeUndefined();
    expect(
      outcomeOf(report)
        .steps.filter((s) => s.kind === "step")
        .map((s) => [s.name, s.outcome, s.notes]),
    ).toEqual([
      ["migrate", "errored", ["secret NPM_TOKEN has no value in the project settings"]],
      ["deploy", "skipped", ["skipped: step migrate didn't pass"]],
    ]);
  });

  it("ends the run errored before any container starts when the project refuses its plan", async () => {
    const error = "check deploy: secret DEPLOY_TOKEN isn't allowed in the default pipeline by the project settings";
    const { started, report, loads } = await secretsRun({ verdict: { kind: "refused", error } });
    expect(started.size).toBe(0);
    expect(loads).toEqual([]);
    expect(report).toEqual({ status: "errored", error: `Error: ${error}` });
  });

  it("starts, tears down and reports nothing when the run waits for the owner", async () => {
    const { started, events, returned, loads } = await secretsRun({ verdict: { kind: "waiting" } });
    expect(started.size).toBe(0);
    expect(loads).toEqual([]);
    expect(events).toEqual(["plan"]);
    expect(returned).toBeNull();
  });

  it("fails a check whose secret is gone as its step starts, naming it, and runs the rest", async () => {
    const { events, report } = await secretsRun({ gone: ["DEPLOY_TOKEN"] });
    // Restored from the snapshot, its container came up, but ran nothing and was stopped.
    expect(events).not.toContain("run check:deploy");
    expect(events).toContain("destroy check:deploy");
    const outcome = outcomeOf(report);
    expect(outcome.steps.map((s) => [s.name, s.outcome, s.notes])).toEqual([
      ["_diff", "passed", []],
      ["deps", "passed", []],
      ["lint", "passed", []],
      ["deploy", "errored", ["secret DEPLOY_TOKEN has no value in the project settings"]],
    ]);
    expect(outcome.gate).toBe("failed");
  });

  it("fails the setups when a secret one names is gone as their step starts, naming it", async () => {
    const config = `setup:\n  - { name: tools, command: make tools }\n${SECRET_CONFIG.slice("setup:\n".length)}`;
    const { started, report } = await secretsRun({ config, gone: ["NPM_TOKEN"] });
    expect(started.size).toBe(0);
    const outcome = outcomeOf(report);
    expect(outcome.steps.map((s) => [s.name, s.outcome, s.notes])).toEqual([
      ["_diff", "passed", []],
      ["tools", "skipped", ["skipped: setup deps failed"]],
      ["deps", "errored", ["secret NPM_TOKEN has no value in the project settings"]],
      ["lint", "skipped", ["skipped: setup deps failed"]],
      ["deploy", "skipped", ["skipped: setup deps failed"]],
    ]);
    expect(outcome.gate).toBe("failed");
  });
});

/** A config whose `main` runs the `verify` group and two post-gate steps; `preview` is in no group. */
const MAIN_CONFIG = `sandbox: { size: standard-2 }
setup:
  - { name: deps, command: npm ci }
checks:
  - { name: lint, command: npm run lint, group: verify }
  - { name: test, command: npm test, group: verify }
  - { name: preview, command: npm run preview, after: test }
pipelines:
  main:
    groups: [verify]
    steps:
      - { name: migrate, command: npm run migrate }
      - { name: deploy, command: npm run deploy }
`;

describe("PipelineWorkflow on a task branch and main", () => {
  const onMain = { ...params, line: "main" };
  const onTaskBranch = { ...params, line: "t1" };

  it.each([
    ["main", onMain],
    ["a task branch", onTaskBranch],
  ])("gives every container on %s one read grant on the origin, which holds its line", async (_, payload) => {
    const { started } = await pipeline({ config: MAIN_CONFIG, payload, snapshot: null });
    expect(started.size).toBeGreaterThan(0);
    for (const container of started.values()) {
      expect(container.access.grants).toEqual([
        { remote: "https://artifacts.invalid/abc123-main.git", token: "read:abc123-main", access: "read" },
      ]);
    }
  });

  it("takes the pipeline from the line: main on main, default on a task branch", async () => {
    const main = await pipeline({ config: MAIN_CONFIG, payload: onMain });
    expect(main.started.get("setup")?.env).toMatchObject({ THRONG_PIPELINE: "main", THRONG_LINE: "main" });
    const branch = await pipeline({ config: MAIN_CONFIG, payload: onTaskBranch });
    expect(branch.started.get("setup")?.env).toMatchObject({ THRONG_PIPELINE: "default", THRONG_LINE: "t1" });
  });

  it("runs only the checks in main's groups on main, and every check on any other line", async () => {
    const main = await pipeline({ config: MAIN_CONFIG, payload: onMain });
    expect(
      outcomeOf(main.report)
        .steps.filter((s) => s.kind === "check")
        .map((s) => [s.name, s.group]),
    ).toEqual([
      ["_diff", null],
      ["lint", "verify"],
      ["test", "verify"],
    ]);
    const branch = await pipeline({ config: MAIN_CONFIG, payload: onTaskBranch });
    expect(
      outcomeOf(branch.report)
        .steps.filter((s) => s.kind === "check")
        .map((s) => s.name),
    ).toEqual(["_diff", "lint", "test", "preview"]);
    // Only `main` has post-gate steps.
    expect(outcomeOf(branch.report).steps.some((s) => s.kind === "step")).toBeFalsy();
  });

  it("runs main's post-gate steps in order after the gate, each in its own container restored from the snapshot", async () => {
    const { events, planned, started, commands, report, stored } = await pipeline({
      config: MAIN_CONFIG,
      payload: onMain,
    });
    expect(planned).toEqual([
      `${INSTANCE}/setup`,
      `${INSTANCE}/check:lint`,
      `${INSTANCE}/check:test`,
      `${INSTANCE}/step:migrate`,
      `${INSTANCE}/step:deploy`,
    ]);
    expect(commands).toEqual(["migrate", "deploy"]);
    expect(events.indexOf("restore step:migrate snap-1")).toBeGreaterThan(events.indexOf("destroy check:test"));
    expect(events.indexOf("restore step:deploy snap-1")).toBeGreaterThan(events.indexOf("destroy step:migrate"));
    expect(started.get("step:deploy")).toMatchObject({ from: "snapshot", env: { THRONG_PIPELINE: "main" } });
    expect(outcomeOf(report).steps.map((s) => [s.name, s.kind, s.outcome, s.log])).toEqual([
      ["_diff", "check", "passed", null],
      ["deps", "setup", "passed", "setup.1"],
      ["lint", "check", "passed", "lint"],
      ["test", "check", "passed", "test"],
      ["migrate", "step", "passed", "step.migrate"],
      ["deploy", "step", "passed", "step.deploy"],
    ]);
    expect(stored.get("logs/abc123/main/7/step.deploy.log")).toBe(
      "step:deploy step.deploy\n== throng ==\nsandbox: standard-2\n",
    );
  });

  it("stops at the first post-gate step that fails, skipping the rest and saying why", async () => {
    const { commands, report } = await pipeline({ config: MAIN_CONFIG, payload: onMain, postGate: { migrate: 1 } });
    expect(commands).toEqual(["migrate"]);
    const outcome = outcomeOf(report);
    expect(outcome.steps.filter((s) => s.kind === "step").map((s) => [s.name, s.outcome, s.notes])).toEqual([
      ["migrate", "failed", []],
      ["deploy", "skipped", ["skipped: step migrate didn't pass"]],
    ]);
    // The gate is the setups' and checks' alone.
    expect(outcome.gate).toBe("passed");
  });

  it("runs no post-gate step when the gate fails", async () => {
    const { commands, events, report } = await pipeline({ config: MAIN_CONFIG, payload: onMain, checks: { test: 1 } });
    expect(commands).toEqual([]);
    expect(events.some((e) => e.includes("step:"))).toBeFalsy();
    expect(
      outcomeOf(report)
        .steps.filter((s) => s.kind === "step")
        .map((s) => [s.name, s.outcome, s.notes]),
    ).toEqual([
      ["migrate", "skipped", ["skipped: the gate failed"]],
      ["deploy", "skipped", ["skipped: the gate failed"]],
    ]);
  });

  it("notes a post-gate step that had to re-run the setups", async () => {
    const { report } = await pipeline({ config: MAIN_CONFIG, payload: onMain, snapshot: null });
    expect(outcomeOf(report).steps.find((s) => s.name === "deploy")?.notes).toEqual([
      "setups re-run in this step's container: the run took no snapshot of them",
    ]);
  });

  it("retries a post-gate step whose container failed before its command started", async () => {
    const { commands, readied, report } = await pipeline({
      config: MAIN_CONFIG,
      payload: onMain,
      unready: { step: "deploy", times: 2 },
    });
    expect(readied.get("deploy")).toBe(3);
    expect(commands).toEqual(["migrate", "deploy"]);
    expect(report?.status).toBe("done");
  });

  it("never runs a post-gate step's command twice: an infrastructure error once it started ends the run errored", async () => {
    const { commands, persisted, report } = await pipeline({
      config: MAIN_CONFIG,
      payload: onMain,
      brokenStep: "migrate",
    });
    expect(commands).toEqual(["migrate"]);
    expect(persisted.filter((p) => p === "step migrate" || p === "step migrate (2)")).toEqual(["step migrate"]);
    expect(report).toMatchObject({ status: "errored", error: expect.stringContaining("step migrate gave no result") });
  });

  it("resumes a run whose post-gate steps finished under older code, never running their commands again", async () => {
    const { commands, report } = await pipeline({
      config: MAIN_CONFIG,
      payload: onMain,
      replayed: {
        "step migrate ready": { setupsRerun: false, cacheNotes: [] },
        "step migrate": { exit: 0, durationMs: 4, logged: true, notes: [] },
        "step deploy ready": { error: "secret PROD_TOKEN has no value in the project settings" },
      },
    });
    expect(commands).toEqual([]);
    expect(
      outcomeOf(report)
        .steps.filter((s) => s.kind === "step")
        .map((s) => [s.name, s.outcome]),
    ).toEqual([
      ["migrate", "passed"],
      ["deploy", "errored"],
    ]);
  });

  it("readies a post-gate step's container again when it was lost before its command started", async () => {
    const { commands, readied, persisted, report, events } = await pipeline({
      config: MAIN_CONFIG,
      payload: onMain,
      lost: { step: "deploy", times: 2 },
    });
    expect(readied.get("deploy")).toBe(3);
    expect(commands).toEqual(["migrate", "deploy"]);
    // Each try is a step of its own, as Workflows remembers a step by its name.
    expect(persisted.filter((p) => typeof p === "string" && p.startsWith("step deploy"))).toEqual([
      "step deploy ready",
      "step deploy",
      "step deploy ready (2)",
      "step deploy (2)",
      "step deploy ready (3)",
      "step deploy (3)",
    ]);
    expect(events.filter((e) => e === "restore step:deploy snap-1")).toHaveLength(3);
    expect(outcomeOf(report).steps.find((s) => s.name === "deploy")?.outcome).toBe("passed");

    const gone = await pipeline({ config: MAIN_CONFIG, payload: onMain, lost: { step: "deploy", times: 3 } });
    expect(gone.commands).toEqual(["migrate"]);
    expect(gone.report).toMatchObject({
      status: "errored",
      error: expect.stringContaining("step deploy: its container was lost before its command started"),
    });
  });
});

describe("PipelineWorkflow for a landing", () => {
  const HEAD = "a".repeat(40);
  const landingParams: LandingRunParams = {
    project: "abc123",
    line: "main",
    sha: null,
    run: 7,
    landing: {
      task: 1,
      attempt: 1,
      title: "Do it",
      head: HEAD,
      approver: { user: "ada00001", alias: null },
      coAuthors: [],
      startedAt: 1_700_000_000_000,
    },
  };
  /** `main`'s own config: smaller, with checks the merged tree drops and a host it allows. */
  const ON_MAIN = `sandbox: { size: lite }
network: { allow: [api.example.com] }
checks:
  - { name: old, command: npm run old }
`;
  const land = (landing: LandingBehaviour = {}, rest: Behaviour = {}) =>
    pipeline({ config: ON_MAIN, payload: landingParams, ...rest, landing: { merged: MAIN_CONFIG, ...landing } });
  const READ_ORIGIN = {
    remote: "https://artifacts.invalid/abc123-main.git",
    token: "read:abc123-main",
    access: "read",
  };
  const READ_FORK = { remote: "https://artifacts.invalid/abc123-t1a1.git", token: "read:abc123-t1a1", access: "read" };

  it("merges, runs the setups and checks on the merged tree, lands, then runs the post-gate steps", async () => {
    const { events, commands, report, landed } = await land();
    expect(events.filter((e) => e.startsWith("run ") || ["plan", "claim", "landed", "report"].includes(e))).toEqual([
      "run merge",
      "plan",
      "run setup",
      expect.stringMatching(/^run check:/u),
      expect.stringMatching(/^run check:/u),
      "claim",
      "run land",
      "landed",
      "run step:migrate",
      "run step:migrate",
      "run step:deploy",
      "run step:deploy",
      "report",
    ]);
    expect(commands).toEqual(["land", "migrate", "deploy"]);
    expect(landed).toEqual([LANDED]);
    const outcome = outcomeOf(report);
    expect(outcome.steps.map((s) => [s.name, s.kind, s.source, s.outcome])).toEqual([
      ["_diff", "check", "platform", "passed"],
      ["merge", "step", "platform", "passed"],
      ["deps", "setup", "project", "passed"],
      ["lint", "check", "project", "passed"],
      ["test", "check", "project", "passed"],
      ["land", "step", "platform", "passed"],
      ["migrate", "step", "project", "passed"],
      ["deploy", "step", "project", "passed"],
    ]);
    expect(outcome).toMatchObject({ gate: "passed", landed: { sha: LANDED } });
  });

  it("runs the merged tree's config, at main's Sandbox size and network", async () => {
    const { started, report } = await land();
    // `old` is only on `main`; `preview` isn't in main's groups.
    expect(
      outcomeOf(report)
        .steps.filter((s) => s.kind === "check")
        .map((s) => s.name),
    ).toEqual(["_diff", "lint", "test"]);
    expect(started.get("setup")).toMatchObject({ size: "lite", access: { allow: ["api.example.com"] } });
    expect(started.get("check:test")).toMatchObject({ access: { allow: ["api.example.com"] } });
  });

  it("merges and checks untrusted, with read grants on the origin and the fork; lands trusted, with origin write", async () => {
    const { started } = await land({}, { snapshot: null });
    for (const name of ["merge", "setup", "check:lint", "check:test"]) {
      expect(started.get(name)?.access.grants, name).toEqual([READ_ORIGIN, READ_FORK]);
    }
    expect(started.get("merge")?.access.allow).toEqual([]);
    expect(started.get("land")?.access.grants).toEqual([
      { remote: "https://artifacts.invalid/abc123-main.git", token: "write:abc123-main", access: "write" },
      READ_FORK,
    ]);
    expect(started.get("land")?.size).toBe("lite");
    // Post-gate steps run on the landed commit, read from the origin like any `main` run's.
    expect(started.get("step:deploy")?.access.grants).toEqual([READ_ORIGIN]);
  });

  it("tells setups and checks the merge commit their containers make, and the post-gate steps the landed sha", async () => {
    const { started } = await land({}, { snapshot: null });
    const merge = await mergeCheckoutSha({
      head: HEAD,
      main: MAIN_SHA,
      tree: TREE,
      committedAt: Math.floor(landingParams.landing.startedAt / 1000),
    });
    expect(merge).toMatch(/^[0-9a-f]{40}$/u);
    expect(started.get("setup")?.env).toMatchObject({
      THRONG_PIPELINE: "main",
      THRONG_LINE: "main",
      THRONG_SHA: merge,
    });
    expect(started.get("check:lint")?.env).toMatchObject({ THRONG_SHA: merge });
    expect(started.get("step:deploy")?.env).toMatchObject({ THRONG_SHA: LANDED });
  });

  it("gives the merged tree's post-gate steps their secrets once it landed, and its merge and land none", async () => {
    const { started, commandEnvs, loads, events, named } = await land(
      { merged: STEP_SECRET_CONFIG },
      { secrets: SECRETS },
    );
    expect(named).toContainEqual({ step: "step deploy", secrets: ["PROD_TOKEN", "DEPLOY_TOKEN"], pipeline: "main" });
    for (const container of ["merge", "land", "setup", "check:lint", "step:deploy"]) {
      expect(
        heldIn(started.get(container)?.env).filter((value) => value !== NPM),
        container,
      ).toEqual([]);
    }
    expect(heldIn(commandEnvs.get("step:deploy"))).toEqual([PROD, DEPLOY]);
    expect(loads.map((names) => names.filter((name) => name !== "NPM_TOKEN"))).toEqual([
      [],
      [],
      [],
      ["PROD_TOKEN"],
      [],
      ["PROD_TOKEN", "DEPLOY_TOKEN"],
    ]);
    expect(events.indexOf("run step:migrate")).toBeGreaterThan(events.indexOf("landed"));
  });

  it("ends `conflict` at a conflicting merge, keeping the conflict, starting nothing more", async () => {
    const { events, report, planned } = await land({ conflict: true });
    expect(events.filter((e) => e.startsWith("run "))).toEqual(["run merge"]);
    expect(planned).toBeNull();
    const outcome = outcomeOf(report);
    expect(outcome).toMatchObject({
      gate: "failed",
      landed: "conflict",
      conflict: { attempt: "t1a1", head: HEAD, main: MAIN_SHA, files: [{ path: "README.md", type: "content" }] },
    });
    expect(outcome.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["merge", "failed"],
      ["land", "skipped"],
    ]);
  });

  it("doesn't land when its gate fails: `land` and the post-gate steps are skipped", async () => {
    const { events, commands, report, landed } = await land({}, { checks: { test: 1 } });
    expect(commands).toEqual([]);
    expect(events).not.toContain("claim");
    expect(landed).toEqual([]);
    const outcome = outcomeOf(report);
    expect(outcome.gate).toBe("failed");
    expect(outcome.landed).toBeUndefined();
    expect(outcome.steps.filter((s) => s.kind === "step").map((s) => [s.name, s.outcome])).toEqual([
      ["merge", "passed"],
      ["land", "skipped"],
      ["migrate", "skipped"],
      ["deploy", "skipped"],
    ]);
  });

  it("ends `errored` when main moved: the lease failed, and nothing after it runs", async () => {
    const { commands, report, landed } = await land({ land: { kind: "moved" } });
    expect(commands).toEqual(["land"]);
    expect(landed).toEqual([]);
    expect(report).toMatchObject({ status: "errored", error: expect.stringContaining(`main moved from ${MAIN_SHA}`) });
  });

  it("doesn't push once its merge request left the queue", async () => {
    const { commands, report } = await land({ claimed: false });
    expect(commands).toEqual([]);
    expect(report).toMatchObject({ status: "errored", error: expect.stringContaining("left the queue") });
  });

  it("finds its merge commit on main when `land` kept failing after it pushed, and carries on", async () => {
    const { report, landed } = await land({ land: "broken", onMain: LANDED });
    expect(landed).toEqual([LANDED]);
    expect(outcomeOf(report).landed).toEqual({ sha: LANDED });
  });

  it("destroys its merge and land containers with the rest when it ends", async () => {
    const { events } = await land({}, { snapshot: null });
    const destroyed = events.filter((e) => e.startsWith("destroy "));
    expect(destroyed).toEqual(expect.arrayContaining(["destroy merge", "destroy land"]));
  });

  /** A merged tree's config with one cache, keyed by the lockfile, which the setup uses. */
  const CACHED_LANDING = `caches:
  pnpm: { path: ~/.pnpm, key: pnpm-lock.yaml }
setup:
  - { name: deps, command: pnpm install, caches: [pnpm] }
checks:
  - { name: test, command: pnpm test }
`;

  it("keys its caches by the merged tree it runs on, whose trees the merge made are in no repo", async () => {
    const { looked } = await land({ merged: CACHED_LANDING });
    expect(configs.treeReads).toEqual([]);
    // The same cache keyed by a head whose tree holds the same lockfile has the same key.
    const onMain = await pipeline({
      config: CACHED_LANDING,
      payload: { ...params, line: "main" },
      lockfile: "merged-lock",
    });
    expect(looked[0]?.[0]?.keyHash).toBe(onMain.looked[0]?.[0]?.keyHash);
    // And differs from one keyed by another lockfile.
    const other = await pipeline({ config: CACHED_LANDING, payload: { ...params, line: "main" } });
    expect(looked[0]?.[0]?.keyHash).not.toBe(other.looked[0]?.[0]?.keyHash);
  });

  it("reads the rest of the merged tree from main's repo, then the attempt's fork", async () => {
    const config = CACHED_LANDING.replace("key: pnpm-lock.yaml", "key: app/pnpm-lock.yaml");
    const trees = { [TREE]: [{ name: "app", mode: "040000", hash: "app-tree", type: "tree" as const }] };
    const { looked } = await land({ merged: config, trees });
    expect(configs.treeReads).toEqual(["abc123-main app-tree"]);
    expect(looked[0]?.map((key) => key.name)).toEqual(["pnpm"]);
  });

  it("hands a landing a Landing Workflow started back to the project, its containers gone", async () => {
    const legacy = {
      project: "abc123",
      landing: 3,
      task: 1,
      attempt: 1,
      title: "Do it",
      head: HEAD,
      approver: { user: "ada00001", alias: null },
      coAuthors: [],
      startedAt: 1,
    };
    const { events, report, returned } = await pipeline({ payload: legacy });
    expect(events).toEqual(["resumed 3"]);
    expect(report).toBeNull();
    expect(returned).toBeNull();
  });
});

/** The notes on the run's step `name`. */
const notesOf = (report: RunReport | null, name: string) =>
  outcomeOf(report).steps.find((s) => s.name === name)?.notes ?? [];

describe("PipelineWorkflow caches", () => {
  /** A config whose setup uses `pnpm`, one check `jest`, and main's deploy step `wrangler`. */
  const CACHED = `caches:
  pnpm: { path: [~/.local/share/pnpm/store, ~/.cache/pnpm], key: pnpm-lock.yaml }
  jest: { path: /tmp/jest, key: pnpm-lock.yaml }
  wrangler: { path: ~/.wrangler, key: pnpm-lock.yaml }
  unused: { path: /tmp/unused, key: pnpm-lock.yaml }
setup:
  - { name: deps, command: pnpm install --offline, caches: [pnpm] }
  - { name: gen, command: pnpm gen }
checks:
  - { name: lint, command: pnpm lint, caches: [pnpm] }
  - { name: test, command: pnpm test, caches: [jest] }
  - { name: e2e, command: pnpm e2e, caches: [jest] }
pipelines:
  main:
    steps: [{ name: deploy, command: pnpm deploy, caches: [wrangler] }]
`;
  const onMain = { ...params, line: "main" };
  const SAVE_ALL = {
    pnpm: { restore: null, save: "main" },
    jest: { restore: null, save: "main" },
    wrangler: { restore: null, save: "main" },
  };
  it("keys each cache the run uses from the head's tree, before any container starts", async () => {
    const { looked, events, cacheCalls } = await pipeline({ config: CACHED, payload: onMain });
    expect(looked).toHaveLength(1);
    expect(looked[0]?.map((key) => key.name)).toEqual(["pnpm", "jest", "wrangler"]);
    for (const key of looked[0] ?? []) expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(configs.treeReads).toEqual(["abc123-main root"]);
    expect(events.indexOf("plan")).toBeLessThan(events.indexOf("run setup"));
    expect(cacheCalls).toEqual([]);

    const changed = await pipeline({ config: CACHED, payload: onMain, lockfile: "lock-2" });
    expect(changed.looked[0]?.[0]?.keyHash).not.toBe(looked[0]?.[0]?.keyHash);
    const same = await pipeline({ config: CACHED, payload: onMain });
    expect(same.looked[0]?.[0]?.keyHash).toBe(looked[0]?.[0]?.keyHash);
  });

  it("reads an attempt's fork for its keys, and looks up none without caches", async () => {
    await pipeline({ config: CACHED });
    expect(configs.treeReads).toEqual(["abc123-t1a1 root"]);
    const none = await pipeline();
    expect(none.looked).toEqual([]);
  });

  it("restores a hit into the container before its command, by its scope's key, and notes the hit", async () => {
    const { cacheCalls, looked, report, events } = await pipeline({
      config: CACHED,
      cacheLookup: { pnpm: { restore: "main", save: null }, jest: { restore: "main", save: null } },
    });
    const [pnpm, jest] = looked[0] ?? [];
    expect(cacheCalls).toEqual([
      `restore setup caches/abc123/main/pnpm/${pnpm?.keyHash ?? ""}.tar.zst`,
      `restore check:test caches/abc123/main/jest/${jest?.keyHash ?? ""}.tar.zst`,
      `restore check:e2e caches/abc123/main/jest/${jest?.keyHash ?? ""}.tar.zst`,
    ]);
    expect(events.indexOf("run setup")).toBeGreaterThan(-1);
    expect(notesOf(report, "deps")).toEqual(["cache pnpm: hit, main's entry restored (2.0 MB) in 1.5 s"]);
    expect(notesOf(report, "gen")).toEqual([]);
    // The setups' caches are in the snapshot each check starts from.
    expect(notesOf(report, "lint")).toEqual(["cache pnpm: in the setups' snapshot"]);
    expect(notesOf(report, "test")).toEqual(["cache jest: hit, main's entry restored (2.0 MB) in 1.5 s"]);
  });

  it("restores the setups' caches too into a check's container that re-runs the setups", async () => {
    const { cacheCalls, report } = await pipeline({
      config: CACHED,
      snapshot: null,
      cacheLookup: { pnpm: { restore: "main", save: null } },
    });
    expect(cacheCalls.filter((c) => c.startsWith("restore check:test"))).toHaveLength(1);
    expect(notesOf(report, "test")).toEqual([
      "setups re-run in this check's container: the run took no snapshot of them",
      "cache pnpm: hit, main's entry restored (2.0 MB) in 1.5 s",
      "cache jest: miss",
    ]);
  });

  it("runs without the cache when a restore fails, noting it as a miss", async () => {
    const { report } = await pipeline({
      config: CACHED,
      cacheLookup: { pnpm: { restore: "main", save: null } },
      cacheRestore: { pnpm: { kind: "failed", error: "exit 1: zstd: corrupted block" } },
    });
    expect(outcomeOf(report).gate).toBe("passed");
    expect(notesOf(report, "deps")).toEqual([
      "cache pnpm: miss: the restore failed, so this ran without it (exit 1: zstd: corrupted block)",
    ]);
  });

  it("notes a miss on every cache, and saves none, when the keys can't be read", async () => {
    const { report, cacheCalls, looked } = await pipeline({
      config: CACHED,
      payload: onMain,
      cacheLookup: SAVE_ALL,
      lockfile: "unreadable",
    });
    expect(looked).toEqual([]);
    expect(cacheCalls).toEqual([]);
    expect(outcomeOf(report).gate).toBe("passed");
    expect(notesOf(report, "deps")).toEqual(["cache pnpm: miss: its key couldn't be read (tree root is missing)"]);
  });

  it("saves each cache once its command passed, from one container each, and records it", async () => {
    const { cacheCalls, report, looked } = await pipeline({ config: CACHED, payload: onMain, cacheLookup: SAVE_ALL });
    const [pnpm, jest, wrangler] = (looked[0] ?? []).map((key) => key.keyHash);
    expect(cacheCalls.filter((c) => !c.startsWith("restore"))).toEqual([
      `save setup caches/abc123/main/pnpm/${pnpm ?? ""}.tar.zst`,
      "saved main/pnpm 3000000",
      `save check:test caches/abc123/main/jest/${jest ?? ""}.tar.zst`,
      "saved main/jest 3000000",
      `save step:deploy caches/abc123/main/wrangler/${wrangler ?? ""}.tar.zst`,
      "saved main/wrangler 3000000",
    ]);
    expect(notesOf(report, "deps")).toEqual(["cache pnpm: miss", "cache pnpm: saved for main (3.0 MB) in 2.5 s"]);
    expect(notesOf(report, "e2e")).toEqual(["cache jest: miss"]);
    expect(notesOf(report, "deploy")).toEqual([
      "cache wrangler: miss",
      "cache wrangler: saved for main (3.0 MB) in 2.5 s",
    ]);
  });

  it("saves nothing after a failed command", async () => {
    const { cacheCalls } = await pipeline({
      config: CACHED,
      payload: onMain,
      cacheLookup: SAVE_ALL,
      setups: { deps: 1 },
    });
    expect(cacheCalls.filter((c) => c.startsWith("save "))).toEqual([]);
    const failedCheck = await pipeline({ config: CACHED, payload: onMain, cacheLookup: SAVE_ALL, checks: { test: 1 } });
    expect(failedCheck.cacheCalls.filter((c) => c.startsWith("save ")).map((c) => c.split(" ")[1])).toEqual(["setup"]);
  });

  it("saves nothing where the project says the run doesn't save, saying why when it isn't trusted", async () => {
    const { cacheCalls, report } = await pipeline({
      config: CACHED,
      payload: { ...params, line: "t1" },
      cacheLookup: { pnpm: { restore: null, save: null, unsaved: "this run isn't trusted" } },
    });
    expect(cacheCalls.filter((c) => c.startsWith("save "))).toEqual([]);
    expect(notesOf(report, "deps")).toEqual(["cache pnpm: miss", "cache pnpm: not saved: this run isn't trusted"]);
  });

  it("never writes over an entry the project already has, and notes a save that failed", async () => {
    const { cacheCalls, report } = await pipeline({
      config: CACHED,
      payload: onMain,
      cacheLookup: SAVE_ALL,
      cacheEntries: ["main/pnpm"],
      cacheSave: { jest: { kind: "tooLarge" }, wrangler: { kind: "failed", error: "exit 2: tar: Broken pipe" } },
    });
    expect(cacheCalls.filter((c) => c.startsWith("save setup"))).toEqual([]);
    expect(cacheCalls.filter((c) => c.startsWith("saved"))).toEqual([]);
    expect(notesOf(report, "deps")).toEqual([
      "cache pnpm: miss",
      "cache pnpm: not saved: main already has an entry for its key, or another run is saving one",
    ]);
    expect(notesOf(report, "test")).toEqual(["cache jest: miss", "cache jest: not saved: over 2 GB"]);
    expect(notesOf(report, "deploy")).toEqual([
      "cache wrangler: miss",
      "cache wrangler: not saved: exit 2: tar: Broken pipe",
    ]);
    expect(outcomeOf(report).gate).toBe("passed");
    expect(outcomeOf(report).steps.find((s) => s.name === "deploy")?.outcome).toBe("passed");
  });

  it("stores each step's cache notes in its log", async () => {
    const { stored } = await pipeline({ config: CACHED, payload: onMain, cacheLookup: SAVE_ALL });
    expect(stored.get("logs/abc123/main/7/setup.1.log")).toContain(
      "== throng ==\nsandbox: standard-1\ncache pnpm: miss\ncache pnpm: saved for main (3.0 MB) in 2.5 s\n",
    );
  });
});

describe("teardownPipeline", () => {
  it("destroys every planned container, the setup one and an old run's score and preview containers, then releases the snapshot", async () => {
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
      "destroy i/preview",
      "destroy i/score",
      "destroy i/setup",
    ]);
    expect(events.at(-1)).toBe("release i/setup");
  });
});
