import { describe, expect, it } from "vitest";
import { attemptRef, isAttemptRef, parseAttemptRef, parseTaskRef, reservedTask, taskRef } from "../src/task-refs.ts";

describe("task references", () => {
  it("parse t42 and 42 as task 42", () => {
    expect(parseTaskRef("t42")).toBe(42);
    expect(parseTaskRef("42")).toBe(42);
    expect(parseTaskRef("t1")).toBe(1);
  });

  it("reject anything else", () => {
    for (const bad of ["t0", "0", "t", "t042", "042", "t42a3", "T42", " t42", "t42 ", "x42", "-1", "t1.5", "1e3", ""])
      expect(parseTaskRef(bad), bad).toBeNull();
    expect(parseTaskRef("9".repeat(20))).toBeNull();
  });

  it("print as t42", () => {
    expect(taskRef(42)).toBe("t42");
  });
});

describe("attempt references", () => {
  it("parse t42a3 as attempt 3 of task 42", () => {
    expect(parseAttemptRef("t42a3")).toEqual({ task: 42, number: 3 });
    expect(parseAttemptRef("t1a10")).toEqual({ task: 1, number: 10 });
  });

  it("reject task references and malformed ones", () => {
    for (const bad of ["t42", "42", "t42a0", "t0a1", "t42a03", "t42a", "t42b3", "t42a3x", "T42A3", "t42a3/", ""])
      expect(parseAttemptRef(bad), bad).toBeNull();
    expect(parseAttemptRef(`t1a${"9".repeat(20)}`)).toBeNull();
  });

  it("print as t42a3, the canonical form repo names use", () => {
    expect(attemptRef(42, 3)).toBe("t42a3");
    expect(isAttemptRef("t42a3")).toBeTruthy();
    expect(isAttemptRef("42a3")).toBeFalsy();
  });
});

describe("reserved branches", () => {
  it("reserve t<n>/ branches for task t<n>", () => {
    expect(reservedTask("t42/fix-login")).toBe(42);
    expect(reservedTask("t42/")).toBe(42);
    for (const branch of ["t42", "fix/t42", "t0/x", "T42/x", "main"]) expect(reservedTask(branch), branch).toBeNull();
  });
});
