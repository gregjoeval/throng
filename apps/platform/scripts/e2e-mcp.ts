// The agent loop over MCP, as an agent drives it: only `/mcp` tools, and git for the push. The e2e
// suite's `mcp` scenario runs it against a deployed Worker; `test/mcp.test.ts` runs it in process.

import type { Client } from "@modelcontextprotocol/client";

/** Calls one MCP tool and returns its structured result; a tool error throws. */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** What the loop reads of an attempt as the tools return it (`src/api.ts`'s `Attempt`). */
export interface LoopAttempt {
  ref: string;
  author: { handle: string };
  alias: string | null;
  state: string;
  remote: string;
  scoring: { status: string; sha: string | null; result?: { gate: string } };
  mergeRequest: { state: string; lastDequeue: { reason: string } | null } | null;
  verdicts: { head: string | null; merge: number; revise: number; reject: number };
  changed?: boolean;
}

/** What the loop reads of a run as `list_runs`, `get_run` and `wait_for_run` return it (`src/api.ts`'s `Run`). */
interface LoopRun {
  id: number;
  sha: string;
  status: string;
  gate: string | null;
  outcome?: { gate: string } | null;
  settled?: boolean;
}

interface LoopMergeRequest {
  state: string;
  mergeSha: string | null;
}

/** `client`'s tools as a `ToolCall`. */
export function toolCaller(client: Client): ToolCall {
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) {
      const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(" ");
      throw new Error(`${name}: ${text}`);
    }
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };
}

export interface WaitOptions {
  project: string;
  attempt: string;
  until: "scored" | "stateChanged" | "mergeRequestChanged" | "any";
  /** Seconds each `wait_for_attempt` holds. */
  wait: number;
  /** Whether the attempt is as wanted. */
  done: (attempt: LoopAttempt) => boolean;
  /** Why the attempt can no longer be as wanted, or null while it still can. */
  failed?: (attempt: LoopAttempt) => string | null;
  timeoutMs: number;
}

/**
 * Calls `wait_for_attempt` until `done` holds. Each answer is checked whether or not it `changed`: a
 * merge request may pass through several states, or change before the first wait began.
 */
export async function waitForAttempt(call: ToolCall, options: WaitOptions): Promise<LoopAttempt> {
  const { project, attempt, until, wait, done, failed, timeoutMs } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await call("wait_for_attempt", { project, attempt, until, wait });
    const found = answer["attempt"] as LoopAttempt;
    if (done(found)) return found;
    const why = failed?.(found) ?? null;
    if (why !== null) throw new Error(`${attempt}: ${why}`);
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting on ${attempt} (${until}); last ${found.state}`);
    }
  }
}

export interface AgentLoopOptions {
  /** The task creator's agent. */
  creator: ToolCall;
  /** Another user's agent, which reviews. */
  reviewer: ToolCall;
  /** `owner/project`. */
  project: string;
  /** Clones the attempt's `remote` as `llms.txt` says, commits a change, pushes it, and returns the head pushed. */
  push: (attempt: LoopAttempt) => Promise<string>;
  /** Seconds each `wait_for_attempt` holds. */
  wait: number;
  /** How long scoring, then merging, may take. */
  timeoutMs: number;
  log?: (line: string) => void;
}

export interface AgentLoopResult {
  /** Who the creator's agent acts as: `user (alias)`. */
  creator: string;
  /** Who the reviewer's agent acts as: `user (alias)`. */
  reviewer: string;
  task: string;
  attempt: string;
  head: string;
  mergeSha: string;
}

/** Who `whoami` says an agent's token acts as. */
interface Agent {
  user: { id: string; handle: string };
  alias: string | null;
}

/** An agent as the UI shows an actor: `greg (claude)`. */
function actorName({ user, alias }: { user: { handle: string }; alias: string | null }): string {
  return alias === null ? user.handle : `${user.handle} (${alias})`;
}

/**
 * The agent loop, end to end: the creator's agent creates a task and starts two attempts, pushes to
 * one and opens it, and waits until it is scored; another user's agent posts a verdict on it; the
 * creator's agent selects it and waits until it merges. Both agents act under an alias, which the
 * attempt and the verdict record.
 */
export async function agentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { creator, reviewer, project, push, wait, timeoutMs } = options;
  const log = options.log ?? (() => {});

  const me = (await creator("whoami", {})) as unknown as Agent;
  const them = (await reviewer("whoami", {})) as unknown as Agent;
  assert(me.user.id !== them.user.id, `the reviewer is the creator, ${me.user.handle}`);
  assert(me.alias !== null && them.alias !== null, `both agents need an alias: ${actorName(me)}, ${actorName(them)}`);
  log(`creator ${actorName(me)}, reviewer ${actorName(them)}`);

  const task = ((await creator("create_task", { project, title: "Greet over MCP" }))["task"] as { ref: string }).ref;
  const started = (await creator("start_attempts", { project, task, count: 2 }))["attempts"] as LoopAttempt[];
  assert(started.length === 2, `started ${started.length} attempts, expected 2`);
  const [first, second] = started as [LoopAttempt, LoopAttempt];
  assert(first.remote.endsWith(`/${first.ref}.git`), `${first.ref}'s remote is ${first.remote}`);
  assert(
    actorName({ user: first.author, alias: first.alias }) === actorName(me),
    `${first.ref} is by ${actorName({ user: first.author, alias: first.alias })}, expected ${actorName(me)}`,
  );
  log(`${task}: started ${first.ref}, ${second.ref}`);

  const head = await push(first);
  log(`${first.ref}: pushed ${head}`);
  const opened = (await creator("update_attempt", { project, attempt: first.ref, state: "open" }))[
    "attempt"
  ] as LoopAttempt;
  assert(opened.state === "open", `${first.ref} is ${opened.state} after opening it`);

  // `scored` holds once the current head, `head`, has a finished run: a wait says so with `changed`.
  const scoredHead = (a: LoopAttempt) => a.changed === true;
  await waitForAttempt(creator, { project, attempt: first.ref, until: "scored", wait, done: scoredHead, timeoutMs });
  const scored = (await creator("get_attempt", { project, attempt: first.ref }))["attempt"] as LoopAttempt;
  assert(
    scored.scoring.status === "done" && scored.scoring.sha === head && scored.scoring.result?.gate === "passed",
    `${first.ref}'s scoring of ${head}: ${JSON.stringify(scored.scoring)}`,
  );
  log(`${first.ref}: scored, gate passed`);

  // The same run, from the project's runs: listed on the attempt's line, settled, and done step by step.
  const listed = (await creator("list_runs", { project, line: first.ref }))["runs"] as LoopRun[];
  const run = listed.find((r) => r.sha === head && r.status === "done");
  assert(run !== undefined, `${first.ref}'s runs don't include a done run of ${head}: ${JSON.stringify(listed)}`);
  const waited = (await creator("wait_for_run", { project, run: run.id, wait }))["run"] as LoopRun;
  assert(waited.settled === true && waited.gate === "passed", `run ${run.id} after a wait: ${JSON.stringify(waited)}`);
  const detail = (await creator("get_run", { project, run: run.id }))["run"] as LoopRun;
  assert(detail.outcome?.gate === "passed", `run ${run.id}'s outcome: ${JSON.stringify(detail)}`);
  log(`${first.ref}: run ${run.id} listed, settled and read`);

  const verdict = (
    await reviewer("post_verdict", { project, attempt: first.ref, recommendation: "merge", body: "Looks right." })
  )["verdict"] as { head: string; reviewer: { handle: string }; alias: string | null };
  assert(verdict.head === head, `the verdict is on ${verdict.head}, expected ${head}`);
  const by = actorName({ user: verdict.reviewer, alias: verdict.alias });
  assert(by === actorName(them), `the verdict is by ${by}, expected ${actorName(them)}`);
  const reviewed = (await creator("get_attempt", { project, attempt: first.ref }))["attempt"] as LoopAttempt;
  assert(
    reviewed.verdicts.head === head && reviewed.verdicts.merge === 1,
    `${first.ref}'s verdicts: ${JSON.stringify(reviewed.verdicts)}`,
  );
  log(`${first.ref}: ${by} recommends merge`);

  await creator("select_attempt", { project, task, attempt: first.ref });
  log(`${task}: selected ${first.ref}`);
  await waitForAttempt(creator, {
    project,
    attempt: first.ref,
    until: "mergeRequestChanged",
    wait,
    done: (a) => a.mergeRequest?.state === "merged",
    failed: (a) => (a.mergeRequest?.state === "cancelled" ? "its merge request was cancelled" : null),
    timeoutMs,
  });

  const found = await creator("get_task", { project, task });
  const mergeRequest = found["mergeRequest"] as LoopMergeRequest | null;
  assert(
    mergeRequest !== null && mergeRequest.mergeSha !== null,
    `${task}'s merge request: ${JSON.stringify(mergeRequest)}`,
  );
  const sibling = (found["attempts"] as LoopAttempt[]).find((a) => a.ref === second.ref);
  assert(sibling?.state === "closed", `selecting ${first.ref} left ${second.ref} ${sibling?.state}`);
  log(`${task}: merged as ${mergeRequest.mergeSha}`);
  return {
    creator: actorName(me),
    reviewer: actorName(them),
    task,
    attempt: first.ref,
    head,
    mergeSha: mergeRequest.mergeSha,
  };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
