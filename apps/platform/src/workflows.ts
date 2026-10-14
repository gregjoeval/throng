// What every Workflow that runs a Sandbox shares: minting a container's grants in the step that
// starts it, running a script in it, and copying its logs to R2.

import { reposFor } from "./artifacts";
import type { ConfigResult, SandboxSize } from "./config";
import { GRANT_SOURCES, ROLE_GRANTS, sandboxName, TRUSTED_SIZE } from "./grants";
import type { RepoCodeRole, RoleGrants, RunGrants, SandboxRole } from "./grants";
import { LOG_CONTENT_TYPE, MISSING_LOG_EXIT, readLogScript, sandboxNote, withNotes } from "./logs";
import { NO_NETWORK, roleAccess } from "./network";
import type { NetworkAccess } from "./network";
import { forkRepo, lineRepo, originRepo } from "./repos";
import { scorePlan, scoreTimeoutMs } from "./results";
import type { ScorePlan } from "./results";
import type { RunResult, SandboxSnapshot, StartOptions } from "./sandbox";

const TOKEN_TTL_SECONDS = 30 * 60;
/** Each step's retries after its first try, for infrastructure errors; then the run ends `errored`. */
export const STEP_RETRIES = { limit: 2, delay: "5 seconds", backoff: "constant" } as const;
/** What a container may reach while its logs are read: nothing. It is already running by then. */
const NO_ACCESS = { grants: [], ...NO_NETWORK };
/**
 * The repos a run's grants are for: the project's origin, and its line's (`t42a3`, `t42` or `main`):
 * a fork grant is only for an attempt's line.
 */
export interface RunRepos {
  project: string;
  line: string;
}

/**
 * What the containers that run repository code start with, read from the origin's `main` alone, never
 * from an attempt or a merged tree: the Sandbox size, and the registries and hosts they may reach.
 */
export interface MainSettings {
  size: SandboxSize;
  network: NetworkAccess;
}

/**
 * What a retest takes from its config: the config itself, the plan it runs and the step's timeout,
 * with `main`'s settings.
 */
export interface RunSettings extends MainSettings {
  config: ConfigResult;
  plan: ScorePlan;
  timeoutMs: number;
}

/** The run settings for `config`, under `main`'s settings. */
export function runSettings(config: ConfigResult, main: MainSettings): RunSettings {
  const plan = scorePlan(config);
  return { config, plan, timeoutMs: scoreTimeoutMs(plan), ...main };
}

/**
 * How a role's script runs: the size its container starts at, the registries and hosts it may reach
 * besides its grants (none by default), and how long it may take. Only a role that runs repository
 * code takes the project's size; a trusted role's is always `TRUSTED_SIZE`.
 */
export interface ScriptOptions<R extends SandboxRole> {
  size: R extends RepoCodeRole ? SandboxSize : typeof TRUSTED_SIZE;
  network?: NetworkAccess;
  timeoutMs?: number;
  /** The container's Sandbox name, when the role has more than one in a run; `<instance>/<role>` by default. */
  sandbox?: string;
  /**
   * Variables the script gets, such as a pipeline run's `THRONG_*`: given, or made once the container
   * is up, from whether it came up from `snapshot`, such as the secrets a check needs only when it
   * has to re-run the setups.
   */
  env?: Record<string, string> | ((fromSnapshot: boolean) => Promise<Record<string, string>>);
  /**
   * A snapshot to start the container from rather than the image. A failed restore is retried once;
   * after that the container starts from the image, and the script finds the snapshot's work missing.
   */
  snapshot?: SandboxSnapshot | null;
  /**
   * Called once the container came up from `snapshot` (or didn't), before the script: such as
   * restoring the caches the script uses. It's given how to start the container, should it start it.
   */
  prepare?: (start: StartOptions & { timeoutMs?: number }, fromSnapshot: boolean) => Promise<void>;
}

/**
 * Runs a script in the role's own container with only that role's grants. They're minted here, in
 * the step, so a retry never holds a stale one. Exit codes 10 and up are infrastructure failures
 * (fetch, checkout, merge); they throw so the step retries.
 */
export async function runInSandbox<R extends SandboxRole>(
  env: Env,
  instanceId: string,
  repos: RunRepos,
  role: R,
  script: (grants: RoleGrants<R>) => string,
  {
    size,
    network = NO_NETWORK,
    timeoutMs,
    sandbox: name = sandboxName(instanceId, role),
    env: vars,
    snapshot = null,
    prepare,
  }: ScriptOptions<R>,
): Promise<RunResult> {
  const grants = (await mintGrants(env, repos, ROLE_GRANTS[role])) as RoleGrants<R>;
  const sandbox = env.SANDBOX.getByName(name);
  // The trusted land container never reaches the registry.
  const access = roleAccess(role, grants, network);
  let restored = false;
  if (snapshot !== null) {
    restored =
      (await sandbox.restore(snapshot, { access, size }, timeoutMs)) ||
      (await sandbox.restore(snapshot, { access, size }, timeoutMs));
    if (!restored) console.warn({ event: "sandbox.restore_gave_up", sandbox: name, snapshot: snapshot.id });
  }
  await prepare?.({ access, size, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, restored);
  const scriptEnv = typeof vars === "function" ? await vars(restored) : vars;
  const result = await sandbox.run(script(grants), {
    access,
    size,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(scriptEnv === undefined ? {} : { env: scriptEnv }),
  });
  if (result.exitCode >= 10) {
    throw new Error(`${name} script exited ${result.exitCode}: ${result.stderr.slice(-2000)}`);
  }
  return result;
}

/** Mints the named grants for the run's origin and fork. */
async function mintGrants<K extends keyof RunGrants>(
  env: Env,
  { project, line }: RunRepos,
  names: readonly K[],
): Promise<Pick<RunGrants, K>> {
  const repos = reposFor(env);
  const repoNames = {
    origin: () => originRepo(project),
    fork: () => forkRepo(project, line),
    line: () => lineRepo(project, line),
  };
  const minted = await Promise.all(
    names.map(async (name) => {
      const { repo, access } = GRANT_SOURCES[name];
      const repoName = repoNames[repo]();
      const [info, token] = await Promise.all([
        repos.get(repoName),
        repos.mintToken(repoName, access, TOKEN_TTL_SECONDS),
      ]);
      return [name, { remote: info.remote, token: token.token, access }] as const;
    }),
  );
  return Object.fromEntries(minted) as Pick<RunGrants, K>;
}

/** The logs one step's container wrote, and how to store them. */
export interface LogsToStore {
  /** The container's Sandbox name. */
  sandbox: string;
  names: string[];
  /** The R2 key each log is stored under. */
  key: (name: string) => string;
  /** The Sandbox size the step's container ran at, noted on each log it wrote. */
  size: SandboxSize;
  /** What the run noted about each log (see `withNotes`). */
  notes?: ReadonlyMap<string, string[]>;
  /** Masks the secrets the container held in each log, with its notes, before it's stored. */
  mask?: (text: string) => string;
}

/**
 * Copies a container's logs to R2, truncated over `MAX_LOG_BYTES`, with each log's notes appended,
 * and returns the names stored. Each log a step wrote also notes the Sandbox size its container ran
 * at. A step that never ran wrote no log, unless it has notes; a log that fails to copy is left out
 * rather than failing the run.
 */
export async function storeLogs(
  env: Env,
  { sandbox: sandboxId, names, key, size, notes = new Map(), mask = (text) => text }: LogsToStore,
): Promise<string[]> {
  const sandbox = env.SANDBOX.getByName(sandboxId);
  const stored: string[] = [];
  for (const name of names) {
    try {
      // Its container is already running, so it keeps its size; if it was lost, a log read needs no
      // more than the smallest to find the log missing.
      const read = await sandbox.run(readLogScript(name), { access: NO_ACCESS, size: TRUSTED_SIZE });
      if (read.exitCode !== 0 && read.exitCode !== MISSING_LOG_EXIT) {
        throw new Error(`exit ${read.exitCode}: ${read.stderr.slice(-500)}`);
      }
      const ran = read.exitCode !== MISSING_LOG_EXIT;
      const own = notes.get(name) ?? [];
      const log = withNotes(ran ? read.stdout : null, ran ? [sandboxNote(size), ...own] : own);
      if (log === null) continue;
      await env.LOGS.put(key(name), mask(log), { httpMetadata: { contentType: LOG_CONTENT_TYPE } });
      stored.push(name);
    } catch (error) {
      console.error({ event: "sandbox.log_not_stored", sandbox: sandboxId, name, error: mask(String(error)) });
    }
  }
  return stored;
}
