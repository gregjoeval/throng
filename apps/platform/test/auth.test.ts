import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { basicPassword, bearerAuth, bearerToken, gitAuth } from "../src/auth.ts";
import type { AuthEnv } from "../src/auth.ts";
import { mintToken, revokeToken } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

const whoami = (c: { var: AuthEnv["Variables"]; json: (body: unknown) => Response }) =>
  c.json({ handle: c.var.actor.user.handle, alias: c.var.actor.alias, token: c.var.token?.id ?? null });
const basic = (username: string, password: string) => `Basic ${btoa(`${username}:${password}`)}`;

async function setup() {
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const user = await userForEmail(env.DB, "greg@example.com");
  const { token, plaintext } = await mintToken(env.DB, {
    userId: user.id,
    alias: "claude",
    ttlSeconds: 3600,
    now: NOW,
  });
  const app = new Hono<AuthEnv>();
  app.get("/api/x", bearerAuth({ now: () => NOW }), whoami);
  app.get("/git/x", gitAuth({ now: () => NOW }), whoami);
  const get = (path: string, authorization?: string) =>
    app.request(path, authorization === undefined ? {} : { headers: { Authorization: authorization } }, env);
  return { env, user, token, plaintext, get };
}

describe("bearerAuth", () => {
  it("exposes the token's user and alias", async () => {
    const { get, plaintext, token } = await setup();
    const res = await get("/api/x", `Bearer ${plaintext}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handle: "greg", alias: "claude", token: token.id });
  });

  it("rejects Basic credentials, unknown tokens and missing headers", async () => {
    const { get, plaintext } = await setup();
    for (const header of [undefined, basic("x", plaintext), "Bearer thr_unknown", `Bearer ${plaintext}x`]) {
      const res = await get("/api/x", header);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/u);
    }
  });

  it("rejects a revoked token", async () => {
    const { env, get, plaintext, token, user } = await setup();
    await revokeToken(env.DB, { userId: user.id, id: token.id, now: NOW });
    expect((await get("/api/x", `Bearer ${plaintext}`)).status).toBe(401);
  });
});

describe("gitAuth", () => {
  it("takes the token as the Basic password with any username", async () => {
    const { get, plaintext } = await setup();
    for (const username of ["git", "x-access-token", ""]) {
      const res = await get("/git/x", basic(username, plaintext));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ handle: "greg", alias: "claude" });
    }
  });

  it("takes the token as a bearer header", async () => {
    const { get, plaintext } = await setup();
    const res = await get("/git/x", `Bearer ${plaintext}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "greg", alias: "claude" });
  });

  it("challenges for Basic credentials when the token is missing or wrong", async () => {
    const { get, plaintext } = await setup();
    for (const header of [undefined, "Bearer thr_wrong", basic(plaintext, "thr_wrong"), "Basic !!!"]) {
      const res = await get("/git/x", header);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="throng"');
    }
  });
});

describe("credential parsing", () => {
  it("reads bearer tokens", () => {
    expect(bearerToken("Bearer thr_abc")).toBe("thr_abc");
    expect(bearerToken("bearer  thr_abc")).toBe("thr_abc");
    expect(bearerToken("Basic thr_abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("reads Basic passwords, which may contain colons", () => {
    expect(basicPassword(`Basic ${btoa("u:p:q")}`)).toBe("p:q");
    expect(basicPassword(`Basic ${btoa("no-colon")}`)).toBeNull();
    expect(basicPassword("Bearer x")).toBeNull();
  });

  it("matches the scheme in ASCII only, not by Unicode case folding", () => {
    // U+017F (long s) case-folds to "s".
    expect(basicPassword(`Ba\u017Fic ${btoa("u:p")}`)).toBeNull();
    expect(basicPassword(`BASIC ${btoa("u:p")}`)).toBe("p");
  });
});
