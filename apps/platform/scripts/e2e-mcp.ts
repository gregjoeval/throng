// The agent loop over MCP, as an agent drives it: only `/mcp` tools, and git for the push. The e2e
// suite's `mcp` scenario runs it against a deployed Worker; `test/mcp.test.ts` runs it in process.

import type { Client } from "@modelcontextprotocol/client";

/** Calls one MCP tool and returns its structured result; a tool error throws. */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** What the loop reads of an attempt as the tools return it (`src/api.ts`'s `Attempt`). */
export interface LoopAttempt {
  ref: string;
  state: string;
  remote: string;
  scoring: { status: string; sha: string | null; result?: { gate: string } };
  mergeRequest: { state: string; lastDequeue: { reason: string } | null } | null;
  verdicts: { head: string | null; merge: number; revise: number; reject: number };
  changed?: boolean;
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
 * Calls `wait_for_attempt` until `done` holds. Each answer is checked whether or not it `changed`:
 * what `until` watches may have changed before the first wait began.
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
  task: string;
  attempt: string;
  head: string;
  mergeSha: string;
}

/**
 * The agent loop, end to end: the creator's agent creates a task and starts two attempts, pushes to
 * one and opens it, and waits until it is scored; another user's agent posts a verdict on it; the
 * creator's agent selects it and waits until it merges.
 */
export async function agentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { creator, reviewer, project, push, wait, timeoutMs } = options;
  const log = options.log ?? (() => {});

  const me = (await creator("whoami", {}))["user"] as { id: string; handle: string };
  const them = (await reviewer("whoami", {}))["user"] as { id: string; handle: string };
  assert(me.id !== them.id, `the reviewer is the creator, ${me.handle}`);
  log(`creator ${me.handle}, reviewer ${them.handle}`);

  const task = ((await creator("create_task", { project, title: "Greet over MCP" }))["task"] as { ref: string }).ref;
  const started = (await creator("start_attempts", { project, task, count: 2 }))["attempts"] as LoopAttempt[];
  assert(started.length === 2, `started ${started.length} attempts, expected 2`);
  const [first, second] = started as [LoopAttempt, LoopAttempt];
  assert(first.remote.endsWith(`/${first.ref}.git`), `${first.ref}'s remote is ${first.remote}`);
  log(`${task}: started ${first.ref}, ${second.ref}`);

  const head = await push(first);
  log(`${first.ref}: pushed ${head}`);
  const opened = (await creator("update_attempt", { project, attempt: first.ref, state: "open" }))[
    "attempt"
  ] as LoopAttempt;
  assert(opened.state === "open", `${first.ref} is ${opened.state} after opening it`);

  const ended = (a: LoopAttempt) => a.scoring.sha === head && ["done", "errored"].includes(a.scoring.status);
  await waitForAttempt(creator, { project, attempt: first.ref, until: "scored", wait, done: ended, timeoutMs });
  const scored = (await creator("get_attempt", { project, attempt: first.ref }))["attempt"] as LoopAttempt;
  assert(
    scored.scoring.status === "done" && scored.scoring.sha === head && scored.scoring.result?.gate === "passed",
    `${first.ref}'s scoring of ${head}: ${JSON.stringify(scored.scoring)}`,
  );
  log(`${first.ref}: scored, gate passed`);

  const verdict = (
    await reviewer("post_verdict", { project, attempt: first.ref, recommendation: "merge", body: "Looks right." })
  )["verdict"] as { head: string };
  assert(verdict.head === head, `the verdict is on ${verdict.head}, expected ${head}`);
  const reviewed = (await creator("get_attempt", { project, attempt: first.ref }))["attempt"] as LoopAttempt;
  assert(
    reviewed.verdicts.head === head && reviewed.verdicts.merge === 1,
    `${first.ref}'s verdicts: ${JSON.stringify(reviewed.verdicts)}`,
  );
  log(`${first.ref}: ${them.handle} recommends merge`);

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
  return { task, attempt: first.ref, head, mergeSha: mergeRequest.mergeSha };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
