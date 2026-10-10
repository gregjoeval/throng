import { describe, expect, it } from "vitest";
import { forkRepo, originRepo, parseRepoName } from "../src/repos.ts";

describe("repo names", () => {
  it("names a project's origin and its attempt forks after the project id", () => {
    expect(originRepo("k3x9q2")).toBe("k3x9q2-main");
    expect(forkRepo("k3x9q2", "t42a3")).toBe("k3x9q2-t42a3");
  });

  it("parses origin and fork names back", () => {
    expect(parseRepoName("k3x9q2-main")).toEqual({ kind: "origin", project: "k3x9q2" });
    expect(parseRepoName("k3x9q2-t42a3")).toEqual({ kind: "fork", project: "k3x9q2", attempt: "t42a3" });
  });

  it("rejects names that are neither", () => {
    for (const name of [
      "k3x9q2",
      "-main",
      "k3x9q2-",
      "k3x9q2-t42",
      "k3x9q2-a3",
      "k3x9q2-t0a1",
      "k3x9q2--t1a1",
      "K3X-main",
    ]) {
      expect(parseRepoName(name), name).toBeNull();
    }
  });

  it("refuses to build a name that isn't valid", () => {
    expect(() => originRepo("has-dash")).toThrow();
    expect(() => forkRepo("k3x9q2", "a1")).toThrow();
    expect(originRepo("x".repeat(58))).toHaveLength(63);
    expect(() => originRepo("x".repeat(59))).toThrow();
  });
});
