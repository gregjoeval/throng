import { describe, expect, it } from "vitest";
import type { GitGrant, RunGrants } from "../src/grants.ts";
import { HOSTNAME, interceptedHosts, isHttpsOnDefaultPort, outboundDecision, roleAccess } from "../src/network.ts";
import type { NetworkAccess, OutboundAccess } from "../src/network.ts";

const NPM = ["registry.npmjs.org"];
const registry = (path: string) => new URL(`https://registry.npmjs.org${path}`);
const acme = (path: string) => new URL(`https://npm.acme.dev${path}`);
const api = (path: string) => new URL(`https://api.cloudflare.com/client/v4/accounts/acct/workers/${path}`);

describe("isHttpsOnDefaultPort", () => {
  it("is true for HTTPS on the default port only", () => {
    expect(isHttpsOnDefaultPort(new URL("https://npm.acme.dev/x"))).toBeTruthy();
    expect(isHttpsOnDefaultPort(new URL("https://npm.acme.dev:443/x"))).toBeTruthy();
    for (const url of ["http://npm.acme.dev/x", "https://npm.acme.dev:8443/x", "ftp://npm.acme.dev/x"]) {
      expect({ url, ok: isHttpsOnDefaultPort(new URL(url)) }).toEqual({ url, ok: false });
    }
  });
});

describe("HOSTNAME", () => {
  it("takes lowercase DNS names", () => {
    for (const host of ["registry.npmjs.org", "npm.acme.dev", "a-b.c1.example.io"]) {
      expect({ host, ok: HOSTNAME.test(host) }).toEqual({ host, ok: true });
    }
  });

  it("refuses IP literals, a trailing dot, single labels, ports and anything else an intercept can't take", () => {
    for (const host of ["10.0.0.1", "[::1]", "::1", "npm.acme.dev.", "localhost", "npm.acme.dev:8443", "", "-a.dev"]) {
      expect({ host, ok: HOSTNAME.test(host) }).toEqual({ host, ok: false });
    }
  });
});

const fork: GitGrant = {
  remote: "https://acct.artifacts.cloudflare.net/git/ns/demo--a1.git",
  token: "fork-read",
  access: "read",
};
const access = (overrides: Partial<OutboundAccess> = {}): OutboundAccess => ({
  grants: [fork],
  registries: [],
  allow: [],
  ...overrides,
});

describe("outboundDecision", () => {
  it("passes registry reads through unchanged, adding no credentials: metadata and tarballs", () => {
    for (const [method, path] of [
      ["GET", "/is-number"],
      ["GET", "/is-number/-/is-number-7.0.0.tgz"],
      ["HEAD", "/@scope%2fpkg"],
    ] as const) {
      expect(outboundDecision(method, registry(path), access({ registries: NPM }))).toEqual({ action: "pass" });
    }
  });

  it("refuses anything that writes to a registry: publish, unpublish, login", () => {
    for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
      expect(outboundDecision(method, registry("/is-number"), access({ registries: NPM }))).toEqual({
        action: "deny",
      });
    }
  });

  it("refuses the registry to containers without registry access, even if its host is intercepted", () => {
    expect(outboundDecision("GET", registry("/is-number"), access())).toEqual({ action: "deny" });
  });

  it("adds a git grant's token for its repo only", () => {
    const fetchFork = new URL(`${fork.remote}/info/refs?service=git-upload-pack`);
    expect(outboundDecision("GET", fetchFork, access())).toEqual({ action: "bearer", token: "fork-read" });
    expect(outboundDecision("POST", new URL(`${fork.remote}/git-receive-pack`), access())).toEqual({ action: "deny" });
  });

  it("treats the Cloudflare API as any other host: refused unless network.allow lists it, and then unchanged", () => {
    for (const method of ["GET", "PUT", "POST", "DELETE"]) {
      expect(outboundDecision(method, api("scripts/pabc123"), access())).toEqual({ action: "deny" });
      expect(outboundDecision(method, api("scripts/pabc123"), access({ allow: ["api.cloudflare.com"] }))).toEqual({
        action: "pass",
      });
    }
    expect([...interceptedHosts(access())]).not.toContain("api.cloudflare.com");
    expect([...interceptedHosts(access({ allow: ["api.cloudflare.com"] }))]).toContain("api.cloudflare.com");
  });

  it("refuses plain HTTP, other ports and unknown hosts", () => {
    for (const url of [
      "http://registry.npmjs.org/x",
      "https://registry.npmjs.org:8443/x",
      "https://registry.yarnpkg.com/x",
    ]) {
      expect(outboundDecision("GET", new URL(url), access({ registries: NPM }))).toEqual({ action: "deny" });
    }
    expect(outboundDecision("GET", new URL("https://example.com/"), access({ registries: NPM }))).toEqual({
      action: "deny",
    });
  });
});

describe("network.allow", () => {
  const allow = ["api.github.com", "example.com"];

  it("passes any HTTPS request to an allowed host through unchanged, adding no credentials", () => {
    for (const method of ["GET", "POST", "PUT"]) {
      expect(outboundDecision(method, new URL("https://api.github.com/repos/x/y"), access({ allow }))).toEqual({
        action: "pass",
      });
    }
  });

  it("refuses plain HTTP, other ports, subdomains and hosts not listed", () => {
    for (const url of [
      "http://api.github.com/",
      "https://api.github.com:8443/",
      "https://evil.api.github.com/",
      "https://github.com/",
    ]) {
      expect(outboundDecision("GET", new URL(url), access({ allow }))).toEqual({ action: "deny" });
    }
  });

  it("can't widen the registry or a granted repo's host", () => {
    const listed = ["registry.npmjs.org", "acct.artifacts.cloudflare.net"];
    const open = access({ allow: listed, registries: NPM });
    expect(outboundDecision("PUT", registry("/is-number"), open)).toEqual({ action: "deny" });
    const other = new URL("https://acct.artifacts.cloudflare.net/git/ns/other.git/info/refs?service=git-upload-pack");
    expect(outboundDecision("GET", other, open)).toEqual({ action: "deny" });
  });

  it("intercepts the allowed hosts", () => {
    expect([...interceptedHosts(access({ allow, registries: NPM }))].toSorted()).toEqual([
      "acct.artifacts.cloudflare.net",
      "api.github.com",
      "example.com",
      "registry.npmjs.org",
    ]);
  });
});

describe("registries from the origin's .npmrc", () => {
  const registries = ["registry.npmjs.org", "npm.acme.dev"];

  it("passes reads through unchanged, adding no credentials", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(outboundDecision(method, acme("/@acme%2fpkg"), access({ registries }))).toEqual({ action: "pass" });
    }
  });

  it("refuses anything that writes, even when the host is also in network.allow", () => {
    for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
      expect(outboundDecision(method, acme("/@acme%2fpkg"), access({ registries }))).toEqual({ action: "deny" });
      expect(outboundDecision(method, acme("/x"), access({ registries, allow: ["npm.acme.dev"] }))).toEqual({
        action: "deny",
      });
    }
  });

  it("refuses plain HTTP and other ports", () => {
    for (const url of ["http://npm.acme.dev/x", "https://npm.acme.dev:8443/x"]) {
      expect(outboundDecision("GET", new URL(url), access({ registries }))).toEqual({ action: "deny" });
    }
  });

  it("refuses a registry the container wasn't given", () => {
    expect(outboundDecision("GET", acme("/x"), access({ registries: NPM }))).toEqual({ action: "deny" });
  });

  it("can't widen a granted repo's host", () => {
    const open = access({ registries: ["acct.artifacts.cloudflare.net"] });
    const other = new URL("https://acct.artifacts.cloudflare.net/git/ns/other.git/info/refs?service=git-upload-pack");
    expect(outboundDecision("GET", other, open)).toEqual({ action: "deny" });
  });

  it("intercepts every registry", () => {
    expect([...interceptedHosts(access({ registries }))].toSorted()).toEqual([
      "acct.artifacts.cloudflare.net",
      "npm.acme.dev",
      "registry.npmjs.org",
    ]);
  });
});

const repoGrant = (repo: string, level: GitGrant["access"], token: string): GitGrant => ({
  remote: `https://acct.artifacts.cloudflare.net/git/ns/${repo}.git`,
  token,
  access: level,
});
const pushTo = (repo: string) => new URL(`https://acct.artifacts.cloudflare.net/git/ns/${repo}.git/git-receive-pack`);

describe("roleAccess", () => {
  const grants: RunGrants = {
    originRead: repoGrant("p1-main", "read", "origin-read"),
    originWrite: repoGrant("p1-main", "write", "origin-write"),
    forkRead: repoGrant("p1-t1a1", "read", "fork-read"),
    forkWrite: repoGrant("p1-t1a1", "write", "fork-write"),
  };
  it("opens network.allow and the registry only to containers that run repository code", () => {
    const allow = ["api.github.com"];
    expect(roleAccess("pipeline", grants, { allow, registries: [] })).toMatchObject({
      registries: NPM,
      allow,
    });
    expect(roleAccess("land", grants, { allow, registries: [] })).toMatchObject({
      registries: [],
      allow: [],
    });
  });

  it("adds the origin's .npmrc registries to the npm registry, only for containers that run repository code", () => {
    const registries = ["npm.acme.dev", "registry.npmjs.org"];
    for (const role of ["pipeline", "check"] as const) {
      expect({
        role,
        registries: roleAccess(role, grants, { allow: [], registries }).registries,
      }).toEqual({
        role,
        registries: ["registry.npmjs.org", "npm.acme.dev"],
      });
    }
    for (const role of ["land", "follow"] as const) {
      expect({
        role,
        registries: roleAccess(role, grants, { allow: [], registries }).registries,
      }).toEqual({
        role,
        registries: [],
      });
    }
  });

  it("keeps every registry read-only even when network.allow lists it too", () => {
    const network: NetworkAccess = {
      allow: ["npm.acme.dev", "registry.npmjs.org", "api.github.com"],
      registries: ["npm.acme.dev"],
    };
    const given = roleAccess("pipeline", grants, network);
    for (const host of ["npm.acme.dev", "registry.npmjs.org"]) {
      expect({ host, decision: outboundDecision("GET", new URL(`https://${host}/x`), given) }).toEqual({
        host,
        decision: { action: "pass" },
      });
      expect({ host, decision: outboundDecision("PUT", new URL(`https://${host}/x`), given) }).toEqual({
        host,
        decision: { action: "deny" },
      });
    }
    // A host only network.allow lists still takes any method.
    expect(outboundDecision("POST", new URL("https://api.github.com/x"), given)).toEqual({ action: "pass" });
  });

  it("gives a landing's conflict check and retest container read grants on the origin and the fork only", () => {
    const allow = ["api.github.com"];
    const given = roleAccess("check", grants, { allow, registries: [] });
    expect(given).toEqual({ grants: [grants.originRead, grants.forkRead], registries: NPM, allow });
    for (const repo of ["p1-main", "p1-t1a1"]) {
      expect(outboundDecision("POST", pushTo(repo), given)).toEqual({ action: "deny" });
    }
  });

  it("gives a landing's trusted land container origin write and fork read, and nothing else", () => {
    const given = roleAccess("land", grants, { allow: ["api.github.com"], registries: [] });
    expect(given).toEqual({
      grants: [grants.originWrite, grants.forkRead],
      registries: [],
      allow: [],
    });
    expect(outboundDecision("POST", pushTo("p1-main"), given)).toEqual({ action: "bearer", token: "origin-write" });
    expect(outboundDecision("POST", pushTo("p1-t1a1"), given)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", new URL("https://registry.npmjs.org/left-pad"), given)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", new URL("https://api.github.com/"), given)).toEqual({ action: "deny" });
  });

  it("gives a follow's trusted container origin read and fork write, and nothing else", () => {
    const given = roleAccess("follow", grants, { allow: ["api.github.com"], registries: [] });
    expect(given).toEqual({
      grants: [grants.originRead, grants.forkWrite],
      registries: [],
      allow: [],
    });
    expect(outboundDecision("POST", pushTo("p1-t1a1"), given)).toEqual({ action: "bearer", token: "fork-write" });
    expect(outboundDecision("POST", pushTo("p1-main"), given)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", new URL("https://registry.npmjs.org/left-pad"), given)).toEqual({ action: "deny" });
  });
});
