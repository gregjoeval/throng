// What a Sandbox container may reach. The Worker's outbound intercept asks `outboundDecision` about every
// request and does only what it says, so the whole policy is here and testable.

import { grantFor, grantsForRole, RUNS_REPO_CODE, type GitGrant, type RoleGrants, type SandboxRole } from "./grants.ts";
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
  /**
   * Extra hosts (`network.allow` in the project's config) the container may reach over HTTPS on the
   * default port. Requests pass through unchanged: the Worker adds no credentials to them.
   */
  allow: string[];
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
  if (grant !== undefined) return { action: "bearer", token: grant.token };
  // A granted repo's host keeps its own rules: listing it doesn't open the host's other repos.
  if (access.grants.some((g) => new URL(g.remote).host === url.host)) return { action: "deny" };
  return url.port === "" && access.allow.includes(url.hostname) ? { action: "pass" } : { action: "deny" };
}

/** Hosts the container's intercepts must cover for `access` to be usable. */
export function interceptedHosts(access: OutboundAccess): Set<string> {
  const hosts = new Set(access.grants.map((g) => new URL(g.remote).host));
  if (access.preview !== null) hosts.add(CLOUDFLARE_API_HOST);
  if (access.npmRegistry) hosts.add(NPM_REGISTRY_HOST);
  for (const host of access.allow) hosts.add(host);
  return hosts;
}

/** Installs only read from the registry; anything that would publish or log in is refused. */
export function registryAllows(method: string, url: URL): boolean {
  return url.protocol === "https:" && url.host === NPM_REGISTRY_HOST && (method === "GET" || method === "HEAD");
}

/**
 * What `role`'s container may reach: its git grants, the Preview deploy grant only for the `preview`
 * role, and the npm registry and `network.allow` hosts only for roles that run repository code.
 */
export function roleAccess<R extends SandboxRole>(
  role: R,
  grants: RoleGrants<R>,
  { preview, allow }: { preview: PreviewGrant | null; allow: string[] },
): OutboundAccess {
  return {
    grants: grantsForRole(role, grants),
    // Only the preview container holds the Preview deploy grant.
    preview: role === "preview" ? preview : null,
    npmRegistry: RUNS_REPO_CODE[role],
    allow: RUNS_REPO_CODE[role] ? allow : [],
  };
}
