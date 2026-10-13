// RunSandbox against a fake container: which size a container starts at. `cloudflare:workers` is
// stubbed; the container records what it was asked.

import { describe, expect, it, vi } from "vitest";
import type { SandboxSize } from "../src/config.ts";
import { importWorkerModule } from "./support/worker-module.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));

const { RunSandbox } = await importWorkerModule<{
  RunSandbox: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (script: string, options: unknown) => Promise<{ exitCode: number; startMs: number }> };
}>("sandbox");

const NO_ACCESS = { grants: [], preview: null, registries: [], allow: [] };

/** A RunSandbox over a fake container, and the options each `start` was given. */
function sandbox() {
  const starts: Record<string, unknown>[] = [];
  const container = {
    running: false,
    images: { sandbox: "sandbox:latest" },
    start(options: Record<string, unknown>) {
      starts.push(options);
      container.running = true;
    },
    interceptOutboundHttps: async () => {},
    setInactivityTimeout: async () => {},
    exec: async () => ({
      exitCode: Promise.resolve(0),
      output: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
    }),
  };
  const ctx = { container, exports: { OutboundAuth: () => ({}) } };
  return { sandbox: new RunSandbox(ctx, {}), starts, container };
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
});
