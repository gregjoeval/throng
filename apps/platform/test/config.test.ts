import { describe, expect, it } from "vitest";
import { CONFIG_PATH, DEFAULT_CHECK_TIMEOUT_MS, loadConfig, MAX_CONFIG_BYTES, parseConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { FakeRepos } from "./fake-repos.ts";

const EMPTY: Config = {
  setup: [],
  network: { allow: [] },
  checks: [],
  preview: null,
  attempts: { limit: null },
};

const FULL = `
setup:
  - pnpm install --frozen-lockfile
network:
  allow:
    - api.github.com
    - Registry.Example.org
checks:
  - name: test
    command: pnpm test
    required: true
    timeout: 10m
    metrics:
      - { name: coverage, unit: "%", order: descending }
  - name: bundle
    command: pnpm build && node scripts/size.js
    required: false
    timeout: 90s
    metrics:
      - { name: bundle_kb, unit: KB, order: asc }
      - { name: gzip-kb, order: ascending }
      - { name: score, order: desc }
preview:
  command: pnpm build
attempts:
  limit: 4
`;

const check = (fields: string) => `checks:\n  - { name: test, command: pnpm test, ${fields} }\n`;
const metric = (fields: string) => check(`metrics: [{ ${fields} }]`);

describe("parseConfig", () => {
  it("is none without a file", () => {
    expect(parseConfig(null)).toEqual({ kind: "none" });
  });

  it.each([
    ["an empty file", ""],
    ["only whitespace", "  \n\n"],
    ["only comments", "# nothing yet\n"],
    ["an empty mapping", "{}"],
  ])("is a valid config with every default for %s", (_, text) => {
    expect(parseConfig(text)).toEqual({ kind: "valid", config: EMPTY });
  });

  it("reads every field, normalising orders, timeouts and hosts", () => {
    expect(parseConfig(FULL)).toEqual({
      kind: "valid",
      config: {
        setup: ["pnpm install --frozen-lockfile"],
        network: { allow: ["api.github.com", "registry.example.org"] },
        checks: [
          {
            name: "test",
            command: "pnpm test",
            required: true,
            timeoutMs: 10 * 60_000,
            metrics: [{ name: "coverage", unit: "%", order: "desc" }],
          },
          {
            name: "bundle",
            command: "pnpm build && node scripts/size.js",
            required: false,
            timeoutMs: 90_000,
            metrics: [
              { name: "bundle_kb", unit: "KB", order: "asc" },
              { name: "gzip-kb", unit: null, order: "asc" },
              { name: "score", unit: null, order: "desc" },
            ],
          },
        ],
        preview: { command: "pnpm build" },
        attempts: { limit: 4 },
      },
    });
  });

  it("defaults a check to required, a 10m timeout and no metrics", () => {
    const result = parseConfig("checks:\n  - name: lint\n    command: pnpm lint\n");
    expect(result).toEqual({
      kind: "valid",
      config: {
        ...EMPTY,
        checks: [
          { name: "lint", command: "pnpm lint", required: true, timeoutMs: DEFAULT_CHECK_TIMEOUT_MS, metrics: [] },
        ],
      },
    });
  });

  it.each([
    ["empty sections", "setup: []\nnetwork: {}\nchecks: []\nattempts: {}\n", EMPTY],
    ["a preview without a command", "preview: {}\n", { ...EMPTY, preview: { command: null } }],
  ])("accepts %s", (_, text, config) => {
    expect(parseConfig(text)).toEqual({ kind: "valid", config });
  });

  it.each([
    ["1s", 1000],
    ["30m", 30 * 60_000],
    ["1800s", 30 * 60_000],
  ])("accepts a check's timeout within bounds: %s", (timeout, ms) => {
    const result = parseConfig(check(`timeout: "${timeout}"`));
    expect(result).toMatchObject({ kind: "valid", config: { checks: [{ timeoutMs: ms }] } });
  });

  it.each(["0h", "31m", "1h", "1801s", "10", "10 m", "10d", "-1m"])(
    "rejects a check's timeout out of bounds or malformed: %s",
    (timeout) => {
      const result = parseConfig(check(`timeout: "${timeout}"`));
      expect(result).toMatchObject({ kind: "invalid", error: expect.stringMatching(/^checks\[0\]\.timeout: /u) });
    },
  );

  it.each([
    // YAML
    ["malformed YAML", "checks: [", /^yaml: /u],
    ["a duplicate YAML key", "setup: []\nsetup: []\n", /^yaml: Map keys must be unique/u],
    ["a scalar document", "just text", /^the config must be a mapping$/u],
    ["a list document", "- a\n", /^the config must be a mapping$/u],
    // unknown keys, at every level
    ["an unknown top-level key", "scoring: {}\n", /^scoring: unknown key$/u],
    ["an unknown network key", "network: { deny: [] }\n", /^network\.deny: unknown key$/u],
    ["an unknown check key", check("image: node"), /^checks\[0\]\.image: unknown key$/u],
    [
      "an unknown metric key",
      metric("name: x, order: asc, weight: 2"),
      /^checks\[0\]\.metrics\[0\]\.weight: unknown key$/u,
    ],
    ["an unknown preview key", "preview: { url: x }\n", /^preview\.url: unknown key$/u],
    ["an unknown attempts key", "attempts: { max: 2 }\n", /^attempts\.max: unknown key$/u],
    // target
    [
      "a metric target",
      metric("name: x, order: asc, target: 90"),
      /^checks\[0\]\.metrics\[0\]\.target: target is reserved/u,
    ],
    ["a null metric target", metric("name: x, order: asc, target:"), /target is reserved/u],
    // setup and network
    ["setup that isn't a list", "setup: pnpm install\n", /^setup: /u],
    ["an empty setup command", 'setup: [""]\n', /^setup\[0\]: must not be empty$/u],
    ["a non-string setup command", "setup: [1]\n", /^setup\[0\]: must be a string$/u],
    [
      "a host with a scheme",
      "network: { allow: [https://api.github.com] }\n",
      /^network\.allow\[0\]: must be a hostname/u,
    ],
    ["a host with a port", 'network: { allow: ["api.github.com:443"] }\n', /^network\.allow\[0\]: must be a hostname/u],
    ["a bare host", "network: { allow: [localhost] }\n", /^network\.allow\[0\]: must be a hostname/u],
    // checks
    ["checks that aren't a list", "checks: { test: pnpm test }\n", /^checks: checks must be a list$/u],
    ["a check without a name", "checks: [{ command: pnpm test }]\n", /^checks\[0\]\.name: /u],
    ["a check without a command", "checks: [{ name: test }]\n", /^checks\[0\]\.command: /u],
    [
      "an empty check command",
      "checks: [{ name: test, command: '  ' }]\n",
      /^checks\[0\]\.command: must not be empty$/u,
    ],
    ["an uppercase check name", "checks: [{ name: Test, command: x }]\n", /^checks\[0\]\.name: check name must match/u],
    ["a check name starting with a dash", "checks: [{ name: -t, command: x }]\n", /^checks\[0\]\.name: /u],
    ["a check name with a dot", "checks: [{ name: a.b, command: x }]\n", /^checks\[0\]\.name: /u],
    ["a non-boolean required", check("required: yes"), /^checks\[0\]\.required: required must be true or false$/u],
    ["a numeric timeout", check("timeout: 600"), /^checks\[0\]\.timeout: /u],
    [
      "a duplicate check name",
      "checks: [{ name: t, command: a }, { name: t, command: b }]\n",
      /^checks\[1\]\.name: duplicate check name t$/u,
    ],
    // metrics
    ["a metric without an order", metric("name: x"), /^checks\[0\]\.metrics\[0\]\.order: order is required/u],
    ["an unknown order", metric("name: x, order: up"), /^checks\[0\]\.metrics\[0\]\.order: order must be/u],
    ["a metric without a name", metric("order: asc"), /^checks\[0\]\.metrics\[0\]\.name: /u],
    [
      "a bad metric name",
      metric("name: Bundle KB, order: asc"),
      /^checks\[0\]\.metrics\[0\]\.name: metric name must match/u,
    ],
    ["a non-string unit", metric("name: x, order: asc, unit: 1"), /^checks\[0\]\.metrics\[0\]\.unit: /u],
    [
      "a duplicate metric name within a check",
      metric("name: x, order: asc }, { name: x, order: desc"),
      /^checks\[0\]\.metrics\[1\]\.name: duplicate metric name x$/u,
    ],
    [
      "a duplicate metric name across checks",
      "checks:\n  - { name: a, command: a, metrics: [{ name: x, order: asc }] }\n" +
        "  - { name: b, command: b, metrics: [{ name: x, order: asc }] }\n",
      /^checks\[1\]\.metrics\[0\]\.name: duplicate metric name x$/u,
    ],
    // preview and attempts
    ["a preview that isn't a mapping", "preview: pnpm build\n", /^preview: preview must be a mapping$/u],
    ["an empty preview command", "preview: { command: '' }\n", /^preview\.command: must not be empty$/u],
    ["a zero limit", "attempts: { limit: 0 }\n", /^attempts\.limit: limit must be a positive integer$/u],
    ["a fractional limit", "attempts: { limit: 1.5 }\n", /^attempts\.limit: limit must be a positive integer$/u],
    ["a string limit", "attempts: { limit: two }\n", /^attempts\.limit: limit must be a positive integer$/u],
  ])("rejects %s", (_, text, error) => {
    const result = parseConfig(text);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" ? result.error : "").toMatch(error);
  });

  it("reports every problem, one per line", () => {
    const result = parseConfig("checks:\n  - { name: Bad, command: x, metrics: [{ name: m, target: 1 }] }\nextra: 1\n");
    expect(result.kind === "invalid" ? result.error.split("\n").toSorted() : []).toEqual([
      "checks[0].metrics[0].order: order is required: ascending, asc, descending or desc",
      "checks[0].metrics[0].target: target is reserved and not supported yet; remove it",
      "checks[0].name: check name must match ^[a-z0-9][a-z0-9_-]*$",
      "extra: unknown key",
    ]);
  });

  it("rejects a config larger than the cap", () => {
    const text = `# ${"x".repeat(MAX_CONFIG_BYTES)}\n`;
    expect(parseConfig(text)).toEqual({
      kind: "invalid",
      error: `the config is larger than ${MAX_CONFIG_BYTES} bytes`,
    });
  });

  it("rejects YAML alias bombs", () => {
    const text =
      'a: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n';
    expect(parseConfig(text)).toMatchObject({ kind: "invalid", error: expect.stringMatching(/^yaml: /u) });
  });
});

describe("loadConfig", () => {
  it("reads the config from the origin's main", async () => {
    const repos = new FakeRepos();
    await repos.create("abc123-main");
    expect(await loadConfig(repos, "abc123")).toEqual({ kind: "none" });
    repos.writeFile("abc123-main", "main", CONFIG_PATH, "attempts: { limit: 2 }\n");
    expect(await loadConfig(repos, "abc123")).toEqual({ kind: "valid", config: { ...EMPTY, attempts: { limit: 2 } } });
    repos.writeFile("abc123-main", "t1", CONFIG_PATH, "nope: 1\n");
    expect(await loadConfig(repos, "abc123")).toMatchObject({ kind: "valid" });
  });
});
