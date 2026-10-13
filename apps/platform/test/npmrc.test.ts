import { describe, expect, it } from "vitest";
import { loadRegistries, NPMRC_PATH, parseRegistries } from "../src/npmrc.ts";
import type { Repos } from "../src/repos.ts";
import { FakeRepos } from "./fake-repos.ts";

describe("parseRegistries", () => {
  it("takes the hostnames of the default and scoped registries", () => {
    const npmrc = [
      "registry=https://npm.example.com/",
      "@acme:registry=https://npm.acme.dev/packages/",
      "@other:registry = https://Registry.Other.io",
    ].join("\n");
    expect(parseRegistries(npmrc)).toEqual(["npm.example.com", "npm.acme.dev", "registry.other.io"]);
  });

  it("keeps only https: URLs on the default port", () => {
    const npmrc = [
      "registry=http://npm.example.com/",
      "@a:registry=https://npm.a.dev:8443/",
      "@b:registry=https://npm.b.dev:443/",
      "@c:registry=ftp://npm.c.dev/",
      "@d:registry=not a url",
      "@e:registry=${NPM_REGISTRY}",
    ].join("\n");
    expect(parseRegistries(npmrc)).toEqual(["npm.b.dev"]);
  });

  it("ignores auth lines, comments and every other setting", () => {
    const npmrc = [
      "//npm.secret.dev/:_authToken=${TOKEN}",
      "//npm.secret.dev/:registry=https://npm.secret.dev/",
      "# registry=https://commented.dev/",
      "; registry=https://also-commented.dev/",
      "always-auth=true",
      "strict-ssl=false",
      "metrics-registry=https://metrics.dev/",
      "registry=https://npm.example.com/",
    ].join("\r\n");
    expect(parseRegistries(npmrc)).toEqual(["npm.example.com"]);
  });

  it("lists each host once", () => {
    expect(parseRegistries("registry=https://a.dev/\n@x:registry=https://a.dev/x/\n")).toEqual(["a.dev"]);
  });

  it("gives nothing for an empty file", () => {
    expect(parseRegistries("")).toEqual([]);
  });
});

describe("loadRegistries", () => {
  const ORIGIN = "abc123-main";
  const FORK = "abc123-t1a1";

  function setup() {
    const repos = new FakeRepos();
    void repos.create(ORIGIN, { defaultBranch: "main" });
    void repos.create(FORK, { defaultBranch: "main" });
    return repos;
  }

  it("reads the .npmrc on the origin's main", async () => {
    const repos = setup();
    repos.commit(ORIGIN, { files: { [NPMRC_PATH]: "@acme:registry=https://npm.acme.dev/\n" } });
    expect(await loadRegistries(repos, "abc123")).toEqual(["npm.acme.dev"]);
  });

  it("never consults an attempt's own .npmrc", async () => {
    const repos = setup();
    repos.commit(ORIGIN, { files: { "README.md": "hi\n" } });
    repos.commit(FORK, { files: { [NPMRC_PATH]: "registry=https://evil.example.com/\n" } });
    repos.writeFile(ORIGIN, "t1a1", NPMRC_PATH, "registry=https://evil.example.com/\n");
    expect(await loadRegistries(repos, "abc123")).toEqual([]);
    expect(repos.calls.filter((c) => c.method === "readFile")).toEqual([
      { method: "readFile", args: [ORIGIN, { ref: "main", path: NPMRC_PATH }] },
    ]);
  });

  it("adds nothing when the origin has no .npmrc", async () => {
    const repos = setup();
    repos.commit(ORIGIN, { files: { "README.md": "hi\n" } });
    expect(await loadRegistries(repos, "abc123")).toEqual([]);
  });

  it("adds nothing, rather than failing, when the .npmrc can't be read", async () => {
    const failing = { readFile: async () => Promise.reject(new Error("artifacts unavailable")) } as unknown as Repos;
    expect(await loadRegistries(failing, "abc123")).toEqual([]);
  });
});
