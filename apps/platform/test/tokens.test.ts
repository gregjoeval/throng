import { describe, expect, it } from "vitest";
import { authenticateToken, hashToken, listTokens, mintToken, revokeToken } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

async function setup() {
  const db = testDatabase();
  const user = await userForEmail(db, "greg@example.com");
  return { db, user };
}

describe("tokens", () => {
  it("authenticates a minted token until it expires", async () => {
    const { db, user } = await setup();
    const { plaintext, token } = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: 60, now: NOW });
    expect(await authenticateToken(db, plaintext, at(59))).toEqual({ actor: { user, agent: null }, token });
    expect(await authenticateToken(db, plaintext, at(60))).toBeNull();
  });

  it("stores the SHA-256 hex of the plaintext and nothing that reveals it", async () => {
    const { db, user } = await setup();
    const { plaintext, token } = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: 60, now: NOW });
    const row = await db.prepare("SELECT * FROM tokens WHERE id = ?").bind(token.id).first<Record<string, unknown>>();
    expect(row?.["hash"]).toBe(await hashToken(plaintext));
    expect(JSON.stringify(row)).not.toContain(plaintext.slice(4));
    // SHA-256("abc"), the FIPS 180-2 test vector.
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("mints distinct tokens", async () => {
    const { db, user } = await setup();
    const a = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: 60, now: NOW });
    const b = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: 60, now: NOW });
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.token.id).not.toBe(b.token.id);
  });

  it("rejects revoked and unknown tokens", async () => {
    const { db, user } = await setup();
    const { plaintext, token } = await mintToken(db, { userId: user.id, agent: "claude", ttlSeconds: 60, now: NOW });
    expect(await revokeToken(db, { userId: user.id, id: token.id, now: NOW })).toMatchObject({
      revoked_at: NOW.toISOString(),
    });
    expect(await authenticateToken(db, plaintext, NOW)).toBeNull();
    expect(await authenticateToken(db, "thr_unknown", NOW)).toBeNull();
    expect(await authenticateToken(db, "", NOW)).toBeNull();
  });

  it("scopes listing and revoking to an agent when given", async () => {
    const { db, user } = await setup();
    const human = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: 60, now: NOW });
    const claude = await mintToken(db, { userId: user.id, agent: "claude", ttlSeconds: 60, now: at(1) });
    expect((await listTokens(db, user.id)).map((t) => t.id)).toEqual([claude.token.id, human.token.id]);
    expect((await listTokens(db, user.id, "claude")).map((t) => t.id)).toEqual([claude.token.id]);
    expect(await revokeToken(db, { userId: user.id, agent: "claude", id: human.token.id, now: NOW })).toBeNull();
    expect(await revokeToken(db, { userId: "someone", id: human.token.id, now: NOW })).toBeNull();
  });
});
