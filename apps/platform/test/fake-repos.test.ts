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
    expect(await repos.delete("k3x9q2-main")).toBeTruthy();
    expect(await repos.delete("k3x9q2-main")).toBeFalsy();
    await expect(repos.get("k3x9q2-main")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists repo names by prefix", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    await repos.fork("k3x9q2-main", "k3x9q2-t1a1");
    await repos.create("p7m4r1-main");
    expect(await repos.list("k3x9q2")).toEqual(["k3x9q2-main", "k3x9q2-t1a1"]);
    expect(await repos.list("")).toEqual(["k3x9q2-main", "k3x9q2-t1a1", "p7m4r1-main"]);
    expect(await repos.list("zzz")).toEqual([]);
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

  it("starts with no git content", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    expect(await repos.readFile("k3x9q2-main", { ref: "main", path: "README.md" })).toBeNull();
    expect(await repos.listCommits("k3x9q2-main", { ref: "main", limit: 1 })).toEqual([]);
    expect(await repos.readCommit("k3x9q2-main", "0".repeat(40))).toBeNull();
    await expect(repos.readTree("k3x9q2-main", "main")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("commits snapshots with git's object ids and reads them back", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    const first = repos.commit("k3x9q2-main", { files: { "README.md": "hello\n" }, message: "first" });
    const second = repos.commit("k3x9q2-main", {
      files: { "README.md": "hello\n", "src/a.ts": "a\n", "bin/run": { content: "#!/bin/sh\n", type: "exec" } },
    });

    // `printf 'hello\n' | git hash-object --stdin`
    const [readme] = (await repos.readTree("k3x9q2-main", first.treeHash)) ?? [];
    expect(readme).toEqual({
      name: "README.md",
      mode: "100644",
      hash: "ce013625030ba8dba906f756967f9e9ca394464a",
      type: "blob",
    });
    expect(second.parents).toEqual([first.hash]);
    const root = (await repos.readTree("k3x9q2-main", second.treeHash)) ?? [];
    expect(root.map((e) => [e.name, e.type, e.mode])).toEqual([
      ["README.md", "blob", "100644"],
      ["bin", "tree", "40000"],
      ["src", "tree", "40000"],
    ]);
    expect(await (await repos.readBlob("k3x9q2-main", readme!.hash))?.text()).toBe("hello\n");
    expect(await (await repos.readFile("k3x9q2-main", { ref: "main", path: "src/a.ts" }))?.text()).toBe("a\n");
    expect(await repos.readCommit("k3x9q2-main", first.hash)).toEqual(first);

    const log = await repos.listCommits("k3x9q2-main", { ref: "main", limit: 10 });
    expect(log.map((c) => c.hash)).toEqual([second.hash, first.hash]);
    expect(await repos.listCommits("k3x9q2-main", { ref: second.hash, limit: 1, offset: 1 })).toEqual([first]);
  });

  it("forks a repo's history and pushes refs between repos", async () => {
    const repos = new FakeRepos();
    await repos.create("k3x9q2-main");
    const base = repos.commit("k3x9q2-main", { files: { a: "1" } });
    await repos.fork("k3x9q2-main", "k3x9q2-t1a1");
    const work = repos.commit("k3x9q2-t1a1", { files: { a: "2" } });
    expect(await repos.readCommit("k3x9q2-main", work.hash)).toBeNull();
    expect(work.parents).toEqual([base.hash]);

    repos.push("k3x9q2-t1a1", "k3x9q2-main", "refs/attempts/t1a1", work.hash);
    const [archived] = await repos.listCommits("k3x9q2-main", { ref: "refs/attempts/t1a1", limit: 1 });
    expect(archived?.hash).toBe(work.hash);
  });
});
