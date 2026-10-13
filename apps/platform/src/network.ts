// What a Sandbox container may reach. The Worker's outbound intercept asks `outboundDecision` about every
// request and does only what it says, so the whole policy is here and testable.

import { grantFor, grantsForRole, RUNS_REPO_CODE } from "./grants.ts";
import type { GitGrant, RoleGrants, SandboxRole } from "./grants.ts";
import { previewAllows } from "./preview.ts";
import type { PreviewGrant } from "./preview.ts";

export const NPM_REGISTRY_HOST = "registry.npmjs.org";
export const CLOUDFLARE_API_HOST = "api.cloudflare.com";

/** Everything one container may reach. Fixed when the container starts. */
export interface OutboundAccess {
  grants: GitGrant[];
  /** Lets the container deploy Previews of one Worker, never delete; the token itself stays in the Worker's env. */
  preview: PreviewGrant | null;
  /**
   * Package registry hosts the container may read, for installs: the npm registry and those in the
   * origin's `.npmrc`. Reads only, over HTTPS on the default port; requests pass through unchanged,
   * so the Worker adds no credentials to them.
   */
  registries: string[];
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
  if (url.host === CLOUDFLARE_API_HOST) {
    const allowed = access.preview !== null && previewAllows(method, url.pathname, access.preview);
    return allowed ? { action: "preview-token" } : { action: "deny" };
  }
  const grant = grantFor(access.grants, url);
  if (grant !== undefined) return { action: "bearer", token: grant.token };
  // A granted repo's host keeps its own rules: listing it doesn't open the host's other repos.
  if (access.grants.some((g) => new URL(g.remote).host === url.host)) return { action: "deny" };
  // A registry stays read-only, even when `network.allow` lists it too.
  if (url.hostname === NPM_REGISTRY_HOST || access.registries.includes(url.hostname)) {
    return registryAllows(method, url, access.registries) ? { action: "pass" } : { action: "deny" };
  }
  return url.port === "" && access.allow.includes(url.hostname) ? { action: "pass" } : { action: "deny" };
}

/** Hosts the container's intercepts must cover for `access` to be usable. */
export function interceptedHosts(access: OutboundAccess): Set<string> {
  const hosts = new Set(access.grants.map((g) => new URL(g.remote).host));
  if (access.preview !== null) hosts.add(CLOUDFLARE_API_HOST);
  for (const host of access.registries) hosts.add(host);
  for (const host of access.allow) hosts.add(host);
  return hosts;
}

/** Installs only read from a registry; anything that would publish or log in is refused. */
export function registryAllows(method: string, url: URL, registries: readonly string[]): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    registries.includes(url.hostname) &&
    (method === "GET" || method === "HEAD")
  );
}

/**
 * What `role`'s container may reach: its git grants, the Preview deploy grant only for the `preview`
 * role, and the registries (the npm registry, then `registries` from the origin's `.npmrc`) and
 * `network.allow` hosts only for roles that run repository code.
 */
export function roleAccess<R extends SandboxRole>(
  role: R,
  grants: RoleGrants<R>,
  { preview, allow, registries }: { preview: PreviewGrant | null; allow: string[]; registries: string[] },
): OutboundAccess {
  return {
    grants: grantsForRole(role, grants),
    // Only the preview container holds the Preview deploy grant.
    preview: role === "preview" ? preview : null,
    registries: RUNS_REPO_CODE[role] ? [...new Set([NPM_REGISTRY_HOST, ...registries])] : [],
    allow: RUNS_REPO_CODE[role] ? allow : [],
  };
}
