// What the arena shows about a task's attempts: their gates and metrics, which value of each metric
// is best among passing attempts, how the rail sorts, and which attempts are shown as lanes.

import type { InferResponseType } from "hono/client";
import type { client } from "@/lib/api";

type Tasks = (typeof client.api.projects)[":owner"][":project"]["tasks"];
export type TaskArena = InferResponseType<Tasks[":t"]["arena"]["$get"], 200>;
export type Metric = TaskArena["metrics"][number];

/**
 * One attempt as the arena reads it. `needsUpdate` and `forkedFrom` come with the task branch
 * (#203–#205); until the platform sends them they're absent, and nothing is shown for them.
 */
export type ArenaAttempt = TaskArena["attempts"][number] & {
  needsUpdate?: boolean;
  forkedFrom?: string | null;
};

/**
 * An attempt's gate in its current result: `noChecks` when it passed with no checks configured,
 * so it reads differently from a real pass; null before its head has a result.
 */
export type GateState = "passed" | "noChecks" | "failed";

export function gateState(attempt: ArenaAttempt): GateState | null {
  const { result } = attempt;
  if (result === undefined) return null;
  if (result.gate === "failed") return "failed";
  return result.config.kind === "none" || result.checks.length === 0 ? "noChecks" : "passed";
}

export const GATE_STATE_LABELS: Record<GateState, string> = {
  passed: "Gate passed",
  noChecks: "No checks configured",
  failed: "Gate failed",
};

/** Draft and open attempts are active; the arena's lanes and rail cards are theirs. */
export const isActiveAttempt = (attempt: ArenaAttempt) => attempt.state === "draft" || attempt.state === "open";

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
    value: (a) => a.result?.builtin.filesChanged ?? null,
  },
  {
    key: "additions",
    label: "Lines added",
    unit: null,
    order: "asc",
    value: (a) => a.result?.builtin.additions ?? null,
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
      value: (a: ArenaAttempt) => a.result?.metrics[metric.name] ?? null,
    })),
    ...BUILTIN_COLUMNS,
  ];
}

/** Whether `a` is better than `b` on a column with this order. */
const better = (order: Metric["order"], a: number, b: number) => (order === "asc" ? a < b : a > b);

/**
 * Each column's best value among passing attempts, by column key. A column has none when fewer than
 * two passing attempts have a value for it, or when they all tie: then there's nothing to point out.
 */
export function bestValues(attempts: ArenaAttempt[], columns: MetricColumn[]): Map<string, number> {
  const passing = attempts.filter(isPassing);
  const best = new Map<string, number>();
  for (const column of columns) {
    const values = passing.map(column.value).filter((v) => v !== null);
    const [first, ...rest] = values;
    if (first === undefined || rest.every((v) => v === first)) continue;
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

/** The `3` of `t42a3`. */
export function attemptNumber(attempt: { ref: string }): number {
  return Number(attempt.ref.slice(attempt.ref.lastIndexOf("a") + 1));
}

/**
 * The lanes a task opens with: its first two passing attempts by number, topped up with the first
 * others by number when fewer than two pass.
 */
export function initialLanes(attempts: ArenaAttempt[]): string[] {
  const active = attempts.filter(isActiveAttempt).toSorted((a, b) => attemptNumber(a) - attemptNumber(b));
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
