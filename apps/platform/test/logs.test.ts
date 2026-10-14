import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLogName,
  landingLogKey,
  legacyLogKey,
  logKey,
  logNames,
  MAX_LOG_BYTES,
  MISSING_LOG_EXIT,
  readLogScript,
  setupLogName,
  withNotes,
} from "../src/logs.ts";

const SHA = "c".repeat(40);

describe("logKey", () => {
  it("lays a run's log out under the project, line and run", () => {
    const run = { project: "p123", line: "t42a3", run: 7 };
    expect(logKey(run, "test")).toBe("logs/p123/t42a3/7/test.log");
    expect(logKey(run, setupLogName(2))).toBe("logs/p123/t42a3/7/setup.2.log");
  });
});

describe("legacyLogKey", () => {
  it("lays a log out where runs stored it before they were keyed on their line: under the head too", () => {
    const run = { project: "p123", line: "t42a3", sha: SHA, run: 7 };
    expect(legacyLogKey(run, "test")).toBe(`logs/p123/t42a3/${SHA}/7/test.log`);
  });
});

describe("landingLogKey", () => {
  it("lays a landing's retest logs out under the approved head, apart from its scoring runs", () => {
    const landing = { project: "p123", task: 42, attempt: 3, head: SHA, landing: 5 };
    expect(landingLogKey(landing, "test")).toBe(`logs/p123/t42a3/${SHA}/landing-5/test.log`);
  });
});

describe("log names", () => {
  it("names each setup step and check of a plan, in run order", () => {
    const plan = { setup: ["npm ci", "npm run gen"], checks: [{ name: "test" }, { name: "setup-1" }] };
    expect(logNames(plan)).toEqual(["setup.1", "setup.2", "test", "setup-1"]);
  });

  it("can't collide: setup logs use a dot, which check names can't", () => {
    for (const name of [setupLogName(1), "test", "bundle_kb", "a-b"]) expect(isLogName(name)).toBeTruthy();
    for (const name of ["", "../x", "a/b", ".hidden", "Test", "a b"]) expect(isLogName(name)).toBeFalsy();
  });
});

/** Runs `readLogScript` in a fresh directory holding `logs/<name>.log` files, as the Sandbox's workspace would. */
function read(files: Record<string, string>, name: string, maxBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "throng-logs-"));
  mkdirSync(join(dir, "logs"));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, "logs", `${file}.log`), content);
  const script = maxBytes === undefined ? readLogScript(name) : readLogScript(name, maxBytes);
  const run = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", maxBuffer: 2 * MAX_LOG_BYTES });
  rmSync(dir, { recursive: true, force: true });
  return { exit: run.status, stdout: run.stdout };
}

describe("readLogScript", () => {
  it("prints a log that fits as it is", () => {
    expect(read({ test: "ok\nall 3 passed\n" }, "test")).toEqual({ exit: 0, stdout: "ok\nall 3 passed\n" });
    expect(read({ "setup.1": "" }, "setup.1")).toEqual({ exit: 0, stdout: "" });
  });

  it("exits MISSING_LOG_EXIT with nothing printed when the step wrote no log", () => {
    expect(read({ test: "x" }, "bundle")).toEqual({ exit: MISSING_LOG_EXIT, stdout: "" });
  });

  it("keeps the head and tail of a log over the limit, with a marker between them", () => {
    const log = "a".repeat(600) + "b".repeat(600);
    const { exit, stdout } = read({ test: log }, "test", 1000);
    expect(exit).toBe(0);
    expect(stdout).toBe("a".repeat(400) + "\n[throng: truncated 400 of 1200 bytes]\n" + "b".repeat(400));
  });

  it("stores at most 5 MB of a larger log", () => {
    const log = "h".repeat(MAX_LOG_BYTES) + "t".repeat(MAX_LOG_BYTES);
    const { stdout } = read({ test: log }, "test");
    expect(stdout.length).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(stdout.length).toBeGreaterThan(MAX_LOG_BYTES - 1024);
    expect(stdout).toMatch(/^h+\n\[throng: truncated \d+ of 10485760 bytes\]\nt+$/u);
  });
});

describe("withNotes", () => {
  it("appends a check's notes to its log under a throng trailer", () => {
    expect(withNotes("ok\n", ["ignored metric coverage: not a number", "metric bundle_kb was not reported"])).toBe(
      "ok\n== throng ==\nignored metric coverage: not a number\nmetric bundle_kb was not reported\n",
    );
  });

  it("starts the trailer on its own line when the log doesn't end in a newline", () => {
    expect(withNotes("ok", ["skipped: setup command 1 failed"])).toBe(
      "ok\n== throng ==\nskipped: setup command 1 failed\n",
    );
  });

  it("gives a check that wrote no log one holding just its notes", () => {
    expect(withNotes(null, ["skipped: setup command 1 failed"])).toBe(
      "== throng ==\nskipped: setup command 1 failed\n",
    );
  });

  it("leaves a log without notes as it is, and stores nothing for a missing one", () => {
    expect(withNotes("ok\n", [])).toBe("ok\n");
    expect(withNotes("", [])).toBe("");
    expect(withNotes(null, [])).toBeNull();
  });
});
