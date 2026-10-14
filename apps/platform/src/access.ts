// Cloudflare Access sign-in. Access sits in front of the UI and forwards a signed JWT in
// `Cf-Access-Jwt-Assertion`; the Worker checks it itself rather than trusting the edge.

import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { userForEmail } from "./users.ts";
import type { Database, User } from "./users.ts";

/** What the Access middleware needs from the Worker's env. */
export interface AccessBindings {
  DB: Database;
  /** The Zero Trust team domain, e.g. `throng.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** The platform's public URL, e.g. `https://throng.example.workers.dev`: see `publicOrigin`. */
  PUBLIC_URL?: string;
}

/**
 * The origin agents and git reach the platform at, for the URLs it hands out: `PUBLIC_URL`, or when
 * that's unset (tests, a bare local run), the origin `url` came in on. Over throng-web's binding the
 * request's origin is throng-web's, which serves only `/api`, so deployed environments set it.
 */
export function publicOrigin(env: { PUBLIC_URL?: string | undefined }, url: string): string {
  return env.PUBLIC_URL ?? new URL(url).origin;
}

export interface AccessEnv {
  Bindings: AccessBindings;
  Variables: { user: User };
}

/** The Access application the Worker trusts: the team's domain and the application's `aud` tag. */
export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

/** Turns an Access JWT into the signed-in identity, or null when it isn't valid for us. */
export type AccessVerifier = (token: string) => Promise<{ email: string } | null>;

export function accessVerifier(keys: JWTVerifyGetKey, { teamDomain, aud }: AccessConfig): AccessVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: `https://${teamDomain}`, audience: aud });
      // Service tokens carry no email; they are not humans and get no user.
      return typeof payload["email"] === "string" ? { email: payload["email"].toLowerCase() } : null;
    } catch {
      return null;
    }
  };
}

const teamKeys = new Map<string, JWTVerifyGetKey>();

/** Verifies against the team's published certs, cached per isolate so keys aren't refetched per request. */
export function remoteAccessVerifier(config: AccessConfig): AccessVerifier {
  let keys = teamKeys.get(config.teamDomain);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`));
    teamKeys.set(config.teamDomain, keys);
  }
  return accessVerifier(keys, config);
}

export function verifierFromEnv(env: AccessBindings): AccessVerifier {
  return remoteAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
}

/**
 * Requires a valid Access session and exposes its user as `c.var.user`, creating the user on first
 * sight. Tests and local runs pass their own `verifierFor`.
 */
export function accessSession(verifierFor: (env: AccessBindings) => AccessVerifier = verifierFromEnv) {
  return createMiddleware<AccessEnv>(async (c, next) => {
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    const identity = token === undefined ? null : await verifierFor(c.env)(token);
    if (identity === null) return c.text("Unauthorized", 401);
    c.set("user", await userForEmail(c.env.DB, identity.email));
    await next();
  });
}
