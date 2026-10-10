// Cloudflare Access sign-in, checked by throng-web itself rather than trusting the edge. A copy of
// the platform's verifier (`apps/platform/src/access.ts`) without the user lookup, which stays on
// the platform.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The Access application throng-web trusts: the team's domain and the application's `aud` tag. */
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
