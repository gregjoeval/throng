import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { loadConfig } from "./config";
import { parseMergeTree, type ConflictDetails } from "./conflicts";
import { LANDING_ROLES, sandboxName } from "./grants";
import {
  failedChecks,
  mergeAuthor,
  mergeCommitMessage,
  retestConfig,
  type LandingOutcome,
  type LandingParams,
  type Signer,
} from "./landing";
import { landingLogKey, logNames } from "./logs";
import { buildResult, scorePlan, scoreTimeoutMs, type RawScore } from "./results";
import {
  conflictCheckScript,
  landScript,
  parseResult,
  retestScript,
  type ConflictCheckResult,
  type LandResult,
  type MergePlan,
} from "./scripts";
import { attemptRef } from "./task-store";
import { runInSandbox, STEP_RETRIES, storeLogs } from "./workflows";

/** A step that kept failing on infrastructure; the landing ends `errored` naming it. */
class StepFailed extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(String(cause).slice(0, 2000));
  }
}

/** The raw score of a retest that ran nothing: an invalid config fails without running anything. */
const NOTHING_RUN: RawScore = { base: null, shortstat: "", builtinMs: 0, setupFailed: null, checks: [] };

/**
 * One landing of the merge queue's front merge request on `origin/main`. See the merge queue spec's
 * "Landing" section.
 *
 * 1. Conflict check, in the untrusted `check` container (read grants on the origin and the fork):
 *    `git merge-tree` of `main` and the approved head. A conflict ends it `conflict`; a clean merge
 *    records the tree and `main`'s sha.
 * 2. Retest, in the same container, only when `origin/main`'s config has required checks: setup and
 *    the required checks on the merged tree, with the scoring runner, outbound policy and logs. A
 *    required check not passing ends it `failed_checks`.
 * 3. Land, in the trusted `land` container (origin write, fork read, no repository code): it first
 *    claims the push from the project's DO, which fails if the merge request left the queue, then
 *    commits the merge (author the approver, committer Throng), checks its tree against step 1's
 *    and pushes with a lease on step 1's `main`. A moved `main` or another tree ends it `errored`.
 * 4. Report the outcome to the DO, which merges or dequeues the merge request and starts the next
 *    landing.
 *
 * Each step retries infrastructure errors twice, then the landing ends `errored`.
 */
export class LandingWorkflow extends WorkflowEntrypoint<Env, LandingParams> {
  override async run(
    event: Readonly<WorkflowEvent<LandingParams>>,
    step: WorkflowStep,
  ): Promise<LandingOutcome | null> {
    const params = event.payload;
    const instanceId = event.instanceId;
    const project = () => this.env.PROJECT.getByName(params.project);

    let outcome: LandingOutcome | null;
    try {
      outcome = await this.#land(instanceId, params, step);
    } catch (cause) {
      const failed = cause instanceof StepFailed ? cause : new StepFailed("landing", cause);
      outcome = { kind: "errored", details: { step: failed.step, error: failed.message } };
    }

    await step.do("teardown", { retries: STEP_RETRIES }, async () => {
      await Promise.all(
        LANDING_ROLES.map((role) => this.env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()),
      );
    });
    // A stopped landing reports nothing: its merge request already left the queue.
    if (outcome !== null) {
      const reported = outcome;
      await step.do("report", { retries: STEP_RETRIES }, async () => {
        await project().landingFinished(params.landing, reported);
      });
    }
    return outcome;
  }

  /** Steps 1 to 3. Null when the DO refused the push claim: the landing was stopped. */
  async #land(instanceId: string, params: LandingParams, step: WorkflowStep): Promise<LandingOutcome | null> {
    const ref = attemptRef(params.task, params.attempt);
    const repos = { project: params.project, attempt: ref };
    const tenMinutes = { retries: STEP_RETRIES, timeout: "10 minutes" } as const;

    const checked = await this.#step(step, "conflict check", tenMinutes, async () => {
      const run = await runInSandbox(this.env, instanceId, repos, "check", (g) =>
        conflictCheckScript(g.originRead.remote, g.forkRead.remote, params.head),
      );
      const result = parseResult<ConflictCheckResult>(run.stdout);
      if (result === null)
        throw new Error(`conflict check gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
      return result;
    });
    const merged = parseMergeTree(checked.output);
    if (!checked.clean) {
      const details: ConflictDetails = { attempt: ref, head: params.head, main: checked.main, files: merged.files };
      return { kind: "conflict", details };
    }
    const merge: MergePlan = { head: params.head, main: checked.main, tree: merged.tree };

    const config = await this.#step(step, "config", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
      loadConfig(reposFor(this.env), params.project),
    );
    const retest = retestConfig(config);
    if (retest !== null) {
      const plan = scorePlan(retest);
      const timeoutMs = scoreTimeoutMs(plan);
      const { result, logs } =
        retest.kind === "invalid"
          ? { result: buildResult(retest, NOTHING_RUN), logs: [] }
          : await this.#step(step, "retest", { retries: STEP_RETRIES, timeout: timeoutMs }, async () => {
              const run = await runInSandbox(
                this.env,
                instanceId,
                repos,
                "check",
                (g) => retestScript(g.originRead.remote, g.forkRead.remote, merge, plan),
                { allow: plan.allow, timeoutMs },
              );
              const raw = parseResult<RawScore>(run.stdout);
              if (raw === null)
                throw new Error(`retest gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
              const built = buildResult(retest, raw);
              const notes = new Map(built.checks.map((check) => [check.name, check.notes]));
              const stored = await storeLogs(
                this.env,
                sandboxName(instanceId, "check"),
                logNames(plan),
                (log) => landingLogKey(params, log),
                notes,
              );
              return { result: built, logs: stored };
            });
      if (result.gate !== "passed") return { kind: "failed_checks", details: failedChecks(result, logs) };
    }

    const signers = await this.#step(step, "signers", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
      this.#signers(params),
    );
    const claimed = await this.#step(step, "claim", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
      this.env.PROJECT.getByName(params.project).claimLandingPush(params.landing),
    );
    if (!claimed) return null;

    const landed = await this.#step(step, "land", tenMinutes, async () => {
      const run = await runInSandbox(this.env, instanceId, repos, "land", (g) =>
        landScript(g.originWrite.remote, g.forkRead.remote, {
          ...merge,
          message: mergeCommitMessage({
            task: params.task,
            attempt: params.attempt,
            title: params.title,
            approver: signers.approver,
            coAuthors: signers.coAuthors,
          }),
          author: mergeAuthor(signers.approver),
          committedAt: Math.floor(params.startedAt / 1000),
        }),
      );
      const result = parseResult<LandResult>(run.stdout);
      if (result === null) throw new Error(`land gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
      return result;
    });
    switch (landed.kind) {
      case "landed":
        return { kind: "landed", sha: landed.sha };
      case "moved":
        return { kind: "errored", details: { step: "land", error: `main moved from ${merge.main}; the lease failed` } };
      case "mismatch":
        return {
          kind: "errored",
          details: { step: "land", error: `the merge gave tree ${landed.tree}, not the checked ${merge.tree}` },
        };
    }
  }

  /** A Workflow step whose failure, once its retries are spent, names it. */
  async #step<T extends Rpc.Serializable<T>>(
    step: WorkflowStep,
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step.do(name, config, fn);
    } catch (cause) {
      throw new StepFailed(name, cause);
    }
  }

  /** The approver and each co-author, with their handles from D1. */
  async #signers(params: LandingParams): Promise<{ approver: Signer; coAuthors: Signer[] }> {
    const ids = [...new Set([params.approver.user, ...params.coAuthors.map((c) => c.user)])];
    const { results } = await this.env.DB.prepare(
      `SELECT id, handle FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(...ids)
      .all<{ id: string; handle: string }>();
    const handles = new Map(results.map((u) => [u.id, u.handle]));
    const signer = (id: string, agent: string | null): Signer => ({ id, handle: handles.get(id) ?? id, agent });
    return {
      approver: signer(params.approver.user, params.approver.agent),
      coAuthors: params.coAuthors.map((c) => signer(c.user, c.agent)),
    };
  }
}
