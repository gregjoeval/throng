import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { lineBase } from "./base";
import { CACHE_TRANSFER_TIMEOUT_MS, cacheKeyHashes, cacheObjectKey, restoreNote, saveNote } from "./caches";
import type { CacheSave, RunCache } from "./caches";
import { loadConfig, namedSecrets, networkAllow, pipelineConfig, sandboxSize } from "./config";
import type { CacheConfig, ConfigResult, SandboxSize, SetupConfig, StepConfig } from "./config";
import { legacyScoreSandboxName, pipelineSandboxName } from "./grants";
import { logKey, setupLogName, stepLogName } from "./logs";
import { NO_NETWORK } from "./network";
import type { NetworkAccess } from "./network";
import { loadRegistries } from "./npmrc";
import { lineRepo, originMainRef } from "./repos";
import { checkOrder, POST_GATE_STEP_TIMEOUT_MS, scorePlan, setupTimeoutMs, STEP_SLACK_MS } from "./results";
import type { PlannedCheck, RawScore, ScorePlan } from "./results";
import { pipelineOutcome, withPostGateSteps } from "./run-outcome";
import type { PostGateRun, RunOutcome, SetupRun } from "./run-outcome";
import type { SandboxSnapshot, StartOptions } from "./sandbox";
import { pipelineFor } from "./scoring";
import type { PipelineParams, PlanVerdict, RunReport } from "./scoring";
import { checkScript, parseResult, setupScript, stepReadyScript, stepScript } from "./scripts";
import type { CheckRun, SetupResult, StepReady, StepRun } from "./scripts";
import { keyringFrom, maskedDeep, masking, openSealed } from "./secrets";
import type { Keyring, SecretRefusal } from "./secrets";
import { NO_TASK_DEFINITIONS, withTask } from "./task-definitions";
import { parseAttemptRef } from "./task-refs";
import { runInSandbox, STEP_RETRIES, storeLogs } from "./workflows";

/** The note on a check whose container ran the setups itself, because it couldn't start from their snapshot. */
const SETUPS_RERUN = "setups re-run in this check's container: it couldn't start from the setups' snapshot";

/** The note on a check whose container ran the setups itself, because the run took no snapshot. */
const NO_SNAPSHOT = "setups re-run in this check's container: the run took no snapshot of them";

/** The note on a post-gate step whose container ran the setups itself, as `SETUPS_RERUN` and `NO_SNAPSHOT` say for a check. */
const STEP_SETUPS_RERUN = (snapshot: SandboxSnapshot | null) =>
  snapshot === null
    ? "setups re-run in this step's container: the run took no snapshot of them"
    : "setups re-run in this step's container: it couldn't start from the setups' snapshot";

/** The secrets a container holds, as its env, and how to mask them in what it reports. */
interface Held {
  env: Record<string, string>;
  mask: (text: string) => string;
}

const NOTHING_HELD: Held = { env: {}, mask: (text) => text };

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
 * run `errored`.
 *
 * Every container (`<instance>/setup`, `<instance>/check:<name>`, `<instance>/step:<name>`) holds one
 * read grant on its line's repo (the fork for an attempt, the origin for a task branch or `main`, both
 * fetched with `refs/tasks/*`) and no write grant, reaches only `main`'s `network.allow` and `.npmrc`
 * registries, and gets the run's `THRONG_*` variables. Each copies its logs to R2 within its step, while it still runs, then
 * stops. When the run ends, or a newer head cancels it, every planned container is destroyed and
 * the snapshot released.
 *
 * Setups and checks name secrets. The plan names them to the project, which refuses the run when one
 * has no value or isn't allowed in its pipeline, and hands an untrusted run that names any to the
 * owner (it waits, and this Workflow ends having started nothing). In a trusted run, the step that
 * starts a container loads the secrets it holds, as the settings are then, and opens them there:
 * the setup container holds every setup's, a check's container its own (and the setups' when it
 * re-runs them). Params, plans and step results carry names only, and what a container held is
 * masked in its logs, metric values and errors. Whatever a setup writes to disk, a secret included,
 * is in the snapshot the checks start from, which Cloudflare keeps until 30 days after its last
 * restore.
 *
 * It takes over the `ScoringWorkflow`'s Workflow name, so a run that started under that class resumes
 * here: its params name the line `attempt`, and its old step names (`score`) are never called again.
 */
export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams | ScoringParams> {
  /** Opens the secrets a step loads: `SECRETS_KEYRING`, read on first use. */
  #keyring: Keyring | null = null;

  override async run(
    event: Readonly<WorkflowEvent<PipelineParams | ScoringParams>>,
    step: WorkflowStep,
  ): Promise<RunReport | null> {
    const params = paramsLine(event.payload);
    const instanceId = event.instanceId;

    let report: RunReport;
    let plan: RunPlan | null = null;
    try {
      // Pinned once, so the config and the `.npmrc` are read from the same commit even if `main` moves.
      const main = await step.do("main", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        originMainRef(reposFor(this.env), params.project),
      );
      // Named apart from the steps it replaced, whose recorded outputs had other shapes.
      const { config, size } = await step.do("pipeline config", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        this.#config(params, main),
      );
      const registries = await step.do("registries", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        loadRegistries(reposFor(this.env), params.project, main),
      );
      const base = await step.do("base", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        lineBase(reposFor(this.env), params.project, { line: params.line, head: params.sha }),
      );
      const planned = { ...scorePlan(config), steps: postGateSteps(config, params) };
      plan = planned;
      // Before any container starts, so a cancel can name every one the run may start, and so the
      // secrets the run names are checked against the settings, by name, before anything runs.
      const verdict = await step.do(
        "plan",
        { retries: STEP_RETRIES, timeout: "1 minute" },
        async (): Promise<PlanVerdict> => {
          const answer = await this.env.PROJECT.getByName(params.project).pipelinePlanned(
            params.run,
            plannedContainers(instanceId, planned),
            namedSecrets(planned),
          );
          return answer.kind === "refused" ? { kind: "refused", error: answer.error } : { kind: answer.kind };
        },
      );
      // An untrusted run that names a secret is the owner's to start; it started nothing.
      if (verdict.kind === "waiting") return null;
      if (verdict.kind === "refused") throw new Error(verdict.error);
      const caches = await this.#caches(step, instanceId, params, runCaches(config, planned));
      // A task's definitions never change `network.allow`, so the run's config gives `main`'s.
      const context: RunContext = {
        instanceId,
        params,
        plan: planned,
        size,
        network: { registries, allow: networkAllow(config) },
        caches,
      };
      const setup = await step.do(
        "setup",
        {
          retries: STEP_RETRIES,
          timeout: setupTimeoutMs(planned) + 2 * STEP_SLACK_MS + cacheTransfersMs(setupCaches(planned), 2),
        },
        () => this.#setup(context, base?.sha ?? null),
      );
      const checks = setup.setups.every((s) => s.exit === 0)
        ? await this.#checks(step, context, setup)
        : new Map<string, CheckStage>();
      const scored = outcomeOf(config, planned, setup, checks);
      report = { status: "done", outcome: await this.#postGate(step, context, setup.snapshot, scored) };
    } catch (error) {
      report = { status: "errored", error: String(error).slice(0, 4000) };
    }

    const containers = plan === null ? [] : plannedContainers(instanceId, plan);
    await step.do("teardown", { retries: STEP_RETRIES }, () =>
      teardownPipeline(this.env.SANDBOX, instanceId, containers),
    );
    await step.do("report", { retries: STEP_RETRIES }, async () => {
      await this.env.PROJECT.getByName(params.project).pipelineFinished(params.run, report);
    });
    return report;
  }

  /**
   * The run's config, its layers merged once: the project's config at `main` (the run's pinned commit
   * of it), then what the task defines over it. A clash between them makes it invalid. The e2e routes'
   * attempts have no task row, so they get the project's alone. The Sandbox size is the project's own,
   * which a task's definitions never change, even when they clash.
   */
  async #config(params: PipelineParams, main: string): Promise<{ config: ConfigResult; size: SandboxSize }> {
    const task = parseAttemptRef(params.line)?.task;
    const [project, definitions] = await Promise.all([
      loadConfig(reposFor(this.env), params.project, main),
      task === undefined ? NO_TASK_DEFINITIONS : this.env.PROJECT.getByName(params.project).definitionsOf(task),
    ]);
    const config = pipelineConfig(withTask(project, definitions), pipelineFor(params.line));
    return { config, size: sandboxSize(project) };
  }

  /**
   * The caches the run uses, each with its key hash, computed from the head's tree before any
   * container starts, and where the project says it restores from and saves to. When that can't be
   * done, every cache is a miss the run never saves, with a note why: a cache never fails a run.
   */
  async #caches(
    step: WorkflowStep,
    instanceId: string,
    params: PipelineParams,
    caches: readonly CacheConfig[],
  ): Promise<RunCache[]> {
    if (caches.length === 0) return [];
    try {
      const lookups = await step.do("caches", { retries: STEP_RETRIES, timeout: "2 minutes" }, async () => {
        const repos = reposFor(this.env);
        const repo = lineRepo(params.project, params.line);
        const head = await repos.readCommit(repo, params.sha);
        if (head === null) throw new Error(`the head ${params.sha} is missing`);
        const image = await this.env.SANDBOX.getByName(pipelineSandboxName(instanceId, { kind: "setup" })).image();
        const reader = { readTree: (hash: string) => repos.readTree(repo, hash) };
        const keys = await cacheKeyHashes(reader, head.treeHash, caches, image);
        return this.env.PROJECT.getByName(params.project).pipelineCaches(params.run, keys);
      });
      return caches.map((cache): RunCache => {
        const lookup = lookups.find((found) => found.name === cache.name);
        if (lookup === undefined) return { ...cache, error: "the project didn't look it up" };
        const { name: _name, ...found } = lookup;
        return { ...cache, ...found };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return caches.map((cache) => ({ ...cache, error: message.slice(0, 300) }));
    }
  }

  /**
   * Restores the caches named `names` into the container `sandbox`, starting it from the image with
   * `start` if it isn't running, and returns a note on each: a hit with its time, or a miss and why.
   */
  async #restoreCaches(
    context: RunContext,
    sandbox: string,
    names: readonly string[],
    start: StartOptions & { timeoutMs?: number },
  ): Promise<string[]> {
    const notes: string[] = [];
    for (const cache of cachesNamed(context, names)) {
      if ("error" in cache || cache.restore === null) {
        notes.push(restoreNote(cache, null));
        continue;
      }
      const key = cacheObjectKey(context.params.project, { ...cache, scope: cache.restore });
      notes.push(restoreNote(cache, await this.env.SANDBOX.getByName(sandbox).restoreCache(key, cache.path, start)));
    }
    return notes;
  }

  /**
   * Restores the caches a check's or post-gate step's container uses, `names`, once it came up. One
   * from the setups' snapshot already holds the setups' caches, so only its own others are restored;
   * one that will re-run the setups gets the setups' caches too.
   */
  async #prepareCaches(
    context: RunContext,
    sandbox: string,
    names: readonly string[],
    start: StartOptions & { timeoutMs?: number },
    fromSnapshot: boolean,
  ): Promise<string[]> {
    const setups = setupCaches(context.plan);
    if (!fromSnapshot) return this.#restoreCaches(context, sandbox, [...new Set([...setups, ...names])], start);
    const inSnapshot = names
      .filter((name) => setups.includes(name))
      .map((name) => `cache ${name}: in the setups' snapshot`);
    const restored = await this.#restoreCaches(
      context,
      sandbox,
      names.filter((name) => !setups.includes(name)),
      start,
    );
    return [...inSnapshot, ...restored];
  }

  /**
   * Saves the caches named `names` from the running container `sandbox` where the run may save them,
   * once the command using them passed, and records each saved entry with the project. An entry is
   * never written over: a key the project already has an entry for isn't saved again. Returns a note
   * on each that says something; a save problem is only ever a note.
   */
  async #saveCaches(context: RunContext, sandbox: string, names: readonly string[]): Promise<string[]> {
    const notes: string[] = [];
    const project = this.env.PROJECT.getByName(context.params.project);
    for (const cache of cachesNamed(context, names)) {
      if ("error" in cache || cache.save === null) {
        const note = saveNote(cache, null);
        if (note !== null) notes.push(note);
        continue;
      }
      const entry = { scope: cache.save, name: cache.name, keyHash: cache.keyHash };
      let saved: CacheSave;
      try {
        if (!(await project.pipelineCacheSaving(context.params.run, entry))) {
          notes.push(`cache ${cache.name}: not saved: ${cache.save} already has an entry for its key`);
          continue;
        }
        saved = await this.env.SANDBOX.getByName(sandbox).saveCache(
          cacheObjectKey(context.params.project, entry),
          cache.path,
        );
        if (saved.kind === "saved") {
          const recorded = await project.pipelineCacheSaved(context.params.run, { ...entry, size: saved.bytes });
          if (!recorded) saved = { kind: "failed", error: "the project didn't record it" };
        }
      } catch (error) {
        saved = { kind: "failed", error: String(error).slice(0, 300) };
      }
      notes.push(saveNote(cache, saved) ?? "");
    }
    return notes.filter((note) => note !== "");
  }

  /**
   * Runs the setups in the setup container and, when they all passed, snapshots it. Its logs are
   * stored before the container goes: the checks start from the snapshot, never from it. The caches
   * the setups use are restored before the first runs, and saved once each setup using one passed;
   * a note on each goes on the first setup that uses it.
   */
  async #setup(context: RunContext, base: string | null): Promise<SetupStage> {
    const { instanceId, params, plan, size, network } = context;
    const name = pipelineSandboxName(instanceId, { kind: "setup" });
    // In a trusted run the container holds every secret the setups name, as the settings are now.
    const held = await this.#hold(params, setupSecrets(plan));
    if ("error" in held) return secretlessSetup(plan, held);
    const caches = setupCaches(plan);
    let restoreNotes: string[] = [];
    try {
      const run = await runInSandbox(
        this.env,
        instanceId,
        { project: params.project, line: params.line },
        "pipeline",
        (g) => setupScript(g.lineRead.remote, { sha: params.sha, base }, plan.setup),
        {
          network,
          size,
          sandbox: name,
          env: { ...runContext(params), ...held.env },
          timeoutMs: setupTimeoutMs(plan) + STEP_SLACK_MS,
          prepare: async (start) => {
            restoreNotes = await this.#restoreCaches(context, name, caches, start);
          },
        },
      );
      const result = parseResult<SetupResult>(run.stdout);
      if (result === null) throw new Error(`setup gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
      const sandbox = this.env.SANDBOX.getByName(name);
      const passed = result.setups.every((s) => s.exit === 0);
      // A cache is saved once every setup using it passed, from this container, which is its saver.
      const saveable = caches.filter((cache) =>
        plan.setup.every((setup, i) => !setup.caches.includes(cache) || result.setups[i]?.exit === 0),
      );
      const saveNotes = await this.#saveCaches(context, name, saveable);
      const setups = withCacheNotes(plan.setup, result.setups, [...restoreNotes, ...saveNotes].map(held.mask));
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
      const logs = await storeLogs(this.env, {
        sandbox: name,
        names: plan.setup.map((_, i) => setupLogName(i + 1)),
        key: (log) => logKey({ project: params.project, line: params.line, run: params.run }, log),
        size,
        notes: new Map(setups.map((setup, i) => [setupLogName(i + 1), setup.notes ?? []])),
        mask: held.mask,
      });
      await sandbox.destroy();
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
   * ends. In a trusted run the container holds the secrets the check names, and the setups' too when
   * it re-runs them, loaded as the container comes up; one that's gone or no longer allowed fails
   * the check, naming it. What the check held is masked in its log, its metrics and any error.
   */
  async #check(context: RunContext, snapshot: SandboxSnapshot | null, check: PlannedCheck): Promise<CheckStage> {
    const { instanceId, params, plan, size, network } = context;
    const name = pipelineSandboxName(instanceId, { kind: "check", name: check.name });
    let held = NOTHING_HELD;
    let cacheNotes: string[] = [];
    try {
      const run = await runInSandbox(
        this.env,
        instanceId,
        { project: params.project, line: params.line },
        "pipeline",
        (g) => checkScript(g.lineRead.remote, params.sha, plan.setup, check),
        {
          network,
          size,
          sandbox: name,
          prepare: async (start, fromSnapshot) => {
            cacheNotes = await this.#prepareCaches(context, name, check.caches, start, fromSnapshot);
          },
          env: async (fromSnapshot) => {
            const names = fromSnapshot ? check.secrets : [...setupSecrets(plan), ...check.secrets];
            const holding = await this.#hold(params, names);
            if ("error" in holding) throw new SecretUnavailable(holding.error);
            held = holding;
            return { ...runContext(params), ...holding.env };
          },
          snapshot,
          timeoutMs: checkTimeoutMs(plan, check),
        },
      );
      const result = parseResult<CheckRun>(run.stdout);
      if (result === null)
        throw new Error(`check ${check.name} gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
      const { setupsRerun, ...ran } = result;
      const saved = ran.exit === 0 ? await this.#saveCaches(context, name, savedBy(context, name, check.caches)) : [];
      const notes = [
        ...(setupsRerun && plan.setup.length > 0 ? [snapshot === null ? NO_SNAPSHOT : SETUPS_RERUN] : []),
        ...[...cacheNotes, ...saved].map(held.mask),
      ];
      const logs = await storeLogs(this.env, {
        sandbox: name,
        names: [check.name],
        key: (log) => logKey({ project: params.project, line: params.line, run: params.run }, log),
        size,
        notes: new Map([[check.name, notes]]),
        mask: held.mask,
      });
      await this.env.SANDBOX.getByName(name).destroy();
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
   * any other; its command then runs once, in the next, with no retry.
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
        const ready = await step.do(
          `step ${postGate.name} ready`,
          {
            retries: STEP_RETRIES,
            timeout:
              setupTimeoutMs(plan) +
              2 * STEP_SLACK_MS +
              cacheTransfersMs([...setupCaches(plan), ...postGate.caches], 1),
          },
          () => this.#stepReady(context, snapshot, postGate),
        );
        const notes = [
          ...(ready.setupsRerun && plan.setup.length > 0 ? [STEP_SETUPS_RERUN(snapshot)] : []),
          ...ready.cacheNotes,
        ];
        const run = await step.do(
          `step ${postGate.name}`,
          {
            retries: { limit: 0, delay: "1 second" },
            timeout: POST_GATE_STEP_TIMEOUT_MS + 2 * STEP_SLACK_MS + cacheTransfersMs(postGate.caches, 1),
          },
          () => this.#stepRun(context, postGate, notes),
        );
        ran.set(postGate.name, run);
        if (run.exit !== 0) break;
      }
    }
    return withPostGateSteps(scored, plan.steps, ran);
  }

  /**
   * Readies a post-gate step's container: restored from the snapshot, or with the setups re-run, and
   * with the caches it uses restored. Says how restoring them went.
   */
  async #stepReady(
    context: RunContext,
    snapshot: SandboxSnapshot | null,
    postGate: StepConfig,
  ): Promise<StepReady & { cacheNotes: string[] }> {
    const { instanceId, params, plan, size, network } = context;
    const name = pipelineSandboxName(instanceId, { kind: "step", name: postGate.name });
    let cacheNotes: string[] = [];
    const run = await runInSandbox(
      this.env,
      instanceId,
      { project: params.project, line: params.line },
      "pipeline",
      (g) => stepReadyScript(g.lineRead.remote, params.sha, plan.setup, postGate),
      {
        network,
        size,
        sandbox: name,
        env: runContext(params),
        snapshot,
        timeoutMs: setupTimeoutMs(plan) + STEP_SLACK_MS,
        prepare: async (start, fromSnapshot) => {
          cacheNotes = await this.#prepareCaches(context, name, postGate.caches, start, fromSnapshot);
        },
      },
    );
    const result = parseResult<StepReady>(run.stdout);
    if (result === null) {
      throw new Error(`step ${postGate.name} wasn't readied (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
    }
    return { ...result, cacheNotes };
  }

  /**
   * Runs a post-gate step's command once in the container its ready step left, then stores its log and
   * stops the container. A container that was lost meanwhile is never started again: the command
   * doesn't run, and the step throws, ending the run `errored`.
   */
  async #stepRun(context: RunContext, postGate: StepConfig, notes: string[]): Promise<PostGateRun> {
    const { instanceId, params, size } = context;
    const name = pipelineSandboxName(instanceId, { kind: "step", name: postGate.name });
    const sandbox = this.env.SANDBOX.getByName(name);
    // Running already, the container keeps the access it started with; one that has to start gets none.
    const run = await sandbox.run(stepScript(postGate, POST_GATE_STEP_TIMEOUT_MS), {
      access: { grants: [], ...NO_NETWORK },
      size,
      timeoutMs: POST_GATE_STEP_TIMEOUT_MS + STEP_SLACK_MS,
      env: runContext(params),
    });
    const result = parseResult<StepRun>(run.stdout);
    if (result === null) {
      throw new Error(`step ${postGate.name} gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
    }
    // Saving a cache is only ever a note, so it never fails this step, which isn't retried.
    const saved =
      result.exit === 0 ? await this.#saveCaches(context, name, savedBy(context, name, postGate.caches)) : [];
    const noted = [...notes, ...saved];
    const log = stepLogName(postGate.name);
    const logs = await storeLogs(this.env, {
      sandbox: name,
      names: [log],
      key: (stored) => logKey({ project: params.project, line: params.line, run: params.run }, stored),
      size,
      notes: new Map([[log, noted]]),
    });
    await sandbox.destroy();
    return { ...result, logged: logs.includes(log), notes: noted };
  }

  /**
   * The values of the secrets `names` for a container of the run, opened here, in the step that
   * starts it, from what the project's settings hold now; or why one can't be had. Never persisted:
   * only the container's env and the step's masking hold them.
   */
  async #hold(params: PipelineParams, names: readonly string[]): Promise<Held | SecretRefusal> {
    if (names.length === 0) return NOTHING_HELD;
    const loaded = await this.env.PROJECT.getByName(params.project).pipelineSecrets(params.run, [...new Set(names)]);
    if ("error" in loaded) return { secret: loaded.secret, error: loaded.error };
    this.#keyring ??= keyringFrom(this.env.SECRETS_KEYRING);
    const keyring = this.#keyring;
    const values = await Promise.all(
      loaded.sealed.map(async (sealed) => [sealed.name, await openSealed(keyring, params.project, sealed)] as const),
    );
    return { env: Object.fromEntries(values), mask: masking(values.map(([, value]) => value)) };
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

/** Every secret the setups name, each once: what the setup container holds. */
function setupSecrets(plan: Pick<ScorePlan, "setup">): string[] {
  return [...new Set(plan.setup.flatMap((setup) => setup.secrets))];
}

/** What a run started under the Scoring Workflow's code was given: its line was its `attempt`. */
export interface ScoringParams extends Omit<PipelineParams, "line"> {
  attempt: string;
}

/** What the run plans to run: its setups and checks, and the post-gate steps after its gate. */
interface RunPlan extends ScorePlan {
  steps: StepConfig[];
}

/** The post-gate steps the run's pipeline has: only `main`'s, and none without a valid config. */
function postGateSteps(config: ConfigResult, params: PipelineParams): StepConfig[] {
  return config.kind === "valid" ? config.config.pipelines[pipelineFor(params.line)].steps : [];
}

/** What every step of a run's containers needs. */
interface RunContext {
  instanceId: string;
  params: PipelineParams;
  plan: RunPlan;
  size: SandboxSize;
  network: NetworkAccess;
  /** The caches the run uses, with where each restores from and saves to. */
  caches: RunCache[];
}

/** The caches anything in the plan uses, as the config defines them; none without a valid config. */
function runCaches(config: ConfigResult, plan: RunPlan): CacheConfig[] {
  if (config.kind !== "valid") return [];
  const used = new Set([...plan.setup, ...plan.checks, ...plan.steps].flatMap((user) => user.caches));
  return config.config.caches.filter((cache) => used.has(cache.name));
}

/** The caches the setups use, each once, in order. */
function setupCaches(plan: Pick<ScorePlan, "setup">): string[] {
  return [...new Set(plan.setup.flatMap((setup) => setup.caches))];
}

/** The run's caches named `names`. */
function cachesNamed(context: RunContext, names: readonly string[]): RunCache[] {
  return context.caches.filter((cache) => names.includes(cache.name));
}

/**
 * Which of `names` the container `sandbox` saves: each cache is saved from one container of a run,
 * so its entry is written once: the setup container's when a setup uses it, else the first check's
 * in the plan that does, else the first post-gate step's.
 */
function savedBy(context: RunContext, sandbox: string, names: readonly string[]): string[] {
  const { instanceId, plan } = context;
  const saver = (name: string): string | null => {
    if (setupCaches(plan).includes(name)) return pipelineSandboxName(instanceId, { kind: "setup" });
    const check = plan.checks.find((c) => c.caches.includes(name));
    if (check !== undefined) return pipelineSandboxName(instanceId, { kind: "check", name: check.name });
    const step = plan.steps.find((s) => s.caches.includes(name));
    return step === undefined ? null : pipelineSandboxName(instanceId, { kind: "step", name: step.name });
  };
  return names.filter((name) => saver(name) === sandbox);
}

/** The setups' runs with `notes` (about their caches) on the first setup that uses each cache. */
function withCacheNotes(
  setups: readonly SetupConfig[],
  runs: readonly SetupRun[],
  notes: readonly string[],
): SetupRun[] {
  return runs.map((run, i) => {
    const earlier = new Set(setups.slice(0, i).flatMap((setup) => setup.caches));
    const own = (setups[i]?.caches ?? []).filter((cache) => !earlier.has(cache));
    const noted = notes.filter((note) => own.some((cache) => note.startsWith(`cache ${cache}:`)));
    return noted.length === 0 ? run : { ...run, notes: noted };
  });
}

/** A run's params in the current shape, whichever code started it. */
function paramsLine(params: PipelineParams | ScoringParams): PipelineParams {
  if ("line" in params) return params;
  const { attempt, ...rest } = params;
  return { ...rest, line: attempt };
}

/** Room a step gets for moving `caches`, each up to `transfers` times (a restore, a save) at its timeout. */
function cacheTransfersMs(caches: readonly string[], transfers: number): number {
  return new Set(caches).size * transfers * CACHE_TRANSFER_TIMEOUT_MS;
}

/** How long a check's container may take: the check at its timeout, and the setups again if it re-runs them. */
function checkTimeoutMs(plan: ScorePlan, check: PlannedCheck): number {
  return setupTimeoutMs(plan) + check.timeoutMs + STEP_SLACK_MS;
}

/** What every container of the run is told about it. */
export function runContext(params: PipelineParams): Record<string, string> {
  return {
    THRONG_PROJECT: params.project,
    THRONG_PIPELINE: pipelineFor(params.line),
    THRONG_LINE: params.line,
    THRONG_SHA: params.sha,
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
 * and the one a `ScoringWorkflow` scored in, which a run planned before it was cancelled may still
 * hold. The setup container's snapshot is released.
 */
export async function teardownPipeline(
  sandboxes: SandboxNamespace,
  instanceId: string,
  containers: readonly string[],
): Promise<void> {
  const setup = pipelineSandboxName(instanceId, { kind: "setup" });
  const names = new Set([setup, ...containers, legacyScoreSandboxName(instanceId)]);
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
