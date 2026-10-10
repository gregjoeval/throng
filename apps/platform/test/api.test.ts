import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { testDatabase } from "./support/d1.ts";

const verify: AccessVerifier = async (token) => (token === "valid" ? { email: "greg@example.com" } : null);

function setup() {
  const api = apiRoutes(() => verify);
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const me = (token?: string) =>
    api.request("/me", token === undefined ? {} : { headers: { "Cf-Access-Jwt-Assertion": token } }, env);
  return { me };
}

describe("GET /api/me", () => {
  it("is 401 without an Access session", async () => {
    const { me } = setup();
    expect((await me()).status).toBe(401);
    expect((await me("forged")).status).toBe(401);
  });

  it("returns the signed-in user, created on first sight", async () => {
    const { me } = setup();
    const first = await me("valid");
    expect(first.status).toBe(200);
    const user = await first.json();
    expect(user).toMatchObject({ handle: "greg", email: "greg@example.com" });
    expect(await (await me("valid")).json()).toEqual(user);
  });
});
