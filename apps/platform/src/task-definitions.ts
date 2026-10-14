// What a task defines over its project's config: its own checks and metrics, in the config's shape.
// A run merges the layers once, when it starts (`withTask`): the task's checks run after the
// project's, under its setup and `network.allow`, and its metrics may read either layer's checks.
// Saving a task checks its definitions against the project's config the same way
// (`taskDefinitionsFrom`), so a save that passes merges cleanly until the project changes. Any clash
// between layers is invalid: there is no implicit precedence.

import { z } from "zod";
import {
  checkConfig,
  checkMetricFields,
  CheckSchema,
  CONFIG_PATH,
  CREATOR_SELECTS,
  DEFAULT_SANDBOX_SIZE,
  describeIssue,
  describePath,
  metricConfig,
  MetricSchema,
  nameProblems,
} from "./config.ts";
import type { CheckConfig, Config, ConfigResult, MetricConfig } from "./config.ts";

export interface TaskDefinitions {
  /** Run after the project's checks, in order. */
  checks: CheckConfig[];
  /** Read from the checks' output files, after the project's metrics. */
  metrics: MetricConfig[];
}

/** A task's checks and metrics as a request gives them, before they're checked; either may be left out. */
export interface TaskDefinitionsInput {
  checks?: unknown;
  metrics?: unknown;
}

export const NO_TASK_DEFINITIONS: TaskDefinitions = { checks: [], metrics: [] };

const TaskSchema = z
  .object({
    checks: z.array(CheckSchema, { error: "checks must be a list" }).optional(),
    metrics: z.array(MetricSchema, { error: "metrics must be a list" }).optional(),
  })
  .superRefine(({ metrics }, ctx) => {
    metrics?.forEach((metric, i) => checkMetricFields(metric, i, ctx));
  });

/**
 * A task's definitions after a request: the checks and metrics it gave, in the config's shape, and
 * `current`'s for those it left out. They're checked together against the project's config: an error
 * with one line per problem (`metrics[0].from: …`) when they don't merge with it.
 */
export function taskDefinitionsFrom(
  input: TaskDefinitionsInput,
  current: TaskDefinitions,
  project: ConfigResult,
): { definitions: TaskDefinitions } | { error: string } {
  const parsed = TaskSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map(describeIssue).join("\n") };
  const definitions = {
    checks: parsed.data.checks?.map((check) => checkConfig(check, "task")) ?? current.checks,
    metrics: parsed.data.metrics?.map((metric) => metricConfig(metric, "task")) ?? current.metrics,
  };
  if (defines(definitions) && project.kind === "invalid") {
    return {
      error: `checks and metrics can't be checked against ${CONFIG_PATH} on main, which is invalid:\n${project.error}`,
    };
  }
  const problems = clashes(project.kind === "valid" ? project.config : null, definitions);
  return problems.length === 0 ? { definitions } : { error: problems.join("\n") };
}

/** Whether a task defines any checks or metrics. */
function defines(task: TaskDefinitions): boolean {
  return task.checks.length > 0 || task.metrics.length > 0;
}

/**
 * The run's config: the project's, with the task's checks and metrics after its own. A clash between
 * them, or a task metric read from a check neither defines, makes it invalid, naming each problem.
 */
export function withTask(project: ConfigResult, task: TaskDefinitions): ConfigResult {
  if (!defines(task) || project.kind === "invalid") return project;
  const config = project.kind === "valid" ? project.config : null;
  const problems = clashes(config, task);
  if (problems.length > 0) return { kind: "invalid", error: problems.map((line) => `task ${line}`).join("\n") };
  const base: Config = config ?? {
    setup: [],
    network: { allow: [] },
    checks: [],
    metrics: [],
    attempts: { limit: null },
    selection: CREATOR_SELECTS,
    sandbox: { size: DEFAULT_SANDBOX_SIZE },
  };
  return {
    kind: "valid",
    config: { ...base, checks: [...base.checks, ...task.checks], metrics: [...base.metrics, ...task.metrics] },
  };
}

/**
 * Each name rule the task's checks and metrics break over the project's config (`nameProblems`), one
 * line each: `metrics[0].from: no check is named lint`.
 */
function clashes(project: Config | null, task: TaskDefinitions): string[] {
  return nameProblems(task, project).map(({ path, message }) => `${describePath(path)}: ${message}`);
}
