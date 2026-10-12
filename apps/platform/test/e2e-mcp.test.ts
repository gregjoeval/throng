import { describe, expect, it } from "vitest";
import { waitForAttempt } from "../scripts/e2e-mcp.ts";
import type { ToolCall } from "../scripts/e2e-mcp.ts";

/** A `wait_for_attempt` that answers `states` in turn, recording what it was asked. */
function answering(...states: string[]) {
  const asked: Record<string, unknown>[] = [];
  const call: ToolCall = async (name, args) => {
    expect(name).toBe("wait_for_attempt");
    asked.push(args);
    const state = states[Math.min(asked.length - 1, states.length - 1)];
    return { attempt: { ref: "t1a1", state, changed: true } };
  };
  return { call, asked };
}

describe("waitForAttempt", () => {
  const base = { project: "e2e/p", attempt: "t1a1", until: "stateChanged", wait: 5 } as const;

  it("waits again until the attempt is as wanted, even when a wait answers it unchanged", async () => {
    const { call, asked } = answering("draft", "draft", "open");
    const found = await waitForAttempt(call, { ...base, done: (a) => a.state === "open", timeoutMs: 60_000 });
    expect(found.state).toBe("open");
    expect(asked).toHaveLength(3);
    expect(asked[0]).toEqual({ project: "e2e/p", attempt: "t1a1", until: "stateChanged", wait: 5 });
  });

  it("fails at once when the attempt can no longer get there", async () => {
    const { call, asked } = answering("draft", "closed", "open");
    const waiting = waitForAttempt(call, {
      ...base,
      done: (a) => a.state === "open",
      failed: (a) => (a.state === "closed" ? "it closed" : null),
      timeoutMs: 60_000,
    });
    await expect(waiting).rejects.toThrow("t1a1: it closed");
    expect(asked).toHaveLength(2);
  });

  it("gives up once the timeout has passed", async () => {
    const { call } = answering("draft");
    const waiting = waitForAttempt(call, { ...base, done: () => false, timeoutMs: 0 });
    await expect(waiting).rejects.toThrow("timed out waiting on t1a1 (stateChanged); last draft");
  });
});
