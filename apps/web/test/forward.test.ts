import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { accessVerifier } from "@/server/access";
import type { AccessVerifier } from "@/server/access";
import { forwardToPlatform, isApiRequest } from "@/server/forward";
import type { Platform } from "@/server/forward";

const TEAM = "throng.cloudflareaccess.com";
const AUD = "test-aud";

let sign: (claims: Record<string, unknown>) => Promise<string>;
let verify: AccessVerifier;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  sign = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  verify = accessVerifier(createLocalJWKSet({ keys: [jwk] }), { teamDomain: TEAM, aud: AUD });
});

/** A platform that records what reached it. */
function fakePlatform() {
  const received: Request[] = [];
  const platform: Platform = {
    fetch: async (request) => {
      received.push(request);
      return Response.json({ ok: true });
    },
  };
  return { platform, received };
}

const request = (headers: Record<string, string>) =>
  new Request("https://throng-web.example.workers.dev/api/me?x=1", { headers });

describe("forwardToPlatform", () => {
  it("forwards an Access-verified request with the user's email and nothing else that identifies them", async () => {
    const { platform, received } = fakePlatform();
    const jwt = await sign({ aud: [AUD], email: "Ada@Example.com" });
    const res = await forwardToPlatform(
      request({
        "Cf-Access-Jwt-Assertion": jwt,
        Cookie: `CF_Authorization=${jwt}`,
        Authorization: "Bearer thr_someone_else",
        "X-Throng-Access-Email": "mallory@example.com",
        Accept: "application/json",
      }),
      platform,
      verify,
    );
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    const [forwarded] = received;
    if (forwarded === undefined) throw new Error("no request was forwarded");
    expect(new URL(forwarded.url).pathname + new URL(forwarded.url).search).toBe("/api/me?x=1");
    expect(forwarded.headers.get("X-Throng-Access-Email")).toBe("ada@example.com");
    expect(forwarded.headers.get("Accept")).toBe("application/json");
    for (const name of ["Authorization", "Cookie", "Cf-Access-Jwt-Assertion"]) {
      expect(forwarded.headers.has(name)).toBeFalsy();
    }
  });

  it("is 401 without a valid Access JWT, and forwards nothing", async () => {
    const { platform, received } = fakePlatform();
    const forged = await new SignJWT({ aud: [AUD], email: "ada@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setExpirationTime("1h")
      .sign((await generateKeyPair("RS256")).privateKey);
    const cases: Record<string, string>[] = [
      {},
      { "Cf-Access-Jwt-Assertion": forged },
      { "X-Throng-Access-Email": "ada@example.com" },
    ];
    for (const headers of cases) {
      const res = await forwardToPlatform(request(headers), platform, verify);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    }
    expect(received).toHaveLength(0);
  });
});

const at = (path: string) => isApiRequest(new URL(path, "https://throng-web.example"));

describe("isApiRequest", () => {
  it("matches /api and paths under it only", () => {
    expect([at("/api"), at("/api/"), at("/api/me")]).toEqual([true, true, true]);
    expect([at("/"), at("/apis"), at("/x/api/me")]).toEqual([false, false, false]);
  });
});
