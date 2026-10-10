// Throng tokens: what machines (agents, the CLI, git) present instead of an Access session.
// The plaintext `thr_<random>` is returned once at mint time; only its SHA-256 hash is stored.

import { randomId, type Database, type User } from "./users.ts";

export const TOKEN_PREFIX = "thr_";
export const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const MAX_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_ID_LENGTH = 12;
const TOKEN_SECRET_BYTES = 32;

/** A token as stored and listed: never the plaintext or its hash. */
export interface Token {
  id: string;
  user_id: string;
  agent: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** Who is acting: a user, and the agent alias they act under when the token names one. */
export interface Actor {
  user: User;
  agent: string | null;
}

const TOKEN_COLUMNS = "id, user_id, agent, expires_at, revoked_at, created_at";

/** A fresh plaintext token: the prefix and 32 random bytes as base64url (no padding). */
function newPlaintext(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES));
  return (
    TOKEN_PREFIX +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}

/** The stored form of a token: lowercase hex SHA-256 of the plaintext. */
export async function hashToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mints a token for `userId` (and `agent`, when given) that expires `ttlSeconds` after `now`. */
export async function mintToken(
  db: Database,
  { userId, agent, ttlSeconds, now }: { userId: string; agent: string | null; ttlSeconds: number; now: Date },
): Promise<{ token: Token; plaintext: string }> {
  const plaintext = newPlaintext();
  const token = await db
    .prepare(
      `INSERT INTO tokens (id, user_id, agent, hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${TOKEN_COLUMNS}`,
    )
    .bind(
      randomId(TOKEN_ID_LENGTH),
      userId,
      agent,
      await hashToken(plaintext),
      new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      now.toISOString(),
    )
    .first<Token>();
  if (token === null) throw new Error("token insert returned no row");
  return { token, plaintext };
}

/**
 * A user's tokens, newest first. With `agent`, only that alias's tokens: an agent sees and manages its
 * own tokens, never its human's or another agent's.
 */
export async function listTokens(db: Database, userId: string, agent?: string | null): Promise<Token[]> {
  const scoped = agent !== undefined && agent !== null;
  const { results } = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS} FROM tokens WHERE user_id = ?${scoped ? " AND agent = ?" : ""} ORDER BY created_at DESC, id`,
    )
    .bind(...(scoped ? [userId, agent] : [userId]))
    .all<Token>();
  return results;
}

/**
 * Revokes one of a user's tokens (scoped to `agent` like `listTokens`). Revoking twice keeps the first
 * revocation time. Null when there's no such token for this caller.
 */
export async function revokeToken(
  db: Database,
  { userId, agent, id, now }: { userId: string; agent?: string | null; id: string; now: Date },
): Promise<Token | null> {
  const scoped = agent !== undefined && agent !== null;
  return db
    .prepare(
      `UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?${scoped ? " AND agent = ?" : ""} RETURNING ${TOKEN_COLUMNS}`,
    )
    .bind(...(scoped ? [now.toISOString(), id, userId, agent] : [now.toISOString(), id, userId]))
    .first<Token>();
}

/** The actor and token for a plaintext token, or null when it is unknown, revoked or expired at `now`. */
export async function authenticateToken(
  db: Database,
  plaintext: string,
  now: Date,
): Promise<{ actor: Actor; token: Token } | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .prepare(
      `SELECT t.id, t.user_id, t.agent, t.expires_at, t.revoked_at, t.created_at,
              u.id AS u_id, u.handle AS u_handle, u.email AS u_email, u.created_at AS u_created_at
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.hash = ?`,
    )
    .bind(await hashToken(plaintext))
    .first<Token & { u_id: string; u_handle: string; u_email: string; u_created_at: string }>();
  if (row === null || row.revoked_at !== null || now.toISOString() >= row.expires_at) return null;
  const { u_id, u_handle, u_email, u_created_at, ...token } = row;
  return {
    actor: { user: { id: u_id, handle: u_handle, email: u_email, created_at: u_created_at }, agent: token.agent },
    token,
  };
}
