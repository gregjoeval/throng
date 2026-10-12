import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { accessVerifier } from "../src/access.ts";
import type { AccessVerifier } from "../src/access.ts";

const TEAM = "throng.cloudflareaccess.com";
const AUD = "test-aud";

let sign: (claims: Record<string, unknown>, options?: { expiresIn?: string | number }) => Promise<string>;
let verify: AccessVerifier;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  sign = (claims, { expiresIn = "1h" } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  verify = accessVerifier(createLocalJWKSet({ keys: [jwk] }), { teamDomain: TEAM, aud: AUD });
});

describe("accessVerifier", () => {
  it("accepts a token signed by the team for our aud", async () => {
    expect(await verify(await sign({ aud: [AUD], email: "Greg@example.com" }))).toEqual({ email: "greg@example.com" });
  });

  it("rejects an expired token", async () => {
    const token = await sign(
      { aud: [AUD], email: "greg@example.com" },
      { expiresIn: Math.floor(Date.now() / 1000) - 60 },
    );
    expect(await verify(token)).toBeNull();
  });

  it("rejects a token for another application's aud", async () => {
    expect(await verify(await sign({ aud: ["someone-else"], email: "greg@example.com" }))).toBeNull();
  });

  it("rejects a token signed by a key outside the team's certs", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ aud: [AUD], email: "greg@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verify(forged)).toBeNull();
  });

  it("rejects garbage and tokens without an email", async () => {
    expect(await verify("not-a-jwt")).toBeNull();
    expect(await verify(await sign({ aud: [AUD], common_name: "service-token" }))).toBeNull();
  });
});
