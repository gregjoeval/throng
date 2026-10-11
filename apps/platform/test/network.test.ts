import { describe, expect, it } from "vitest";
import type { GitGrant } from "../src/grants.ts";
import { interceptedHosts, outboundDecision, registryAllows, type OutboundAccess } from "../src/network.ts";

const registry = (path: string) => new URL(`https://registry.npmjs.org${path}`);

describe("registryAllows", () => {
  it("lets installs read package metadata and tarballs", () => {
    expect(registryAllows("GET", registry("/is-number"))).toBe(true);
    expect(registryAllows("GET", registry("/is-number/-/is-number-7.0.0.tgz"))).toBe(true);
    expect(registryAllows("HEAD", registry("/@scope%2fpkg"))).toBe(true);
  });

  it("refuses anything that writes: publish, unpublish, login", () => {
    for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
      expect(registryAllows(method, registry("/is-number"))).toBe(false);
    }
  });

  it("only covers the npm registry, over HTTPS", () => {
    expect(registryAllows("GET", new URL("https://registry.yarnpkg.com/is-number"))).toBe(false);
    expect(registryAllows("GET", new URL("http://registry.npmjs.org/is-number"))).toBe(false);
  });
});

const fork: GitGrant = {
  remote: "https://acct.artifacts.cloudflare.net/git/ns/demo--a1.git",
  token: "fork-read",
  access: "read",
};
const access = (overrides: Partial<OutboundAccess> = {}): OutboundAccess => ({
  grants: [fork],
  preview: null,
  npmRegistry: false,
  allow: [],
  ...overrides,
});

describe("outboundDecision", () => {
  it("passes registry reads through unchanged, adding no credentials", () => {
    expect(outboundDecision("GET", registry("/is-number"), access({ npmRegistry: true }))).toEqual({ action: "pass" });
  });

  it("refuses the registry to containers without registry access, even if its host is intercepted", () => {
    expect(outboundDecision("GET", registry("/is-number"), access())).toEqual({ action: "deny" });
  });

  it("refuses registry writes even with registry access", () => {
    expect(outboundDecision("PUT", registry("/is-number"), access({ npmRegistry: true }))).toEqual({ action: "deny" });
  });

  it("adds a git grant's token for its repo only", () => {
    const fetchFork = new URL(`${fork.remote}/info/refs?service=git-upload-pack`);
    expect(outboundDecision("GET", fetchFork, access())).toEqual({ action: "bearer", token: "fork-read" });
    expect(outboundDecision("POST", new URL(`${fork.remote}/git-receive-pack`), access())).toEqual({ action: "deny" });
  });

  it("uses the Preview token only for the previewed Worker, and only with a Preview grant", () => {
    const script = new URL("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/fixture");
    const preview = { accountId: "acct", workerName: "fixture" };
    expect(outboundDecision("PUT", script, access({ preview }))).toEqual({ action: "preview-token" });
    expect(outboundDecision("PUT", script, access())).toEqual({ action: "deny" });
  });

  it("refuses plain HTTP and unknown hosts", () => {
    expect(outboundDecision("GET", new URL("http://registry.npmjs.org/x"), access({ npmRegistry: true }))).toEqual({
      action: "deny",
    });
    expect(outboundDecision("GET", new URL("https://example.com/"), access({ npmRegistry: true }))).toEqual({
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

  it("can't widen the registry, the Cloudflare API or a granted repo's host", () => {
    const listed = ["registry.npmjs.org", "api.cloudflare.com", "acct.artifacts.cloudflare.net"];
    const open = access({ allow: listed, npmRegistry: true });
    expect(outboundDecision("PUT", registry("/is-number"), open)).toEqual({ action: "deny" });
    const api = new URL("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/fixture");
    expect(outboundDecision("GET", api, open)).toEqual({ action: "deny" });
    const other = new URL("https://acct.artifacts.cloudflare.net/git/ns/other.git/info/refs?service=git-upload-pack");
    expect(outboundDecision("GET", other, open)).toEqual({ action: "deny" });
  });

  it("intercepts the allowed hosts", () => {
    expect([...interceptedHosts(access({ allow, npmRegistry: true }))].toSorted()).toEqual([
      "acct.artifacts.cloudflare.net",
      "api.github.com",
      "example.com",
      "registry.npmjs.org",
    ]);
  });
});
