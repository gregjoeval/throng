// What a check container may reach. The Worker's outbound intercept asks `outboundDecision` about every
// request and does only what it says, so the whole policy is here and testable.

import { grantFor, type GitGrant } from "./grants.ts";
import { previewPathAllowed, type PreviewGrant } from "./preview.ts";

export const NPM_REGISTRY_HOST = "registry.npmjs.org";
export const CLOUDFLARE_API_HOST = "api.cloudflare.com";

/** Everything one container may reach. Fixed when the container starts. */
export interface OutboundAccess {
  grants: GitGrant[];
  /** Lets the container deploy Previews of one Worker; the token itself stays in the Worker's env. */
  preview: PreviewGrant | null;
  /** Read-only access to the npm registry, for installs. */
  npmRegistry: boolean;
}

export type OutboundDecision =
  /** Refuse with a 403. */
  | { action: "deny" }
  /** Forward the request unchanged. */
  | { action: "pass" }
  /** Forward with this git grant's token as the bearer. */
  | { action: "bearer"; token: string }
  /** Forward with the Worker's Preview deploy token as the bearer. */
  | { action: "preview-token" };

export function outboundDecision(method: string, url: URL, access: OutboundAccess): OutboundDecision {
  if (url.protocol !== "https:") return { action: "deny" };
  if (url.host === NPM_REGISTRY_HOST) {
    return access.npmRegistry && registryAllows(method, url) ? { action: "pass" } : { action: "deny" };
  }
  if (url.host === CLOUDFLARE_API_HOST) {
    const allowed = access.preview !== null && previewPathAllowed(url.pathname, access.preview);
    return allowed ? { action: "preview-token" } : { action: "deny" };
  }
  const grant = grantFor(access.grants, url);
  return grant === undefined ? { action: "deny" } : { action: "bearer", token: grant.token };
}

/** Hosts the container's intercepts must cover for `access` to be usable. */
export function interceptedHosts(access: OutboundAccess): Set<string> {
  const hosts = new Set(access.grants.map((g) => new URL(g.remote).host));
  if (access.preview !== null) hosts.add(CLOUDFLARE_API_HOST);
  if (access.npmRegistry) hosts.add(NPM_REGISTRY_HOST);
  return hosts;
}

/** Installs only read from the registry; anything that would publish or log in is refused. */
export function registryAllows(method: string, url: URL): boolean {
  return url.protocol === "https:" && url.host === NPM_REGISTRY_HOST && (method === "GET" || method === "HEAD");
}
