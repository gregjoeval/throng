import { describe, expect, it } from "vitest";
import { cloudflarePreviewWorkers } from "../src/preview-workers.ts";

const BASE = "https://api.cloudflare.com/client/v4/accounts/acct/workers/workers";

/** A Cloudflare API response envelope. */
function envelope(status: number, body: object = {}): Response {
  return new Response(JSON.stringify({ success: status < 300, errors: [], messages: [], ...body }), { status });
}

/**
 * The Cloudflare API's Workers endpoints for account `acct`, in memory, with the bodies of its create
 * calls. A missing Worker answers `notFoundStatus` with the API's not-found code. After `fail()`,
 * every call answers 500; a `race` callback runs just before each create, as a concurrent one would.
 */
function fakeApi(existing: string[] = [], { notFoundStatus = 404 } = {}) {
  const workers = new Set(existing);
  const bodies: unknown[] = [];
  let down = false;
  let racer: ((name: string) => void) | null = null;
  const notFound = () =>
    envelope(notFoundStatus, { errors: [{ code: 10_007, message: "This Worker does not exist" }] });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.headers.get("Authorization") !== "Bearer tok") return envelope(403);
    if (down) return envelope(500, { errors: [{ message: "internal error" }] });
    if (request.url === BASE && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      bodies.push(body);
      racer?.(body.name);
      if (workers.has(body.name)) return envelope(409, { errors: [{ message: "already exists" }] });
      workers.add(body.name);
      return envelope(200, { result: { name: body.name } });
    }
    const name = request.url.startsWith(`${BASE}/`) ? request.url.slice(BASE.length + 1) : null;
    if (name === null) return envelope(400);
    if (request.method === "GET") return workers.has(name) ? envelope(200) : notFound();
    if (request.method === "DELETE") return workers.delete(name) ? envelope(200) : notFound();
    return envelope(405);
  };
  return {
    workers,
    bodies,
    fetch,
    fail: () => (down = true),
    race: (run: (name: string) => void) => (racer = run),
  };
}

const previewWorkers = (api: ReturnType<typeof fakeApi>) =>
  cloudflarePreviewWorkers({ accountId: "acct", token: "tok", fetch: api.fetch });

describe("cloudflarePreviewWorkers", () => {
  it("creates the project's p<projectId> Worker, with Preview URLs on", async () => {
    const api = fakeApi();
    expect(await previewWorkers(api).ensure("abc123")).toBeTruthy();
    expect([...api.workers]).toEqual(["pabc123"]);
    expect(api.bodies).toEqual([{ name: "pabc123", subdomain: { enabled: true, previews_enabled: true } }]);
  });

  it("leaves a Worker that already exists, so it's safe to retry and backfills older projects", async () => {
    const api = fakeApi(["pabc123"]);
    expect(await previewWorkers(api).ensure("abc123")).toBeFalsy();
    expect(await previewWorkers(api).ensure("abc123")).toBeFalsy();
    expect([...api.workers]).toEqual(["pabc123"]);
    expect(api.bodies).toEqual([]);
  });

  it("counts a Worker a concurrent call created first as there, and not created by this one", async () => {
    const api = fakeApi();
    api.race((name) => api.workers.add(name));
    expect(await previewWorkers(api).ensure("abc123")).toBeFalsy();
    expect([...api.workers]).toEqual(["pabc123"]);
  });

  it("deletes the project's Worker, and a missing one counts as deleted", async () => {
    const api = fakeApi(["pabc123", "pxyz789"]);
    await previewWorkers(api).delete("abc123");
    await previewWorkers(api).delete("abc123");
    expect([...api.workers]).toEqual(["pxyz789"]);
  });

  it("knows a missing Worker by the API's not-found code, whatever the status", async () => {
    const api = fakeApi(["pabc123"], { notFoundStatus: 400 });
    expect(await previewWorkers(api).ensure("xyz789")).toBeTruthy();
    await previewWorkers(api).delete("abc123");
    await previewWorkers(api).delete("abc123");
    expect([...api.workers]).toEqual(["pxyz789"]);
  });

  it("throws on any other API error, naming the Worker", async () => {
    const api = fakeApi(["pabc123"]);
    api.fail();
    await expect(previewWorkers(api).ensure("abc123")).rejects.toThrow(/pabc123: 500 .*internal error/u);
    await expect(previewWorkers(api).delete("abc123")).rejects.toThrow(/pabc123: 500 .*internal error/u);
  });
});
