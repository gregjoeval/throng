// What the arena shows about a task's attempts: their gates and metrics, which value of each metric
// is best among passing attempts, how the rail sorts, and which attempts are shown as lanes.

import { parseAttemptRef, taskRef } from "@throng/platform/task-refs";
import type { InferResponseType } from "hono/client";
import type { TasksApi as Tasks } from "@/lib/api";
import { isActive } from "@/lib/tasks";

export type TaskArena = InferResponseType<Tasks[":t"]["arena"]["$get"], 200>;
export type Metric = TaskArena["metrics"][number];

/** One attempt as the arena reads it. */
export type ArenaAttempt = TaskArena["attempts"][number];

/**
 * An attempt's gate in its current result: `noChecks` when it passed with no checks configured,
 * so it reads differently from a real pass; null before its head has a result.
 */
export type GateState = "passed" | "noChecks" | "failed";

export function gateState(attempt: ArenaAttempt): GateState | null {
  const { result } = attempt;
  if (result === undefined) return null;
  if (result.gate === "failed") return "failed";
  const configured = result.checks.filter((check) => check.source !== "platform");
  return result.config.kind === "none" || configured.length === 0 ? "noChecks" : "passed";
}

type Result = NonNullable<ArenaAttempt["result"]>;

/** A number metric's value in a result; null when it's missing, null or not a number. */
export function numberValue(result: Result | undefined, name: string): number | null {
  const metric = result?.metrics[name];
  return metric?.type === "number" ? metric.value : null;
}

/** Where the attempt's Preview is served: `_preview.url`, null unless `_preview` passed. */
export function previewUrl(result: Result | undefined): string | null {
  const metric = result?.metrics["_preview.url"];
  return metric?.type === "string" ? metric.value : null;
}

export const GATE_STATE_LABELS: Record<GateState, string> = {
  passed: "Gate passed",
  noChecks: "No checks configured",
  failed: "Gate failed",
};

/** An open attempt whose current head passed the gate (`GLOSSARY.md`). */
export const isPassing = (attempt: ArenaAttempt) => attempt.state === "open" && attempt.result?.gate === "passed";

/** A column of the rail: a metric the config declares, or one Throng measures on every diff. */
export interface MetricColumn {
  key: string;
  label: string;
  unit: string | null;
  order: Metric["order"];
  value: (attempt: ArenaAttempt) => number | null;
}

/** Throng's own measures, after the declared metrics; a smaller change is better. */
const BUILTIN_COLUMNS: MetricColumn[] = [
  {
    key: "filesChanged",
    label: "Files changed",
    unit: null,
    order: "asc",
    value: (a) => numberValue(a.result, "_diff.filesChanged"),
  },
  {
    key: "additions",
    label: "Lines added",
    unit: null,
    order: "asc",
    value: (a) => numberValue(a.result, "_diff.additions"),
  },
];

/** Every declared metric, in check order, then files changed and lines added. */
export function metricColumns(metrics: Metric[]): MetricColumn[] {
  return [
    ...metrics.map((metric) => ({
      key: `metric:${metric.name}`,
      label: metric.name,
      unit: metric.unit,
      order: metric.order,
      value: (a: ArenaAttempt) => numberValue(a.result, metric.name),
    })),
    ...BUILTIN_COLUMNS,
  ];
}

/** Whether `a` is better than `b` on a column with this order. */
const better = (order: Metric["order"], a: number, b: number) => (order === "asc" ? a < b : a > b);

/**
 * Each column's best value among passing attempts, by column key, even when only one passes. A
 * column has none when no passing attempt has a value for it, or when every attempt's value ties:
 * then there's nothing to point out.
 */
export function bestValues(attempts: ArenaAttempt[], columns: MetricColumn[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const column of columns) {
    const all = attempts.map(column.value).filter((v) => v !== null);
    const [first, ...rest] = attempts
      .filter(isPassing)
      .map(column.value)
      .filter((v) => v !== null);
    if (first === undefined || all.every((v) => v === all[0])) continue;
    best.set(
      column.key,
      rest.reduce((top, v) => (better(column.order, v, top) ? v : top), first),
    );
  }
  return best;
}

/** What the rail can be sorted by: the attempt number, the gate, or a column's key. */
export type RailSort = "number" | "gate" | (string & {});

const GATE_RANK: Record<GateState, number> = { passed: 0, noChecks: 1, failed: 2 };

/**
 * The attempts in rail order: by number, by gate (passed first, unscored last), or by a column, best
 * first and attempts without a value last. Ties keep number order.
 */
export function sortRail(attempts: ArenaAttempt[], sort: RailSort, columns: MetricColumn[]): ArenaAttempt[] {
  const byNumber = attempts.toSorted((a, b) => attemptNumber(a) - attemptNumber(b));
  if (sort === "number") return byNumber;
  if (sort === "gate") {
    const rank = (a: ArenaAttempt) => {
      const gate = gateState(a);
      return gate === null ? 3 : GATE_RANK[gate];
    };
    return byNumber.toSorted((a, b) => rank(a) - rank(b));
  }
  const column = columns.find((c) => c.key === sort);
  if (column === undefined) return byNumber;
  return byNumber.toSorted((a, b) => {
    const [x, y] = [column.value(a), column.value(b)];
    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    if (better(column.order, x, y)) return -1;
    return better(column.order, y, x) ? 1 : 0;
  });
}

function parsedRef(attempt: { ref: string }): { task: number; number: number } {
  const parsed = parseAttemptRef(attempt.ref);
  if (parsed === null) throw new Error(`not an attempt: ${attempt.ref}`);
  return parsed;
}

/** The `t42` of `t42a3`. */
export function taskOf(attempt: { ref: string }): string {
  return taskRef(parsedRef(attempt).task);
}

/** The `3` of `t42a3`. */
export function attemptNumber(attempt: { ref: string }): number {
  return parsedRef(attempt).number;
}

/**
 * The lanes a task opens with: its first two passing attempts by number, topped up with the first
 * others by number when fewer than two pass.
 */
export function initialLanes(attempts: ArenaAttempt[]): string[] {
  const active = attempts.filter(isActive).toSorted((a, b) => attemptNumber(a) - attemptNumber(b));
  const passing = active.filter(isPassing);
  const others = active.filter((a) => !isPassing(a));
  return [...passing, ...others]
    .slice(0, 2)
    .toSorted((a, b) => attemptNumber(a) - attemptNumber(b))
    .map((a) => a.ref);
}

/**
 * Clicking a card: shows its attempt as the last lane, or hides its lane unless it's the only one,
 * since at least one lane stays shown.
 */
export function toggleLane(lanes: string[], ref: string): string[] {
  if (!lanes.includes(ref)) return [...lanes, ref];
  return lanes.length === 1 ? lanes : lanes.filter((lane) => lane !== ref);
}

/** A metric value with its unit, as the rail and scorecard print it. */
export function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  return unit === null ? String(value) : `${value}${unit === "%" ? "" : " "}${unit}`;
}
