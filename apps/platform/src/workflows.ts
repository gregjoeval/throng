import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { loadConfig, type ConfigResult } from "./config";
import {
  GRANT_SOURCES,
  ROLE_GRANTS,
  sandboxName,
  SCORING_ROLES,
  type RoleGrants,
  type RunGrants,
  type SandboxRole,
} from "./grants";
import { roleAccess } from "./network";
import { previewName } from "./preview";
import { forkRepo, originRepo } from "./repos";
import {
  buildResult,
  previewPlan,
  scorePlan,
  scoreTimeoutMs,
  withPreview,
  type RawScore,
  type ScorePlan,
  type ScoringResult,
} from "./results";
import type { RunResult } from "./sandbox";
import type { ScoringOutcome, ScoringParams } from "./scoring";
import {
  landScript,
  parseResult,
  PREVIEW_BUILD_TIMEOUT_MS,
  previewScript,
  retestScript,
  scoreScript,
  type FailureStage,
  type LandResult,
  type PreviewScriptResult,
  type RetestResult,
} from "./scripts";

const TOKEN_TTL_SECONDS = 30 * 60;
/** The preview step: fetching, installing and the build step at its timeout, then the deploy. */
const PREVIEW_STEP_TIMEOUT_MS = PREVIEW_BUILD_TIMEOUT_MS + 10 * 60 * 1000;
/** Each step's retries after its first try, for infrastructure errors; then the run ends `errored`. */
const STEP_RETRIES = { limit: 2, delay: "5 seconds", backoff: "constant" } as const;
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
 * When the config has a `preview` section and the gate passed, the head is then deployed as a Worker
 * Preview from a separate container (see `#preview`); a failed Preview never changes the gate.
 *
 * Until the merge queue takes them over, a head whose gate passed is then rebased onto main,
 * re-tested and landed, as the spike did. Landing runs before the result is reported, so a newer
 * push still cancels it.
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
      const result =
        preview === null ? scored : withPreview(scored, await this.#preview(instanceId, params, preview, step));
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

  /** Runs the score script in the run's own container and builds its result. */
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
    return buildResult(config, raw);
  }

  /**
   * Deploys the head as a Worker Preview from the preview container, which holds the Preview deploy
   * grant and only a read grant on the fork. Null when it gave no result or kept failing: a failed
   * Preview is recorded on the result and never changes the gate.
   */
  async #preview(
    instanceId: string,
    params: ScoringParams,
    { command }: { command: string | null },
    step: WorkflowStep,
  ): Promise<PreviewScriptResult | null> {
    const workerName = this.env.PREVIEW_WORKER;
    const name = previewName(params, workerName);
    try {
      const run = await step.do("preview", { retries: STEP_RETRIES, timeout: PREVIEW_STEP_TIMEOUT_MS }, () =>
        this.#run(
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
          { timeoutMs: PREVIEW_STEP_TIMEOUT_MS },
        ),
      );
      const deployed = parseResult<PreviewScriptResult>(run.stdout);
      if (deployed === null) {
        console.warn({ event: "scoring.preview_no_result", exit: run.exitCode, stderr: run.stderr.slice(-2000) });
      } else if (!deployed.ok) {
        console.log({ event: "scoring.preview_failed", stage: deployed.stage, output: deployed.output.slice(-2000) });
      }
      return deployed;
    } catch (cause) {
      console.warn({ event: "scoring.preview_errored", error: String(cause).slice(0, 2000) });
      return null;
    }
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
      // Only the preview container gets the Preview deploy grant; the trusted land container never
      // reaches the registry.
      access: roleAccess(role, grants, {
        preview: { accountId: this.env.CF_ACCOUNT_ID, workerName: this.env.PREVIEW_WORKER },
        allow,
      }),
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
