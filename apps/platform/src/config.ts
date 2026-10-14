// A project's `.throng/config.yml`: its setups, checks, metrics, attempt cap and Sandbox size. `parseConfig`
// is pure, so the API's validate endpoint, the attempt cap and scoring all read a config the same
// way. `loadConfig` always reads it from the origin's `main`, so an attempt can't change its own
// checks.

import { parseDocument } from "yaml";
import { z } from "zod";
import { METRIC_FORMATS, METRIC_TYPES, parseFrom } from "./metric-values.ts";
import type { MetricFormat } from "./metric-values.ts";
import { HOSTNAME } from "./network.ts";
import { PIPELINES } from "./pipelines.ts";
import type { Pipeline } from "./pipelines.ts";
import { readOriginFile } from "./repos.ts";
import type { Repos } from "./repos.ts";
import { secretNameError } from "./secrets.ts";

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
/** What each Sandbox size gets, as Cloudflare's container limits give it. */
export const SANDBOX_RESOURCES: Record<SandboxSize, { memory: string; vcpu: string }> = {
  lite: { memory: "256 MiB", vcpu: "1/16" },
  "standard-1": { memory: "4 GiB", vcpu: "1/2" },
  "standard-2": { memory: "6 GiB", vcpu: "1" },
  "standard-3": { memory: "8 GiB", vcpu: "2" },
  "standard-4": { memory: "12 GiB", vcpu: "4" },
};
/** The size when a config sets none, or there's no valid config (see `SANDBOX_RESOURCES`). */
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

/** A setup: a named command run before every check, in order with the others. */
export interface SetupConfig {
  name: string;
  command: string;
  /** The secrets it uses, by name: in a trusted run, the setup container holds them. */
  secrets: string[];
}

export interface CheckConfig {
  name: string;
  command: string;
  timeoutMs: number;
  /** The checks it waits for: it runs only once each of them passed. */
  after: string[];
  /** The secrets it uses, by name: in a trusted run, its container holds them. A task's check names none. */
  secrets: string[];
  /** The one group it is in, which a pipeline may choose it by; null outside one, and always for a task's check. */
  group: string | null;
  source: ConfigLayer;
}

/** A post-gate step: a named command `main` runs once the gate passes, in order with the others. */
export interface StepConfig {
  name: string;
  command: string;
}

/** What one pipeline runs besides the setups: which checks, and the post-gate steps after its gate. */
export interface PipelineConfig {
  /** The groups whose checks it runs; null to run every check. A task's checks always run on its attempts. */
  groups: string[] | null;
  /** Run in order once the gate passes, stopping at the first that fails. Only `main` has any. */
  steps: StepConfig[];
}

export interface Config {
  /** Run once, in order, before the checks; a failed one stops the run. */
  setup: SetupConfig[];
  /** Extra HTTPS hosts checks may reach, lowercased. */
  network: { allow: string[] };
  /** Run in parallel once the setups passed, each once the checks it waits for passed. */
  checks: CheckConfig[];
  /** Read from the checks' output files, in order. */
  metrics: MetricConfig[];
  /** Null to use the default cap on active attempts per task. */
  attempts: { limit: number | null };
  /** Who makes each task's selection, unless a task overrides it. */
  selection: SelectionPolicy;
  /** The size of the containers that run the repository's code: setups, checks and retests. */
  sandbox: { size: SandboxSize };
  /** What each pipeline runs: `main` on `main`, `default` on every other line. */
  pipelines: Record<Pipeline, PipelineConfig>;
}

/** A pipeline a config leaves out: it runs every check, and nothing after its gate. */
export const EVERY_CHECK: PipelineConfig = { groups: null, steps: [] };

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
/** Most aliases a config may resolve, so a few anchors can't expand into a huge document. */
const MAX_ALIASES = 100;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const;

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
export const oneOf = (values: readonly string[]) =>
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

/** Where `main`'s post-gate steps are in a config. */
const MAIN_STEPS = ["pipelines", "main", "steps"] as const;

/** A layer's setups, checks and metrics, as far as the name rules read them. A task's layer has no setups. */
export interface NamedLayer {
  setup?: readonly { name: string }[];
  checks: readonly { name: string; after: readonly string[] }[];
  metrics: readonly { name: string; from: string }[];
  /** `main`'s post-gate steps; a task's layer has none. */
  steps?: readonly { name: string }[];
}

/** A broken name rule, at its path in the layer: `["metrics", 0, "from"]`. */
export interface NameProblem {
  path: (string | number)[];
  message: string;
}

/**
 * Each name rule a layer's setups, checks, post-gate steps and metrics break, in order. Setups, checks
 * and steps share one namespace, and so do checks and metrics, as a check's outcome is a metric named
 * after it: a name may
 * be used once, and a metric may read only a check that exists. A check's `after` names only checks,
 * never itself, a setup (every check already waits for every setup) or a circle. `project` is the
 * config a task's layer goes over: its names are taken, and its checks may be read and waited for. It
 * is null for the project's config itself, whose checks can't name a task's.
 */
export function nameProblems(layer: NamedLayer, project: NamedLayer | null): NameProblem[] {
  const projectSetups = new Set(project?.setup?.map((setup) => setup.name));
  const projectChecks = new Set(project?.checks.map((check) => check.name));
  const projectMetrics = new Set(project?.metrics.map((metric) => metric.name));
  const projectSteps = new Set(project?.steps?.map((step) => step.name));
  const taken = (used: string): string | null => {
    if (projectSetups.has(used)) return `${used} is also a setup's name in ${CONFIG_PATH}`;
    if (projectChecks.has(used)) return `${used} is also a check's name in ${CONFIG_PATH}`;
    if (projectSteps.has(used)) return `${used} is also a post-gate step's name in ${CONFIG_PATH}`;
    if (projectMetrics.has(used)) return `${used} is also a metric's name in ${CONFIG_PATH}`;
    return null;
  };
  const problems: NameProblem[] = [];
  const setups = new Set<string>();
  layer.setup?.forEach((setup, i) => {
    if (setups.has(setup.name))
      problems.push({ path: ["setup", i, "name"], message: `duplicate setup name ${setup.name}` });
    setups.add(setup.name);
  });
  const checks = new Set<string>();
  layer.checks.forEach((check, i) => {
    let message = taken(check.name);
    if (message === null && setups.has(check.name)) message = `check name ${check.name} is also a setup's name`;
    else if (message === null && checks.has(check.name)) message = `duplicate check name ${check.name}`;
    if (message !== null) problems.push({ path: ["checks", i, "name"], message });
    checks.add(check.name);
  });
  layer.checks.forEach((check, i) => {
    for (const waited of check.after) {
      const message = afterProblem(check.name, waited, {
        setups: (other) => setups.has(other) || projectSetups.has(other),
        checks: (other) => checks.has(other) || projectChecks.has(other),
      });
      if (message !== null) problems.push({ path: ["checks", i, "after"], message });
    }
  });
  problems.push(...circles(layer.checks));
  const steps = new Set<string>();
  layer.steps?.forEach((step, i) => {
    let message: string | null = null;
    if (setups.has(step.name)) message = `step name ${step.name} is also a setup's name`;
    else if (checks.has(step.name)) message = `step name ${step.name} is also a check's name`;
    else if (steps.has(step.name)) message = `duplicate step name ${step.name}`;
    if (message !== null) problems.push({ path: [...MAIN_STEPS, i, "name"], message });
    steps.add(step.name);
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

/** What's wrong with check `check` waiting for `waited`, given which names are setups and checks; null when nothing. */
function afterProblem(
  check: string,
  waited: string,
  names: { setups: (name: string) => boolean; checks: (name: string) => boolean },
): string | null {
  if (waited === check) return "a check can't wait for itself";
  if (names.setups(waited))
    return `${waited} is a setup; every check already waits for every setup, so after only names checks`;
  return names.checks(waited) ? null : `no check is named ${waited}`;
}

/**
 * Each circle the layer's `after`s make, once, at the check it was found from: `a → b → a`. A
 * layer's checks wait only for its own or for the project's, and the project's never wait for a
 * task's, so every circle lies within one layer.
 */
function circles(checks: NamedLayer["checks"]): NameProblem[] {
  const index = new Map(checks.map((check, i) => [check.name, i]));
  const state = new Map<string, "visiting" | "done">();
  const problems: NameProblem[] = [];
  const visit = (check: string, trail: string[]): void => {
    if (state.get(check) === "done") return;
    if (state.get(check) === "visiting") {
      const circle = [...trail.slice(trail.indexOf(check)), check].join(" → ");
      problems.push({ path: ["checks", index.get(check) ?? 0, "after"], message: `after makes a circle: ${circle}` });
      return;
    }
    state.set(check, "visiting");
    for (const waited of checks[index.get(check) ?? 0]?.after ?? []) {
      if (waited !== check && index.has(waited)) visit(waited, [...trail, check]);
    }
    state.set(check, "done");
  };
  for (const check of checks) visit(check.name, []);
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

/**
 * A parsed check as stored, as the layer `source` defined it: with a 10m timeout, and nothing to wait
 * for and no secrets by default.
 */
export function checkConfig(check: z.infer<typeof CheckSchema>, source: ConfigLayer): CheckConfig {
  return {
    name: check.name,
    command: check.command,
    timeoutMs: check.timeout ?? DEFAULT_CHECK_TIMEOUT_MS,
    after: check.after,
    secrets: check.secrets,
    group: check.group ?? null,
    source,
  };
}

/** The secrets one setup or check names, with the step as a run's errors name it: `setup deps`, `check test`. */
export interface NamedSecrets {
  step: string;
  secrets: string[];
}

/** The secrets each setup and check names, in run order, leaving out those that name none. */
export function namedSecrets(stages: {
  setup: readonly Pick<SetupConfig, "name" | "secrets">[];
  checks: readonly Pick<CheckConfig, "name" | "secrets">[];
}): NamedSecrets[] {
  return [
    ...stages.setup.map((setup) => ({ step: `setup ${setup.name}`, secrets: setup.secrets })),
    ...stages.checks.map((check) => ({ step: `check ${check.name}`, secrets: check.secrets })),
  ].filter((named) => named.secrets.length > 0);
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

/** The checks a check waits for: one name or a list of them, as a list; none by default. */
const AfterSchema = z
  .union([z.string(), z.array(z.string({ error: "must be a check's name" }))], {
    error: "after must be a check's name or a list of them",
  })
  .optional()
  .transform((after) => (after === undefined ? [] : [after].flat()));

/** The secrets a setup or check uses: their names, each once; none by default. */
const SecretsSchema = z
  .array(
    z.string({ error: "must be a secret's name" }).superRefine((text, ctx) => {
      const message = secretNameError(text);
      if (message !== null) ctx.addIssue({ code: "custom", message });
    }),
    { error: "secrets must be a list of secrets' names" },
  )
  .optional()
  .transform((secrets) => [...new Set(secrets)]);

/** Only a check is in a group, which a pipeline chooses it by. */
const NO_GROUP = z.never({ error: "only checks take a group; a pipeline's groups choose which checks it runs" });

/** A setup: a name and a command, run in order before every check. */
const SetupSchema = z.strictObject(
  {
    name: name("setup name"),
    command,
    secrets: SecretsSchema,
    after: z.never({ error: "only checks take after; setups run in order" }).optional(),
    group: NO_GROUP.optional(),
  },
  { error: "a setup must be a mapping with a name and a command, like { name: deps, command: npm ci }" },
);

export const CheckSchema = z.strictObject({
  name: name("check name"),
  command,
  required: z
    .never({
      error: "required is gone: every check that runs must pass; to report without blocking, exit 0 and write a metric",
    })
    .optional(),
  needs: z.never({ error: "needs is gone: a check names the checks it waits for with after" }).optional(),
  after: AfterSchema,
  secrets: SecretsSchema,
  group: name("group").optional(),
  groups: z.never({ error: "a check is in at most one group: use group" }).optional(),
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

/** A post-gate step: a name and a command, run in order once the gate passes. */
const StepSchema = z.strictObject(
  {
    name: name("step name"),
    command,
    after: z.never({ error: "only checks take after; steps run in order" }).optional(),
    group: NO_GROUP.optional(),
  },
  { error: "a step must be a mapping with a name and a command, like { name: deploy, command: pnpm deploy }" },
);

/** The groups a pipeline runs: at least one group's name; every check when left out. */
const GroupsSchema = z
  .array(name("group"), { error: "groups must be a list of groups" })
  .min(1, "groups must name at least one group; leave groups out to run every check");

const SKIP = z.never({
  error: "skip is gone: give checks groups, and list the groups this pipeline runs under groups",
});

/** A pipeline as a config writes it; only `main` has post-gate steps. */
const pipelineSchema = (steps: z.ZodType<z.infer<typeof StepSchema>[] | undefined>) =>
  z.strictObject(
    { groups: GroupsSchema.optional(), skip: SKIP.optional(), steps },
    { error: "a pipeline must be a mapping" },
  );

/** The pipelines a config may set, and no other: there are no per-branch pipelines. */
const PipelinesSchema = z
  .looseObject(
    {
      default: pipelineSchema(
        z.never({ error: "only main has post-gate steps; default runs on attempts and task branches" }).optional(),
      ).optional(),
      main: pipelineSchema(z.array(StepSchema, { error: "steps must be a list of steps" }).optional()).optional(),
    },
    { error: "pipelines must be a mapping of default and main" },
  )
  .superRefine((pipelines, ctx) => {
    const known: readonly string[] = PIPELINES;
    for (const pipeline of Object.keys(pipelines).filter((key) => !known.includes(key))) {
      ctx.addIssue({
        code: "custom",
        path: [pipeline],
        message: `unknown pipeline; the pipelines are ${PIPELINES.join(" and ")}`,
      });
    }
  });

/**
 * What's wrong with the groups each pipeline runs: a group no check is in, and a check it runs waiting
 * for one it doesn't, which would then never run.
 */
function groupProblems(
  checks: readonly { name: string; after: readonly string[]; group?: string | undefined }[],
  pipelines: Partial<Record<Pipeline, { groups?: readonly string[] | undefined } | undefined>>,
): NameProblem[] {
  const problems: NameProblem[] = [];
  for (const pipeline of PIPELINES) {
    const groups = pipelines[pipeline]?.groups;
    if (groups === undefined) continue;
    const path = ["pipelines", pipeline, "groups"];
    for (const group of new Set(groups)) {
      if (!checks.some((check) => check.group === group)) {
        problems.push({ path, message: `no check is in the group ${group}` });
      }
    }
    const runs = new Set(
      checks.filter((check) => check.group !== undefined && groups.includes(check.group)).map((check) => check.name),
    );
    const known = new Set(checks.map((check) => check.name));
    for (const check of checks.filter((c) => runs.has(c.name))) {
      for (const waited of check.after.filter((other) => known.has(other) && !runs.has(other))) {
        problems.push({
          path,
          message: `${check.name} runs here and waits for ${waited}, which doesn't; put them in a group together`,
        });
      }
    }
  }
  return problems;
}

const ConfigSchema = z
  .strictObject(
    {
      /** Where a config keeps the anchors it reuses; Throng reads nothing in it. */
      definitions: z.unknown().optional(),
      setup: z.array(SetupSchema, { error: "setup must be a list of setups" }).optional(),
      network: z
        .strictObject({
          allow: z
            .array(
              z
                .string({ error: "must be a string" })
                .toLowerCase()
                .regex(HOSTNAME, "must be a hostname, like api.github.com, without a scheme or port"),
              { error: "allow must be a list of hostnames" },
            )
            .optional(),
        })
        .optional(),
      checks: z.array(CheckSchema, { error: "checks must be a list" }).optional(),
      metrics: z.array(MetricSchema, { error: "metrics must be a list" }).optional(),
      preview: z
        .never({
          error: "previews are now a check: move it under `checks`, with `after` naming the checks it waits for",
        })
        .optional(),
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
      pipelines: PipelinesSchema.optional(),
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
    const layer = {
      setup: config.setup ?? [],
      checks: config.checks ?? [],
      metrics: config.metrics ?? [],
      steps: config.pipelines?.main?.steps ?? [],
    };
    for (const problem of nameProblems(layer, null)) ctx.addIssue({ code: "custom", ...problem });
    for (const problem of groupProblems(layer.checks, config.pipelines ?? {})) {
      ctx.addIssue({ code: "custom", ...problem });
    }
    layer.metrics.forEach((metric, i) => checkMetricFields(metric, i, ctx));
  });

/**
 * Parses a config file's text, or null when there's no file. An empty file is a valid config with
 * every default. YAML errors, schema errors and unknown keys all make it `invalid`. A config may reuse
 * blocks through anchors, aliases and `<<` merge keys, resolving at most `MAX_ALIASES` aliases; it
 * keeps its anchors under a top-level `definitions:`, which is otherwise ignored.
 */
export function parseConfig(text: string | null): ConfigResult {
  if (text === null) return { kind: "none" };
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return { kind: "invalid", error: `the config is larger than ${MAX_CONFIG_BYTES} bytes` };
  }
  const doc = parseDocument(text, { merge: true });
  if (doc.errors.length > 0) {
    return { kind: "invalid", error: doc.errors.map((e) => `yaml: ${e.message}`).join("\n") };
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIASES });
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
      setup: (config.setup ?? []).map((setup) => ({
        name: setup.name,
        command: setup.command,
        secrets: setup.secrets,
      })),
      network: { allow: config.network?.allow ?? [] },
      checks: (config.checks ?? []).map((check) => checkConfig(check, "project")),
      metrics: (config.metrics ?? []).map((metric) => metricConfig(metric, "project")),
      attempts: { limit: config.attempts?.limit ?? null },
      selection: config.selection ?? CREATOR_SELECTS,
      sandbox: { size: config.sandbox?.size ?? DEFAULT_SANDBOX_SIZE },
      pipelines: {
        default: { groups: config.pipelines?.default?.groups ?? null, steps: [] },
        main: {
          groups: config.pipelines?.main?.groups ?? null,
          steps: (config.pipelines?.main?.steps ?? []).map((step) => ({ name: step.name, command: step.command })),
        },
      },
    },
  };
}

/**
 * The config as `pipeline` runs it: only the checks it runs, the metrics read from them, and its own
 * post-gate steps (see `PipelineConfig`). A task's check waiting for a project check the pipeline
 * doesn't run makes it invalid, as that check would never run.
 */
export function pipelineConfig(config: ConfigResult, pipeline: Pipeline): ConfigResult {
  if (config.kind !== "valid") return config;
  const { groups } = config.config.pipelines[pipeline];
  const runs = (check: CheckConfig) =>
    groups === null || check.source === "task" || (check.group !== null && groups.includes(check.group));
  const checks = config.config.checks.filter(runs);
  const names = new Set(checks.map((check) => check.name));
  const dropped = new Set(config.config.checks.filter((check) => !runs(check)).map((check) => check.name));
  const problems = checks.flatMap((check) =>
    check.after
      .filter((waited) => dropped.has(waited))
      .map((waited) => `${check.name} waits for ${waited}, which the ${pipeline} pipeline doesn't run`),
  );
  if (problems.length > 0) return { kind: "invalid", error: problems.join("\n") };
  const metrics = config.config.metrics.filter((metric) => names.has(parseFrom(metric.from).check));
  return { kind: "valid", config: { ...config.config, checks, metrics } };
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

/** The hosts the config's `network.allow` lets checks reach; none without a valid config. */
export function networkAllow(config: ConfigResult): string[] {
  return config.kind === "valid" ? config.config.network.allow : [];
}

/** The project's config, read from its origin's `main`, or from the commit of it `ref` names. */
export async function loadConfig(repos: Repos, projectId: string, ref = "main"): Promise<ConfigResult> {
  return parseConfig(await readOriginFile(repos, projectId, CONFIG_PATH, ref));
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
