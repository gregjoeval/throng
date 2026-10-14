import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { attemptBase } from "./base";
import { loadConfig, namedSecrets, networkAllow, sandboxSize } from "./config";
import type { ConfigResult, SandboxSize } from "./config";
import { legacyScoreSandboxName, pipelineSandboxName } from "./grants";
import { logKey, setupLogName } from "./logs";
import type { NetworkAccess } from "./network";
import { loadRegistries } from "./npmrc";
import { originMainRef } from "./repos";
import { checkOrder, scorePlan, setupTimeoutMs, STEP_SLACK_MS } from "./results";
import type { PlannedCheck, RawScore, ScorePlan } from "./results";
import { pipelineOutcome } from "./run-outcome";
import type { SetupRun } from "./run-outcome";
import type { SandboxSnapshot } from "./sandbox";
import { pipelineFor } from "./scoring";
import type { PipelineParams, PlanVerdict, RunReport } from "./scoring";
import { checkScript, parseResult, setupScript } from "./scripts";
import type { CheckRun, SetupResult } from "./scripts";
import { keyringFrom, maskedDeep, masking, openSealed } from "./secrets";
import type { Keyring, SecretRefusal } from "./secrets";
import { NO_TASK_DEFINITIONS, withTask } from "./task-definitions";
import { parseAttemptRef } from "./task-refs";
import { runInSandbox, STEP_RETRIES, storeLogs } from "./workflows";

/** The note on a check whose container ran the setups itself, because it couldn't start from their snapshot. */
const SETUPS_RERUN = "setups re-run in this check's container: it couldn't start from the setups' snapshot";

/** The note on a check whose container ran the setups itself, because the run took no snapshot. */
const NO_SNAPSHOT = "setups re-run in this check's container: the run took no snapshot of them";

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
 * An attempt line (`t42a3`) runs `default`; the config and the `.npmrc` registry hosts are read from
 * one commit of the origin's `main`, so an attempt can't change its own checks or widen its own network
 * access, and the two always agree.
 *
 * Its stages are fixed. One container runs the setups in order and stops at the first that fails; it
 * is then snapshotted. Each check runs in its own container started from that snapshot, in parallel,
 * once every check it waits for (`after`) passed; a check whose wait didn't pass is skipped. A failed
 * restore is retried once, then the check's container starts from the image and re-runs the setups.
 * There's no snapshot under `wrangler dev`, so every check's container re-runs them there.
 *
 * Every container (`<instance>/setup`, `<instance>/check:<name>`) holds one read grant on the fork
 * and no write grant, reaches only `main`'s `network.allow` and `.npmrc` registries, and gets the
 * run's `THRONG_*` variables. Each copies its logs to R2 within its step, while it still runs, then
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
    let plan: ScorePlan | null = null;
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
        attemptBase(reposFor(this.env), params.project, { attempt: params.line, head: params.sha }),
      );
      const planned = scorePlan(config);
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
      // A task's definitions never change `network.allow`, so the run's config gives `main`'s.
      const context: RunContext = {
        instanceId,
        params,
        plan: planned,
        size,
        network: { registries, allow: networkAllow(config) },
      };
      const setup = await step.do(
        "setup",
        { retries: STEP_RETRIES, timeout: setupTimeoutMs(planned) + 2 * STEP_SLACK_MS },
        () => this.#setup(context, base?.sha ?? null),
      );
      const checks = setup.setups.every((s) => s.exit === 0)
        ? await this.#checks(step, context, setup)
        : new Map<string, CheckStage>();
      report = { status: "done", outcome: outcomeOf(config, planned, setup, checks) };
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
    return { config: withTask(project, definitions), size: sandboxSize(project) };
  }

  /**
   * Runs the setups in the setup container and, when they all passed, snapshots it. Its logs are
   * stored before the container goes: the checks start from the snapshot, never from it.
   */
  async #setup(context: RunContext, base: string | null): Promise<SetupStage> {
    const { instanceId, params, plan, size, network } = context;
    const name = pipelineSandboxName(instanceId, { kind: "setup" });
    // In a trusted run the container holds every secret the setups name, as the settings are now.
    const held = await this.#hold(params, setupSecrets(plan));
    if ("error" in held) return secretlessSetup(plan, held);
    try {
      const run = await runInSandbox(
        this.env,
        instanceId,
        { project: params.project, attempt: params.line },
        "pipeline",
        (g) => setupScript(g.forkRead.remote, { sha: params.sha, base }, plan.setup),
        {
          network,
          size,
          sandbox: name,
          env: { ...runContext(params), ...held.env },
          timeoutMs: setupTimeoutMs(plan) + STEP_SLACK_MS,
        },
      );
      const result = parseResult<SetupResult>(run.stdout);
      if (result === null) throw new Error(`setup gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
      const sandbox = this.env.SANDBOX.getByName(name);
      const passed = result.setups.every((s) => s.exit === 0);
      let snapshot: SandboxSnapshot | null = null;
      // With no setups there's nothing to keep: each check's container just checks the head out.
      if (passed && plan.setup.length > 0 && plan.checks.length > 0) {
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
        mask: held.mask,
      });
      await sandbox.destroy();
      return { ...result, snapshot, logs };
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
          { retries: STEP_RETRIES, timeout: checkTimeoutMs(context.plan, check) + STEP_SLACK_MS },
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
    try {
      const run = await runInSandbox(
        this.env,
        instanceId,
        { project: params.project, attempt: params.line },
        "pipeline",
        (g) => checkScript(g.forkRead.remote, params.sha, plan.setup, check),
        {
          network,
          size,
          sandbox: name,
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
      const notes = setupsRerun && plan.setup.length > 0 ? [snapshot === null ? NO_SNAPSHOT : SETUPS_RERUN] : [];
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

/** What every step of a run's containers needs. */
interface RunContext {
  instanceId: string;
  params: PipelineParams;
  plan: ScorePlan;
  size: SandboxSize;
  network: NetworkAccess;
}

/** A run's params in the current shape, whichever code started it. */
function paramsLine(params: PipelineParams | ScoringParams): PipelineParams {
  if ("line" in params) return params;
  const { attempt, ...rest } = params;
  return { ...rest, line: attempt };
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

/** Every container the run may start: the setup container and one per check. */
export function plannedContainers(instanceId: string, plan: Pick<ScorePlan, "checks">): string[] {
  return [
    pipelineSandboxName(instanceId, { kind: "setup" }),
    ...plan.checks.map((check) => pipelineSandboxName(instanceId, { kind: "check", name: check.name })),
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
