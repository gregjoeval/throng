import { describe, expect, it } from "vitest";
import { cloudflarePreviewWorkers } from "../src/preview-workers.ts";

const BASE = "https://api.cloudflare.com/client/v4/accounts/acct/workers/workers";

/** A Cloudflare API response envelope. */
function envelope(status: number, body: object = {}): Response {
  return new Response(JSON.stringify({ success: status < 300, errors: [], messages: [], ...body }), { status });
}

/** The Cloudflare API's Workers endpoints for account `acct`, in memory; `fail` makes every call a 500. */
function fakeApi(existing: string[] = []) {
  const workers = new Set(existing);
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let down = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    if (request.headers.get("Authorization") !== "Bearer tok") return envelope(403);
    if (down) return envelope(500, { errors: [{ message: "internal error" }] });
    if (request.url === BASE && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      bodies.push(body);
      if (workers.has(body.name)) return envelope(409);
      workers.add(body.name);
      return envelope(200, { result: { name: body.name } });
    }
    const name = request.url.startsWith(`${BASE}/`) ? request.url.slice(BASE.length + 1) : null;
    if (name === null) return envelope(400);
    if (request.method === "GET") return envelope(workers.has(name) ? 200 : 404);
    if (request.method === "DELETE") return envelope(workers.delete(name) ? 200 : 404);
    return envelope(405);
  };
  return { workers, calls, bodies, fetch, fail: () => (down = true) };
}

const previewWorkers = (api: ReturnType<typeof fakeApi>) =>
  cloudflarePreviewWorkers({ accountId: "acct", token: "tok", fetch: api.fetch });

describe("cloudflarePreviewWorkers", () => {
  it("creates the project's p<projectId> Worker, with Preview URLs on", async () => {
    const api = fakeApi();
    await previewWorkers(api).ensure("abc123");
    expect([...api.workers]).toEqual(["pabc123"]);
    expect(api.bodies).toEqual([{ name: "pabc123", subdomain: { enabled: true, previews_enabled: true } }]);
  });

  it("leaves a Worker that already exists, so it's safe to retry and backfills older projects", async () => {
    const api = fakeApi(["pabc123"]);
    await previewWorkers(api).ensure("abc123");
    await previewWorkers(api).ensure("abc123");
    expect([...api.workers]).toEqual(["pabc123"]);
    expect(api.bodies).toEqual([]);
  });

  it("deletes the project's Worker, and a missing one counts as deleted", async () => {
    const api = fakeApi(["pabc123", "pxyz789"]);
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
