import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { loadConfig, type ConfigResult } from "./config";
import {
  GRANT_SOURCES,
  grantsForRole,
  ROLE_GRANTS,
  RUNS_REPO_CODE,
  sandboxName,
  SCORING_ROLES,
  type RoleGrants,
  type RunGrants,
  type SandboxRole,
} from "./grants";
import { logKey, logNames, MISSING_LOG_EXIT, readLogScript } from "./logs";
import { forkRepo, originRepo } from "./repos";
import { buildResult, scorePlan, scoreTimeoutMs, type RawScore, type ScorePlan, type ScoringResult } from "./results";
import type { RunResult } from "./sandbox";
import type { ScoringOutcome, ScoringParams } from "./scoring";
import {
  landScript,
  parseResult,
  retestScript,
  scoreScript,
  type FailureStage,
  type LandResult,
  type RetestResult,
} from "./scripts";

const TOKEN_TTL_SECONDS = 30 * 60;
/** Each step's retries after its first try, for infrastructure errors; then the run ends `errored`. */
const STEP_RETRIES = { limit: 2, delay: "5 seconds", backoff: "constant" } as const;
/** What a container may reach while its logs are read: nothing. It is already running by then. */
const NO_ACCESS = { grants: [], preview: null, npmRegistry: false, allow: [] };
/** Re-test and land rounds before giving up on a main that keeps moving. */
const LAND_ROUNDS = 3;

/** How the spike's landing ended, journaled after the run's result. */
export type LandOutcome =
  | { kind: "landed"; mainSha: string }
  | { kind: "failed"; stage: FailureStage | "rebase-test"; output: string }
  | { kind: "bounced"; files: string[]; diff: string }
  | { kind: "error"; message: string };

/**
 * One scoring run: scores an attempt's head in a Sandbox and reports the result to the project's
 * Durable Object. The config is read from the origin's `main`, so an attempt can't change its own
 * checks. The container that runs repo code holds read grants only (see `grants.ts`).
 *
 * Until the merge queue takes them over, a head whose gate passed is then rebased onto main,
 * re-tested and landed, as the spike did. Landing runs before the result is reported, so a newer
 * push still cancels it. Previews (`previewScript`) are deployed by a later stage.
 *
 * Each setup step's and check's log is copied to R2 (`logs.ts`) before the score step returns, so
 * the result names the logs that were stored.
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
      const result = await step.do("score", { retries: STEP_RETRIES, timeout: timeoutMs }, () =>
        this.#score(instanceId, params, config, plan, timeoutMs),
      );
      outcome = { status: "done", result };
    } catch (cause) {
      outcome = { status: "errored", error: String(cause).slice(0, 4000) };
    }

    let landed: LandOutcome | null = null;
    if (outcome.status === "done" && outcome.result.gate === "passed") {
      try {
        landed = await this.#land(instanceId, params, step);
      } catch (cause) {
        landed = { kind: "error", message: String(cause).slice(0, 4000) };
      }
    }

    await step.do("teardown", async () => {
      await Promise.all(
        SCORING_ROLES.map((role) => this.env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()),
      );
    });
    await step.do("report", async () => {
      const project = this.env.PROJECT.getByName(params.project);
      await project.scoringFinished(params.run, outcome);
      const detail = { attempt: params.attempt, head: params.sha };
      if (landed?.kind === "landed") await project.note("main_advanced", { ...detail, sha: landed.mainSha });
      else if (landed !== null) await project.note("land_failed", { ...detail, landed });
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
    const run = await this.#run(
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
    const logs = await this.#storeLogs(instanceId, params, logNames(plan));
    return buildResult(config, raw, logs);
  }

  /**
   * Copies the score container's logs to R2, truncated over 5 MB, and returns the names stored. A
   * step that never ran wrote no log; a log that fails to copy is left out rather than failing the run.
   */
  async #storeLogs(instanceId: string, params: ScoringParams, names: string[]): Promise<string[]> {
    const sandbox = this.env.SANDBOX.getByName(sandboxName(instanceId, "score"));
    const run = { project: params.project, attempt: params.attempt, sha: params.sha, run: params.run };
    const stored: string[] = [];
    for (const name of names) {
      try {
        const read = await sandbox.run(readLogScript(name), { access: NO_ACCESS });
        if (read.exitCode === MISSING_LOG_EXIT) continue;
        if (read.exitCode !== 0) throw new Error(`exit ${read.exitCode}: ${read.stderr.slice(-500)}`);
        await this.env.LOGS.put(logKey(run, name), read.stdout, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        stored.push(name);
      } catch (cause) {
        console.error({ event: "scoring.log_not_stored", run: params.run, name, error: String(cause) });
      }
    }
    return stored;
  }

  /** The spike's landing: rebase onto main, re-test, and push, retrying while main moves underneath. */
  async #land(instanceId: string, params: ScoringParams, step: WorkflowStep): Promise<LandOutcome> {
    const landStep = { retries: STEP_RETRIES, timeout: "10 minutes" } as const;
    for (let round = 1; round <= LAND_ROUNDS; round++) {
      const retest = await step.do(`retest ${round}`, landStep, () =>
        this.#run(instanceId, params, "retest", (g) =>
          retestScript(g.originRead.remote, g.forkRead.remote, params.sha),
        ),
      );
      const retested = parseResult<RetestResult>(retest.stdout);
      if (retested === null) return scriptError("retest", retest);
      if (retested.kind === "bounced") return retested;
      if (retested.kind === "failed") {
        const stage = retested.stage === "install" ? "install" : "rebase-test";
        return { kind: "failed", stage, output: retested.output };
      }

      const land = await step.do(`land ${round}`, landStep, () =>
        this.#run(instanceId, params, "land", (g) =>
          landScript(g.originWrite.remote, g.forkRead.remote, params.sha, retested),
        ),
      );
      const result = parseResult<LandResult>(land.stdout);
      if (result === null) return scriptError("land", land);
      if (result.kind === "landed") return { kind: "landed", mainSha: result.mainSha };
      if (result.kind === "mismatch") {
        return {
          kind: "error",
          message: `land produced tree ${result.tree}, but retest tested ${retested.tree}; refusing to push`,
        };
      }
    }
    return { kind: "error", message: `main kept moving; gave up after ${LAND_ROUNDS} rounds` };
  }

  /**
   * Runs a script in the role's own container with only that role's grants. They're minted here, in
   * the step, so a retry never holds a stale one.
   */
  async #run<R extends SandboxRole>(
    instanceId: string,
    params: ScoringParams,
    role: R,
    script: (grants: RoleGrants<R>) => string,
    { allow = [], timeoutMs }: { allow?: string[]; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const grants = (await this.#grants(params, ROLE_GRANTS[role])) as RoleGrants<R>;
    const sandbox = this.env.SANDBOX.getByName(sandboxName(instanceId, role));
    const result = await sandbox.run(script(grants), {
      // Installing dependencies is repo work; the trusted land container never reaches the registry.
      access: { grants: grantsForRole(role, grants), preview: null, npmRegistry: RUNS_REPO_CODE[role], allow },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    // Exit codes 10+ are infrastructure failures (fetch, checkout, diff); throw so the step retries.
    if (result.exitCode >= 10) {
      throw new Error(`${role} script exited ${result.exitCode}: ${result.stderr.slice(-2000)}`);
    }
    return result;
  }

  /** Mints the named grants for the run's origin and fork. */
  async #grants<K extends keyof RunGrants>(
    { project, attempt }: ScoringParams,
    names: readonly K[],
  ): Promise<Pick<RunGrants, K>> {
    const repos = reposFor(this.env);
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
}

function scriptError(stage: string, result: RunResult): LandOutcome {
  return {
    kind: "error",
    message: `${stage} script gave no result (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`,
  };
}
