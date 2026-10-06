import { describe, expect, it } from "vitest";
import {
  CHECK_ROLES,
  grantFor,
  grantsForRole,
  roleGetsPreview,
  RUNS_REPO_CODE,
  type CheckGrants,
} from "../src/grants.ts";

const remote = (repo: string) => `https://acct.artifacts.cloudflare.net/git/ns/${repo}.git`;
const grants: CheckGrants = {
  canonicalRead: { remote: remote("demo"), token: "canonical-read", access: "read" },
  canonicalWrite: { remote: remote("demo"), token: "canonical-write", access: "write" },
  forkRead: { remote: remote("demo--a1"), token: "fork-read", access: "read" },
};

describe("grantsForRole", () => {
  it("never gives canonical write to a role that runs repository code", () => {
    for (const role of CHECK_ROLES) {
      const writes = grantsForRole(role, grants).some((g) => g.access === "write");
      expect({ role, writes }).toEqual({ role, writes: writes && !RUNS_REPO_CODE[role] });
    }
    expect(grantsForRole("land", grants).map((g) => g.token)).toEqual(["canonical-write", "fork-read"]);
  });

  it("gives the Preview grant only to the preview role", () => {
    expect(CHECK_ROLES.filter(roleGetsPreview)).toEqual(["preview"]);
  });
});

const url = (path: string) => new URL(`https://acct.artifacts.cloudflare.net/git/ns/${path}`);

describe("grantFor", () => {
  it("allows fetches with a read grant", () => {
    const read = [grants.canonicalRead];
    expect(grantFor(read, url("demo.git/info/refs?service=git-upload-pack"))?.token).toBe("canonical-read");
    expect(grantFor(read, url("demo.git/git-upload-pack"))?.token).toBe("canonical-read");
  });

  it("refuses pushes with a read grant", () => {
    const read = [grants.canonicalRead, grants.forkRead];
    expect(grantFor(read, url("demo.git/info/refs?service=git-receive-pack"))).toBeUndefined();
    expect(grantFor(read, url("demo.git/git-receive-pack"))).toBeUndefined();
    expect(grantFor(read, url("demo--a1.git/git-receive-pack"))).toBeUndefined();
  });

  it("allows pushes with a write grant, and nothing outside the granted repos", () => {
    const write = [grants.canonicalWrite];
    expect(grantFor(write, url("demo.git/git-receive-pack"))?.token).toBe("canonical-write");
    expect(grantFor(write, url("other.git/git-upload-pack"))).toBeUndefined();
    expect(grantFor(write, url("demo.gitx/git-upload-pack"))).toBeUndefined();
  });
});
