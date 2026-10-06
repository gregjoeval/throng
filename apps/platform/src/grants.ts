// What each check container may reach. The rule: a container that runs repository code never holds
// write access to the canonical repo.

/** A git remote the sandbox may reach; the Worker adds the token on the sandbox's behalf. */
export interface GitGrant {
  remote: string;
  token: string;
  access: "read" | "write";
}

/**
 * A check runs in several containers, one per role. Intercepts are fixed when a container starts, so
 * roles with different grants need different containers.
 */
export const CHECK_ROLES = ["test", "preview", "retest", "land"] as const;
export type CheckRole = (typeof CHECK_ROLES)[number];

/** Roles whose container runs the repository's own code (npm, its scripts, wrangler builds). */
export const RUNS_REPO_CODE: Record<CheckRole, boolean> = {
  test: true,
  preview: true,
  retest: true,
  land: false,
};

export interface CheckGrants {
  canonicalRead: GitGrant;
  canonicalWrite: GitGrant;
  forkRead: GitGrant;
}

export function grantsForRole(role: CheckRole, grants: CheckGrants): GitGrant[] {
  switch (role) {
    case "test":
    case "preview":
      return [grants.forkRead];
    case "retest":
      return [grants.canonicalRead, grants.forkRead];
    case "land":
      return [grants.canonicalWrite, grants.forkRead];
  }
}

/** Only the preview role may deploy Previews. */
export function roleGetsPreview(role: CheckRole): boolean {
  return role === "preview";
}

export function sandboxName(instanceId: string, role: CheckRole): string {
  return `${instanceId}/${role}`;
}

/** Finds the grant covering a git request, refusing pushes on read grants. */
export function grantFor(grants: GitGrant[], url: URL): GitGrant | undefined {
  const grant = grants.find((g) => {
    const remote = new URL(g.remote);
    return (
      url.host === remote.host && (url.pathname === remote.pathname || url.pathname.startsWith(`${remote.pathname}/`))
    );
  });
  if (grant === undefined) return undefined;
  if (grant.access === "read" && isReceivePack(url)) return undefined;
  return grant;
}

function isReceivePack(url: URL): boolean {
  return url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
}
