import { describe, expect, it } from "vitest";
import {
  CONFIG_PATH,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_SANDBOX_SIZE,
  loadConfig,
  MAX_CONFIG_BYTES,
  parseConfig,
  sandboxSize,
} from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { FakeRepos } from "./fake-repos.ts";

const EMPTY: Config = {
  setup: [],
  network: { allow: [] },
  checks: [],
  metrics: [],
  attempts: { limit: null },
  selection: { policy: "creator" },
  sandbox: { size: "standard-1" },
};

const FULL = `
setup:
  - { name: deps, command: pnpm install --frozen-lockfile }
network:
  allow:
    - api.github.com
    - Registry.Example.org
checks:
  - name: test
    command: pnpm test
    timeout: 10m
  - name: bundle
    command: pnpm build && node scripts/size.js
    timeout: 90s
    after: test
metrics:
  - { name: coverage, from: test.coverage-summary.total.lines.pct, type: number, unit: "%" }
  - { name: bundle_kb, from: bundle.size.files.0.kb, type: number, unit: KB, order: asc }
  - { name: gzip-kb, from: bundle.size.gzip, type: number, order: ascending }
  - { name: score, from: bundle.size.score, type: number, order: desc }
  - { name: typed, from: test.report.typed, type: boolean }
  - { name: untyped, from: test.report.untyped, type: boolean, order: asc }
  - { name: grade, from: test.report.grade, type: enum, values: [a, b, c] }
  - { name: summary, from: test.report.summary, type: string }
  - { name: report-url, from: test.report.url, type: string, format: url }
attempts:
  limit: 4
sandbox:
  size: standard-2
`;

/** The error an old `preview:` section gets, whatever it holds. */
const MOVE_PREVIEW =
  /^preview: previews are now a check: move it under `checks`, with `after` naming the checks it waits for$/u;

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

  it("reads every field, normalising orders, timeouts and hosts, and defaulting booleans to true-best", () => {
    expect(parseConfig(FULL)).toEqual({
      kind: "valid",
      config: {
        setup: [{ name: "deps", command: "pnpm install --frozen-lockfile" }],
        network: { allow: ["api.github.com", "registry.example.org"] },
        checks: [
          {
            name: "test",
            command: "pnpm test",
            timeoutMs: 10 * 60_000,
            after: [],
            source: "project",
          },
          {
            name: "bundle",
            command: "pnpm build && node scripts/size.js",
            timeoutMs: 90_000,
            after: ["test"],
            source: "project",
          },
        ],
        metrics: [
          {
            name: "coverage",
            from: "test.coverage-summary.total.lines.pct",
            type: "number",
            unit: "%",
            order: "desc",
            source: "project",
          },
          {
            name: "bundle_kb",
            from: "bundle.size.files.0.kb",
            type: "number",
            unit: "KB",
            order: "asc",
            source: "project",
          },
          { name: "gzip-kb", from: "bundle.size.gzip", type: "number", unit: null, order: "asc", source: "project" },
          { name: "score", from: "bundle.size.score", type: "number", unit: null, order: "desc", source: "project" },
          { name: "typed", from: "test.report.typed", type: "boolean", order: "desc", source: "project" },
          { name: "untyped", from: "test.report.untyped", type: "boolean", order: "asc", source: "project" },
          { name: "grade", from: "test.report.grade", type: "enum", values: ["a", "b", "c"], source: "project" },
          { name: "summary", from: "test.report.summary", type: "string", format: null, source: "project" },
          { name: "report-url", from: "test.report.url", type: "string", format: "url", source: "project" },
        ],
        attempts: { limit: 4 },
        selection: { policy: "creator" },
        sandbox: { size: "standard-2" },
      },
    });
  });

  it.each([
    ["the creator policy", "selection: { policy: creator }\n", { policy: "creator" }],
    ["a vote, anyone eligible by default", "selection: { policy: vote }\n", { policy: "vote", eligible: "anyone" }],
    ["a vote among humans", "selection: { policy: vote, eligible: humans }\n", { policy: "vote", eligible: "humans" }],
    [
      "a vote among aliases",
      "selection: { policy: vote, eligible: aliases }\n",
      { policy: "vote", eligible: "aliases" },
    ],
  ])("reads the selection policy: %s", (_, text, selection) => {
    expect(parseConfig(text)).toEqual({ kind: "valid", config: { ...EMPTY, selection } });
  });

  it.each(["lite", "standard-1", "standard-2", "standard-3", "standard-4"] as const)(
    "reads the sandbox size %s",
    (size) => {
      expect(parseConfig(`sandbox: { size: ${size} }\n`)).toEqual({
        kind: "valid",
        config: { ...EMPTY, sandbox: { size } },
      });
    },
  );

  it.each([
    ["no sandbox", ""],
    ["a sandbox without a size", "sandbox: {}\n"],
  ])("defaults the sandbox size to standard-1 with %s", (_, text) => {
    expect(parseConfig(text)).toMatchObject({ kind: "valid", config: { sandbox: { size: "standard-1" } } });
  });

  it("defaults a check to a 10m timeout", () => {
    const result = parseConfig("checks:\n  - name: lint\n    command: pnpm lint\n");
    expect(result).toEqual({
      kind: "valid",
      config: {
        ...EMPTY,
        checks: [
          {
            name: "lint",
            command: "pnpm lint",
            timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
            after: [],
            source: "project",
          },
        ],
      },
    });
  });

  it.each([["empty sections", "setup: []\nnetwork: {}\nchecks: []\nmetrics: []\nattempts: {}\n", EMPTY]])(
    "accepts %s",
    (_, text, config) => {
      expect(parseConfig(text)).toEqual({ kind: "valid", config });
    },
  );

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
    ["an unknown attempts key", "attempts: { max: 2 }\n", /^attempts\.max: unknown key$/u],
    // target
    [
      "a metric target",
      metric(`name: x, ${FROM}, type: number, target: 90`),
      /^metrics\[0\]\.target: target is reserved/u,
    ],
    ["a null metric target", metric(`name: x, ${FROM}, type: number, target:`), /target is reserved/u],
    ["setup that isn't a list", "setup: pnpm install\n", /^setup: setup must be a list of setups$/u],
    [
      "a setup that's only a command",
      "setup: [pnpm install]\n",
      /^setup\[0\]: a setup must be a mapping with a name and a command, like \{ name: deps, command: npm ci \}$/u,
    ],
    ["a setup without a name", "setup: [{ command: npm ci }]\n", /^setup\[0\]\.name: /u],
    ["a setup without a command", "setup: [{ name: deps }]\n", /^setup\[0\]\.command: /u],
    ["an empty setup command", 'setup: [{ name: deps, command: "" }]\n', /^setup\[0\]\.command: must not be empty$/u],
    ["a non-string setup command", "setup: [{ name: deps, command: 1 }]\n", /^setup\[0\]\.command: must be a string$/u],
    [
      "a setup name starting with _",
      "setup: [{ name: _deps, command: npm ci }]\n",
      /^setup\[0\]\.name: setup name must not start with _/u,
    ],
    [
      "after on a setup",
      "setup: [{ name: deps, command: npm ci, after: gen }]\n",
      /^setup\[0\]\.after: only checks take after; setups run in order$/u,
    ],
    [
      "an unknown setup key",
      "setup: [{ name: deps, command: npm ci, timeout: 2m }]\n",
      /^setup\[0\]\.timeout: unknown key$/u,
    ],
    [
      "a duplicate setup name",
      "setup: [{ name: deps, command: a }, { name: deps, command: b }]\n",
      /^setup\[1\]\.name: duplicate setup name deps$/u,
    ],
    [
      "a check named like a setup",
      "setup: [{ name: deps, command: a }]\nchecks: [{ name: deps, command: b }]\n",
      /^checks\[0\]\.name: check name deps is also a setup's name$/u,
    ],
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
    [
      "required on a check",
      check("required: false"),
      /^checks\[0\]\.required: required is gone: every check that runs must pass; to report without blocking, exit 0 and write a metric$/u,
    ],
    [
      "needs on a check",
      check("needs: [lint]"),
      /^checks\[0\]\.needs: needs is gone: a check names the checks it waits for with after$/u,
    ],
    ["a numeric timeout", check("timeout: 600"), /^checks\[0\]\.timeout: /u],
    // after
    [
      "after naming a setup",
      `setup: [{ name: deps, command: npm ci }]\n${check("after: deps")}`,
      /^checks\[0\]\.after: deps is a setup; every check already waits for every setup, so after only names checks$/u,
    ],
    ["after naming an unknown check", check("after: [smoke]"), /^checks\[0\]\.after: no check is named smoke$/u],
    ["a check waiting for itself", check("after: test"), /^checks\[0\]\.after: a check can't wait for itself$/u],
    [
      "after making a circle",
      "checks:\n  - { name: a, command: x, after: b }\n  - { name: b, command: x, after: [c] }\n  - { name: c, command: x, after: a }\n",
      /^checks\[0\]\.after: after makes a circle: a → b → c → a$/u,
    ],
    [
      "after that isn't a name or a list",
      check("after: { a: 1 }"),
      /^checks\[0\]\.after: after must be a check's name or a list of them$/u,
    ],
    [
      "after listing a non-name",
      check("after: [1]"),
      /^checks\[0\]\.after: after must be a check's name or a list of them$/u,
    ],
    [
      "a duplicate check name",
      "checks: [{ name: t, command: a }, { name: t, command: b }]\n",
      /^checks\[1\]\.name: duplicate check name t$/u,
    ],
    // metrics
    [
      "a metric without a type",
      metric(`name: x, ${FROM}`),
      /^metrics\[0\]\.type: type is required: boolean, number, string or enum$/u,
    ],
    [
      "an unknown type",
      metric(`name: x, ${FROM}, type: float`),
      /^metrics\[0\]\.type: type must be boolean, number, string or enum$/u,
    ],
    [
      "a format on a number",
      metric(`name: x, ${FROM}, type: number, format: url`),
      /^metrics\[0\]\.format: format is only for a string metric$/u,
    ],
    [
      "an unknown format",
      metric(`name: x, ${FROM}, type: string, format: email`),
      /^metrics\[0\]\.format: format must be url$/u,
    ],
    [
      "values on a number",
      metric(`name: x, ${FROM}, type: number, values: [a]`),
      /^metrics\[0\]\.values: values are only for an enum metric$/u,
    ],
    [
      "an enum without values",
      metric(`name: x, ${FROM}, type: enum`),
      /^metrics\[0\]\.values: an enum metric needs its values, best first$/u,
    ],
    [
      "an enum with no values",
      metric(`name: x, ${FROM}, type: enum, values: []`),
      /^metrics\[0\]\.values: an enum metric needs its values, best first$/u,
    ],
    [
      "an enum with a non-string value",
      metric(`name: x, ${FROM}, type: enum, values: [a, 1]`),
      /^metrics\[0\]\.values\[1\]: must be a string$/u,
    ],
    [
      "an enum with a duplicate value",
      metric(`name: x, ${FROM}, type: enum, values: [a, b, a]`),
      /^metrics\[0\]\.values\[2\]: duplicate value a$/u,
    ],
    [
      "an order on a string, which never ranks",
      metric(`name: x, ${FROM}, type: string, order: asc`),
      /^metrics\[0\]\.order: a string metric has no order$/u,
    ],
    [
      "an order on an enum, whose values give its order",
      metric(`name: x, ${FROM}, type: enum, values: [a], order: asc`),
      /^metrics\[0\]\.order: an enum metric's order is its values, best first$/u,
    ],
    [
      "a unit on a boolean",
      metric(`name: x, ${FROM}, type: boolean, unit: KB`),
      /^metrics\[0\]\.unit: unit is only for a number metric$/u,
    ],
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
    ["a preview section", "preview: { command: pnpm build }\n", MOVE_PREVIEW],
    ["an empty preview section", "preview: {}\n", MOVE_PREVIEW],
    ["a preview that isn't a mapping", "preview: pnpm build\n", MOVE_PREVIEW],
    ["a zero limit", "attempts: { limit: 0 }\n", /^attempts\.limit: limit must be a positive integer$/u],
    ["a fractional limit", "attempts: { limit: 1.5 }\n", /^attempts\.limit: limit must be a positive integer$/u],
    ["a string limit", "attempts: { limit: two }\n", /^attempts\.limit: limit must be a positive integer$/u],
    [
      "an unknown sandbox size",
      "sandbox: { size: huge }\n",
      /^sandbox\.size: size must be lite, standard-1, standard-2, standard-3 or standard-4$/u,
    ],
    [
      "a numeric sandbox size",
      "sandbox: { size: 2 }\n",
      /^sandbox\.size: size must be lite, standard-1, standard-2, standard-3 or standard-4$/u,
    ],
    ["custom sandbox resources", "sandbox: { size: { vcpu: 1 } }\n", /^sandbox\.size: size must be lite/u],
    ["a sandbox that isn't a mapping", "sandbox: standard-2\n", /^sandbox: sandbox must be a mapping$/u],
    ["an unknown sandbox key", "sandbox: { memory: 4096 }\n", /^sandbox\.memory: unknown key$/u],
    ["a selection without a policy", "selection: {}\n", /^selection\.policy: policy is required: creator or vote$/u],
    ["an unknown policy", "selection: { policy: judge }\n", /^selection\.policy: policy must be creator or vote$/u],
    [
      "an unknown eligibility",
      "selection: { policy: vote, eligible: bots }\n",
      /^selection\.eligible: eligible must be humans, aliases or anyone$/u,
    ],
    [
      "eligibility without a vote",
      "selection: { policy: creator, eligible: humans }\n",
      /^selection\.eligible: eligible is only for the vote policy$/u,
    ],
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
      "metrics[0].type: type is required: boolean, number, string or enum",
    ]);
  });

  it("reads after as one check or a list of them", () => {
    const result = parseConfig(
      "checks:\n  - { name: a, command: x }\n  - { name: b, command: x, after: a }\n  - { name: c, command: x, after: [a, b] }\n",
    );
    expect(result.kind === "valid" ? result.config.checks.map((c) => c.after) : []).toEqual([[], ["a"], ["a", "b"]]);
  });

  it("rejects a project check waiting for a task's check, which only some attempts have", () => {
    // The project's config never sees a task's checks, so a name only a task defines is unknown to it.
    expect(parseConfig("checks:\n  - { name: test, command: x, after: smoke }\n")).toEqual({
      kind: "invalid",
      error: "checks[0].after: no check is named smoke",
    });
  });

  it("reports a circle once, however many checks lead into it", () => {
    const result = parseConfig(
      "checks:\n  - { name: a, command: x, after: b }\n  - { name: b, command: x, after: a }\n  - { name: c, command: x, after: [a, b] }\n",
    );
    expect(result).toEqual({ kind: "invalid", error: "checks[0].after: after makes a circle: a → b → a" });
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

  it("reuses blocks anchored under definitions, merging mappings with <<, and ignores definitions", () => {
    const text = `definitions:
  quick: &quick { timeout: 2m }
  test: &test pnpm test
checks:
  - { <<: *quick, name: unit, command: *test }
  - <<: *quick
    name: e2e
    command: pnpm e2e
    timeout: 5m
`;
    expect(parseConfig(text)).toEqual({
      kind: "valid",
      config: {
        ...EMPTY,
        checks: [
          { name: "unit", command: "pnpm test", timeoutMs: 120_000, after: [], source: "project" },
          { name: "e2e", command: "pnpm e2e", timeoutMs: 300_000, after: [], source: "project" },
        ],
      },
    });
  });

  it("rejects a merge key that would bring in too many aliases", () => {
    const text = `definitions:
  a: &a { x: 1 }
  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
  c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
  d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
`;
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

  it("reads the config at the commit it's given", async () => {
    const repos = new FakeRepos();
    await repos.create("abc123-main");
    const first = repos.commit("abc123-main", { files: { [CONFIG_PATH]: "attempts: { limit: 2 }\n" } });
    repos.commit("abc123-main", { files: { [CONFIG_PATH]: "attempts: { limit: 3 }\n" } });
    expect(await loadConfig(repos, "abc123", first.hash)).toMatchObject({ config: { attempts: { limit: 2 } } });
    expect(await loadConfig(repos, "abc123")).toMatchObject({ config: { attempts: { limit: 3 } } });
  });
});

describe("sandboxSize", () => {
  it("is main's, whatever an attempt's head sets", async () => {
    const repos = new FakeRepos();
    await repos.create("abc123-main");
    await repos.create("abc123-t1a1");
    repos.writeFile("abc123-main", "main", CONFIG_PATH, "sandbox: { size: standard-2 }\n");
    repos.writeFile("abc123-t1a1", "main", CONFIG_PATH, "sandbox: { size: standard-4 }\n");
    expect(sandboxSize(await loadConfig(repos, "abc123"))).toBe("standard-2");
  });

  it("is the config's size, or the default when there is no valid config", () => {
    expect(sandboxSize(parseConfig("sandbox: { size: standard-3 }\n"))).toBe("standard-3");
    expect(sandboxSize(parseConfig(""))).toBe("standard-1");
    expect(sandboxSize({ kind: "none" })).toBe(DEFAULT_SANDBOX_SIZE);
    expect(sandboxSize({ kind: "invalid", error: "x" })).toBe(DEFAULT_SANDBOX_SIZE);
  });
});
