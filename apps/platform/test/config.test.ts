import { describe, expect, it } from "vitest";
import { CONFIG_PATH, DEFAULT_CHECK_TIMEOUT_MS, loadConfig, MAX_CONFIG_BYTES, parseConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { FakeRepos } from "./fake-repos.ts";

const EMPTY: Config = {
  setup: [],
  network: { allow: [] },
  checks: [],
  metrics: [],
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
  - name: bundle
    command: pnpm build && node scripts/size.js
    required: false
    timeout: 90s
metrics:
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
  - { name: bundle_kb, from: bundle.size.files.0.kb, type: number, unit: KB, order: asc }
  - { name: gzip-kb, from: bundle.size.gzip, type: number, order: ascending }
  - { name: score, from: bundle.size.score, type: number, order: desc }
preview:
  command: pnpm build
attempts:
  limit: 4
`;

const check = (fields: string) => `checks:\n  - { name: test, command: pnpm test, ${fields} }\n`;
const metric = (fields: string) => `checks:\n  - { name: test, command: pnpm test }\nmetrics:\n  - { ${fields} }\n`;
const FROM = "from: test.report.total";

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
          },
          {
            name: "bundle",
            command: "pnpm build && node scripts/size.js",
            required: false,
            timeoutMs: 90_000,
          },
        ],
        metrics: [
          { name: "coverage", from: "test.coverage-summary.total.lines.pct", type: "number", unit: "%", order: "desc" },
          { name: "bundle_kb", from: "bundle.size.files.0.kb", type: "number", unit: "KB", order: "asc" },
          { name: "gzip-kb", from: "bundle.size.gzip", type: "number", unit: null, order: "asc" },
          { name: "score", from: "bundle.size.score", type: "number", unit: null, order: "desc" },
        ],
        preview: { command: "pnpm build" },
        attempts: { limit: 4 },
      },
    });
  });

  it("defaults a check to required and a 10m timeout", () => {
    const result = parseConfig("checks:\n  - name: lint\n    command: pnpm lint\n");
    expect(result).toEqual({
      kind: "valid",
      config: {
        ...EMPTY,
        checks: [{ name: "lint", command: "pnpm lint", required: true, timeoutMs: DEFAULT_CHECK_TIMEOUT_MS }],
      },
    });
  });

  it.each([
    ["empty sections", "setup: []\nnetwork: {}\nchecks: []\nmetrics: []\nattempts: {}\n", EMPTY],
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
      metric(`name: x, ${FROM}, type: number, weight: 2`),
      /^metrics\[0\]\.weight: unknown key$/u,
    ],
    ["an unknown preview key", "preview: { url: x }\n", /^preview\.url: unknown key$/u],
    ["an unknown attempts key", "attempts: { max: 2 }\n", /^attempts\.max: unknown key$/u],
    // target
    [
      "a metric target",
      metric(`name: x, ${FROM}, type: number, target: 90`),
      /^metrics\[0\]\.target: target is reserved/u,
    ],
    ["a null metric target", metric(`name: x, ${FROM}, type: number, target:`), /target is reserved/u],
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
    [
      "a check name with a dot",
      "checks: [{ name: a.b, command: x }]\n",
      /^checks\[0\]\.name: check name must not contain a dot; dots separate the parts of a metric's from$/u,
    ],
    [
      "a check name starting with _",
      "checks: [{ name: _diff, command: x }]\n",
      /^checks\[0\]\.name: check name must not start with _, which is reserved for Throng's own checks and metrics$/u,
    ],
    [
      "inline metrics under a check",
      check("metrics: [{ name: coverage, order: desc }]"),
      /^checks\[0\]\.metrics: a check no longer declares metrics; .*top-level metrics list.*from: <check>\.<file>\.<path>.*\$THRONG_OUTPUT/u,
    ],
    ["a non-boolean required", check("required: yes"), /^checks\[0\]\.required: required must be true or false$/u],
    ["a numeric timeout", check("timeout: 600"), /^checks\[0\]\.timeout: /u],
    [
      "a duplicate check name",
      "checks: [{ name: t, command: a }, { name: t, command: b }]\n",
      /^checks\[1\]\.name: duplicate check name t$/u,
    ],
    // metrics
    ["a metric without a type", metric(`name: x, ${FROM}`), /^metrics\[0\]\.type: type is required: number$/u],
    ["an unknown type", metric(`name: x, ${FROM}, type: float`), /^metrics\[0\]\.type: type must be number$/u],
    ["an unknown order", metric(`name: x, ${FROM}, type: number, order: up`), /^metrics\[0\]\.order: order must be/u],
    ["a metric without a name", metric(`${FROM}, type: number`), /^metrics\[0\]\.name: /u],
    [
      "a bad metric name",
      metric(`name: Bundle KB, ${FROM}, type: number`),
      /^metrics\[0\]\.name: metric name must match/u,
    ],
    [
      "a metric name starting with _",
      metric(`name: _size, ${FROM}, type: number`),
      /^metrics\[0\]\.name: metric name must not start with _, which is reserved/u,
    ],
    [
      "a metric name with a dot",
      metric(`name: lines.pct, ${FROM}, type: number`),
      /^metrics\[0\]\.name: metric name must not contain a dot/u,
    ],
    ["a non-string unit", metric(`name: x, ${FROM}, type: number, unit: 1`), /^metrics\[0\]\.unit: /u],
    ["a metric without a from", metric("name: x, type: number"), /^metrics\[0\]\.from: from is required/u],
    [
      "a from without a path",
      metric("name: x, from: test.report, type: number"),
      /^metrics\[0\]\.from: from must be <check>\.<file>\.<path>, like test\.coverage-summary\.total\.lines\.pct$/u,
    ],
    [
      "a from with an empty segment",
      metric("name: x, from: test..total, type: number"),
      /^metrics\[0\]\.from: from must be/u,
    ],
    [
      "a from with a / in its file",
      metric("name: x, from: test.a/b.total, type: number"),
      /^metrics\[0\]\.from: from must be/u,
    ],
    [
      "a from naming an unknown check",
      metric("name: x, from: tests.report.total, type: number"),
      /^metrics\[0\]\.from: no check is named tests$/u,
    ],
    [
      "a duplicate metric name",
      metric(`name: x, ${FROM}, type: number }\n  - { name: x, ${FROM}, type: number`),
      /^metrics\[1\]\.name: duplicate metric name x$/u,
    ],
    [
      "a metric named like a check, whose outcome is a metric of that name",
      metric(`name: test, ${FROM}, type: number`),
      /^metrics\[0\]\.name: metric name test is also a check's name$/u,
    ],
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
    const result = parseConfig(
      "checks:\n  - { name: Bad, command: x }\nmetrics:\n  - { name: m, from: Bad.r.x, target: 1 }\nextra: 1\n",
    );
    expect(result.kind === "invalid" ? result.error.split("\n").toSorted() : []).toEqual([
      "checks[0].name: check name must match ^[a-z0-9][a-z0-9_-]*$",
      "extra: unknown key",
      "metrics[0].target: target is reserved and not supported yet; remove it",
      "metrics[0].type: type is required: number",
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
