import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { forkName, routePush, type PushRoute } from "./events";
import type { CheckOutcome, CheckParams } from "./project";
import type { GitGrant, RunResult } from "./sandbox";
import { landScript, parseResult, testScript, type LandResult, type TestResult } from "./scripts";

const TOKEN_TTL_SECONDS = 30 * 60;

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

/** Tests an attempt's commit, then rebases it onto main, re-tests, and lands it. */
export class CheckWorkflow extends WorkflowEntrypoint<Env, CheckParams> {
  override async run(event: Readonly<WorkflowEvent<CheckParams>>, step: WorkflowStep): Promise<CheckOutcome> {
    const params = event.payload;
    const instanceId = event.instanceId;
    const timings: Record<string, number> = { createdAt: event.timestamp.getTime() };
    const sandboxStep = {
      retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
      timeout: "10 minutes",
    } as const;

    const outcome = await (async (): Promise<CheckOutcome> => {
      const test = await step.do("test", sandboxStep, async () => {
        const grants = await this.#grants(params);
        const fork = grants[1]!.remote;
        return this.#run(instanceId, testScript(fork, params.sha), grants);
      });
      timings.testStartMs = test.startMs;
      timings.testRunMs = test.runMs;
      const tested = parseResult<TestResult>(test.stdout);
      if (tested === null) return scriptError("test", test);
      if (!tested.ok) return { kind: "failed", stage: "test", output: tested.output };

      const land = await step.do("land", sandboxStep, async () => {
        const grants = await this.#grants(params);
        return this.#run(instanceId, landScript(grants[0]!.remote, grants[1]!.remote, params.sha), grants);
      });
      timings.landStartMs = land.startMs;
      timings.landRunMs = land.runMs;
      const landed = parseResult<LandResult>(land.stdout);
      if (landed === null) return scriptError("land", land);
      switch (landed.kind) {
        case "landed":
          timings.landAttempts = landed.attempts;
          return { kind: "landed", mainSha: landed.mainSha };
        case "failed":
          return { kind: "failed", stage: "rebase-test", output: landed.output };
        case "bounced":
          return landed;
        case "gave-up":
          return { kind: "error", message: `main kept moving; gave up after ${landed.attempts} pushes` };
      }
    })();

    await step.do("teardown", async () => {
      await this.env.SANDBOX.getByName(instanceId).destroy();
    });
    timings.finishedAt = Date.now();
    await step.do("report", async () => {
      await this.env.PROJECT.getByName(params.project).checkFinished({ ...params, instanceId }, outcome, timings);
    });
    return outcome;
  }

  /** Canonical repo (write) then attempt fork (read). Minted per step so a retry never holds a stale token. */
  async #grants({ project, attempt }: CheckParams): Promise<[GitGrant, GitGrant]> {
    using canonical = await this.env.ARTIFACTS.get(project);
    using fork = await this.env.ARTIFACTS.get(forkName(project, attempt));
    const [canonicalInfo, forkInfo, canonicalToken, forkToken] = await Promise.all([
      canonical.info(),
      fork.info(),
      canonical.createToken("write", TOKEN_TTL_SECONDS),
      fork.createToken("read", TOKEN_TTL_SECONDS),
    ]);
    return [
      { remote: canonicalInfo.remote, token: canonicalToken.plaintext },
      { remote: forkInfo.remote, token: forkToken.plaintext },
    ];
  }

  async #run(instanceId: string, script: string, grants: GitGrant[]): Promise<RunResult> {
    const result = await this.env.SANDBOX.getByName(instanceId).run(script, grants);
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
