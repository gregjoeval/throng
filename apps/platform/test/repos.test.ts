import { describe, expect, it } from "vitest";
import { forkRepo, originMainRef, originRepo, parseRepoName, readOriginFile } from "../src/repos.ts";
import { FakeRepos } from "./fake-repos.ts";
import { UnreadableRepos } from "./support/unreadable-repos.ts";

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

/** A project `abc123` with an empty origin and one attempt fork. */
async function setup(): Promise<FakeRepos> {
  const repos = new FakeRepos();
  await repos.create("abc123-main");
  await repos.create("abc123-t1a1");
  return repos;
}

describe("reading the origin's main", () => {
  it("reads a file's text from the origin's main, or null when it isn't there", async () => {
    const repos = await setup();
    repos.commit("abc123-main", { files: { "a.txt": "main\n" } });
    repos.commit("abc123-t1a1", { files: { "a.txt": "attempt\n", "b.txt": "attempt\n" } });
    expect(await readOriginFile(repos, "abc123", "a.txt")).toBe("main\n");
    expect(await readOriginFile(repos, "abc123", "b.txt")).toBeNull();
    expect(repos.calls.filter((c) => c.method === "readFile").map((c) => c.args[0])).toEqual([
      "abc123-main",
      "abc123-main",
    ]);
  });

  it("reads at a pinned commit, so a later push to main doesn't change what the next read sees", async () => {
    const repos = await setup();
    const first = repos.commit("abc123-main", { files: { "a.txt": "one\n", "b.txt": "one\n" } });
    const ref = await originMainRef(repos, "abc123");
    expect(ref).toBe(first.hash);
    expect(await readOriginFile(repos, "abc123", "a.txt", ref)).toBe("one\n");
    repos.commit("abc123-main", { files: { "a.txt": "two\n", "b.txt": "two\n" } });
    expect(await readOriginFile(repos, "abc123", "b.txt", ref)).toBe("one\n");
  });

  it("pins main itself while the origin has no commits, where nothing is there to read", async () => {
    const repos = await setup();
    const ref = await originMainRef(repos, "abc123");
    expect(ref).toBe("main");
    expect(await readOriginFile(repos, "abc123", "a.txt", ref)).toBeNull();
  });

  it("fails when the origin can't be read, rather than reading it as empty", async () => {
    const unreadable = new UnreadableRepos();
    await expect(readOriginFile(unreadable, "abc123", "a.txt")).rejects.toBe(unreadable.error);
    await expect(originMainRef(new FakeRepos(), "abc123")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
