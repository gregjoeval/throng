// Same-origin `/api/*` goes to the platform over the `PLATFORM` service binding, with the
// Access-verified user's email attached. The binding targets the platform's `WebEntrypoint`, the only
// place that trusts the header (see `apps/platform/src/app.ts`).

import { FORWARDED_EMAIL_HEADER } from "@throng/platform/forwarded";
import type { AccessVerifier } from "./access";

/** Whether a request is for the platform API rather than the UI. */
export function isApiRequest(url: URL): boolean {
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

/** Where forwarded requests go: the `PLATFORM` binding in production, a fake in tests. */
export interface Platform {
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Verifies the request's Access JWT and forwards it to the platform as that user. Credentials the
 * browser sent are dropped, so the forwarded email is the only identity the platform sees.
 */
export async function forwardToPlatform(request: Request, platform: Platform, verify: AccessVerifier) {
  const identity = await verify(request.headers.get("Cf-Access-Jwt-Assertion"));
  if (identity === null) {
    return Response.json(
      { error: { code: "unauthorized", message: "a valid Access session is required" } },
      { status: 401 },
    );
  }
  const headers = new Headers(request.headers);
  for (const name of ["Authorization", "Cookie", "Cf-Access-Jwt-Assertion"]) headers.delete(name);
  headers.set(FORWARDED_EMAIL_HEADER, identity.email);
  return platform.fetch(new Request(request, { headers }));
}
