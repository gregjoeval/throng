// Cloudflare Access sign-in, checked by throng-web itself rather than trusting the edge. A copy of
// the platform's verifier (`apps/platform/src/access.ts`) without the user lookup, which stays on
// the platform.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

/** The Access application throng-web trusts: the team's domain and the application's `aud` tag. */
export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

/** Turns an Access JWT into the signed-in identity, or null when it's missing or isn't valid for us. */
export type AccessVerifier = (token: string | null) => Promise<{ email: string } | null>;

/** Emails are compared lowercased, as the platform keys users by them. */
function identityFor(email: string): { email: string } {
  return { email: email.toLowerCase() };
}

export function accessVerifier(keys: JWTVerifyGetKey, { teamDomain, aud }: AccessConfig): AccessVerifier {
  return async (token) => {
    if (token === null) return null;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: `https://${teamDomain}`, audience: aud });
      // Service tokens carry no email; they are not humans and get no user.
      return typeof payload["email"] === "string" ? identityFor(payload["email"]) : null;
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

/** Local dev's stand-in for Access: every request is signed in as `email`, with or without a JWT. */
export function devAccessVerifier(email: string): AccessVerifier {
  const identity = identityFor(email);
  return async () => identity;
}
