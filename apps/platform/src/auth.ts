// Authentication for the product API and the git proxy. Machines present a Throng token: as
// `Authorization: Bearer` on `/api/*`, and as the HTTP Basic password (any username) on `/git/*`.
// Handlers read `c.var.actor` (`{user, agent}`) and `c.var.token` (null under an Access session).

import { createMiddleware } from "hono/factory";
import { verifierFromEnv, type AccessBindings, type AccessVerifier } from "./access.ts";
import { errorBody } from "./errors.ts";
import { authenticateToken, type Actor, type Token } from "./tokens.ts";
import { userForEmail } from "./users.ts";

export interface AuthEnv {
  Bindings: AccessBindings;
  Variables: { actor: Actor; token: Token | null };
}

export interface AuthOptions {
  /** How to check Access JWTs; tests and local runs pass their own. */
  verifierFor?: (env: AccessBindings) => AccessVerifier;
  /** The clock tokens expire against; tests pass their own. */
  now?: () => Date;
}

const BEARER_CHALLENGE = { "WWW-Authenticate": 'Bearer realm="throng"' };
const BASIC_CHALLENGE = { "WWW-Authenticate": 'Basic realm="throng"' };

/** The token in an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

/** The password in an `Authorization: Basic <base64(user:password)>` header, or null. */
export function basicPassword(header: string | undefined): string | null {
  const match = /^Basic[ ]+([A-Za-z0-9+/=]+)[ ]*$/i.exec(header ?? "");
  if (match?.[1] === undefined) return null;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/** Requires `Authorization: Bearer <Throng token>`. */
export function bearerAuth({ now = () => new Date() }: AuthOptions = {}) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const plaintext = bearerToken(c.req.header("Authorization"));
    const found = plaintext === null ? null : await authenticateToken(c.env.DB, plaintext, now());
    if (found === null)
      return c.json(errorBody("unauthorized", "a valid bearer token is required"), 401, BEARER_CHALLENGE);
    c.set("actor", found.actor);
    c.set("token", found.token);
    await next();
  });
}

/**
 * Accepts a bearer token or, when no `Authorization` header is sent, an Access session. Only the
 * endpoints a human needs before holding a token (minting one, `/me`) use this.
 */
export function bearerOrAccess({ verifierFor = verifierFromEnv, now }: AuthOptions = {}) {
  const bearer = bearerAuth(now === undefined ? {} : { now });
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (c.req.header("Authorization") !== undefined) return bearer(c, next);
    const jwt = c.req.header("Cf-Access-Jwt-Assertion");
    const identity = jwt === undefined ? null : await verifierFor(c.env)(jwt);
    if (identity === null) {
      return c.json(errorBody("unauthorized", "a bearer token or Access session is required"), 401, BEARER_CHALLENGE);
    }
    c.set("actor", { user: await userForEmail(c.env.DB, identity.email), agent: null });
    c.set("token", null);
    await next();
  });
}

/** Requires a Throng token as the HTTP Basic password, which is how git sends credentials. */
export function gitAuth({ now = () => new Date() }: AuthOptions = {}) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const plaintext = basicPassword(c.req.header("Authorization"));
    const found = plaintext === null ? null : await authenticateToken(c.env.DB, plaintext, now());
    if (found === null) return c.text("A Throng token is required as the password.\n", 401, BASIC_CHALLENGE);
    c.set("actor", found.actor);
    c.set("token", found.token);
    await next();
  });
}
