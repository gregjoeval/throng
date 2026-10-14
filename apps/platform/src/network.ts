// What a Sandbox container may reach. The Worker's outbound intercept asks `outboundDecision` about every
// request and does only what it says, so the whole policy is here and testable.

import { grantFor, grantsForRole, RUNS_REPO_CODE } from "./grants.ts";
import type { GitGrant, RoleGrants, SandboxRole } from "./grants.ts";

export const NPM_REGISTRY_HOST = "registry.npmjs.org";

/**
 * A host a project can open to its containers, through `network.allow` or a registry in its
 * `.npmrc`: a lowercase DNS name with a top-level domain. IP literals, ports, a trailing dot and
 * single labels such as `localhost` don't match, so every such host is one an intercept can take.
 */
export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** What a registry takes: reads, for installs. Anything that would publish or log in is refused. */
const REGISTRY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * The hosts, beyond its grants, that a container running repository code may reach. Requests to them
 * pass through unchanged, so the Worker adds no credentials.
 */
export interface NetworkAccess {
  /**
   * Package registries, for installs: the npm registry and those in the origin's `.npmrc`. Reads
   * only, even when `network.allow` lists the host too.
   */
  registries: string[];
  /** Extra hosts (`network.allow` in the project's config), which take any method. */
  allow: string[];
}

/** No hosts beyond the grants. */
export const NO_NETWORK: NetworkAccess = { registries: [], allow: [] };

/** Everything one container may reach. Fixed when the container starts. */
export interface OutboundAccess extends NetworkAccess {
  grants: GitGrant[];
}

export type OutboundDecision =
  /** Refuse with a 403. */
  | { action: "deny" }
  /** Forward the request unchanged. */
  | { action: "pass" }
  /** Forward with this git grant's token as the bearer. */
  | { action: "bearer"; token: string };

const DENY: OutboundDecision = { action: "deny" };
const PASS: OutboundDecision = { action: "pass" };

/** Whether `url` is HTTPS on the default port: the only kind of request a container may make. */
export function isHttpsOnDefaultPort(url: URL): boolean {
  return url.protocol === "https:" && url.port === "";
}

export function outboundDecision(method: string, url: URL, access: OutboundAccess): OutboundDecision {
  if (!isHttpsOnDefaultPort(url)) return DENY;
  const grant = grantFor(access.grants, url);
  if (grant !== undefined) return { action: "bearer", token: grant.token };
  // A granted repo's host keeps its own rules: listing it doesn't open the host's other repos.
  if (access.grants.some((g) => new URL(g.remote).host === url.host)) return DENY;
  // A registry stays read-only, even when `network.allow` lists it too.
  if (access.registries.includes(url.hostname)) return REGISTRY_METHODS.has(method) ? PASS : DENY;
  return access.allow.includes(url.hostname) ? PASS : DENY;
}

/** Hosts the container's intercepts must cover for `access` to be usable. */
export function interceptedHosts(access: OutboundAccess): Set<string> {
  const hosts = new Set(access.grants.map((g) => new URL(g.remote).host));
  for (const host of access.registries) hosts.add(host);
  for (const host of access.allow) hosts.add(host);
  return hosts;
}

/**
 * What `role`'s container may reach: its git grants, and `network` with the npm registry added only
 * for roles that run repository code.
 */
export function roleAccess<R extends SandboxRole>(
  role: R,
  grants: RoleGrants<R>,
  network: NetworkAccess,
): OutboundAccess {
  return {
    grants: grantsForRole(role, grants),
    registries: RUNS_REPO_CODE[role] ? [...new Set([NPM_REGISTRY_HOST, ...network.registries])] : [],
    allow: RUNS_REPO_CODE[role] ? network.allow : [],
  };
}
