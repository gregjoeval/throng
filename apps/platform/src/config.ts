// A project's `.throng/config.yml`: its setup, checks, metrics, preview and attempt cap. `parseConfig`
// is pure, so the API's validate endpoint, the attempt cap and scoring all read a config the same
// way. `loadConfig` always reads it from the origin's `main`, so an attempt can't change its own
// checks.

import { parseDocument } from "yaml";
import { z } from "zod";
import { METRIC_TYPES } from "./metric-values.ts";
import type { MetricType } from "./metric-values.ts";
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
/** Who defined a check or metric: the project's config, or a task over it. */
export const CONFIG_LAYERS = ["project", "task"] as const;
export type ConfigLayer = (typeof CONFIG_LAYERS)[number];

export interface MetricConfig {
  name: string;
  /** Where its value is read: `<check>.<file>.<path>`. */
  from: string;
  type: MetricType;
  unit: string | null;
  /** Which way is better: `asc` when lower values are better, `desc` when higher are. */
  order: MetricOrder;
  source: ConfigLayer;
}

export interface CheckConfig {
  name: string;
  command: string;
  /** Whether the gate needs it to pass. */
  required: boolean;
  timeoutMs: number;
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
  target: z.never({ error: "target is reserved and not supported yet; remove it" }).optional(),
});

const TimeoutSchema = z
  .string({ error: "timeout must be a duration like 90s, 10m or 1h" })
  .regex(DURATION, "timeout must be a duration like 90s, 10m or 1h")
  .transform((text) => {
    const [, amount, unit] = DURATION.exec(text) as unknown as [string, string, keyof typeof UNIT_MS];
    return Number(amount) * UNIT_MS[unit];
  })
  .refine((ms) => ms > 0, "timeout must be positive")
  .refine((ms) => ms <= MAX_CHECK_TIMEOUT_MS, "timeout must be at most 30m");

const CheckSchema = z.strictObject({
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
    },
    { error: "the config must be a mapping" },
  )
  .superRefine((config, ctx) => {
    // Each check's outcome is a metric named after it, so checks and metrics share one namespace.
    const checks = new Set<string>();
    config.checks?.forEach((check, i) => {
      if (checks.has(check.name)) {
        ctx.addIssue({ code: "custom", path: ["checks", i, "name"], message: `duplicate check name ${check.name}` });
      }
      checks.add(check.name);
    });
    const metrics = new Set<string>();
    config.metrics?.forEach((metric, i) => {
      const path = ["metrics", i, "name"];
      if (checks.has(metric.name)) {
        ctx.addIssue({ code: "custom", path, message: `metric name ${metric.name} is also a check's name` });
      } else if (metrics.has(metric.name)) {
        ctx.addIssue({ code: "custom", path, message: `duplicate metric name ${metric.name}` });
      }
      metrics.add(metric.name);
      const check = metric.from.split(".")[0] ?? "";
      if (!checks.has(check)) {
        ctx.addIssue({ code: "custom", path: ["metrics", i, "from"], message: `no check is named ${check}` });
      }
    });
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
      checks: (config.checks ?? []).map((check) => ({
        name: check.name,
        command: check.command,
        required: check.required ?? true,
        timeoutMs: check.timeout ?? DEFAULT_CHECK_TIMEOUT_MS,
      })),
      metrics: (config.metrics ?? []).map((metric) => metricConfig(metric, "project")),
      preview: config.preview === undefined ? null : { command: config.preview.command ?? null },
      attempts: { limit: config.attempts?.limit ?? null },
    },
  };
}

/** A metric `MetricSchema` parsed, with its defaults, as the layer `source` defined it. */
export function metricConfig(metric: z.infer<typeof MetricSchema>, source: ConfigLayer): MetricConfig {
  return {
    name: metric.name,
    from: metric.from,
    type: metric.type,
    unit: metric.unit ?? null,
    order: metric.order === undefined ? "desc" : ORDERS[metric.order],
    source,
  };
}

/** The project's config, read from its origin's `main`. */
export async function loadConfig(repos: Repos, projectId: string): Promise<ConfigResult> {
  const file = await repos.readFile(originRepo(projectId), { ref: "main", path: CONFIG_PATH });
  return parseConfig(file === null ? null : await file.text());
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
  // An unknown key's path is its parent's, so name the key itself.
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => (path === "" ? key : `${path}.${key}`));
    return `${keys.join(", ")}: unknown key${keys.length === 1 ? "" : "s"}`;
  }
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}
