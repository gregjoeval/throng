import { describe, expect, it } from "vitest";
import { SANDBOX_ROLES } from "../src/grants.ts";
import type { GitGrant, RunGrants } from "../src/grants.ts";
import {
  HOSTNAME,
  interceptedHosts,
  isHttpsOnDefaultPort,
  NO_NETWORK,
  outboundDecision,
  roleAccess,
} from "../src/network.ts";
import type { NetworkAccess, OutboundAccess } from "../src/network.ts";
import { previewGrant } from "../src/preview.ts";

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
  preview: null,
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

  it("uses the Preview token only for the previewed Worker, and only with a Preview grant", () => {
    const script = new URL("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/fixture");
    const preview = { accountId: "acct", workerName: "fixture" };
    expect(outboundDecision("PUT", script, access({ preview }))).toEqual({ action: "preview-token" });
    expect(outboundDecision("PUT", script, access())).toEqual({ action: "deny" });
  });

  it("refuses every DELETE to the Cloudflare API, even on the previewed Worker", () => {
    const preview = { accountId: "acct", workerName: "pabc123" };
    for (const path of ["scripts/pabc123", "workers/pabc123/previews", "workers/pabc123", "subdomain"]) {
      expect({ path, decision: outboundDecision("DELETE", api(path), access({ preview })) }).toEqual({
        path,
        decision: { action: "deny" },
      });
      for (const method of ["GET", "PUT", "POST"]) {
        expect(outboundDecision(method, api(path), access({ preview }))).toEqual({ action: "preview-token" });
      }
    }
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

  it("can't widen the registry, the Cloudflare API or a granted repo's host", () => {
    const listed = ["registry.npmjs.org", "api.cloudflare.com", "acct.artifacts.cloudflare.net"];
    const open = access({ allow: listed, registries: NPM });
    expect(outboundDecision("PUT", registry("/is-number"), open)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", api("scripts/fixture"), open)).toEqual({ action: "deny" });
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

  it("can't widen the Cloudflare API or a granted repo's host", () => {
    const open = access({ registries: ["api.cloudflare.com", "acct.artifacts.cloudflare.net"] });
    expect(outboundDecision("GET", api("scripts/fixture"), open)).toEqual({ action: "deny" });
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
  const preview = { accountId: "acct", workerName: "fixture" };
  const deploy = new URL("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/fixture");

  it("gives the preview container the Preview deploy grant, a fork read grant and nothing that writes a repo", () => {
    const given = roleAccess("preview", grants, { preview, network: NO_NETWORK });
    expect(given).toEqual({ grants: [grants.forkRead], preview, registries: NPM, allow: [] });
    expect(outboundDecision("PUT", deploy, given)).toEqual({ action: "preview-token" });
    for (const repo of ["p1-main", "p1-t1a1"]) {
      expect(outboundDecision("POST", pushTo(repo), given)).toEqual({ action: "deny" });
    }
  });

  it("lets a project's preview container deploy under its own Worker only, never another project's", () => {
    const given = roleAccess("preview", grants, { preview: previewGrant("acct", "abc123"), network: NO_NETWORK });
    expect(outboundDecision("POST", api("workers/pabc123/previews"), given)).toEqual({ action: "preview-token" });
    for (const path of [
      "workers/pxyz789/previews",
      "scripts/pxyz789",
      "workers/pabc1234/previews",
      "scripts/throng",
      // Creating a Worker is the platform Worker's job, never a container's.
      "workers",
    ]) {
      expect({ path, decision: outboundDecision("POST", api(path), given) }).toEqual({
        path,
        decision: { action: "deny" },
      });
    }
  });

  it("gives the Preview deploy grant to no other container", () => {
    for (const role of SANDBOX_ROLES.filter((r) => r !== "preview")) {
      const given = roleAccess(role, grants, { preview, network: NO_NETWORK });
      expect({ role, preview: given.preview }).toEqual({ role, preview: null });
      expect(outboundDecision("PUT", deploy, given)).toEqual({ action: "deny" });
    }
  });

  it("opens network.allow and the registry only to containers that run repository code", () => {
    const allow = ["api.github.com"];
    expect(roleAccess("score", grants, { preview, network: { allow, registries: [] } })).toMatchObject({
      registries: NPM,
      allow,
    });
    expect(roleAccess("land", grants, { preview, network: { allow, registries: [] } })).toMatchObject({
      registries: [],
      allow: [],
    });
  });

  it("adds the origin's .npmrc registries to the npm registry, only for containers that run repository code", () => {
    const registries = ["npm.acme.dev", "registry.npmjs.org"];
    for (const role of ["score", "preview", "check"] as const) {
      expect({
        role,
        registries: roleAccess(role, grants, { preview, network: { allow: [], registries } }).registries,
      }).toEqual({
        role,
        registries: ["registry.npmjs.org", "npm.acme.dev"],
      });
    }
    for (const role of ["land", "follow"] as const) {
      expect({
        role,
        registries: roleAccess(role, grants, { preview, network: { allow: [], registries } }).registries,
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
    const given = roleAccess("score", grants, { preview, network });
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
    const given = roleAccess("check", grants, { preview, network: { allow, registries: [] } });
    expect(given).toEqual({ grants: [grants.originRead, grants.forkRead], preview: null, registries: NPM, allow });
    for (const repo of ["p1-main", "p1-t1a1"]) {
      expect(outboundDecision("POST", pushTo(repo), given)).toEqual({ action: "deny" });
    }
  });

  it("gives a landing's trusted land container origin write and fork read, and nothing else", () => {
    const given = roleAccess("land", grants, { preview, network: { allow: ["api.github.com"], registries: [] } });
    expect(given).toEqual({
      grants: [grants.originWrite, grants.forkRead],
      preview: null,
      registries: [],
      allow: [],
    });
    expect(outboundDecision("POST", pushTo("p1-main"), given)).toEqual({ action: "bearer", token: "origin-write" });
    expect(outboundDecision("POST", pushTo("p1-t1a1"), given)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", new URL("https://registry.npmjs.org/left-pad"), given)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", new URL("https://api.github.com/"), given)).toEqual({ action: "deny" });
  });

  it("gives a follow's trusted container origin read and fork write, and nothing else", () => {
    const given = roleAccess("follow", grants, { preview, network: { allow: ["api.github.com"], registries: [] } });
    expect(given).toEqual({
      grants: [grants.originRead, grants.forkWrite],
      preview: null,
      registries: [],
      allow: [],
    });
    expect(outboundDecision("POST", pushTo("p1-t1a1"), given)).toEqual({ action: "bearer", token: "fork-write" });
    expect(outboundDecision("POST", pushTo("p1-main"), given)).toEqual({ action: "deny" });
    expect(outboundDecision("GET", new URL("https://registry.npmjs.org/left-pad"), given)).toEqual({ action: "deny" });
  });
});
