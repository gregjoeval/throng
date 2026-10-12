import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { followMessage } from "./follows";
import type { FollowOutcome, FollowParams } from "./follows";
import { FOLLOW_ROLES, sandboxName } from "./grants";
import { followScript, parseResult } from "./scripts";
import type { FollowResult } from "./scripts";
import { attemptRef } from "./task-refs";
import { runInSandbox, STEP_RETRIES } from "./workflows";

/**
 * One follow of a task branch (ADR 0003): merges a new task head into an active attempt's fork.
 *
 * 1. Claim the push from the project's DO, which refuses when the attempt ended, the follow already
 *    reported, or a landing of the attempt's merge request has claimed its push to `main`.
 * 2. Follow, in the trusted `follow` container (origin read, fork write, no repository code): merge
 *    the task head into the fork's `main` and push it with a lease on the head it read
 *    (`followScript`). A conflict writes nothing.
 * 3. Tear the container down, then report the outcome to the DO, which records the new head (and
 *    scores it) or marks the attempt needs update.
 *
 * Each step retries infrastructure errors twice; then the follow reports `errored`.
 */
export class FollowWorkflow extends WorkflowEntrypoint<Env, FollowParams> {
  override async run(event: Readonly<WorkflowEvent<FollowParams>>, step: WorkflowStep): Promise<FollowOutcome | null> {
    const params = event.payload;
    const instanceId = event.instanceId;
    const project = () => this.env.PROJECT.getByName(params.project);

    let outcome: FollowOutcome | null;
    let at = "claim";
    try {
      const claimed = await step.do("claim", { retries: STEP_RETRIES, timeout: "1 minute" }, () =>
        project().claimFollowPush(params.follow),
      );
      if (claimed) {
        at = "follow";
        outcome = await step.do("follow", { retries: STEP_RETRIES, timeout: "10 minutes" }, () =>
          this.#follow(instanceId, params),
        );
      } else {
        outcome = null;
      }
    } catch (error) {
      outcome = { kind: "errored", step: at, error: String(error).slice(0, 2000) };
    }

    await step.do("teardown", { retries: STEP_RETRIES }, async () => {
      await Promise.all(
        FOLLOW_ROLES.map((role) => this.env.SANDBOX.getByName(sandboxName(instanceId, role)).destroy()),
      );
    });
    // A refused claim reports nothing: the DO already knows the follow won't run.
    if (outcome !== null) {
      const reported = outcome;
      await step.do("report", { retries: STEP_RETRIES }, async () => {
        await project().followFinished(params.follow, reported);
      });
    }
    return outcome;
  }

  async #follow(instanceId: string, params: FollowParams): Promise<FollowResult> {
    const repos = { project: params.project, attempt: attemptRef(params.task, params.attempt) };
    const run = await runInSandbox(this.env, instanceId, repos, "follow", (g) =>
      followScript(g.originRead.remote, g.forkWrite.remote, {
        task: params.task,
        taskHead: params.taskHead,
        message: followMessage(params.task, params.attempt),
        committedAt: Math.floor(params.startedAt / 1000),
      }),
    );
    const result = parseResult<FollowResult>(run.stdout);
    if (result === null) throw new Error(`follow gave no result (exit ${run.exitCode}): ${run.stderr.slice(-2000)}`);
    return result;
  }
}
