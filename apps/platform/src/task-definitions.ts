// What a task defines over its project's config: its own metrics, in the config's shape. A run
// merges the layers once, when it starts (`withTask`); saving a task checks its definitions against
// the project's config the same way (`taskDefinitionsFrom`), so a save that passes merges cleanly
// until the project changes. Any clash between layers is invalid: there is no implicit precedence.

import { z } from "zod";
import { checkMetricFields, CONFIG_PATH, describeIssue, metricConfig, MetricSchema } from "./config.ts";
import type { Config, ConfigResult, MetricConfig } from "./config.ts";

export interface TaskDefinitions {
  /** Read from the checks' output files, after the project's metrics. */
  metrics: MetricConfig[];
}

export const NO_TASK_DEFINITIONS: TaskDefinitions = { metrics: [] };

const TaskSchema = z
  .object({ metrics: z.array(MetricSchema, { error: "metrics must be a list" }) })
  .superRefine(({ metrics }, ctx) => {
    const names = new Set<string>();
    metrics.forEach((metric, i) => {
      if (names.has(metric.name)) {
        ctx.addIssue({ code: "custom", path: ["metrics", i, "name"], message: `duplicate metric name ${metric.name}` });
      }
      names.add(metric.name);
      checkMetricFields(metric, i, ctx);
    });
  });

/**
 * A task's metrics as a request gave them, in the config's shape, checked against the project's
 * config: an error with one line per problem (`metrics[0].from: …`) when they don't merge with it.
 */
export function taskDefinitionsFrom(
  input: { metrics: unknown },
  project: ConfigResult,
): { definitions: TaskDefinitions } | { error: string } {
  const parsed = TaskSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map(describeIssue).join("\n") };
  const definitions = { metrics: parsed.data.metrics.map((metric) => metricConfig(metric, "task")) };
  if (definitions.metrics.length > 0 && project.kind === "invalid") {
    return { error: `metrics can't be checked against ${CONFIG_PATH} on main, which is invalid:\n${project.error}` };
  }
  const problems = clashes(project.kind === "valid" ? project.config : null, definitions);
  return problems.length === 0 ? { definitions } : { error: problems.join("\n") };
}

/**
 * The run's config: the project's, with the task's metrics after its own. A clash between them, or
 * a task metric read from a check neither defines, makes it invalid, naming each problem.
 */
export function withTask(project: ConfigResult, task: TaskDefinitions): ConfigResult {
  if (task.metrics.length === 0 || project.kind === "invalid") return project;
  const config = project.kind === "valid" ? project.config : null;
  const problems = clashes(config, task);
  if (problems.length > 0) return { kind: "invalid", error: problems.map((line) => `task ${line}`).join("\n") };
  const base: Config = config ?? {
    setup: [],
    network: { allow: [] },
    checks: [],
    metrics: [],
    preview: null,
    attempts: { limit: null },
  };
  return { kind: "valid", config: { ...base, metrics: [...base.metrics, ...task.metrics] } };
}

/** Each task name the project's config already uses, and each task metric read from no check. */
function clashes(project: Config | null, task: TaskDefinitions): string[] {
  const checks = new Set(project?.checks.map((check) => check.name));
  const metrics = new Set(project?.metrics.map((metric) => metric.name));
  return task.metrics.flatMap((metric, i) => {
    const problems: string[] = [];
    if (checks.has(metric.name)) {
      problems.push(`metrics[${i}].name: ${metric.name} is also a check's name in ${CONFIG_PATH}`);
    } else if (metrics.has(metric.name)) {
      problems.push(`metrics[${i}].name: ${metric.name} is also a metric's name in ${CONFIG_PATH}`);
    }
    const check = metric.from.split(".")[0] ?? "";
    if (!checks.has(check)) problems.push(`metrics[${i}].from: no check is named ${check}`);
    return problems;
  });
}
