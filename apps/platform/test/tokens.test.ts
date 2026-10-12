import { describe, expect, it } from "vitest";
import {
  authenticateToken,
  DEFAULT_TOKEN_TTL_SECONDS,
  hashToken,
  listTokens,
  mintToken,
  revokeToken,
  tokenService,
} from "../src/tokens.ts";
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

async function service() {
  const { db, user } = await setup();
  return { tokens: tokenService({ db, now: () => NOW }), user };
}

describe("the token service", () => {
  it("mints for the human or one of their agents, with a default lifetime", async () => {
    const { tokens, user } = await service();
    const human = await tokens.mint({ user, agent: null }, { via: null });
    expect(human.token).toMatchObject({
      user_id: user.id,
      agent: null,
      expires_at: at(DEFAULT_TOKEN_TTL_SECONDS).toISOString(),
    });
    const claude = await tokens.mint({ user, agent: null }, { agent: "claude", expiresIn: 60, via: null });
    expect(claude.token).toMatchObject({ agent: "claude", expires_at: at(60).toISOString() });
  });

  it("lets an agent mint only for itself, never for its human or another agent", async () => {
    const { tokens, user } = await service();
    const claude = { user, agent: "claude" };
    const { token: via } = await tokens.mint(claude, { via: null });
    await expect(tokens.mint(claude, { agent: "codex", via })).rejects.toMatchObject({ code: "forbidden" });
    expect((await tokens.mint(claude, { via })).token.agent).toBe("claude");
  });

  it("never mints a token that outlives the one minting it", async () => {
    const { tokens, user } = await service();
    const actor = { user, agent: null };
    const { token: via } = await tokens.mint(actor, { expiresIn: 60, via: null });
    expect((await tokens.mint(actor, { via })).token.expires_at).toBe(at(60).toISOString());
    await expect(tokens.mint(actor, { expiresIn: 61, via })).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("lists and revokes only the actor's own tokens", async () => {
    const { tokens, user } = await service();
    const human = await tokens.mint({ user, agent: null }, { via: null });
    const claude = await tokens.mint({ user, agent: "claude" }, { via: null });
    expect((await tokens.list({ user, agent: "claude" })).map((t) => t.id)).toEqual([claude.token.id]);
    await expect(tokens.revoke({ user, agent: "claude" }, { id: human.token.id })).rejects.toMatchObject({
      code: "notFound",
    });
    expect((await tokens.revoke({ user, agent: null }, { id: human.token.id })).revoked_at).toBe(NOW.toISOString());
  });
});
