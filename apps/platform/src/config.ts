// A project's `.throng/config.yml`: its setup, checks, metrics, preview and attempt cap. `parseConfig`
// is pure, so the API's validate endpoint, the attempt cap and scoring all read a config the same
// way. `loadConfig` always reads it from the origin's `main`, so an attempt can't change its own
// checks.

import { parseDocument } from "yaml";
import { z } from "zod";
import { originRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";

export const CONFIG_PATH = ".throng/config.yml";
/** Larger configs are rejected rather than parsed. */
export const MAX_CONFIG_BYTES = 64 * 1024;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_CHECK_TIMEOUT_MS = 30 * 60 * 1000;
/** Check and metric names. */
export const CONFIG_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface MetricConfig {
  name: string;
  unit: string | null;
  /** Which way is better: `asc` when lower values are better, `desc` when higher are. */
  order: "asc" | "desc";
}

export interface CheckConfig {
  name: string;
  command: string;
  /** Whether the gate needs it to pass. */
  required: boolean;
  timeoutMs: number;
  metrics: MetricConfig[];
}

export interface Config {
  /** Commands run once, in order, before the checks. */
  setup: string[];
  /** Extra HTTPS hosts checks may reach, lowercased. */
  network: { allow: string[] };
  /** Run in order. */
  checks: CheckConfig[];
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

const ORDERS = { ascending: "asc", asc: "asc", descending: "desc", desc: "desc" } as const;
const DURATION = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const name = (what: string) =>
  z.string({ error: `${what} must be a string` }).regex(CONFIG_NAME, `${what} must match ${CONFIG_NAME.source}`);
const command = z.string({ error: "must be a string" }).trim().min(1, "must not be empty");

const MetricSchema = z.strictObject({
  name: name("metric name"),
  unit: z.string({ error: "unit must be a string" }).optional(),
  order: z.enum(Object.keys(ORDERS) as [keyof typeof ORDERS], {
    error: (issue) =>
      issue.input === undefined
        ? "order is required: ascending, asc, descending or desc"
        : "order must be ascending, asc, descending or desc",
  }),
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
  metrics: z.array(MetricSchema, { error: "metrics must be a list" }).optional(),
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
    const checks = new Set<string>();
    const metrics = new Set<string>();
    config.checks?.forEach((check, i) => {
      if (checks.has(check.name)) {
        ctx.addIssue({ code: "custom", path: ["checks", i, "name"], message: `duplicate check name ${check.name}` });
      }
      checks.add(check.name);
      check.metrics?.forEach((metric, j) => {
        if (metrics.has(metric.name)) {
          const path = ["checks", i, "metrics", j, "name"];
          ctx.addIssue({ code: "custom", path, message: `duplicate metric name ${metric.name}` });
        }
        metrics.add(metric.name);
      });
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
  } catch (cause) {
    return { kind: "invalid", error: `yaml: ${cause instanceof Error ? cause.message : String(cause)}` };
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
        metrics: (check.metrics ?? []).map((metric) => ({
          name: metric.name,
          unit: metric.unit ?? null,
          order: ORDERS[metric.order],
        })),
      })),
      preview: config.preview === undefined ? null : { command: config.preview.command ?? null },
      attempts: { limit: config.attempts?.limit ?? null },
    },
  };
}

/** The project's config, read from its origin's `main`. */
export async function loadConfig(repos: Repos, projectId: string): Promise<ConfigResult> {
  const file = await repos.readFile(originRepo(projectId), { ref: "main", path: CONFIG_PATH });
  return parseConfig(file === null ? null : await file.text());
}

function describeIssue(issue: z.core.$ZodIssue): string {
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
