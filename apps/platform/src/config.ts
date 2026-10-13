// A project's `.throng/config.yml`: its setup, checks, metrics, preview, attempt cap and Sandbox size. `parseConfig`
// is pure, so the API's validate endpoint, the attempt cap and scoring all read a config the same
// way. `loadConfig` always reads it from the origin's `main`, so an attempt can't change its own
// checks.

import { parseDocument } from "yaml";
import { z } from "zod";
import { METRIC_FORMATS, METRIC_TYPES, parseFrom } from "./metric-values.ts";
import type { MetricFormat } from "./metric-values.ts";
import { originRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";

export const CONFIG_PATH = ".throng/config.yml";
/** Larger configs are rejected rather than parsed. */
export const MAX_CONFIG_BYTES = 64 * 1024;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_CHECK_TIMEOUT_MS = 30 * 60 * 1000;
/** Check and metric names. A leading `_` is Throng's, and a dot would split a metric's `from`. */
export const CONFIG_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
/** A metric's `from`: `<check>.<file>.<path>`, the file being a name in `$THRONG_OUTPUT` without `.json`. */
const FROM = /^[^.]+\.[^./\\]+(\.[^.]+)+$/u;
/** A metric's stored `order`: `asc` when lower values are better, `desc` when higher are. */
export const METRIC_ORDERS = ["asc", "desc"] as const;
export type MetricOrder = (typeof METRIC_ORDERS)[number];
/** Who defined a check or metric: Throng itself, the project's config, or a task over it. */
export const SOURCES = ["platform", "project", "task"] as const;
export type Source = (typeof SOURCES)[number];
/** The layers a config merges: every source but Throng, whose own checks no config defines. */
export type ConfigLayer = Exclude<Source, "platform">;
export const CONFIG_LAYERS = SOURCES.filter((source): source is ConfigLayer => source !== "platform");

/** Who makes a task's selection: its creator, or a vote among eligible users. */
export const SELECTION_POLICIES = ["creator", "vote"] as const;
/** Who may vote: users acting as themselves, users acting under an alias, or either. */
export const VOTE_ELIGIBILITIES = ["humans", "aliases", "anyone"] as const;
export type VoteEligibility = (typeof VOTE_ELIGIBILITIES)[number];

/**
 * The Sandbox sizes a project may choose for the containers that run its code: the named instance
 * types the container API's `start({ instance })` takes.
 */
export const SANDBOX_SIZES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"] as const;
export type SandboxSize = (typeof SANDBOX_SIZES)[number];
/** The size when a config sets none, or there's no valid config: 4 GiB, 1/2 vCPU. */
export const DEFAULT_SANDBOX_SIZE: SandboxSize = "standard-1";

/** A selection policy: a vote says who is eligible to vote in it. */
export type SelectionPolicy = { policy: "creator" } | { policy: "vote"; eligible: VoteEligibility };

/** The policy a project has when its config sets none: the task's creator selects. */
export const CREATOR_SELECTS: SelectionPolicy = { policy: "creator" };

/** A metric, with the fields its type has. */
export type MetricConfig = {
  name: string;
  /** Where its value is read: `<check>.<file>.<path>`. */
  from: string;
  source: ConfigLayer;
} & (
  | {
      type: "number";
      unit: string | null;
      /** Which way is better: `asc` when lower values are better, `desc` when higher are. */
      order: MetricOrder;
    }
  /** `order` is `desc` when true is better, `asc` when false is. */
  | { type: "boolean"; order: MetricOrder }
  /** Never ranks; `format` says only how it's shown. */
  | { type: "string"; format: MetricFormat | null }
  /** `values` are every value it may take, best first. */
  | { type: "enum"; values: string[] }
);

export interface CheckConfig {
  name: string;
  command: string;
  /** Whether the gate needs it to pass. */
  required: boolean;
  timeoutMs: number;
  source: ConfigLayer;
}

export interface Config {
  /** Commands run once, in order, before the checks. */
  setup: string[];
  /** Extra HTTPS hosts checks may reach, lowercased. */
  network: { allow: string[] };
  /** Run in order. */
  checks: CheckConfig[];
  /** Read from the checks' output files, in order. */
  metrics: MetricConfig[];
  /** Null when the project doesn't deploy previews; `command` is null when it needs no build. */
  preview: { command: string | null } | null;
  /** Null to use the default cap on active attempts per task. */
  attempts: { limit: number | null };
  /** Who makes each task's selection, unless a task overrides it. */
  selection: SelectionPolicy;
  /** The size of the containers that run the repository's code: `score`, `check` and `preview`. */
  sandbox: { size: SandboxSize };
}

export type ConfigResult =
  /** No config file: zero config. */
  | { kind: "none" }
  | { kind: "valid"; config: Config }
  /** One line per problem, each prefixed with its path, e.g. `checks[0].name: …`. */
  | { kind: "invalid"; error: string };

/** The `order` spellings a config may use, and the stored order each one means. */
const ORDER_ALIASES = ["ascending", "asc", "descending", "desc"] as const;
const ORDERS: Record<(typeof ORDER_ALIASES)[number], MetricOrder> = {
  ascending: "asc",
  asc: "asc",
  descending: "desc",
  desc: "desc",
};
const DURATION = /^(\d+)(s|m|h)$/u;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

const name = (what: string) =>
  z.string({ error: `${what} must be a string` }).superRefine((text, ctx) => {
    let message: string | null = null;
    if (text.startsWith("_")) {
      message = `${what} must not start with _, which is reserved for Throng's own checks and metrics`;
    } else if (text.includes(".")) {
      message = `${what} must not contain a dot; dots separate the parts of a metric's from`;
    } else if (!CONFIG_NAME.test(text)) {
      message = `${what} must match ${CONFIG_NAME.source}`;
    }
    if (message !== null) ctx.addIssue({ code: "custom", message });
  });
/** `a`, `a or b`, `a, b or c`. */
const oneOf = (values: readonly string[]) =>
  values.length === 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} or ${values.at(-1) ?? ""}`;
const FROM_FORMAT = "from must be <check>.<file>.<path>, like test.coverage-summary.total.lines.pct";
const command = z.string({ error: "must be a string" }).trim().min(1, "must not be empty");

/**
 * A metric as a config writes it. It stays one flat object rather than a union on `type`, so each
 * field's error names that field; `checkMetricFields` enforces which fields each type has.
 */
export const MetricSchema = z.strictObject({
  name: name("metric name"),
  from: z
    .string({ error: (issue) => (issue.input === undefined ? "from is required: <check>.<file>.<path>" : FROM_FORMAT) })
    .regex(FROM, FROM_FORMAT),
  type: z.enum(METRIC_TYPES, {
    error: (issue) =>
      issue.input === undefined ? `type is required: ${oneOf(METRIC_TYPES)}` : `type must be ${oneOf(METRIC_TYPES)}`,
  }),
  unit: z.string({ error: "unit must be a string" }).optional(),
  order: z.enum(ORDER_ALIASES, { error: "order must be ascending, asc, descending or desc" }).optional(),
  values: z.array(z.string({ error: "must be a string" }), { error: "values must be a list" }).optional(),
  format: z.enum(METRIC_FORMATS, { error: `format must be ${oneOf(METRIC_FORMATS)}` }).optional(),
  target: z.never({ error: "target is reserved and not supported yet; remove it" }).optional(),
});

/** Rejects each field a metric sets that its type doesn't have, and an enum without its values. */
export function checkMetricFields(metric: z.infer<typeof MetricSchema>, at: number, ctx: z.RefinementCtx): void {
  const problem = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path: ["metrics", at, ...path], message });
  if (metric.unit !== undefined && metric.type !== "number") problem(["unit"], "unit is only for a number metric");
  if (metric.format !== undefined && metric.type !== "string")
    problem(["format"], "format is only for a string metric");
  if (metric.order !== undefined && metric.type === "string") problem(["order"], "a string metric has no order");
  if (metric.order !== undefined && metric.type === "enum") {
    problem(["order"], "an enum metric's order is its values, best first");
  }
  if (metric.type !== "enum") {
    if (metric.values !== undefined) problem(["values"], "values are only for an enum metric");
    return;
  }
  if (metric.values === undefined || metric.values.length === 0) {
    problem(["values"], "an enum metric needs its values, best first");
    return;
  }
  const seen = new Set<string>();
  metric.values.forEach((value, i) => {
    if (seen.has(value)) problem(["values", i], `duplicate value ${value}`);
    seen.add(value);
  });
}

/** A layer's checks and metrics, as far as the name rules read them. */
export interface NamedLayer {
  checks: readonly { name: string }[];
  metrics: readonly { name: string; from: string }[];
}

/** A broken name rule, at its path in the layer: `["metrics", 0, "from"]`. */
export interface NameProblem {
  path: (string | number)[];
  message: string;
}

/**
 * Each name rule a layer's checks and metrics break, in order. A check's outcome is a metric named
 * after it, so checks and metrics share one namespace: a name may be used once, and a metric may read
 * only a check that exists. `project` is the config a task's layer goes over: its names are taken,
 * and its checks may be read. It is null for the project's config itself.
 */
export function nameProblems(layer: NamedLayer, project: NamedLayer | null): NameProblem[] {
  const projectChecks = new Set(project?.checks.map((check) => check.name));
  const projectMetrics = new Set(project?.metrics.map((metric) => metric.name));
  const taken = (used: string): string | null => {
    if (projectChecks.has(used)) return `${used} is also a check's name in ${CONFIG_PATH}`;
    if (projectMetrics.has(used)) return `${used} is also a metric's name in ${CONFIG_PATH}`;
    return null;
  };
  const problems: NameProblem[] = [];
  const checks = new Set<string>();
  layer.checks.forEach((check, i) => {
    const message = taken(check.name) ?? (checks.has(check.name) ? `duplicate check name ${check.name}` : null);
    if (message !== null) problems.push({ path: ["checks", i, "name"], message });
    checks.add(check.name);
  });
  const metrics = new Set<string>();
  layer.metrics.forEach((metric, i) => {
    let message = taken(metric.name);
    if (message === null && checks.has(metric.name)) message = `metric name ${metric.name} is also a check's name`;
    else if (message === null && metrics.has(metric.name)) message = `duplicate metric name ${metric.name}`;
    if (message !== null) problems.push({ path: ["metrics", i, "name"], message });
    metrics.add(metric.name);
    const { check } = parseFrom(metric.from);
    if (!checks.has(check) && !projectChecks.has(check)) {
      problems.push({ path: ["metrics", i, "from"], message: `no check is named ${check}` });
    }
  });
  return problems;
}

/**
 * A parsed metric as stored, as the layer `source` defined it, with its type's defaults: a number or
 * boolean is `desc` (higher or true is better).
 */
export function metricConfig(metric: z.infer<typeof MetricSchema>, source: ConfigLayer): MetricConfig {
  const fields = { name: metric.name, from: metric.from, source };
  const order = metric.order === undefined ? "desc" : ORDERS[metric.order];
  switch (metric.type) {
    case "number": {
      return { ...fields, type: "number", unit: metric.unit ?? null, order };
    }
    case "boolean": {
      return { ...fields, type: "boolean", order };
    }
    case "string": {
      return { ...fields, type: "string", format: metric.format ?? null };
    }
    case "enum": {
      return { ...fields, type: "enum", values: metric.values ?? [] };
    }
  }
}

/** A parsed check as stored, as the layer `source` defined it: required, with a 10m timeout, by default. */
export function checkConfig(check: z.infer<typeof CheckSchema>, source: ConfigLayer): CheckConfig {
  return {
    name: check.name,
    command: check.command,
    required: check.required ?? true,
    timeoutMs: check.timeout ?? DEFAULT_CHECK_TIMEOUT_MS,
    source,
  };
}

const TimeoutSchema = z
  .string({ error: "timeout must be a duration like 90s, 10m or 1h" })
  .regex(DURATION, "timeout must be a duration like 90s, 10m or 1h")
  .transform((text) => {
    const [, amount, unit] = DURATION.exec(text) as unknown as [string, string, keyof typeof UNIT_MS];
    return Number(amount) * UNIT_MS[unit];
  })
  .refine((ms) => ms > 0, "timeout must be positive")
  .refine((ms) => ms <= MAX_CHECK_TIMEOUT_MS, "timeout must be at most 30m");

export const CheckSchema = z.strictObject({
  name: name("check name"),
  command,
  required: z.boolean({ error: "required must be true or false" }).optional(),
  timeout: TimeoutSchema.optional(),
  metrics: z
    .never({
      error:
        "a check no longer declares metrics; move each to the top-level metrics list, with " +
        "from: <check>.<file>.<path> naming a JSON file the check writes into $THRONG_OUTPUT, and a type",
    })
    .optional(),
});

/** A selection policy as a config, or a task overriding it, writes it. */
export const SelectionPolicySchema = z
  .strictObject(
    {
      policy: z.enum(SELECTION_POLICIES, {
        error: (issue) =>
          issue.input === undefined
            ? `policy is required: ${oneOf(SELECTION_POLICIES)}`
            : `policy must be ${oneOf(SELECTION_POLICIES)}`,
      }),
      eligible: z.enum(VOTE_ELIGIBILITIES, { error: `eligible must be ${oneOf(VOTE_ELIGIBILITIES)}` }).optional(),
    },
    { error: "selection must be a mapping" },
  )
  .superRefine((selection, ctx) => {
    if (selection.policy !== "vote" && selection.eligible !== undefined) {
      ctx.addIssue({ code: "custom", path: ["eligible"], message: "eligible is only for the vote policy" });
    }
  })
  .transform((selection): SelectionPolicy =>
    selection.policy === "vote" ? { policy: "vote", eligible: selection.eligible ?? "anyone" } : CREATOR_SELECTS,
  );

const ConfigSchema = z
  .strictObject(
    {
      setup: z.array(command, { error: "setup must be a list of commands" }).optional(),
      network: z
        .strictObject({
          allow: z
            .array(
              z
                .string({ error: "must be a string" })
                .toLowerCase()
                .regex(HOST, "must be a hostname, like api.github.com, without a scheme or port"),
              { error: "allow must be a list of hostnames" },
            )
            .optional(),
        })
        .optional(),
      checks: z.array(CheckSchema, { error: "checks must be a list" }).optional(),
      metrics: z.array(MetricSchema, { error: "metrics must be a list" }).optional(),
      preview: z.strictObject({ command: command.optional() }, { error: "preview must be a mapping" }).optional(),
      attempts: z
        .strictObject({
          limit: z
            .number({ error: "limit must be a positive integer" })
            .int("limit must be a positive integer")
            .min(1, "limit must be a positive integer")
            .optional(),
        })
        .optional(),
      selection: SelectionPolicySchema.optional(),
      sandbox: z
        .strictObject(
          { size: z.enum(SANDBOX_SIZES, { error: `size must be ${oneOf(SANDBOX_SIZES)}` }).optional() },
          { error: "sandbox must be a mapping" },
        )
        .optional(),
    },
    { error: "the config must be a mapping" },
  )
  .superRefine((config, ctx) => {
    const layer = { checks: config.checks ?? [], metrics: config.metrics ?? [] };
    for (const problem of nameProblems(layer, null)) ctx.addIssue({ code: "custom", ...problem });
    layer.metrics.forEach((metric, i) => checkMetricFields(metric, i, ctx));
  });

/**
 * Parses a config file's text, or null when there's no file. An empty file is a valid config with
 * every default. YAML errors, schema errors and unknown keys all make it `invalid`.
 */
export function parseConfig(text: string | null): ConfigResult {
  if (text === null) return { kind: "none" };
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return { kind: "invalid", error: `the config is larger than ${MAX_CONFIG_BYTES} bytes` };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { kind: "invalid", error: doc.errors.map((e) => `yaml: ${e.message}`).join("\n") };
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return { kind: "invalid", error: `yaml: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = ConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return { kind: "invalid", error: parsed.error.issues.map(describeIssue).join("\n") };
  }
  const config = parsed.data;
  return {
    kind: "valid",
    config: {
      setup: config.setup ?? [],
      network: { allow: config.network?.allow ?? [] },
      checks: (config.checks ?? []).map((check) => checkConfig(check, "project")),
      metrics: (config.metrics ?? []).map((metric) => metricConfig(metric, "project")),
      preview: config.preview === undefined ? null : { command: config.preview.command ?? null },
      attempts: { limit: config.attempts?.limit ?? null },
      selection: config.selection ?? CREATOR_SELECTS,
      sandbox: { size: config.sandbox?.size ?? DEFAULT_SANDBOX_SIZE },
    },
  };
}

/**
 * The selection policy a task is selected under: its own override, else its project config's. A
 * missing or invalid config leaves it to the task's creator.
 */
export function selectionPolicy(config: ConfigResult, override: SelectionPolicy | null): SelectionPolicy {
  if (override !== null) return override;
  return config.kind === "valid" ? config.config.selection : CREATOR_SELECTS;
}

/** The size of the containers that run the repository's code: the config's, else the default. */
export function sandboxSize(config: ConfigResult): SandboxSize {
  return config.kind === "valid" ? config.config.sandbox.size : DEFAULT_SANDBOX_SIZE;
}

/** The project's config, read from its origin's `main`. */
export async function loadConfig(repos: Repos, projectId: string): Promise<ConfigResult> {
  const file = await repos.readFile(originRepo(projectId), { ref: "main", path: CONFIG_PATH });
  return parseConfig(file === null ? null : await file.text());
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const path = describePath(issue.path);
  // An unknown key's path is its parent's, so name the key itself.
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => (path === "" ? key : `${path}.${key}`));
    return `${keys.join(", ")}: unknown key${keys.length === 1 ? "" : "s"}`;
  }
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** A path into a config as its YAML reads: `checks[0].name`. */
export function describePath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
}
