// RunSandbox's cache transfers against a fake container and a fake R2 bucket: a restore streams the
// object into the container's stdin, a save streams the container's stdout into a multipart upload,
// and anything that goes wrong comes back as an answer, never a throw. `cloudflare:workers` is
// stubbed, and the entry cap is lowered so a test can go over it.

import { describe, expect, it, vi } from "vitest";
import type { CacheRestore, CacheSave } from "../src/caches.ts";
import { importWorkerModule } from "./support/worker-module.ts";

vi.mock("cloudflare:workers", () => import("./support/cloudflare-workers.ts"));
vi.mock("../src/caches.ts", async (original) => ({
  ...(await original<typeof import("../src/caches.ts")>()),
  MAX_CACHE_ENTRY_BYTES: 20 * 1024 * 1024,
}));

interface Sandbox {
  run: (script: string, options: unknown) => Promise<unknown>;
  restoreCache: (key: string, paths: string[], options: unknown) => Promise<CacheRestore>;
  saveCache: (key: string, paths: string[]) => Promise<CacheSave>;
  image: () => string;
}

const { RunSandbox } = await importWorkerModule<{ RunSandbox: new (ctx: unknown, env: unknown) => Sandbox }>("sandbox");

const NO_ACCESS = { grants: [], registries: [], allow: [] };
const MIB = 1024 * 1024;
const PATHS = ["~/.local/share/pnpm/store", "~/.cache/pnpm"];

/** A stream of `chunks`, each that many bytes. */
function bytes(...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(7));
      controller.close();
    },
  });
}

/** What a cache command in the fake container does: what it prints, and how it exits. */
interface Command {
  stdout?: number[];
  stderr?: string;
  exit?: number;
}

function setup({ command = {} as Command, object = null as Uint8Array | null } = {}) {
  const execs: { cmd: string[]; cwd?: string; stdin: Uint8Array | null }[] = [];
  const container = {
    running: false,
    images: { sandbox: "registry.cloudflare.com/acct/throng:abc" },
    start() {
      container.running = true;
    },
    destroy: async () => {
      container.running = false;
    },
    interceptOutboundHttps: async () => {},
    setInactivityTimeout: async () => {},
    exec: async (cmd: string[], options?: { cwd?: string; stdin?: ReadableStream; stdout?: string }) => {
      const stdin =
        options?.stdin === undefined ? null : new Uint8Array(await new Response(options.stdin).arrayBuffer());
      execs.push({ cmd, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }), stdin });
      const exit = command.exit ?? 0;
      const stderr = new TextEncoder().encode(command.stderr ?? "");
      return {
        exitCode: Promise.resolve(exit),
        stdout: options?.stdout === "pipe" ? bytes(...(command.stdout ?? [])) : null,
        stderr: options?.stdout === "pipe" ? new Response(stderr).body : null,
        kill: () => {},
        output: async () => ({ exitCode: exit, stdout: new ArrayBuffer(0), stderr: stderr.buffer }),
      };
    },
  };
  const uploads: { key: string; parts: number[]; completed: boolean; aborted: boolean }[] = [];
  const CACHES = {
    get: async (key: string) =>
      object === null ? null : { key, size: object.byteLength, body: new Response(object).body },
    createMultipartUpload: async (key: string) => {
      const upload = { key, parts: [] as number[], completed: false, aborted: false };
      uploads.push(upload);
      return {
        uploadPart: async (n: number, body: Uint8Array) => {
          upload.parts[n - 1] = body.byteLength;
          return { partNumber: n, etag: `e${n}` };
        },
        complete: async () => {
          upload.completed = true;
        },
        abort: async () => {
          upload.aborted = true;
        },
      };
    },
  };
  const ctx = {
    container,
    exports: { OutboundAuth: () => ({}) },
    storage: { kv: { get: () => undefined, put: () => {}, delete: () => {} } },
  };
  return { sandbox: new RunSandbox(ctx, { CACHES }), execs, uploads, container };
}

const KEY = "caches/abc123/main/pnpm/f00.tar.zst";

describe("RunSandbox caches", () => {
  it("restores an entry by streaming it into zstd -d | tar -x at /, starting the container first", async () => {
    const object = new Uint8Array(5 * MIB).fill(1);
    const { sandbox, execs, container } = setup({ object });
    const restored = await sandbox.restoreCache(KEY, PATHS, { access: NO_ACCESS, size: "standard-1" });
    expect(restored).toMatchObject({ kind: "restored", bytes: 5 * MIB });
    expect(container.running).toBeTruthy();
    const restore = execs.at(-1);
    expect(restore?.cwd).toBe("/");
    expect(restore?.cmd.at(-1)).toMatch(/zstd -q -d -T0 -c \| tar -xf -/u);
    expect(restore?.stdin?.byteLength).toBe(5 * MIB);
  });

  it("answers missing for an entry whose object is gone, and failed for an extract that failed", async () => {
    expect(await setup().sandbox.restoreCache(KEY, PATHS, { access: NO_ACCESS, size: "lite" })).toEqual({
      kind: "missing",
    });
    const broken = setup({ object: new Uint8Array(10), command: { exit: 2, stderr: "zstd: corrupted block\n" } });
    expect(await broken.sandbox.restoreCache(KEY, PATHS, { access: NO_ACCESS, size: "lite" })).toEqual({
      kind: "failed",
      error: "exit 2: zstd: corrupted block",
    });
    // The failed extract removes the cache's paths again, so nothing half-restored is left.
    expect(broken.execs.at(-1)?.cmd.at(-1)).toContain(`rm -rf -- "$home"/'.local/share/pnpm/store'`);
  });

  it("saves the container's tar | zstd as a multipart upload of 16 MiB parts, then completes it", async () => {
    const { sandbox, uploads, execs, container } = setup({ command: { stdout: [10 * MIB, 8 * MIB] } });
    container.running = true;
    const saved = await sandbox.saveCache(KEY, PATHS);
    expect(saved).toMatchObject({ kind: "saved", bytes: 18 * MIB });
    expect(uploads).toEqual([{ key: KEY, parts: [16 * MIB, 2 * MIB], completed: true, aborted: false }]);
    expect(execs.at(-1)?.cmd.at(-1)).toMatch(/tar -cf - -- "\$\{saved\[@\]\}" \| zstd -q -3 -T0 -c/u);
  });

  it("keeps nothing over the cap, nor when the save fails, nor with none of its paths there", async () => {
    const large = setup({ command: { stdout: [8 * MIB, 8 * MIB, 8 * MIB] } });
    large.container.running = true;
    expect(await large.sandbox.saveCache(KEY, PATHS)).toEqual({ kind: "tooLarge" });
    expect(large.uploads[0]).toMatchObject({ completed: false, aborted: true });

    const failing = setup({ command: { stdout: [MIB], exit: 1, stderr: "tar: store: Cannot stat\n" } });
    failing.container.running = true;
    expect(await failing.sandbox.saveCache(KEY, PATHS)).toEqual({
      kind: "failed",
      error: "exit 1: tar: store: Cannot stat",
    });
    expect(failing.uploads[0]).toMatchObject({ completed: false, aborted: true });

    const empty = setup({ command: { exit: 3 } });
    empty.container.running = true;
    expect(await empty.sandbox.saveCache(KEY, PATHS)).toEqual({ kind: "empty" });
  });

  it("saves nothing from a container that's gone", async () => {
    const { sandbox, uploads } = setup({ command: { stdout: [MIB] } });
    expect(await sandbox.saveCache(KEY, PATHS)).toEqual({ kind: "failed", error: "its container is gone" });
    expect(uploads).toEqual([]);
  });

  it("names its image, which keys every cache", () => {
    expect(setup().sandbox.image()).toBe("registry.cloudflare.com/acct/throng:abc");
  });
});
