import { describe, expect, it } from "vitest";
import { registryAllows } from "../src/network.ts";

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
