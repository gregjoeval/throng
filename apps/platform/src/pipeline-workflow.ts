import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { lineBase } from "./base";
import { CACHE_TRANSFER_TIMEOUT_MS, cacheKeyHashes, runCachesFrom, unkeyedCaches } from "./caches";
import type { RunCache, TreeReader } from "./caches";
import { loadConfig, namedSecrets, networkAllow, parseConfig, pipelineConfig, sandboxSize } from "./config";
import type { CacheConfig, ConfigResult, SandboxSize, StepConfig } from "./config";
import { conflictFiles, parseMergeTree } from "./conflicts";
import type { ConflictDetails } from "./conflicts";
import {
  landingSandboxNames,
  legacyScoringSandboxNames,
  pipelineSandboxName,
  sandboxName,
  TRUSTED_SIZE,
} from "./grants";
import { actedAlias, conflictOutcome, landingOutcome, mergeAuthor, mergeCommitMessage } from "./landing";
import type { LandingParams, LegacyLandingParams, Signer } from "./landing";
import { logKey, setupLogName, stepLogName } from "./logs";
import type { NetworkAccess } from "./network";
import { loadRegistries } from "./npmrc";
import { forkRepo, lineRepo, originMainRef, originRepo } from "./repos";
import type { TreeEntry } from "./repos";
import { checkOrder, POST_GATE_STEP_TIMEOUT_MS, scorePlan, setupTimeoutMs, STEP_SLACK_MS } from "./results";
import type { PlannedCheck, RawScore, ScorePlan } from "./results";
import { cacheSavers, RunCaches, setupCaches, withCacheNotes } from "./run-caches";
import type { CacheNote } from "./run-caches";
import { pipelineOutcome, withPostGateSteps } from "./run-outcome";
import type { PostGateRun, RunOutcome, SetupRun } from "./run-outcome";
import type { RunResult, SandboxSnapshot } from "./sandbox";
import { pipelineFor } from "./scoring";
import type { LandingRunParams, PipelineParams, PlanVerdict, RunReport } from "./scoring";
import {
  checkScript,
  landScript,
  mergeCheckoutSha,
  mergeScript,
  parseResult,
  setupScript,
  stepReadyScript,
  stepScript,
} from "./scripts";
import type {
  Checkout,
  CheckRun,
  LandResult,
  MergeCheckout,
  MergePlan,
  MergeResult,
  SetupResult,
  StepReady,
  StepRun,
} from "./scripts";
import { keyringFrom, maskedDeep, masking, openSealed } from "./secrets";
import type { Keyring, SecretRefusal } from "./secrets";
import { withTask } from "./task-definitions";
import { attemptRef } from "./task-refs";
import { userHandles } from "./users";
import { runInSandbox, STEP_RETRIES, storeLogs } from "./workflows";
import type { ScriptOptions } from "./workflows";

/** The note on a check's or post-gate step's container that ran the setups itself, saying why. */
function setupsRerunNote(kind: "check" | "step", snapshot: SandboxSnapshot | null): string {
  const why = snapshot === null ? "the run took no snapshot of them" : "it couldn't start from the setups' snapshot";
  return `setups re-run in this ${kind}'s container: ${why}`;
}

/** The secrets a container holds, as its env, and how to mask them, and any others it may print, in what it reports. */
interface Held {
  env: Record<string, string>;
  mask: (text: string) => string;
}

const nothingHeld: Held = { env: {}, mask: (text) => text };

/** The secrets a step loaded for a container, or why one it was to hold can't be had. */
type Holding = ({ kind: "held" } & Held) | ({ kind: "refused" } & SecretRefusal);

/** How readying a post-gate step's container went: ready for its command, or refused a secret it was to hold. */
type StepReadied = { kind: "ready"; setupsRerun: boolean; cacheNotes: string[] } | { kind: "refused"; error: string };

/** How a post-gate step's command went: it ran, or its readied container was lost before it started. */
type StepCommand = { kind: "ran"; run: PostGateRun } | { kind: "lost" };

/**
 * A ready step's result as Workflows kept it, in the current shape: a run that started before ready
 * steps' results had a `kind` kept `{ error }` for a refusal, and `StepReady` with its notes else.
 */
function readiedOf(kept: StepReadied | { error: string } | (StepReady & { cacheNotes: string[] })): StepReadied {
  if ("kind" in kept) return kept;
  return "error" in kept ? { kind: "refused", error: kept.error } : { kind: "ready", ...kept };
}

/** A command step's result as Workflows kept it, in the current shape: one from before it had a `kind` ran. */
function commandOf(kept: StepCommand | PostGateRun): StepCommand {
  return "kind" in kept ? kept : { kind: "ran", run: kept };
}

/** A secret a step was to hold is gone or no longer allowed: the step fails, naming it. */
class SecretUnavailable extends Error {}

/** What the setup container leaves for the checks: how each setup went, its diff, and the snapshot to start from. */
interface SetupStage extends Omit<SetupResult, "setups"> {
  setups: SetupRun[];
  /** Null when a setup failed, under `wrangler dev`, or when the snapshot failed: checks then re-run the setups. */
  snapshot: SandboxSnapshot | null;
  /** The setup logs stored, by name. */
  logs: string[];
}

/**
 * How one check went: its run, and whether its log was stored. One that never started because a
 * secret it was to hold is gone has no exit, and says so in `error`.
 */
interface CheckStage extends Omit<CheckRun, "setupsRerun" | "exit"> {
  exit: number | null;
  logged: boolean;
  notes: string[];
  error?: string;
}

/**
 * One pipeline run of a line's head, reported to the project's Durable Object as the run's outcome.
 * The pipeline comes from the line, never the tree: `main` runs `main`, and an attempt's fork (`t42a3`)
 * or a task branch (`t42`) runs `default`. The config and the `.npmrc` registry hosts are read from
 * one commit of the origin's `main`, so a run can't change its own checks or widen its own network
 * access, and the two always agree. The pipeline's groups choose which of the project's checks run;
 * an attempt's task's checks always run on it.
 *
 * Its stages are fixed. One container runs the setups in order and stops at the first that fails; it
 * is then snapshotted. Each check runs in its own container started from that snapshot, in parallel,
 * once every check it waits for (`after`) passed; a check whose wait didn't pass is skipped. A failed
 * restore is retried once, then the check's container starts from the image and re-runs the setups.
 * There's no snapshot under `wrangler dev`, so every check's container re-runs them there. Once the
 * gate passes, `main`'s post-gate steps run in order, each in its own container started the same
 * way, stopping at the first that doesn't pass; the rest are skipped. A post-gate step's container
 * is readied in one Workflow step, retried like any other, and its command runs in the next, never
 * retried, so a deploy never runs twice by itself: an infrastructure error once it started ends the
 * run `errored`. A readied container lost before its command started is readied again, in new
 * steps, as many times as a step retries.
 *
 * A merge request's landing is a `main` run with a `merge` before its setups and a `land` before its
 * post-gate steps (spec #257, "Landing"):
 *
 * 1. `merge`, untrusted, in `<instance>/merge` (read grants on the origin and the attempt's fork):
 *    `git merge-tree` of `main` and the approved head. A conflict ends the run there, keeping the
 *    conflict in its outcome; a clean merge records the merged tree and its `.throng/config.yml`.
 * 2. The setups and checks run on the merged tree, under its config rather than `main`'s, so a merge
 *    request that fixes a broken config can land. Their containers make the merge again from the
 *    origin and the fork, with the same read grants. The Sandbox size and network are still `main`'s.
 *    A failed gate ends the run there.
 * 3. `land`, trusted, in `<instance>/land` (origin write, fork read, no repository code): it claims
 *    the push from the project, which fails once the merge request has left the queue, commits the
 *    merge as the approver, checks its tree against step 1's and pushes with a lease on step 1's
 *    `main`. A moved `main` ends the run `errored`. One whose result was lost after it pushed finds
 *    its merge commit on `main`. The landed sha becomes the run's head, and the project merges the
 *    merge request.
 * 4. The post-gate steps run on the landed commit.
 *
 * Every other container (`<instance>/setup`, `<instance>/check:<name>`, `<instance>/step:<name>`) holds one
 * read grant on its line's repo (the fork for an attempt, the origin for a task branch or `main`, both
 * fetched with `refs/tasks/*`) and no write grant, reaches only `main`'s `network.allow` and `.npmrc`
 * registries, and gets the run's `THRONG_*` variables (until a landing lands, its `THRONG_SHA` is the
 * merge commit its containers make, which is never pushed). Each copies its logs to R2 within its
 * step, while it still runs, then stops; a retried step starts its container afresh. When the run
 * ends, or a newer head cancels it, every planned container is destroyed and the snapshot released.
 *
 * Setups, checks and `main`'s post-gate steps name secrets; `main`'s own reach only its post-gate
 * steps. The plan names them to the project, which refuses the run when one has no value or isn't
 * allowed in its pipeline, and hands an untrusted run that names any to the owner (it waits, and
 * this Workflow ends having started nothing). In a trusted run, the step that starts a container
 * loads the secrets it holds, as the settings are then, and opens them there: the setup container
 * holds every setup's, a check's container its own (and the setups' when it re-runs them). A
 * post-gate step's are loaded in the step that runs its command, never retried, and go to that
 * command alone; the step readying its container holds only the setups' when it re-runs them.
 * Params, plans and step results carry names only, and what a container held is
 * masked in its logs, metric values and errors. Whatever a setup writes to disk, a secret included,
 * is in the snapshot the checks start from, which Cloudflare keeps until 30 days after its last
 * restore; so a check's or post-gate step's step loads the setups' secrets too, to mask them, though
 * only a container that re-runs the setups holds them.
 *
 * It takes over the `ScoringWorkflow`'s Workflow name, so a run that started under that class resumes
 * here: its params name the line `attempt`, and its old step names (`score`) are never called again.
 * It takes over the `LandingWorkflow`'s too: a landing that started under that class resumes here
 * only to hand its landing back to the project, which lands it again as a run.
 */
export class PipelineWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  /** Opens the secrets a step loads: `SECRETS_KEYRING`, read on first use. */
  #keyring: Keyring | null = null;

  override async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<RunReport | null> {
    const payload = event.payload;
    if (isLegacyLanding(payload)) {
      await this.#retireLanding(payload, event.instanceId, step);
      return null;
    }
    const params = paramsLine(payload);
    const instanceId = event.instanceId;
    const landing = params.sha === null ? params.landing : null;
    let report: RunReport | null;
    const planned: { plan: RunPlan | null } = { plan: null };
    try {
      report = await this.#run(step, instanceId, params, planned);
    } catch (error) {
      report = { status: "errored", error: String(error).slice(0, 4000) };
    }
    // An untrusted run that names a secret is the owner's to start; it started nothing.
    if (report === null) return null;

    const containers = planned.plan === null ? [] : plannedContainers(instanceId, planned.plan);
    const all = landing === null ? containers : [...landingSandboxNames(instanceId), ...containers];
    await step.do("teardown", { retries: STEP_RETRIES }, () => teardownPipeline(this.env.SANDBOX, instanceId, all));
    const reported = report;
    await step.do("report", { retries: STEP_RETRIES }, async () => {
      await this.env.PROJECT.getByName(params.project).pipelineFinished(params.run, reported);
    });
    return report;
  }

  /**
   * The run up to its report: its outcome, or null when it waits for the owner. What it plans to run
   * goes in `planned` as soon as it's known, so the containers it may have started are torn down
   * whatever happens next.
   */
  async #run(
    step: WorkflowStep,
    instanceId: string,
    params: RunParams,
    planned: { plan: RunPlan | null },
  ): Promise<RunReport | null> {
    const landing = params.sha === null ? params.landing : null;
    const oneMinute = { retries: STEP_RETRIES, timeout: "1 minute" } as const;
    // Pinned once, so the config and the `.npmrc` are read from the same commit even if `main` moves.
    const main = await step.do("main", oneMinute, () => originMainRef(reposFor(this.env), params.project));
    let config: ConfigResult;
    let size: SandboxSize;
    let allow: string[];
    let base: string | null;
    let merge: LandingMerge | null = null;
    if (landing === null) {
      // Named apart from the steps it replaced, whose recorded outputs had other shapes.
      ({ config, size } = await step.do("pipeline config", oneMinute, () => this.#config(params, main)));
      // A task's definitions never change `network.allow`, so the run's config gives `main`'s.
      allow = networkAllow(config);
      const found = await step.do("base", oneMinute, () =>
        lineBase(reposFor(this.env), params.project, { line: params.line, head: params.sha ?? "" }),
      );
      base = found?.sha ?? null;
    } else {
      // A landing's containers start at the size, and reach the hosts, `main`'s config sets, whatever
      // the merged tree's says.
      ({ size, allow } = await step.do("main settings", oneMinute, async () => {
        const mainConfig = await loadConfig(reposFor(this.env), params.project, main);
        return { size: sandboxSize(mainConfig), allow: networkAllow(mainConfig) };
      }));
      const merged = await step.do("merge", { retries: STEP_RETRIES, timeout: "10 minutes" }, () =>
        this.#merge(instanceId, params, landing, size),
      );
      if (merged.kind === "conflict") return { status: "done", outcome: conflictOutcome(merged.details) };
      // Committed at the landing's start, so every container makes the same merge commit.
      const plan = { ...merged.plan, committedAt: Math.floor(landing.startedAt / 1000) };
      const sha = await mergeCheckoutSha(plan);
      merge = { attempt: attemptRef(landing.task, landing.attempt), plan, sha, trees: merged.trees };
      // The merged tree's config, so a merge request that fixes a broken config can land.
      config = pipelineConfig(parseConfig(merged.config), "main");
      base = merged.plan.main;
    }
    const registries = await step.do("registries", oneMinute, () =>
      loadRegistries(reposFor(this.env), params.project, main),
    );
    const plan = { ...scorePlan(config), steps: postGateSteps(config, params) };
    planned.plan = plan;
    // Before any container starts, so a cancel can name every one the run may start, and so the
    // secrets the run names are checked against the settings, by name, before anything runs.
    const verdict = await step.do("plan", oneMinute, async (): Promise<PlanVerdict> => {
      const answer = await this.env.PROJECT.getByName(params.project).pipelinePlanned(
        params.run,
        plannedContainers(instanceId, plan),
        namedSecrets(plan),
      );
      return answer.kind === "refused" ? { kind: "refused", error: answer.error } : { kind: answer.kind };
    });
    if (verdict.kind === "waiting") return null;
    if (verdict.kind === "refused") throw new Error(verdict.error);
    // Keyed by the tree the run runs on: a landing's merged tree, which its head isn't.
    const caches = new RunCaches({
      containers: this.env.SANDBOX,
      index: this.env.PROJECT.getByName(params.project),
      project: params.project,
      run: params.run,
      caches: await this.#caches(step, instanceId, params, runCaches(config, plan), merge),
      inSnapshot: setupCaches(plan),
      savers: cacheSavers(instanceId, plan),
    });
    const context: RunContext = { instanceId, params, merge, plan, size, network: { registries, allow }, caches };
    const setup = await step.do(
      "setup",
      { retries: STEP_RETRIES, timeout: setupsStepTimeoutMs(plan, setupCaches(plan), 2) },
      () => this.#setup(context, base),
    );
    const checks = setup.setups.every((s) => s.exit === 0)
      ? await this.#checks(step, context, setup)
      : new Map<string, CheckStage>();
    const scored = outcomeOf(config, plan, setup, checks);
    if (landing === null || merge === null) {
      return { status: "done", outcome: await this.#postGate(step, context, setup.snapshot, scored) };
    }
    if (scored.gate !== "passed") {
      return { status: "done", outcome: landingOutcome(withPostGateSteps(scored, plan.steps, new Map()), null) };
    }
    const sha = await this.#land(step, instanceId, params, landing, merge.plan);
    // The post-gate steps run on the landed commit, read from the origin like any `main` run's.
    const landed: RunContext = { ...context, params: { ...params, sha }, merge: null };
    const outcome = await this.#postGate(step, landed, setup.snapshot, scored);
    return { status: "done", outcome: landingOutcome(outcome, { sha }) };
  }

  /**
   * The run's config, its layers merged once: the project's config at `main` (the run's pinned commit
   * of it), then what the task defines over it. A clash between them makes it invalid. The e2e routes'
   * attempts have no task row, so they get the project's alone. Reading the task's checks takes the
   * run's trust if someone other than the owner wrote one (`TaskStore.runDefinitions`). The Sandbox
   * size is the project's own, which a task's definitions never change, even when they clash.
   */
  async #config(params: RunParams, main: string): Promise<{ config: ConfigResult; size: SandboxSize }> {
    const [project, definitions] = await Promise.all([
      loadConfig(reposFor(this.env), params.project, main),
      this.env.PROJECT.getByName(params.project).runDefinitions(params.run),
    ]);
    const config = pipelineConfig(withTask(project, definitions), pipelineFor(params.line));
    return { config, size: sandboxSize(project) };
  }

  /**
   * A landing's `merge`, in its own untrusted container, which runs git alone and so reaches none of
   * `main`'s `network.allow`: `git merge-tree` of `main` and the approved head. A conflict comes back with
   * its files; a clean merge with the tree and the merged tree's config. The container is gone
   * before the step ends.
   */
  async #merge(instanceId: string, params: RunParams, landing: LandingParams, size: SandboxSize): Promise<Merged> {
    const attempt = attemptRef(landing.task, landing.attempt);
    const run = await runInSandbox(
      this.env,
      instanceId,
      { project: params.project, line: attempt },
      "merge",
      (g) => mergeScript(g.originRead.remote, g.forkRead.remote, landing.head),
      { size },
    );
    await this.env.SANDBOX.getByName(sandboxName(instanceId, "merge")).destroy();
    const result = resultOf<MergeResult>(run, "merge");
    const merged = parseMergeTree(result.output);
    if (!result.clean) {
      const files = conflictFiles(merged.files, result.remerges);
      return {
        kind: "conflict",
        details: { attempt, head: landing.head, main: result.main, base: result.base, files },
      };
    }
    const plan = { head: landing.head, main: result.main, tree: merged.tree };
    return { kind: "clean", plan, config: result.config, trees: result.trees ?? {} };
  }

  /**
   * A landing's `land`: claims the push, then commits the merge as the approver and pushes it with a
   * lease on the `main` it merged onto, in the trusted `land` container. A landing whose push was
   * claimed but whose result was lost reads `main` for its merge commit before it gives up. The
   * project then records the landed sha. Returns it.
   */
  async #land(
    step: WorkflowStep,
    instanceId: string,
    params: RunParams,
    landing: LandingParams,
    merge: MergePlan,
  ): Promise<string> {
    const project = () => this.env.PROJECT.getByName(params.project);
    const oneMinute = { retries: STEP_RETRIES, timeout: "1 minute" } as const;
    const signers = await step.do("signers", oneMinute, () => this.#signers(landing));
    const claimed = await step.do("claim", oneMinute, () => project().claimLand(params.run));
    if (!claimed) throw new Error("land: its merge request left the queue before it landed");
    let landed: LandResult;
    try {
      landed = await step.do("land", { retries: STEP_RETRIES, timeout: "10 minutes" }, async () => {
        const run = await runInSandbox(
          this.env,
          instanceId,
          { project: params.project, line: attemptRef(landing.task, landing.attempt) },
          "land",
          (g) =>
            landScript(g.originWrite.remote, g.forkRead.remote, {
              ...merge,
              message: mergeCommitMessage({
                task: landing.task,
                attempt: landing.attempt,
                title: landing.title,
                approver: signers.approver,
                coAuthors: signers.coAuthors,
              }),
              author: mergeAuthor(signers.approver),
              committedAt: Math.floor(landing.startedAt / 1000),
            }),
          { size: TRUSTED_SIZE },
        );
        await this.env.SANDBOX.getByName(sandboxName(instanceId, "land")).destroy();
        return resultOf<LandResult>(run, "land");
      });
    } catch (error) {
      const onMain = await step.do("landed on main", oneMinute, () => project().landedOnMain(params.run));
      if (onMain === null) throw new Error(`land: ${String(error)}`, { cause: error });
      landed = { kind: "landed", sha: onMain };
    }
    switch (landed.kind) {
      case "landed": {
        const { sha } = landed;
        await step.do("landed", { retries: STEP_RETRIES, timeout: "5 minutes" }, () =>
          project().pipelineLanded(params.run, sha),
        );
        return sha;
      }
      case "moved": {
        throw new Error(`land: main moved from ${merge.main}; the lease failed`);
      }
      case "mismatch": {
        throw new Error(`land: the merge gave tree ${landed.tree}, not the merged ${merge.tree}`);
      }
    }
  }

  /** The approver and each co-author, with their handles from D1. */
  async #signers(landing: LandingParams): Promise<{ approver: Signer; coAuthors: Signer[] }> {
    const handles = await userHandles(this.env.DB, [landing.approver.user, ...landing.coAuthors.map((c) => c.user)]);
    const signer = (id: string, alias: string | null): Signer => ({ id, handle: handles.get(id) ?? id, alias });
    return {
      approver: signer(landing.approver.user, actedAlias(landing.approver)),
      coAuthors: landing.coAuthors.map((c) => signer(c.user, actedAlias(c))),
    };
  }

  /**
   * A landing a `LandingWorkflow` started, resumed here: its containers are destroyed, so nothing it
   * started can still push, and the project lands its merge request again as a run, or records it
   * landed when `main` already holds its merge commit.
   */
  async #retireLanding(params: LegacyLandingParams, instanceId: string, step: WorkflowStep): Promise<void> {
    await step.do("retire", { retries: STEP_RETRIES, timeout: "5 minutes" }, async () => {
      await Promise.all(landingSandboxNames(instanceId).map((name) => this.env.SANDBOX.getByName(name).destroy()));
      await this.env.PROJECT.getByName(params.project).legacyLandingResumed(params.landing);
    });
  }

  /**
   * The caches the run uses, each with its key hash, computed from the head's tree before any
   * container starts, and where the project says it restores from and saves to. When that can't be
   * done, every cache is a miss the run never saves, with a note why: a cache never fails a run.
   */
  async #caches(
    step: WorkflowStep,
    instanceId: string,
    params: RunParams,
    caches: readonly CacheConfig[],
    merge: LandingMerge | null,
  ): Promise<RunCache[]> {
    if (caches.length === 0) return [];
    try {
      const lookups = await step.do("caches", { retries: STEP_RETRIES, timeout: "2 minutes" }, async () => {
        const { root, reader } = await this.#keyTree(params, merge);
        const image = await this.env.SANDBOX.getByName(pipelineSandboxName(instanceId, { kind: "setup" })).image();
        const keys = await cacheKeyHashes(reader, root, caches, image);
        return this.env.PROJECT.getByName(params.project).pipelineCaches(params.run, keys);
      });
      return runCachesFrom(caches, lookups);
    } catch (error) {
      return unkeyedCaches(caches, error);
    }
  }

  /**
   * The tree the run's caches are keyed by, and how to read its trees: the line's head's, from the
   * line's repo; or for a landing the merged tree it runs on, whose trees are the ones its merge
   * made, then `main`'s, from the origin, then the approved head's, from the attempt's fork.
   */
  async #keyTree(params: RunParams, merge: LandingMerge | null): Promise<{ root: string; reader: TreeReader }> {
    const repos = reposFor(this.env);
    if (merge === null) {
      const repo = lineRepo(params.project, params.line);
      const head = await repos.readCommit(repo, params.sha ?? "");
      if (head === null) throw new Error(`the head ${params.sha} is missing`);
      return { root: head.treeHash, reader: { readTree: (hash) => repos.readTree(repo, hash) } };
    }
    const sides = [originRepo(params.project), forkRepo(params.project, merge.attempt)];
    const readTree = async (hash: string) => {
      const made = merge.trees[hash];
      if (made !== undefined) return made;
      for (const repo of sides) {
        const entries = await repos.readTree(repo, hash);
        if (entries !== null) return entries;
      }
      return null;
    };
    return { root: merge.plan.tree, reader: { readTree } };
  }

  /**
   * Runs the setups in the setup container and, when they all passed, snapshots it. Its logs are
   * stored before the container goes: the checks start from the snapshot, never from it. The caches
   * the setups use are restored before the first runs, and saved once each setup using one passed;
   * a note on each goes on the first setup that uses it. A retry starts the container afresh.
   */
  async #setup(context: RunContext, base: string | null): Promise<SetupStage> {
    const { instanceId, params, plan, size, network, caches } = context;
    const name = pipelineSandboxName(instanceId, { kind: "setup" });
    const sandbox = this.env.SANDBOX.getByName(name);
    await sandbox.destroy();
    // In a trusted run the container holds every secret the setups name, as the settings are now.
    const held = await this.#hold(params, setupSecrets(plan));
    if (held.kind === "refused") return secretlessSetup(plan, held);
    const used = setupCaches(plan);
    let restoreNotes: CacheNote[] = [];
    try {
      const run = await this.#runIn(context, (checkout) => setupScript(checkout, base, plan.setup), {
        network,
        size,
        sandbox: name,
        env: { ...runContext(context), ...held.env },
        timeoutMs: setupTimeoutMs(plan) + STEP_SLACK_MS,
        prepare: async (start) => {
          restoreNotes = await caches.restore(name, used, start);
        },
      });
      const result = resultOf<SetupResult>(run, "setup");
      const passed = result.setups.every((s) => s.exit === 0);
      // A cache is saved once every setup using it passed, from this container, which is its saver.
      const saveable = used.filter((cache) =>
        plan.setup.every((setup, i) => !setup.caches.includes(cache) || result.setups[i]?.exit === 0),
      );
      const saveNotes = await caches.save(name, saveable);
      const setups = withCacheNotes(plan.setup, result.setups, [...restoreNotes, ...saveNotes], held.mask);
      let snapshot: SandboxSnapshot | null = null;
      // With no setups there's nothing to keep: each later container just checks the head out.
      if (passed && plan.setup.length > 0 && (plan.checks.length > 0 || plan.steps.length > 0)) {
        try {
          snapshot = await sandbox.snapshot();
        } catch (error) {
          // The checks re-run the setups instead.
          console.warn({ event: "sandbox.snapshot_failed", sandbox: name, error: held.mask(String(error)) });
        }
      }
      const notes = new Map(setups.map((setup, i) => [setupLogName(i + 1), setup.notes ?? []]));
      const logs = await this.#storeAndStop(context, name, notes, held.mask);
      return { ...result, setups, snapshot, logs };
    } catch (error) {
      throw maskedError(error, held.mask);
    }
  }

  /**
   * Runs every check in its own container, in parallel, each once the checks it waits for passed; a
   * check whose wait didn't pass never starts. A check that ends in an infrastructure error after its
   * retries ends the run `errored`, once every other check has settled.
   */
  async #checks(step: WorkflowStep, context: RunContext, setup: SetupStage): Promise<Map<string, CheckStage>> {
    const done = new Map<string, Promise<CheckStage | null>>();
    const byName = new Map(context.plan.checks.map((check) => [check.name, check]));
    const run = (check: PlannedCheck): Promise<CheckStage | null> => {
      const known = done.get(check.name);
      if (known !== undefined) return known;
      const started = (async () => {
        const waited = await Promise.all(check.after.flatMap((name) => byName.get(name) ?? []).map(run));
        if (waited.some((stage) => stage?.exit !== 0)) return null;
        return step.do(
          `check ${check.name}`,
          {
            retries: STEP_RETRIES,
            timeout:
              checkTimeoutMs(context.plan, check) +
              STEP_SLACK_MS +
              cacheTransfersMs([...setupCaches(context.plan), ...check.caches], 2),
          },
          () => this.#check(context, setup.snapshot, check),
        );
      })();
      done.set(check.name, started);
      return started;
    };
    const settled = await Promise.allSettled(checkOrder(context.plan.checks).map(run));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    const stages = new Map<string, CheckStage>();
    for (const [name, stage] of done) {
      const ran = await stage;
      if (ran !== null) stages.set(name, ran);
    }
    return stages;
  }

  /**
   * Runs one check in its own container, started from the setup snapshot or, failing that, from the
   * image with the setups re-run first. Its log is stored, and the container stopped, before the step
   * ends; a retry starts the container afresh. In a trusted run the container holds the secrets the
   * check names, and the setups' too when it re-runs them, loaded as the container comes up; one
   * that's gone or no longer allowed fails the check, naming it. What the check held, and the setups'
   * secrets, which the snapshot may hold, are masked in its log, its metrics and any error.
   */
  async #check(context: RunContext, snapshot: SandboxSnapshot | null, check: PlannedCheck): Promise<CheckStage> {
    const { instanceId, params, plan, size, network, caches } = context;
    const name = pipelineSandboxName(instanceId, { kind: "check", name: check.name });
    await this.env.SANDBOX.getByName(name).destroy();
    let held = nothingHeld;
    let cacheNotes: CacheNote[] = [];
    try {
      const run = await this.#runIn(context, (checkout) => checkScript(checkout, plan.setup, check), {
        network,
        size,
        sandbox: name,
        prepare: async (start, fromSnapshot) => {
          cacheNotes = await caches.prepare(name, check.caches, start, fromSnapshot);
        },
        env: async (fromSnapshot) => {
          const own = fromSnapshot ? check.secrets : [...setupSecrets(plan), ...check.secrets];
          const holding = await this.#hold(params, own, setupSecrets(plan));
          if (holding.kind === "refused") throw new SecretUnavailable(holding.error);
          held = holding;
          return { ...runContext(context), ...holding.env };
        },
        snapshot,
        timeoutMs: checkTimeoutMs(plan, check),
      });
      const { setupsRerun, ...ran } = resultOf<CheckRun>(run, `check ${check.name}`);
      const saved = ran.exit === 0 ? await caches.save(name, check.caches) : [];
      const notes = [
        ...(setupsRerun && plan.setup.length > 0 ? [setupsRerunNote("check", snapshot)] : []),
        ...[...cacheNotes, ...saved].map((note) => held.mask(note.text)),
      ];
      const logs = await this.#storeAndStop(context, name, new Map([[check.name, notes]]), held.mask);
      return { ...ran, metrics: maskedDeep(ran.metrics, held.mask), logged: logs.includes(check.name), notes };
    } catch (error) {
      if (!(error instanceof SecretUnavailable)) throw maskedError(error, held.mask);
      // Restored from the snapshot, the container may already be up.
      await this.env.SANDBOX.getByName(name).destroy();
      return { exit: null, durationMs: 0, metrics: {}, logged: false, notes: [], error: error.message };
    }
  }

  /**
   * Runs the post-gate steps in order once the gate passed, each in its own container, stopping at the
   * first that doesn't pass, and adds them to `scored`, the rest skipped. Each step's container is
   * readied (restored from the setups' snapshot, or the setups re-run) in a Workflow step retried like
   * any other; its command then runs once, in the next, with no retry. A readied container lost
   * before the command started is readied again in new steps, up to `STEP_RETRIES` times.
   */
  async #postGate(
    step: WorkflowStep,
    context: RunContext,
    snapshot: SandboxSnapshot | null,
    scored: RunOutcome,
  ): Promise<RunOutcome> {
    const { plan } = context;
    const ran = new Map<string, PostGateRun>();
    if (scored.gate === "passed") {
      for (const postGate of plan.steps) {
        const run = await this.#postGateStep(step, context, snapshot, postGate);
        ran.set(postGate.name, run);
        if (run.exit !== 0 || run.error !== undefined) break;
      }
    }
    return withPostGateSteps(scored, plan.steps, ran);
  }

  /**
   * One post-gate step: its container readied, then its command run once. When the container was
   * lost before the command started, both happen again under new step names (Workflows remembers a
   * step by its name), at most `STEP_RETRIES` more times; then the run ends `errored`.
   */
  async #postGateStep(
    step: WorkflowStep,
    context: RunContext,
    snapshot: SandboxSnapshot | null,
    postGate: StepConfig,
  ): Promise<PostGateRun> {
    const { plan } = context;
    for (let attempt = 1; attempt <= STEP_RETRIES.limit + 1; attempt += 1) {
      const suffix = attempt === 1 ? "" : ` (${attempt})`;
      const ready = readiedOf(
        await step.do(
          `step ${postGate.name} ready${suffix}`,
          {
            retries: STEP_RETRIES,
            timeout: setupsStepTimeoutMs(plan, [...setupCaches(plan), ...postGate.caches], 1),
          },
          () => this.#stepReady(context, snapshot, postGate),
        ),
      );
      if (ready.kind === "refused") return { exit: null, durationMs: 0, logged: false, notes: [], error: ready.error };
      const notes = [
        ...(ready.setupsRerun && plan.setup.length > 0 ? [setupsRerunNote("step", snapshot)] : []),
        ...ready.cacheNotes,
      ];
      const command = commandOf(
        await step.do(
          `step ${postGate.name}${suffix}`,
          {
            retries: { limit: 0, delay: "1 second" },
            timeout: POST_GATE_STEP_TIMEOUT_MS + 2 * STEP_SLACK_MS + cacheTransfersMs(postGate.caches, 1),
          },
          () => this.#stepRun(context, postGate, notes),
        ),
      );
      if (command.kind === "ran") return command.run;
    }
    throw new Error(`step ${postGate.name}: its container was lost before its command started, every try`);
  }

  /**
   * Runs `script` in one of the run's containers, checking out what the run runs on: the line's
   * head, read with the line's one read grant; or, for a landing before it lands, the merge it makes
   * again, read from the origin and the attempt's fork in the untrusted `merge` role.
   */
  async #runIn(
    context: RunContext,
    script: (checkout: Checkout) => string,
    options: ScriptOptions<"pipeline">,
  ): Promise<RunResult> {
    const { instanceId, params, merge } = context;
    if (merge === null) {
      const sha = params.sha ?? "";
      return runInSandbox(
        this.env,
        instanceId,
        { project: params.project, line: params.line },
        "pipeline",
        (g) => script({ kind: "line", remote: g.lineRead.remote, sha }),
        options,
      );
    }
    return runInSandbox(
      this.env,
      instanceId,
      { project: params.project, line: merge.attempt },
      "merge",
      (g) => script({ kind: "merge", origin: g.originRead.remote, fork: g.forkRead.remote, merge: merge.plan }),
      options,
    );
  }

  /**
   * Readies a post-gate step's container: restored from the snapshot, or with the setups re-run, and
   * with the caches it uses restored; a retry starts it afresh. Says how restoring them went.
   * Re-running the setups, it holds the setups' secrets for them, as a check's container does, and
   * fails the step, naming one gone or no longer allowed; the step's own secrets wait for its
   * command. The setups' secrets are masked in what it reports either way.
   */
  async #stepReady(context: RunContext, snapshot: SandboxSnapshot | null, postGate: StepConfig): Promise<StepReadied> {
    const { instanceId, params, plan, size, network, caches } = context;
    const name = pipelineSandboxName(instanceId, { kind: "step", name: postGate.name });
    await this.env.SANDBOX.getByName(name).destroy();
    let held = nothingHeld;
    let cacheNotes: CacheNote[] = [];
    try {
      const run = await runInSandbox(
        this.env,
        instanceId,
        { project: params.project, line: params.line },
        "pipeline",
        (g) => stepReadyScript(g.lineRead.remote, params.sha ?? "", plan.setup, postGate),
        {
          network,
          size,
          sandbox: name,
          env: async (fromSnapshot) => {
            const holding = await this.#hold(params, fromSnapshot ? [] : setupSecrets(plan), setupSecrets(plan));
            if (holding.kind === "refused") throw new SecretUnavailable(holding.error);
            held = holding;
            return { ...runContext(context), ...holding.env };
          },
          snapshot,
          timeoutMs: setupTimeoutMs(plan) + STEP_SLACK_MS,
          prepare: async (start, fromSnapshot) => {
            cacheNotes = await caches.prepare(name, postGate.caches, start, fromSnapshot);
          },
        },
      );
      const result = resultOf<StepReady>(run, `step ${postGate.name} ready`);
      return { kind: "ready", ...result, cacheNotes: cacheNotes.map((note) => held.mask(note.text)) };
    } catch (error) {
      if (!(error instanceof SecretUnavailable)) throw maskedError(error, held.mask);
      await this.env.SANDBOX.getByName(name).destroy();
      return { kind: "refused", error: error.message };
    }
  }

  /**
   * Runs a post-gate step's command once in the container its ready step left, then stores its log and
   * stops the container. A container that was lost meanwhile is never started again: the command
   * doesn't run, and the step says so, for the container to be readied again. In a trusted run the
   * command holds the secrets the step names, its pipeline's among them, loaded here as it starts, so
   * they reach this command alone; one that's gone or no longer allowed fails the step, naming it,
   * before the command starts. What it held, and the setups' secrets, which its container may hold
   * from the snapshot or its own re-run of the setups, are masked in its log and any error.
   */
  async #stepRun(context: RunContext, postGate: StepConfig, notes: string[]): Promise<StepCommand> {
    const { instanceId, params, plan, caches } = context;
    const name = pipelineSandboxName(instanceId, { kind: "step", name: postGate.name });
    const sandbox = this.env.SANDBOX.getByName(name);
    const held = await this.#hold(params, postGate.secrets, setupSecrets(plan));
    if (held.kind === "refused") {
      await sandbox.destroy();
      return { kind: "ran", run: { exit: null, durationMs: 0, logged: false, notes, error: held.error } };
    }
    try {
      // Only a running container keeps the access it was readied with; one that's gone isn't started.
      const run = await sandbox.runIfRunning(stepScript(postGate, POST_GATE_STEP_TIMEOUT_MS), {
        timeoutMs: POST_GATE_STEP_TIMEOUT_MS + STEP_SLACK_MS,
        env: { ...runContext(context), ...held.env },
      });
      if (run === null) return { kind: "lost" };
      const result = resultOf<StepRun>(run, `step ${postGate.name}`);
      // Saving a cache is only ever a note, so it never fails this step, which isn't retried.
      const saved = result.exit === 0 ? await caches.save(name, postGate.caches) : [];
      const noted = [...notes, ...saved.map((note) => held.mask(note.text))];
      const log = stepLogName(postGate.name);
      const logs = await this.#storeAndStop(context, name, new Map([[log, noted]]), held.mask);
      return { kind: "ran", run: { ...result, logged: logs.includes(log), notes: noted } };
    } catch (error) {
      throw maskedError(error, held.mask);
    }
  }

  /**
   * Copies the logs `notes` names (each with its notes) from the container `sandbox` to R2 under the
   * run's line and id, masked with `mask`, then stops the container. Returns the logs stored.
   */
  async #storeAndStop(
    context: RunContext,
    sandbox: string,
    notes: ReadonlyMap<string, string[]>,
    mask: (text: string) => string,
  ): Promise<string[]> {
    const { params, size } = context;
    const run = { project: params.project, line: params.line, run: params.run };
    const logs = await storeLogs(this.env, {
      sandbox,
      names: [...notes.keys()],
      key: (log) => logKey(run, log),
      size,
      notes,
      mask,
    });
    await this.env.SANDBOX.getByName(sandbox).destroy();
    return logs;
  }

  /**
   * The values of the secrets a container of the run holds, `own`, opened here, in the step that
   * starts it, from what the project's settings hold now, as its env; or why one can't be had. The
   * secrets `maskOnly` are opened too, where they can be, only to mask them: such as the setups',
   * which a snapshot may hold. Never persisted: only the container's env and the step's masking
   * hold them.
   */
  async #hold(params: RunParams, own: readonly string[], maskOnly: readonly string[] = []): Promise<Holding> {
    const project = this.env.PROJECT.getByName(params.project);
    let names = [...new Set([...own, ...maskOnly])];
    for (;;) {
      if (names.length === 0) return { kind: "held", ...nothingHeld };
      const loaded = await project.pipelineSecrets(params.run, names);
      if (!("error" in loaded)) {
        this.#keyring ??= keyringFrom(this.env.SECRETS_KEYRING);
        const keyring = this.#keyring;
        const values = await Promise.all(
          loaded.sealed.map(
            async (sealed) => [sealed.name, await openSealed(keyring, params.project, sealed)] as const,
          ),
        );
        const env = Object.fromEntries(values.filter(([name]) => own.includes(name)));
        return { kind: "held", env, mask: masking(values.map(([, value]) => value)) };
      }
      // A secret held only to mask it that's gone can't be masked, and doesn't fail the step.
      if (own.includes(loaded.secret)) return { kind: "refused", secret: loaded.secret, error: loaded.error };
      const refused = loaded.secret;
      names = names.filter((name) => name !== refused);
    }
  }
}

/** `error` with the secrets a step held masked in its message, as the Workflow keeps it. */
function maskedError(error: unknown, mask: (text: string) => string): Error {
  return new Error(mask(error instanceof Error ? error.message : String(error)));
}

/**
 * The setup stage of a run whose setups never started, because a secret they were to hold is gone or
 * no longer allowed: the first setup naming it errored, saying so, and none ran.
 */
function secretlessSetup(plan: Pick<ScorePlan, "setup">, refused: SecretRefusal): SetupStage {
  const blamed = plan.setup.findIndex((setup) => setup.secrets.includes(refused.secret));
  return {
    base: null,
    shortstat: "",
    builtinMs: 0,
    setups: plan.setup.map((_, i) => ({
      exit: null,
      durationMs: 0,
      ...(i === blamed ? { error: refused.error } : {}),
    })),
    snapshot: null,
    logs: [],
  };
}

/** The result a script printed, or an error saying `what` gave none, with its exit and the end of its stderr. */
function resultOf<T>(run: RunResult, what: string): T {
  const result = parseResult<T>(run.stdout);
  if (result === null) throw new Error(`${what} gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
  return result;
}

/** Every secret the setups name, each once: what the setup container holds. */
function setupSecrets(plan: Pick<ScorePlan, "setup">): string[] {
  return [...new Set(plan.setup.flatMap((setup) => setup.secrets))];
}

/** What a run started under the Scoring Workflow's code was given: its line was its `attempt`. */
export interface ScoringParams extends Omit<PipelineParams, "line"> {
  attempt: string;
}

/** A run's params in the current shape: a landing's has no head until it lands. */
type RunParams = PipelineParams | LandingRunParams;

/**
 * What the Workflow may be started with: a run's params, as a Pipeline Workflow or a Scoring
 * Workflow started it, or a Landing Workflow's, from before landings were runs.
 */
type WorkflowParams = PipelineParams | LandingRunParams | ScoringParams | LegacyLandingParams;

/** Whether the Workflow was started as a Landing Workflow, before landings were runs. */
function isLegacyLanding(params: Readonly<WorkflowParams>): params is Readonly<LegacyLandingParams> {
  return "landing" in params && typeof params.landing === "number";
}

/** How a landing's `merge` went: the conflict, or the merge and the merged tree's config. */
type Merged =
  | { kind: "conflict"; details: ConflictDetails }
  | { kind: "clean"; plan: MergePlan; config: string | null; trees: Record<string, TreeEntry[]> };

/**
 * What a landing runs on before it lands: the source attempt, the merge its containers make again
 * and the sha of the commit they make of it, and the trees that merge made, which no repo has.
 */
interface LandingMerge {
  attempt: string;
  plan: MergeCheckout;
  sha: string;
  trees: Record<string, TreeEntry[]>;
}

/** What the run plans to run: its setups and checks, and the post-gate steps after its gate. */
interface RunPlan extends ScorePlan {
  steps: StepConfig[];
}

/** The post-gate steps the run's pipeline has: only `main`'s, and none without a valid config. */
function postGateSteps(config: ConfigResult, params: Pick<RunParams, "line">): StepConfig[] {
  return config.kind === "valid" ? config.config.pipelines[pipelineFor(params.line)].steps : [];
}

/** What every step of a run's containers needs. */
interface RunContext {
  instanceId: string;
  params: RunParams;
  /** For a landing before it lands: what it runs on. */
  merge: LandingMerge | null;
  plan: RunPlan;
  size: SandboxSize;
  network: NetworkAccess;
  /** The caches the run uses, restored into and saved from its containers. */
  caches: RunCaches;
}

/** The caches anything in the plan uses, as the config defines them; none without a valid config. */
function runCaches(config: ConfigResult, plan: RunPlan): CacheConfig[] {
  if (config.kind !== "valid") return [];
  const used = new Set([...plan.setup, ...plan.checks, ...plan.steps].flatMap((user) => user.caches));
  return config.config.caches.filter((cache) => used.has(cache.name));
}

/** A run's params in the current shape, whichever code started it. */
function paramsLine(params: PipelineParams | LandingRunParams | ScoringParams): RunParams {
  if ("line" in params) return params;
  const { attempt, ...rest } = params;
  return { ...rest, line: attempt };
}

/** Room a step gets for moving `caches`, each up to `transfers` times (a restore, a save) at its timeout. */
function cacheTransfersMs(caches: readonly string[], transfers: number): number {
  return new Set(caches).size * transfers * CACHE_TRANSFER_TIMEOUT_MS;
}

/**
 * How long a step that runs the setups (the setup step, or a post-gate step's ready step) may take:
 * the setups at their timeouts, slack for starting and stopping the container, and room for moving
 * `caches`, each up to `transfers` times.
 */
function setupsStepTimeoutMs(plan: ScorePlan, caches: readonly string[], transfers: number): number {
  return setupTimeoutMs(plan) + 2 * STEP_SLACK_MS + cacheTransfersMs(caches, transfers);
}

/** How long a check's container may take: the check at its timeout, and the setups again if it re-runs them. */
function checkTimeoutMs(plan: ScorePlan, check: PlannedCheck): number {
  return setupTimeoutMs(plan) + check.timeoutMs + STEP_SLACK_MS;
}

/**
 * What every container of the run is told about it. Until a landing lands it has no head, so its
 * `THRONG_SHA` is the merge commit its containers make, which is never pushed.
 */
function runContext({ params, merge }: Pick<RunContext, "params" | "merge">): Record<string, string> {
  return {
    THRONG_PROJECT: params.project,
    THRONG_PIPELINE: pipelineFor(params.line),
    THRONG_LINE: params.line,
    THRONG_SHA: merge?.sha ?? params.sha ?? "",
    THRONG_RUN: String(params.run),
  };
}

/** Every container the run may start: the setup container, one per check and one per post-gate step. */
export function plannedContainers(
  instanceId: string,
  plan: Pick<ScorePlan, "checks"> & { steps?: readonly StepConfig[] },
): string[] {
  return [
    pipelineSandboxName(instanceId, { kind: "setup" }),
    ...plan.checks.map((check) => pipelineSandboxName(instanceId, { kind: "check", name: check.name })),
    ...(plan.steps ?? []).map((step) => pipelineSandboxName(instanceId, { kind: "step", name: step.name })),
  ];
}

/** The part of the `SANDBOX` binding teardown uses. */
export interface SandboxNamespace {
  getByName: (name: string) => { destroy: () => Promise<void>; releaseSnapshot: () => void | Promise<void> };
}

/**
 * Stops a pipeline run's containers: every one in `containers` (its plan's), the setup container
 * and those a `ScoringWorkflow` started (it scored and deployed Previews in), which a run planned
 * before it was cancelled, or that resumed here, may still hold. The setup container's snapshot is
 * released.
 */
export async function teardownPipeline(
  sandboxes: SandboxNamespace,
  instanceId: string,
  containers: readonly string[],
): Promise<void> {
  const setup = pipelineSandboxName(instanceId, { kind: "setup" });
  const names = new Set([setup, ...containers, ...legacyScoringSandboxNames(instanceId)]);
  await Promise.all([...names].map((name) => sandboxes.getByName(name).destroy()));
  await sandboxes.getByName(setup).releaseSnapshot();
}

/** The run's outcome: how each setup went, then each check, skipped where it never ran. */
function outcomeOf(
  config: ConfigResult,
  plan: ScorePlan,
  setup: SetupStage,
  checks: ReadonlyMap<string, CheckStage>,
): ReturnType<typeof pipelineOutcome> {
  // A setup that errored let none run; otherwise the first that didn't pass failed.
  const errored = setup.setups.findIndex((s) => s.error !== undefined);
  const failed = errored === -1 ? setup.setups.findIndex((s) => s.exit !== 0) : errored;
  const raw: RawScore = {
    base: setup.base,
    shortstat: setup.shortstat,
    builtinMs: setup.builtinMs,
    setupFailed: failed === -1 ? null : failed + 1,
    checks: plan.checks.map((check) => {
      const ran = checks.get(check.name);
      if (ran === undefined) return { exit: null, durationMs: 0, metrics: {} };
      const { exit, durationMs, metrics, error } = ran;
      return { exit, durationMs, metrics, ...(error === undefined ? {} : { error }) };
    }),
  };
  const logs = [...setup.logs, ...[...checks].flatMap(([name, stage]) => (stage.logged ? [name] : []))];
  const notes = new Map([...checks].map(([name, stage]) => [name, stage.notes]));
  return pipelineOutcome(config, raw, setup.setups, logs, notes);
}
