import { describe, expect, it } from "vitest";
import { grantFor, grantsForRole, RUNS_REPO_CODE, SANDBOX_ROLES } from "../src/grants.ts";
import type { RunGrants } from "../src/grants.ts";

const remote = (repo: string) => `https://acct.artifacts.cloudflare.net/git/ns/${repo}.git`;
const grants: RunGrants = {
  originRead: { remote: remote("demo"), token: "origin-read", access: "read" },
  originWrite: { remote: remote("demo"), token: "origin-write", access: "write" },
  forkRead: { remote: remote("demo--a1"), token: "fork-read", access: "read" },
  forkWrite: { remote: remote("demo--a1"), token: "fork-write", access: "write" },
  lineRead: { remote: remote("demo--a1"), token: "line-read", access: "read" },
};

describe("grantsForRole", () => {
  it("never gives origin write to a role that runs repository code", () => {
    for (const role of SANDBOX_ROLES) {
      const writes = grantsForRole(role, grants).some((g) => g.access === "write");
      expect({ role, writes }).toEqual({ role, writes: writes && !RUNS_REPO_CODE[role] });
    }
    expect(grantsForRole("land", grants).map((g) => g.token)).toEqual(["origin-write", "fork-read"]);
    // A pipeline container reads its line's repo alone: an attempt's fork, or the origin for a task branch or `main`.
    expect(grantsForRole("pipeline", grants).map((g) => g.token)).toEqual(["line-read"]);
    expect(grantsForRole("follow", grants).map((g) => g.token)).toEqual(["origin-read", "fork-write"]);
  });
});

const url = (path: string) => new URL(`https://acct.artifacts.cloudflare.net/git/ns/${path}`);

describe("grantFor", () => {
  it("allows fetches with a read grant", () => {
    const read = [grants.originRead];
    expect(grantFor(read, url("demo.git/info/refs?service=git-upload-pack"))?.token).toBe("origin-read");
    expect(grantFor(read, url("demo.git/git-upload-pack"))?.token).toBe("origin-read");
  });

  it("refuses pushes with a read grant", () => {
    const read = [grants.originRead, grants.forkRead];
    expect(grantFor(read, url("demo.git/info/refs?service=git-receive-pack"))).toBeUndefined();
    expect(grantFor(read, url("demo.git/git-receive-pack"))).toBeUndefined();
    expect(grantFor(read, url("demo--a1.git/git-receive-pack"))).toBeUndefined();
  });

  it("allows pushes with a write grant, and nothing outside the granted repos", () => {
    const write = [grants.originWrite];
    expect(grantFor(write, url("demo.git/git-receive-pack"))?.token).toBe("origin-write");
    expect(grantFor(write, url("other.git/git-upload-pack"))).toBeUndefined();
    expect(grantFor(write, url("demo.gitx/git-upload-pack"))).toBeUndefined();
  });
});
