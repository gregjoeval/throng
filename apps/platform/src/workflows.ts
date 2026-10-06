import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { forkName, routePush, type PushRoute } from "./events";
import type { CheckOutcome, CheckParams } from "./project";
import {
  CHECK_ROLES,
  grantsForRole,
  roleGetsPreview,
  RUNS_REPO_CODE,
  sandboxName,
  type CheckGrants,
  type CheckRole,
} from "./grants";
import { previewName, type PreviewGrant } from "./preview";
import type { RunResult } from "./sandbox";
import {
  landScript,
  parseResult,
  previewScript,
  retestScript,
  testScript,
  type LandResult,
  type PreviewResult,
  type RetestResult,
  type TestResult,
} from "./scripts";

const TOKEN_TTL_SECONDS = 30 * 60;
/** Re-test and land rounds before giving up on a main that keeps moving. */
const LAND_ROUNDS = 3;

/** Started by the `cf.artifacts.repo.pushed` event trigger for every repo in the namespace. */
export class IngestWorkflow extends WorkflowEntrypoint<Env, unknown> {
  override async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<PushRoute> {
    const startedAt = event.timestamp.getTime();
    const route = routePush(event.payload);
    if (route.kind === "ignored") {
      console.log({ event: "ingest.ignored", reason: route.reason, payload: event.payload });
      return route;
    }
    await step.do("deliver", async () => {
      await this.env.PROJECT.getByName(route.project).receive(route, { startedAt, instanceId: event.instanceId });
    });
    return route;
  }
}

/**
 * Tests an attempt's commit, then rebases it onto main, re-tests, and lands it. Repo code runs only in
 * containers without canonical write access; landing happens in its own container (see `grants.ts`).
 */
export class CheckWorkflow extends WorkflowEntrypoint<Env, CheckParams> {
  override async run(event: Readonly<WorkflowEvent<CheckParams>>, step: WorkflowStep): Promise<CheckOutcome> {
    const params = event.payload;
    const instanceId = event.instanceId;
    const timings: Record<string, number> = { createdAt: event.timestamp.getTime() };
    const sandboxStep = {
      retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
      timeout: "10 minutes",
    } as const;
    // Each role runs in its own container with only that role's grants. Retest and land repeat per round.
    const run = (role: CheckRole, script: (grants: CheckGrants) => string) =>
      step.do(`${role}${role === "retest" || role === "land" ? ` ${round}` : ""}`, sandboxStep, async () => {
        const grants = await this.#grants(params);
        return this.#run(instanceId, role, script(grants), grants);
      });
    let round = 0;

    const outcome = await (async (): Promise<CheckOutcome> => {
      const test = await run("test", (g) => testScript(g.forkRead.remote, params.sha));
      timings.testStartMs = test.startMs;
      timings.testRunMs = test.runMs;
      const tested = parseResult<TestResult>(test.stdout);
      if (tested === null) return scriptError("test", test);
      if (!tested.ok) return { kind: "failed", stage: tested.stage, output: tested.output };

      // A preview is a convenience: a failed one is journaled but doesn't fail the check.
      const preview = await run("preview", (g) =>
        previewScript(g.forkRead.remote, params.sha, { ...this.#preview(), previewName: previewName(params) }),
      );
      timings.previewRunMs = preview.runMs;
      const previewed = parseResult<PreviewResult>(preview.stdout);
      await step.do("note preview", async () => {
        const detail = { instanceId, attempt: params.attempt, sha: params.sha, runMs: preview.runMs };
        const project = this.env.PROJECT.getByName(params.project);
        if (previewed?.ok) await project.note("preview-ready", { ...detail, url: previewed.url });
        else
          await project.note("preview-failed", {
            ...detail,
            stage: previewed?.stage ?? "deploy",
            output: previewed?.output ?? preview.stderr.slice(-4000),
          });
      });

      for (round = 1; round <= LAND_ROUNDS; round++) {
        const retest = await run("retest", (g) => retestScript(g.canonicalRead.remote, g.forkRead.remote, params.sha));
        timings.retestRunMs = retest.runMs;
        const retested = parseResult<RetestResult>(retest.stdout);
        if (retested === null) return scriptError("retest", retest);
        if (retested.kind === "bounced") return retested;
        if (retested.kind === "failed") {
          const stage = retested.stage === "install" ? "install" : "rebase-test";
          return { kind: "failed", stage, output: retested.output };
        }

        const land = await run("land", (g) =>
          landScript(g.canonicalWrite.remote, g.forkRead.remote, params.sha, retested),
        );
        timings.landRunMs = land.runMs;
        const landed = parseResult<LandResult>(land.stdout);
        if (landed === null) return scriptError("land", land);
        if (landed.kind === "landed") {
          timings.landRounds = round;
          return { kind: "landed", mainSha: landed.mainSha };
        }
        if (landed.kind === "mismatch") {
          return {
            kind: "error",
            message: `land produced tree ${landed.tree}, but retest tested ${retested.tree}; refusing to push`,
          };
        }
      }
      return { kind: "error", message: `main kept moving; gave up after ${LAND_ROUNDS} rounds` };
    })();

    await step.do("teardown", async () => {
      await Promise.all(CHECK_ROLES.map((role) => this.env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()));
    });
    timings.finishedAt = Date.now();
    await step.do("report", async () => {
      await this.env.PROJECT.getByName(params.project).checkFinished({ ...params, instanceId }, outcome, timings);
    });
    return outcome;
  }

  /** Every token a check might need. Minted per step, so a retry never holds a stale one. */
  async #grants({ project, attempt }: CheckParams): Promise<CheckGrants> {
    using canonical = await this.env.ARTIFACTS.get(project);
    using fork = await this.env.ARTIFACTS.get(forkName(project, attempt));
    const [canonicalInfo, forkInfo, canonicalRead, canonicalWrite, forkRead] = await Promise.all([
      canonical.info(),
      fork.info(),
      canonical.createToken("read", TOKEN_TTL_SECONDS),
      canonical.createToken("write", TOKEN_TTL_SECONDS),
      fork.createToken("read", TOKEN_TTL_SECONDS),
    ]);
    return {
      canonicalRead: { remote: canonicalInfo.remote, token: canonicalRead.plaintext, access: "read" },
      canonicalWrite: { remote: canonicalInfo.remote, token: canonicalWrite.plaintext, access: "write" },
      forkRead: { remote: forkInfo.remote, token: forkRead.plaintext, access: "read" },
    };
  }

  #preview(): PreviewGrant {
    return { accountId: this.env.CF_ACCOUNT_ID, workerName: this.env.PREVIEW_WORKER };
  }

  /** Runs a script in the role's own container, which only ever gets that role's grants. */
  async #run(instanceId: string, role: CheckRole, script: string, grants: CheckGrants): Promise<RunResult> {
    const sandbox = this.env.SANDBOX.getByName(sandboxName(instanceId, role));
    const result = await sandbox.run(script, {
      grants: grantsForRole(role, grants),
      preview: roleGetsPreview(role) ? this.#preview() : null,
      // Installing dependencies is repo work; the trusted land container never reaches the registry.
      npmRegistry: RUNS_REPO_CODE[role],
    });
    // Exit codes 10+ are infrastructure failures (fetch, checkout); throw so the step retries.
    if (result.exitCode >= 10) {
      throw new Error(`sandbox script exited ${result.exitCode}: ${result.stderr.slice(-2000)}`);
    }
    return result;
  }
}

function scriptError(stage: string, result: RunResult): CheckOutcome {
  return {
    kind: "error",
    message: `${stage} script gave no result (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`,
  };
}
