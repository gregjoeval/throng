import { describe, expect, it } from "vitest";
import { FakeRepos } from "./fake-repos.ts";

describe("FakeRepos", () => {
  it("creates an origin and forks it for an attempt", async () => {
    const repos = new FakeRepos();
    const origin = await repos.create("k3x9q2-main");
    expect(origin).toMatchObject({ name: "k3x9q2-main", defaultBranch: "main", parent: null });
    expect(origin.token).not.toBe("");

    await repos.fork("k3x9q2-main", "k3x9q2-t1a1");
    expect(await repos.get("k3x9q2-t1a1")).toMatchObject({
      name: "k3x9q2-t1a1",
      defaultBranch: "main",
      parent: "k3x9q2-main",
    });
    expect(repos.calls.map((c) => c.method)).toEqual(["create", "fork", "get"]);
  });

  it("throws NOT_FOUND for a missing repo and ALREADY_EXISTS for a taken name", async () => {
    const repos = new FakeRepos();
    await expect(repos.get("k3x9q2-main")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repos.fork("k3x9q2-main", "k3x9q2-t1a1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await repos.create("k3x9q2-main");
    await expect(repos.create("k3x9q2-main")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await repos.fork("k3x9q2-main", "k3x9q2-t1a1");
    await expect(repos.fork("k3x9q2-main", "k3x9q2-t1a1")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("deletes a repo once", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    expect(await repos.delete("k3x9q2-main")).toBe(true);
    expect(await repos.delete("k3x9q2-main")).toBe(false);
    await expect(repos.get("k3x9q2-main")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("mints distinct tokens and remembers them per repo", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    const read = await repos.mintToken("k3x9q2-main", "read", 60);
    const write = await repos.mintToken("k3x9q2-main", "write", 60);
    expect(read.scope).toBe("read");
    expect(read.token).not.toBe(write.token);
    expect(Date.parse(read.expiresAt)).toBeGreaterThan(Date.now());
    expect(repos.tokens("k3x9q2-main").map((t) => t.scope)).toEqual(["write", "read", "write"]);
    await expect(repos.mintToken("k3x9q2-t1a1", "read", 60)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("has no git content", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    expect(await repos.readFile("k3x9q2-main", { ref: "main", path: "README.md" })).toBeNull();
    expect(await repos.listCommits("k3x9q2-main", { ref: "main", limit: 1 })).toEqual([]);
    expect(await repos.readTree("k3x9q2-main", { ref: "main", path: "" })).toBeNull();
  });
});
