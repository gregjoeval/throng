import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { loadConfig } from "./config";
import type { ConfigResult } from "./config";
import { GRANT_SOURCES, ROLE_GRANTS, sandboxName, SCORING_ROLES } from "./grants";
import type { RoleGrants, RunGrants, SandboxRole } from "./grants";
import { LOG_CONTENT_TYPE, logKey, logNames, MISSING_LOG_EXIT, PREVIEW_LOG, readLogScript, withNotes } from "./logs";
import { roleAccess } from "./network";
import { previewName } from "./preview";
import { forkRepo, originRepo } from "./repos";
import { buildResult, previewPlan, scorePlan, scoreTimeoutMs, withPreview } from "./results";
import type { PreviewPlan, RawScore, ScorePlan, ScoringResult } from "./results";
import type { RunResult } from "./sandbox";
import type { ScoringOutcome, ScoringParams } from "./scoring";
import { parseResult, PREVIEW_BUILD_TIMEOUT_MS, previewScript, scoreScript } from "./scripts";
import type { PreviewScriptResult } from "./scripts";

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
      const config = await step.do("config", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        loadConfig(reposFor(this.env), params.project),
      );
      const plan = scorePlan(config);
      const timeoutMs = scoreTimeoutMs(plan);
      const scored = await step.do("score", { retries: STEP_RETRIES, timeout: timeoutMs }, () =>
        this.#score(instanceId, params, config, plan, timeoutMs),
      );
      const preview = previewPlan(config, scored);
      let result = scored;
      if (preview !== null) {
        const { deployed, logs } = await this.#preview(instanceId, params, preview, step);
        result = { ...withPreview(scored, deployed), logs: [...scored.logs, ...logs] };
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

  /** Runs the score script in the run's own container, stores its logs and builds its result. */
  async #score(
    instanceId: string,
    params: ScoringParams,
    config: ConfigResult,
    plan: ScorePlan,
    timeoutMs: number,
  ): Promise<ScoringResult> {
    const run = await runInSandbox(
      this.env,
      instanceId,
      params,
      "score",
      (g) => scoreScript(g.forkRead.remote, g.originRead.remote, params.sha, plan),
      { allow: plan.allow, timeoutMs },
    );
    const raw = parseResult<RawScore>(run.stdout);
    if (raw === null) {
      throw new Error(`score script gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
    }
    const result = buildResult(config, raw);
    const notes = new Map(result.checks.map((check) => [check.name, check.notes]));
    const logs = await storeLogs(
      this.env,
      sandboxName(instanceId, "score"),
      logNames(plan),
      (log) => logKey(params, log),
      notes,
    );
    return { ...result, logs };
  }

  /**
   * Deploys the head as a Worker Preview from the preview container, which holds the Preview deploy
   * grant and only a read grant on the fork, and stores its log. `deployed` is null when it gave no
   * result, and the error when the step kept failing on infrastructure; then whatever log the
   * container wrote is still stored. A failed Preview is recorded on the result and never changes the gate.
   */
  async #preview(
    instanceId: string,
    params: ScoringParams,
    { command, allow }: PreviewPlan,
    step: WorkflowStep,
  ): Promise<{ deployed: PreviewScriptResult | null | { error: string }; logs: string[] }> {
    const workerName = this.env.PREVIEW_WORKER;
    const name = previewName(params, workerName);
    try {
      const { run, logs } = await step.do(
        "preview",
        { retries: STEP_RETRIES, timeout: PREVIEW_STEP_TIMEOUT_MS },
        async () => {
          const deploy = await runInSandbox(
            this.env,
            instanceId,
            params,
            "preview",
            (g) =>
              previewScript(g.forkRead.remote, params.sha, {
                accountId: this.env.CF_ACCOUNT_ID,
                workerName,
                previewName: name,
                command,
              }),
            { allow, timeoutMs: PREVIEW_STEP_TIMEOUT_MS },
          );
          return {
            run: deploy,
            logs: await storeLogs(this.env, sandboxName(instanceId, "preview"), [PREVIEW_LOG], (log) =>
              logKey(params, log),
            ),
          };
        },
      );
      const deployed = parseResult<PreviewScriptResult>(run.stdout);
      if (deployed === null) {
        console.warn({ event: "scoring.preview_no_result", exit: run.exitCode, stderr: run.stderr.slice(-2000) });
      } else if (!deployed.ok) {
        console.log({ event: "scoring.preview_failed", stage: deployed.stage, output: deployed.output.slice(-2000) });
      }
      return { deployed, logs };
    } catch (error) {
      const message = String(error).slice(0, 2000);
      console.warn({ event: "scoring.preview_errored", error: message });
      // A lost Sandbox can't give its log back either; that still mustn't end the run.
      const logs = await step
        .do("preview logs", { retries: STEP_RETRIES }, () =>
          storeLogs(this.env, sandboxName(instanceId, "preview"), [PREVIEW_LOG], (log) => logKey(params, log)),
        )
        .catch(() => []);
      return { deployed: { error: message }, logs };
    }
  }
}

/** The repos a run's grants are for: the project's origin and one attempt's fork (`t42a3`). */
export interface RunRepos {
  project: string;
  attempt: string;
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
  { allow = [], timeoutMs }: { allow?: string[]; timeoutMs?: number } = {},
): Promise<RunResult> {
  const grants = (await mintGrants(env, repos, ROLE_GRANTS[role])) as RoleGrants<R>;
  const sandbox = env.SANDBOX.getByName(sandboxName(instanceId, role));
  const result = await sandbox.run(script(grants), {
    // Only the preview container gets the Preview deploy grant; the trusted land container never
    // reaches the registry.
    access: roleAccess(role, grants, {
      preview: { accountId: env.CF_ACCOUNT_ID, workerName: env.PREVIEW_WORKER },
      allow,
    }),
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

/**
 * Copies a container's logs to R2 under `key(name)`, truncated over `MAX_LOG_BYTES`, with each log's
 * `notes` appended (see `withNotes`), and returns the names stored. A step that never ran wrote no
 * log, unless it has notes; a log that fails to copy is left out rather than failing the run.
 */
export async function storeLogs(
  env: Env,
  sandboxId: string,
  names: string[],
  key: (name: string) => string,
  notes: ReadonlyMap<string, string[]> = new Map(),
): Promise<string[]> {
  const sandbox = env.SANDBOX.getByName(sandboxId);
  const stored: string[] = [];
  for (const name of names) {
    try {
      const read = await sandbox.run(readLogScript(name), { access: NO_ACCESS });
      if (read.exitCode !== 0 && read.exitCode !== MISSING_LOG_EXIT) {
        throw new Error(`exit ${read.exitCode}: ${read.stderr.slice(-500)}`);
      }
      const log = withNotes(read.exitCode === MISSING_LOG_EXIT ? null : read.stdout, notes.get(name) ?? []);
      if (log === null) continue;
      await env.LOGS.put(key(name), log, { httpMetadata: { contentType: LOG_CONTENT_TYPE } });
      stored.push(name);
    } catch (error) {
      console.error({ event: "sandbox.log_not_stored", sandbox: sandboxId, name, error: String(error) });
    }
  }
  return stored;
}
