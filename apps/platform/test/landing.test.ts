import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  actedAlias,
  failedChecks,
  mergeAuthor,
  mergeCommitMessage,
  retestConfig,
  THRONG_COMMITTER,
} from "../src/landing.ts";
import { buildResult } from "../src/results.ts";

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

describe("retestConfig", () => {
  it("skips the retest with no config, or with no checks", () => {
    expect(retestConfig(parseConfig(null))).toBeNull();
    expect(retestConfig(parseConfig("setup: [{ name: deps, command: npm ci }]\n"))).toBeNull();
  });

  it("runs every check, with setup and every metric, as every check that runs must pass", () => {
    const config = parseConfig(
      "setup: [{ name: deps, command: npm ci }]\nchecks:\n  - name: lint\n    command: a\n  - name: test\n    command: b\n" +
        "metrics:\n  - { name: errors, from: lint.out.errors, type: number }\n" +
        "  - { name: tests, from: test.out.tests, type: number }\n",
    );
    const retest = retestConfig(config);
    expect(retest?.kind === "valid" && retest.config.checks.map((c) => c.name)).toEqual(["lint", "test"]);
    expect(retest?.kind === "valid" && retest.config.metrics.map((m) => m.name)).toEqual(["errors", "tests"]);
    expect(retest?.kind === "valid" && retest.config.setup).toEqual([{ name: "deps", command: "npm ci" }]);
  });

  it("retests an invalid config, which fails", () => {
    expect(retestConfig(parseConfig("checks: 3\n"))).toMatchObject({ kind: "invalid" });
  });
});

describe("failedChecks", () => {
  it("names each config check that didn't pass, with its stored log, leaving out Throng's own", () => {
    const config = parseConfig(
      "checks:\n  - name: test\n    command: a\n  - name: build\n    command: b\n  - name: e2e\n    command: c\n",
    );
    const result = buildResult(config, {
      base: null,
      shortstat: "",
      builtinMs: 0,
      setupFailed: null,
      checks: [
        { exit: 0, durationMs: 1, metrics: {} },
        { exit: 2, durationMs: 1, metrics: {} },
        { exit: null, durationMs: 0, metrics: {} },
      ],
    });
    expect(failedChecks(result, ["test", "build"])).toEqual({
      checks: [
        { name: "build", outcome: "failed", log: "build" },
        { name: "e2e", outcome: "skipped", log: null },
      ],
    });
  });

  it("gives an invalid config's error, with no checks", () => {
    const result = buildResult(parseConfig("checks: 3\n"), {
      base: null,
      shortstat: "",
      builtinMs: 0,
      setupFailed: null,
      checks: [],
    });
    expect(failedChecks(result, [])).toEqual({
      checks: [],
      error: expect.stringContaining("checks"),
    });
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
