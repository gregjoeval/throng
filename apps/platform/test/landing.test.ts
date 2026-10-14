import { describe, expect, it } from "vitest";
import {
  actedAlias,
  conflictOutcome,
  dequeueDetails,
  landingOutcome,
  mergeAuthor,
  mergeCommitMessage,
  THRONG_COMMITTER,
} from "../src/landing.ts";
import type { RunOutcome, RunStep } from "../src/run-outcome.ts";
import type { StoredRun } from "../src/scoring.ts";

const ada = { id: "ada00001", handle: "ada", alias: null };

describe("mergeCommitMessage", () => {
  it("names the attempt and task, with the trailers from the spec", () => {
    const message = mergeCommitMessage({
      task: 42,
      attempt: 3,
      title: "Fix the greeting",
      approver: ada,
      coAuthors: [
        { id: "bob00001", handle: "bob", alias: "claude" },
        { id: "bob00001", handle: "bob", alias: "codex" },
      ],
    });
    expect(message).toBe(
      [
        "Merge t42a3: Fix the greeting",
        "",
        "Throng-Task: t42",
        "Throng-Attempt: t42a3",
        "Throng-Merge-Request: t42",
        "Approved-by: ada <ada00001+ada@users.noreply.throng>",
        "Co-authored-by: bob (claude) <bob00001+claude@users.noreply.throng>",
        "Co-authored-by: bob (codex) <bob00001+codex@users.noreply.throng>",
        "",
      ].join("\n"),
    );
  });

  it("keeps the subject on one line and leaves out co-authors when no alias pushed", () => {
    const message = mergeCommitMessage({
      task: 7,
      attempt: 1,
      title: "Two\nlines  here ",
      approver: ada,
      coAuthors: [],
    });
    expect(message.split("\n")[0]).toBe("Merge t7a1: Two lines here");
    expect(message).not.toContain("Co-authored-by");
  });

  it("names the approver's alias when they approved under one", () => {
    const message = mergeCommitMessage({
      task: 7,
      attempt: 1,
      title: "x",
      approver: { ...ada, alias: "claude" },
      coAuthors: [],
    });
    expect(message).toContain("Approved-by: ada (claude) <ada00001+claude@users.noreply.throng>");
  });
});

describe("actedAlias", () => {
  it("reads the alias from params saved before it was called agent, and null for acting as oneself", () => {
    expect(actedAlias({ alias: "claude" })).toBe("claude");
    expect(actedAlias({ alias: null })).toBeNull();
    expect(actedAlias({ agent: "claude" })).toBe("claude");
    expect(actedAlias({ agent: null })).toBeNull();
    expect(actedAlias({})).toBeNull();
  });
});

const step = (
  name: string,
  kind: RunStep["kind"],
  outcome: RunStep["outcome"],
  source: RunStep["source"] = "project",
) => ({ name, kind, source, group: null, outcome, durationMs: 1, notes: [], log: null }) satisfies RunStep;

const ran: RunOutcome = {
  base: "b".repeat(40),
  config: { kind: "valid" },
  gate: "passed",
  steps: [
    step("_diff", "check", "passed", "platform"),
    step("deps", "setup", "passed"),
    step("test", "check", "passed"),
    step("deploy", "step", "passed"),
  ],
  metrics: {},
};

describe("landingOutcome", () => {
  it("puts `merge` after `_diff` and `land` before the post-gate steps, with what landed", () => {
    const outcome = landingOutcome(ran, { sha: "e".repeat(40) });
    expect(outcome.steps.map((s) => [s.name, s.kind, s.source, s.outcome])).toEqual([
      ["_diff", "check", "platform", "passed"],
      ["merge", "step", "platform", "passed"],
      ["deps", "setup", "project", "passed"],
      ["test", "check", "project", "passed"],
      ["land", "step", "platform", "passed"],
      ["deploy", "step", "project", "passed"],
    ]);
    expect(outcome.landed).toEqual({ sha: "e".repeat(40) });
  });

  it("skips `land` when the gate failed, landing nothing", () => {
    const outcome = landingOutcome({ ...ran, gate: "failed", steps: ran.steps.slice(0, 3) }, null);
    expect(outcome.steps.at(-1)).toMatchObject({
      name: "land",
      outcome: "skipped",
      notes: ["skipped: the gate failed"],
    });
    expect(outcome.landed).toBeUndefined();
  });
});

describe("conflictOutcome", () => {
  it("fails `merge`, skips `land`, and keeps the conflict", () => {
    const details = { attempt: "t1a1", head: "a".repeat(40), main: "m".repeat(40), base: null, files: [] };
    const outcome = conflictOutcome(details);
    expect(outcome).toMatchObject({ gate: "failed", landed: "conflict", conflict: details });
    expect(outcome.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["merge", "failed"],
      ["land", "skipped"],
    ]);
  });
});

const run = (outcome: RunOutcome | null, error: string | null = null) => ({ outcome, error }) as unknown as StoredRun;
const at = "2026-10-14T00:00:00.000Z";

describe("dequeueDetails", () => {
  it("reads a failed gate's failed setups and checks from the run, leaving out what was skipped", () => {
    const failed: RunOutcome = {
      ...ran,
      gate: "failed",
      steps: [
        step("deps", "setup", "passed"),
        step("test", "check", "failed"),
        step("lint", "check", "errored"),
        step("e2e", "check", "skipped"),
        step("land", "step", "skipped", "platform"),
      ],
    };
    expect(dequeueDetails({ reason: "failedChecks", run: 7, at }, run(failed))).toEqual({
      steps: [
        { name: "test", kind: "check", outcome: "failed" },
        { name: "lint", kind: "check", outcome: "errored" },
      ],
    });
  });

  it("reads a conflict, and an error, from the run", () => {
    const details = { attempt: "t1a1", head: "a".repeat(40), main: "m".repeat(40), base: null, files: [] };
    expect(dequeueDetails({ reason: "conflict", run: 7, at }, run(conflictOutcome(details)))).toEqual(details);
    expect(dequeueDetails({ reason: "errored", run: 7, at }, run(null, "land: main moved"))).toEqual({
      error: "land: main moved",
    });
  });

  it("reads what a dequeue from before landings were runs kept", () => {
    const legacy = { checks: [{ name: "test", outcome: "timedOut" as const, log: "test" }] };
    expect(dequeueDetails({ reason: "failedChecks", run: null, at, details: legacy }, null)).toEqual({
      steps: [{ name: "test", kind: "check", outcome: "failed" }],
    });
    expect(dequeueDetails({ reason: "newPush", run: null, at }, null)).toBeNull();
  });
});

describe("the merge commit's identities", () => {
  it("authors it as the approver's user and commits it as Throng", () => {
    expect(mergeAuthor({ ...ada, alias: "claude" })).toEqual({
      name: "ada",
      email: "ada00001+ada@users.noreply.throng",
    });
    expect(THRONG_COMMITTER).toEqual({ name: "Throng", email: "noreply@users.noreply.throng" });
  });
});
