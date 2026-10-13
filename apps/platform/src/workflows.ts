import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { attemptBase } from "./base";
import { loadConfig, sandboxSize } from "./config";
import type { ConfigResult, SandboxSize } from "./config";
import { GRANT_SOURCES, ROLE_GRANTS, sandboxName, SCORING_ROLES, TRUSTED_SIZE } from "./grants";
import type { RepoCodeRole, RoleGrants, RunGrants, SandboxRole } from "./grants";
import {
  LOG_CONTENT_TYPE,
  logKey,
  logNames,
  MISSING_LOG_EXIT,
  PREVIEW_LOG,
  readLogScript,
  sandboxNote,
  withNotes,
} from "./logs";
import { roleAccess } from "./network";
import { previewGrant, previewName } from "./preview";
import { previewWorkersFor } from "./preview-workers";
import { forkRepo, originRepo } from "./repos";
import { buildResult, previewPlan, scorePlan, scoreTimeoutMs, withPreview } from "./results";
import type { PreviewPlan, RawScore, ScorePlan, ScoringResult } from "./results";
import type { RunResult } from "./sandbox";
import type { ScoringOutcome, ScoringParams } from "./scoring";
import { parseResult, PREVIEW_BUILD_TIMEOUT_MS, previewScript, scoreScript } from "./scripts";
import type { PreviewScriptResult } from "./scripts";
import { NO_TASK_DEFINITIONS, withTask } from "./task-definitions";
import { parseAttemptRef } from "./task-refs";

const TOKEN_TTL_SECONDS = 30 * 60;
/** The preview step: fetching, installing and the build step at its timeout, then the deploy. */
const PREVIEW_STEP_TIMEOUT_MS = PREVIEW_BUILD_TIMEOUT_MS + 10 * 60 * 1000;
/** Each step's retries after its first try, for infrastructure errors; then the run ends `errored`. */
export const STEP_RETRIES = { limit: 2, delay: "5 seconds", backoff: "constant" } as const;
/** What a container may reach while its logs are read: nothing. It is already running by then. */
const NO_ACCESS = { grants: [], preview: null, npmRegistry: false, allow: [] };
/**
 * One scoring run: scores an attempt's head in a Sandbox and reports the result to the project's
 * Durable Object. The config is read from the origin's `main`, so an attempt can't change its own
 * checks. The container that runs repo code holds read grants only (see `grants.ts`).
 *
 * When the config has a `preview` section and the gate passed, the head is then deployed as a Worker
 * Preview from a separate container (see `#preview`); a failed Preview never changes the gate.
 *
 * Each setup step's, check's and Preview's log is copied to R2 (`logs.ts`) within the step that
 * wrote it, while its container still runs, so the result names the logs that were stored.
 */
export class ScoringWorkflow extends WorkflowEntrypoint<Env, ScoringParams> {
  override async run(event: Readonly<WorkflowEvent<ScoringParams>>, step: WorkflowStep): Promise<ScoringOutcome> {
    const params = event.payload;
    const instanceId = event.instanceId;

    let outcome: ScoringOutcome;
    try {
      // Named apart from the `config` step it replaced, whose recorded output had another shape.
      const { config, size } = await step.do("config and size", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        this.#config(params),
      );
      const settings = runSettings(config, size);
      const base = await step.do("base", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        attemptBase(reposFor(this.env), params.project, { attempt: params.attempt, head: params.sha }),
      );
      const scored = await step.do("score", { retries: STEP_RETRIES, timeout: settings.timeoutMs }, () =>
        this.#score(instanceId, params, base?.sha ?? null, settings),
      );
      const preview = previewPlan(config, scored);
      let result = scored;
      if (preview !== null) {
        const { deployed, durationMs, logs } = await this.#preview(instanceId, params, preview, size, step);
        result = { ...withPreview(scored, deployed, durationMs), logs: [...scored.logs, ...logs] };
      }
      outcome = { status: "done", result };
    } catch (error) {
      outcome = { status: "errored", error: String(error).slice(0, 4000) };
    }

    await step.do("teardown", async () => {
      await Promise.all(
        SCORING_ROLES.map((role) => this.env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()),
      );
    });
    await step.do("report", async () => {
      const project = this.env.PROJECT.getByName(params.project);
      await project.scoringFinished(params.run, outcome);
    });
    return outcome;
  }

  /**
   * The run's config, its layers merged once: the project's config on `main`, then what the task
   * defines over it. A clash between them makes it invalid. The e2e routes' attempts have no task row,
   * so they get the project's alone. The Sandbox size is the project's own, which a task's
   * definitions never change, even when they clash.
   */
  async #config(params: ScoringParams): Promise<{ config: ConfigResult; size: SandboxSize }> {
    const task = parseAttemptRef(params.attempt)?.task;
    const [project, definitions] = await Promise.all([
      loadConfig(reposFor(this.env), params.project),
      task === undefined ? NO_TASK_DEFINITIONS : this.env.PROJECT.getByName(params.project).definitionsOf(task),
    ]);
    return { config: withTask(project, definitions), size: sandboxSize(project) };
  }

  /** Runs the score script in the run's own container, stores its logs and builds its result. */
  async #score(
    instanceId: string,
    params: ScoringParams,
    base: string | null,
    { config, plan, timeoutMs, size }: RunSettings,
  ): Promise<ScoringResult> {
    const run = await runInSandbox(
      this.env,
      instanceId,
      params,
      "score",
      (g) => scoreScript(g.forkRead.remote, { sha: params.sha, base }, plan),
      { allow: plan.allow, timeoutMs, size },
    );
    const raw = parseResult<RawScore>(run.stdout);
    if (raw === null) {
      throw new Error(`score script gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
    }
    const result = buildResult(config, raw);
    const notes = new Map(result.checks.map((check) => [check.name, check.notes]));
    const logs = await storeLogs(this.env, {
      sandbox: sandboxName(instanceId, "score"),
      names: logNames(plan),
      key: (log) => logKey(params, log),
      size,
      notes,
    });
    return { ...result, logs };
  }

  /**
   * Deploys the head as a Worker Preview under the project's own Worker (`p<projectId>`, created here
   * if the project predates it) from the preview container, which holds that Worker's Preview deploy
   * grant and only a read grant on the fork, and stores its log. `deployed` is null when it gave no
   * result, and the error when the step kept failing on infrastructure; then whatever log the
   * container wrote is still stored. A failed Preview is recorded on the result and never changes the gate.
   * `durationMs` is how long its last try took, timed within the step so a replay keeps it; 0 once it errored.
   */
  async #preview(
    instanceId: string,
    params: ScoringParams,
    { command, allow }: PreviewPlan,
    size: SandboxSize,
    step: WorkflowStep,
  ): Promise<{ deployed: PreviewScriptResult | null | { error: string }; durationMs: number; logs: string[] }> {
    const { accountId, workerName } = previewGrant(this.env.CF_ACCOUNT_ID, params.project);
    const name = previewName(params);
    const previewLogs: LogsToStore = {
      sandbox: sandboxName(instanceId, "preview"),
      names: [PREVIEW_LOG],
      key: (log) => logKey(params, log),
      size,
    };
    try {
      const { run, durationMs, logs } = await step.do(
        "preview",
        { retries: STEP_RETRIES, timeout: PREVIEW_STEP_TIMEOUT_MS },
        async () => {
          const started = Date.now();
          // Projects made before their Worker was created with them get it here.
          await previewWorkersFor(this.env).ensure(params.project);
          const deploy = await runInSandbox(
            this.env,
            instanceId,
            params,
            "preview",
            (g) =>
              previewScript(g.forkRead.remote, params.sha, {
                accountId,
                workerName,
                previewName: name,
                command,
              }),
            { allow, timeoutMs: PREVIEW_STEP_TIMEOUT_MS, size },
          );
          return {
            run: deploy,
            durationMs: Date.now() - started,
            logs: await storeLogs(this.env, previewLogs),
          };
        },
      );
      const deployed = parseResult<PreviewScriptResult>(run.stdout);
      if (deployed === null) {
        console.warn({ event: "scoring.preview_no_result", exit: run.exitCode, stderr: run.stderr.slice(-2000) });
      } else if (!deployed.ok) {
        console.log({ event: "scoring.preview_failed", stage: deployed.stage, output: deployed.output.slice(-2000) });
      }
      return { deployed, durationMs, logs };
    } catch (error) {
      const message = String(error).slice(0, 2000);
      console.warn({ event: "scoring.preview_errored", error: message });
      // A lost Sandbox can't give its log back either; that still mustn't end the run.
      const logs = await step
        .do("preview logs", { retries: STEP_RETRIES }, () => storeLogs(this.env, previewLogs))
        .catch(() => []);
      return { deployed: { error: message }, durationMs: 0, logs };
    }
  }
}

/** The repos a run's grants are for: the project's origin and one attempt's fork (`t42a3`). */
export interface RunRepos {
  project: string;
  attempt: string;
}

/**
 * What a scoring run or a retest takes from its config: the config itself, the plan it runs, the
 * step's timeout, and the Sandbox size, which comes from `main`'s config alone.
 */
export interface RunSettings {
  config: ConfigResult;
  plan: ScorePlan;
  timeoutMs: number;
  size: SandboxSize;
}

/** The run settings for `config`, at `size`. */
export function runSettings(config: ConfigResult, size: SandboxSize): RunSettings {
  const plan = scorePlan(config);
  return { config, plan, timeoutMs: scoreTimeoutMs(plan), size };
}

/**
 * How a role's script runs: the size its container starts at, the hosts it may reach besides its
 * grants, and how long it may take. Only a role that runs repository code takes the project's size;
 * a trusted role's is always `TRUSTED_SIZE`.
 */
export interface ScriptOptions<R extends SandboxRole> {
  size: R extends RepoCodeRole ? SandboxSize : typeof TRUSTED_SIZE;
  allow?: string[];
  timeoutMs?: number;
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
  { size, allow = [], timeoutMs }: ScriptOptions<R>,
): Promise<RunResult> {
  const grants = (await mintGrants(env, repos, ROLE_GRANTS[role])) as RoleGrants<R>;
  const sandbox = env.SANDBOX.getByName(sandboxName(instanceId, role));
  const result = await sandbox.run(script(grants), {
    // Only the preview container gets the Preview deploy grant; the trusted land container never
    // reaches the registry.
    access: roleAccess(role, grants, {
      preview: previewGrant(env.CF_ACCOUNT_ID, repos.project),
      allow,
    }),
    size,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (result.exitCode >= 10) {
    throw new Error(`${role} script exited ${result.exitCode}: ${result.stderr.slice(-2000)}`);
  }
  return result;
}

/** Mints the named grants for the run's origin and fork. */
async function mintGrants<K extends keyof RunGrants>(
  env: Env,
  { project, attempt }: RunRepos,
  names: readonly K[],
): Promise<Pick<RunGrants, K>> {
  const repos = reposFor(env);
  const repoNames = { origin: originRepo(project), fork: forkRepo(project, attempt) };
  const minted = await Promise.all(
    names.map(async (name) => {
      const { repo, access } = GRANT_SOURCES[name];
      const [info, token] = await Promise.all([
        repos.get(repoNames[repo]),
        repos.mintToken(repoNames[repo], access, TOKEN_TTL_SECONDS),
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
}

/**
 * Copies a container's logs to R2, truncated over `MAX_LOG_BYTES`, with each log's notes appended,
 * and returns the names stored. Each log a step wrote also notes the Sandbox size its container ran
 * at. A step that never ran wrote no log, unless it has notes; a log that fails to copy is left out
 * rather than failing the run.
 */
export async function storeLogs(
  env: Env,
  { sandbox: sandboxId, names, key, size, notes = new Map() }: LogsToStore,
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
      await env.LOGS.put(key(name), log, { httpMetadata: { contentType: LOG_CONTENT_TYPE } });
      stored.push(name);
    } catch (error) {
      console.error({ event: "sandbox.log_not_stored", sandbox: sandboxId, name, error: String(error) });
    }
  }
  return stored;
}
