import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { publicApp, webApp } from "../src/app.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import { mintToken } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const verify: AccessVerifier = async (token) => (token === "valid" ? { email: "greg@example.com" } : null);

type Json = Record<string, any>;

async function setup() {
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const options = { verifierFor: () => verify, now: () => NOW };
  const apps = { public: publicApp(options), binding: webApp(options) };
  const owner = await userForEmail(env.DB, "owner@example.com");
  const { plaintext } = await mintToken(env.DB, { userId: owner.id, agent: null, ttlSeconds: 3600, now: NOW });
  const me = async (via: keyof typeof apps, headers: Record<string, string> = {}) => {
    const res = await apps[via].request("/api/me", { headers }, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  return { me, plaintext };
}

describe("the service binding (WebEntrypoint)", () => {
  it("accepts a forwarded email as the signed-in user, created on first sight", async () => {
    const { me } = await setup();
    const res = await me("binding", { [FORWARDED_EMAIL_HEADER]: "Ada@Example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { handle: "ada", email: "ada@example.com" }, agent: null, token: null });
  });

  it("is 401 without a forwarded email", async () => {
    const { me } = await setup();
    for (const headers of [{} as Record<string, string>, { [FORWARDED_EMAIL_HEADER]: " " }]) {
      const res = await me("binding", headers);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    }
  });

  it("still takes bearer tokens", async () => {
    const { me, plaintext } = await setup();
    const res = await me("binding", { Authorization: `Bearer ${plaintext}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: "owner@example.com" } });
  });
});

describe("the public hostname", () => {
  it("rejects a spoofed forwarded email", async () => {
    const { me } = await setup();
    const res = await me("public", { [FORWARDED_EMAIL_HEADER]: "owner@example.com" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  it("rejects the header even alongside a valid bearer token or Access session", async () => {
    const { me, plaintext } = await setup();
    const credentials: Record<string, string>[] = [
      { Authorization: `Bearer ${plaintext}` },
      { "Cf-Access-Jwt-Assertion": "valid" },
    ];
    for (const credential of credentials) {
      const res = await me("public", { ...credential, [FORWARDED_EMAIL_HEADER]: "owner@example.com" });
      expect(res.status).toBe(401);
    }
  });

  it("keeps bearer and Access auth unchanged", async () => {
    const { me, plaintext } = await setup();
    expect((await me("public", { Authorization: `Bearer ${plaintext}` })).body).toMatchObject({
      user: { email: "owner@example.com" },
    });
    expect((await me("public", { "Cf-Access-Jwt-Assertion": "valid" })).body).toMatchObject({
      user: { email: "greg@example.com" },
    });
    expect((await me("public")).status).toBe(401);
  });
});
