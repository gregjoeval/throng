// What each Sandbox container may reach. The rule: a container that runs repository code never
// holds write access to the origin.

import type { SandboxSize } from "./config.ts";

/** A git remote the sandbox may reach; the Worker adds the token on the sandbox's behalf. */
export interface GitGrant {
  remote: string;
  token: string;
  access: "read" | "write";
}

/**
 * What a container may do: its grants, its network and its size. Intercepts are fixed when a
 * container starts, so roles with different grants need different containers. A pipeline run's
 * containers all take the `pipeline` role.
 */
export const SANDBOX_ROLES = ["pipeline", "check", "land", "follow"] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];
/**
 * The roles a Landing Workflow starts containers for: the untrusted conflict check and retest, then
 * the trusted land step.
 */
export const LANDING_ROLES = ["check", "land"] as const satisfies readonly SandboxRole[];
/** The role a Follow Workflow starts a container for: the trusted merge of a task branch into a fork. */
export const FOLLOW_ROLES = ["follow"] as const satisfies readonly SandboxRole[];

/**
 * Roles whose container runs the repository's own code (npm and its scripts). They
 * start at the project's Sandbox size; the trusted roles only run git, and start at `TRUSTED_SIZE`.
 */
export const RUNS_REPO_CODE = {
  pipeline: true,
  check: true,
  land: false,
  follow: false,
} as const satisfies Record<SandboxRole, boolean>;
export type RepoCodeRole = { [R in SandboxRole]: (typeof RUNS_REPO_CODE)[R] extends true ? R : never }[SandboxRole];

/** The size the trusted roles' containers start at, whatever the project's config says. */
export const TRUSTED_SIZE = "lite" satisfies SandboxSize;

/** Every grant a run's roles may get. Each is minted only for the step whose role needs it. */
export interface RunGrants {
  originRead: GitGrant;
  originWrite: GitGrant;
  forkRead: GitGrant;
  forkWrite: GitGrant;
}

/** Which repo each grant is for, and with what access. */
export const GRANT_SOURCES: Record<keyof RunGrants, { repo: "origin" | "fork"; access: GitGrant["access"] }> = {
  originRead: { repo: "origin", access: "read" },
  originWrite: { repo: "origin", access: "write" },
  forkRead: { repo: "fork", access: "read" },
  forkWrite: { repo: "fork", access: "write" },
};

/** The grants each role's container gets. */
export const ROLE_GRANTS = {
  // One read grant on the run's line: an attempt's fork.
  pipeline: ["forkRead"],
  check: ["originRead", "forkRead"],
  land: ["originWrite", "forkRead"],
  follow: ["originRead", "forkWrite"],
} as const satisfies Record<SandboxRole, readonly (keyof RunGrants)[]>;

/** The grants `role`'s container gets, by name. */
export type RoleGrants<R extends SandboxRole> = Pick<RunGrants, (typeof ROLE_GRANTS)[R][number]>;

/** The git grants `role`'s container gets, in the order its intercepts list them. */
export function grantsForRole<R extends SandboxRole>(role: R, grants: RoleGrants<R>): GitGrant[] {
  const byName: Partial<RunGrants> = grants;
  return ROLE_GRANTS[role].map((name) => byName[name] as GitGrant);
}

/** The container a Landing or Follow Workflow runs `role` in: `<instance>/<role>`. */
export function sandboxName(instanceId: string, role: SandboxRole): string {
  return `${instanceId}/${role}`;
}

/** A pipeline run's container: the one its setups run in, or one check's. */
export type PipelineContainer = { kind: "setup" } | { kind: "check"; name: string };

/**
 * A pipeline run's container's name: `<instance>/setup` or `<instance>/check:<name>`, so the run's
 * plan names every container it may start, and teardown can destroy them all.
 */
export function pipelineSandboxName(instanceId: string, container: PipelineContainer): string {
  return container.kind === "setup" ? `${instanceId}/setup` : `${instanceId}/check:${container.name}`;
}

/** The one container a run's Workflow scored in before each check got its own. */
export function legacyScoreSandboxName(instanceId: string): string {
  return `${instanceId}/score`;
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
