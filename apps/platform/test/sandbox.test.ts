// RunSandbox against a fake container: which size and source a container starts at, what each
// script gets, and its snapshots. `cloudflare:workers` is stubbed; the container records what it was
// asked.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import { importWorkerModule } from "./support/worker-module.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

interface SandboxSnapshot {
  id: string;
  size: number;
}

interface Sandbox {
  run: (script: string, options: unknown) => Promise<{ exitCode: number; startMs: number }>;
  runIfRunning: (script: string, options: unknown) => Promise<{ exitCode: number; startMs: number } | null>;
  restore: (snapshot: SandboxSnapshot, options: unknown) => Promise<boolean>;
  snapshot: () => Promise<SandboxSnapshot | null>;
  releaseSnapshot: () => void;
}

const { RunSandbox } = await importWorkerModule<{ RunSandbox: new (ctx: unknown, env: unknown) => Sandbox }>("sandbox");

const NO_ACCESS = { grants: [], registries: [], allow: [] };
const SNAPSHOT = { id: "snap-1", size: 400_000_000 };

/**
 * A RunSandbox over a fake container, the options each `start` was given and each `exec`'s env.
 * `failStarts` starts fail before the container comes up.
 */
function sandbox({ image = "registry.cloudflare.com/acct/throng:abc", failStarts = 0 } = {}) {
  const starts: Record<string, unknown>[] = [];
  const envs: Record<string, string>[] = [];
  let failing = failStarts;
  const container = {
    running: false,
    images: { sandbox: image },
    start(options: Record<string, unknown>) {
      starts.push(options);
      container.running = true;
    },
    destroy: async () => {
      container.running = false;
    },
    interceptOutboundHttps: async () => {},
    setInactivityTimeout: async () => {},
    snapshots: 0,
    snapshotContainer: async () => {
      container.snapshots += 1;
      return { id: container.snapshots === 1 ? "snap-1" : `snap-${container.snapshots}`, size: 400_000_000, name: "" };
    },
    exec: async (_cmd: string[], options?: { env?: Record<string, string> }) => {
      if (options?.env === undefined && failing > 0) {
        failing -= 1;
        throw new Error("Network connection lost");
      }
      if (options?.env !== undefined) envs.push(options.env);
      return {
        exitCode: Promise.resolve(0),
        output: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      };
    },
  };
  const kv = new Map<string, unknown>();
  const storage = {
    kv: {
      get: (key: string) => kv.get(key),
      put: (key: string, value: unknown) => kv.set(key, value),
      delete: (key: string) => kv.delete(key),
    },
  };
  const ctx = { container, exports: { OutboundAuth: () => ({}) }, storage };
  return { sandbox: new RunSandbox(ctx, {}), starts, envs, container, kv };
}

describe("RunSandbox", () => {
  it.each<SandboxSize>(["lite", "standard-1", "standard-4"])(
    "starts its container at the size it's given: %s",
    async (size) => {
      const { sandbox: box, starts } = sandbox();
      await box.run("true", { access: NO_ACCESS, size });
      expect(starts).toEqual([expect.objectContaining({ instance: size, enableInternet: false })]);
    },
  );

  it("keeps a running container's size: only the next start takes a new one", async () => {
    const { sandbox: box, starts, container } = sandbox();
    await box.run("true", { access: NO_ACCESS, size: "standard-1" });
    await box.run("true", { access: NO_ACCESS, size: "standard-3" });
    expect(starts.map((s) => s["instance"])).toEqual(["standard-1"]);
    container.running = false;
    await box.run("true", { access: NO_ACCESS, size: "standard-3" });
    expect(starts.map((s) => s["instance"])).toEqual(["standard-1", "standard-3"]);
  });

  it("gives a script its variables under the container's own, which it can't override", async () => {
    const { sandbox: box, envs } = sandbox();
    await box.run("true", {
      access: NO_ACCESS,
      size: "lite",
      env: { THRONG_RUN: "7", GIT_TERMINAL_PROMPT: "1" },
    });
    expect(envs).toEqual([expect.objectContaining({ THRONG_RUN: "7", GIT_TERMINAL_PROMPT: "0" })]);
  });

  it("restores a container from a snapshot, and the script runs in it without another start", async () => {
    const { sandbox: box, starts } = sandbox();
    expect(await box.restore(SNAPSHOT, { access: NO_ACCESS, size: "standard-2" })).toBeTruthy();
    await box.run("true", { access: NO_ACCESS, size: "standard-2" });
    expect(starts).toEqual([{ containerSnapshot: { id: "snap-1" }, instance: "standard-2", enableInternet: false }]);
  });

  it("stops a container whose restore failed, so the next try starts it afresh", async () => {
    const { sandbox: box, starts, container } = sandbox({ failStarts: 1 });
    expect(await box.restore(SNAPSHOT, { access: NO_ACCESS, size: "standard-1" })).toBeFalsy();
    expect(container.running).toBeFalsy();
    expect(await box.restore(SNAPSHOT, { access: NO_ACCESS, size: "standard-1" })).toBeTruthy();
    expect(starts).toHaveLength(2);
  });

  it("keeps its snapshot until it's released, once, with no snapshot API to delete it", async () => {
    const { sandbox: box, kv } = sandbox();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await box.run("true", { access: NO_ACCESS, size: "lite" });
    await box.snapshot();
    expect(kv.get("snapshot")).toEqual(SNAPSHOT);
    box.releaseSnapshot();
    box.releaseSnapshot();
    expect(kv.has("snapshot")).toBeFalsy();
    expect(log.mock.calls).toEqual([[{ event: "sandbox.snapshot_expires", snapshot: "snap-1", size: 400_000_000 }]]);
    log.mockRestore();
  });

  it("releases the snapshot it took before when it takes another, as a retried setup step does", async () => {
    const { sandbox: box, kv } = sandbox();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await box.run("true", { access: NO_ACCESS, size: "lite" });
    await box.snapshot();
    await box.snapshot();
    expect(kv.get("snapshot")).toEqual({ ...SNAPSHOT, id: "snap-2" });
    box.releaseSnapshot();
    expect(log.mock.calls.map(([call]) => (call as { snapshot: string }).snapshot)).toEqual(["snap-1", "snap-2"]);
    log.mockRestore();
  });

  it("runs a script in a running container only, never starting one that's gone", async () => {
    const { sandbox: box, starts, envs, container } = sandbox();
    expect(await box.runIfRunning("true", { env: { A: "1" } })).toBeNull();
    expect(starts).toEqual([]);
    expect(envs).toEqual([]);
    await box.run("true", { access: NO_ACCESS, size: "lite" });
    expect(await box.runIfRunning("true", { env: { A: "1" } })).toMatchObject({ exitCode: 0, startMs: 0 });
    expect(envs.at(-1)).toMatchObject({ A: "1" });
    container.running = false;
    expect(await box.runIfRunning("true", {})).toBeNull();
    expect(starts).toHaveLength(1);
  });

  it("snapshots a deployed container, and none under wrangler dev", async () => {
    const deployed = sandbox();
    await deployed.sandbox.run("true", { access: NO_ACCESS, size: "lite" });
    expect(await deployed.sandbox.snapshot()).toEqual(SNAPSHOT);
    const local = sandbox({ image: "cloudflare-dev/runsandbox-sandbox-0123abcd:build" });
    await local.sandbox.run("true", { access: NO_ACCESS, size: "lite" });
    expect(await local.sandbox.snapshot()).toBeNull();
  });
});
