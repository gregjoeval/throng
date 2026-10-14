import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";

const verify: AccessVerifier = async (token) => (token === "valid" ? { email: "greg@example.com" } : null);

function setup() {
  const repos = new FakeRepos();
  const api = apiRoutes({ verifierFor: () => verify, repos: () => repos });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const request = (path: string, init: RequestInit) => api.request(path, init, env);
  const mint = async (body: object = {}) => {
    const res = await request("/tokens", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "valid", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return ((await res.json()) as { token: string }).token;
  };
  const validate = async (body: string, headers: Record<string, string>) => {
    const res = await request("/config/validate", { method: "POST", headers, body });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { request, mint, validate };
}

describe("POST /api/config/validate", () => {
  it("returns the parse result for a YAML body, to any valid token", async () => {
    const { mint, validate } = setup();
    for (const token of [await mint(), await mint({ alias: "claude" })]) {
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/yaml" };
      expect(await validate("checks:\n  - { name: test, command: pnpm test }\n", headers)).toEqual({
        status: 200,
        body: {
          kind: "valid",
          config: {
            setup: [],
            network: { allow: [] },
            checks: [
              { name: "test", command: "pnpm test", timeoutMs: 600_000, after: [], secrets: [], source: "project" },
            ],
            metrics: [],
            attempts: { limit: null },
            selection: { policy: "creator" },
            sandbox: { size: "standard-1" },
          },
        },
      });
    }
  });

  it("returns an invalid config as a 200, and takes text/plain", async () => {
    const { mint, validate } = setup();
    const headers = { Authorization: `Bearer ${await mint()}`, "Content-Type": "text/plain" };
    expect(
      await validate(
        "checks: [{ name: t, command: x }]\nmetrics: [{ name: m, from: t.r.m, type: number, target: 1 }]",
        headers,
      ),
    ).toEqual({
      status: 200,
      body: {
        kind: "invalid",
        error: "metrics[0].target: target is reserved and not supported yet; remove it",
      },
    });
    expect((await validate("", headers)).body).toMatchObject({ kind: "valid" });
  });

  it("is 401 without a bearer token, even with an Access session", async () => {
    const { validate } = setup();
    const cases: Record<string, string>[] = [
      {},
      { "Cf-Access-Jwt-Assertion": "valid" },
      { Authorization: "Bearer thr_nope" },
    ];
    for (const headers of cases) {
      const res = await validate("{}", headers);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    }
  });

  it("is described in the OpenAPI document", async () => {
    const { request } = setup();
    const doc = (await (await request("/openapi.json", {})).json()) as Json;
    const op = doc["paths"]["/config/validate"]["post"];
    expect(op).toMatchObject({ operationId: "validateConfig", tags: ["Config"], summary: expect.any(String) });
    expect(Object.keys(op["requestBody"]["content"])).toEqual(["application/yaml", "text/plain"]);
    expect(doc["components"]["schemas"]["ConfigResult"]).toBeDefined();
  });
});
