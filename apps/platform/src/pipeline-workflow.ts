import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { reposFor } from "./artifacts";
import { attemptBase } from "./base";
import { loadConfig, networkAllow, sandboxSize } from "./config";
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
import type { PipelineParams, RunReport } from "./scoring";
import { checkScript, parseResult, setupScript } from "./scripts";
import type { CheckRun, SetupResult } from "./scripts";
import { NO_TASK_DEFINITIONS, withTask } from "./task-definitions";
import { parseAttemptRef } from "./task-refs";
import { runInSandbox, STEP_RETRIES, storeLogs } from "./workflows";

/** The note on a check whose container ran the setups itself, because it couldn't start from their snapshot. */
const SETUPS_RERUN = "setups re-run in this check's container: it couldn't start from the setups' snapshot";

/** The note on a check whose container ran the setups itself, because the run took no snapshot. */
const NO_SNAPSHOT = "setups re-run in this check's container: the run took no snapshot of them";

/** What the setup container leaves for the checks: how each setup went, its diff, and the snapshot to start from. */
interface SetupStage extends SetupResult {
  /** Null when a setup failed, under `wrangler dev`, or when the snapshot failed: checks then re-run the setups. */
  snapshot: SandboxSnapshot | null;
  /** The setup logs stored, by name. */
  logs: string[];
}

/** How one check went: its run, and whether its log was stored. */
interface CheckStage extends Omit<CheckRun, "setupsRerun"> {
  logged: boolean;
  notes: string[];
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
 * It takes over the `ScoringWorkflow`'s Workflow name, so a run that started under that class resumes
 * here: its params name the line `attempt`, and its old step names (`score`) are never called again.
 */
export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams | ScoringParams> {
  override async run(
    event: Readonly<WorkflowEvent<PipelineParams | ScoringParams>>,
    step: WorkflowStep,
  ): Promise<RunReport> {
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
      // Before any container starts, so a cancel can name every one the run may start.
      await step.do("plan", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        this.env.PROJECT.getByName(params.project).pipelinePlanned(params.run, plannedContainers(instanceId, planned)),
      );
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
    const run = await runInSandbox(
      this.env,
      instanceId,
      { project: params.project, attempt: params.line },
      "pipeline",
      (g) => setupScript(g.forkRead.remote, { sha: params.sha, base }, plan.setup),
      { network, size, sandbox: name, env: runContext(params), timeoutMs: setupTimeoutMs(plan) + STEP_SLACK_MS },
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
        console.warn({ event: "sandbox.snapshot_failed", sandbox: name, error: String(error) });
      }
    }
    const logs = await storeLogs(this.env, {
      sandbox: name,
      names: plan.setup.map((_, i) => setupLogName(i + 1)),
      key: (log) => logKey({ project: params.project, line: params.line, run: params.run }, log),
      size,
    });
    await sandbox.destroy();
    return { ...result, snapshot, logs };
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
   * image with the setups re-run first. Its log is stored, and the container stopped, before the step ends.
   */
  async #check(context: RunContext, snapshot: SandboxSnapshot | null, check: PlannedCheck): Promise<CheckStage> {
    const { instanceId, params, plan, size, network } = context;
    const name = pipelineSandboxName(instanceId, { kind: "check", name: check.name });
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
        env: runContext(params),
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
    });
    await this.env.SANDBOX.getByName(name).destroy();
    return { ...ran, logged: logs.includes(check.name), notes };
  }
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
  const failed = setup.setups.findIndex((s) => s.exit !== 0);
  const raw: RawScore = {
    base: setup.base,
    shortstat: setup.shortstat,
    builtinMs: setup.builtinMs,
    setupFailed: failed === -1 ? null : failed + 1,
    checks: plan.checks.map((check) => {
      const ran = checks.get(check.name);
      return ran === undefined
        ? { exit: null, durationMs: 0, metrics: {} }
        : { exit: ran.exit, durationMs: ran.durationMs, metrics: ran.metrics };
    }),
  };
  const setups: SetupRun[] = setup.setups;
  const logs = [...setup.logs, ...[...checks].flatMap(([name, stage]) => (stage.logged ? [name] : []))];
  const notes = new Map([...checks].map(([name, stage]) => [name, stage.notes]));
  return pipelineOutcome(config, raw, setups, logs, notes);
}
