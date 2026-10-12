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

type MetricResult = Result["metrics"][string];

/** A metric's value in a result, whatever its type; null when it's missing or null. */
export type MetricValue = NonNullable<MetricResult["value"]>;

/** A metric's value in a result; null when it's missing or null. */
function metricValue(result: Result | undefined, name: string): MetricValue | null {
  return result?.metrics[name]?.value ?? null;
}

/** Where the attempt's Preview is served: `_preview.url`, null unless `_preview` passed. */
export function previewUrl(result: Result | undefined): string | null {
  const metric = result?.metrics["_preview.url"];
  return metric?.type === "string" ? metric.value : null;
}

/**
 * A `url` metric's value as a link's target, or null when it isn't an http or https URL: a
 * project's checks run the attempt's code, so the value may be anything.
 */
export function linkTarget(value: MetricValue | null): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:" ? value : null;
}

export const GATE_STATE_LABELS: Record<GateState, string> = {
  passed: "Gate passed",
  noChecks: "No checks configured",
  failed: "Gate failed",
};

/** An open attempt whose current head passed the gate (`GLOSSARY.md`). */
export const isPassing = (attempt: ArenaAttempt) => attempt.state === "open" && attempt.result?.gate === "passed";

/** How a column's values rank: higher is better, and a value it can't rank (a string's) is null. */
interface Ranking {
  rank: (value: MetricValue) => number | null;
  /** Which way is better, for the best value's hint. */
  hint: string;
}

/** A column of the rail: a metric the config declares, or one Throng measures on every diff. */
export interface MetricColumn {
  key: string;
  label: string;
  unit: string | null;
  /** `url`: the value is shown as a link where the page can have one. */
  format: "url" | null;
  /** Null for a string, which never ranks. */
  ranking: Ranking | null;
  value: (attempt: ArenaAttempt) => MetricValue | null;
}

/** A number's or boolean's ranking: by value, true above false, flipped when lower is better. */
function ordered(order: "asc" | "desc", hint: [lower: string, higher: string]): Ranking {
  return {
    rank: (value) => {
      if (typeof value === "string") return null;
      const n = Number(value);
      return order === "asc" ? -n : n;
    },
    hint: `${order === "asc" ? hint[0] : hint[1]} is better`,
  };
}

/** Throng's own measures, after the declared metrics; a smaller change is better. */
const BUILTIN_COLUMNS: MetricColumn[] = [
  {
    key: "filesChanged",
    label: "Files changed",
    unit: null,
    format: null,
    ranking: ordered("asc", ["lower", "higher"]),
    value: (a) => metricValue(a.result, "_diff.filesChanged"),
  },
  {
    key: "additions",
    label: "Lines added",
    unit: null,
    format: null,
    ranking: ordered("asc", ["lower", "higher"]),
    value: (a) => metricValue(a.result, "_diff.additions"),
  },
];

/** How a declared metric's values rank, by its type. */
function rankingOf(metric: Metric): Ranking | null {
  switch (metric.type) {
    case "number": {
      return ordered(metric.order, ["lower", "higher"]);
    }
    case "boolean": {
      return ordered(metric.order, ["false", "true"]);
    }
    case "enum": {
      const { values } = metric;
      return {
        rank: (value) => (typeof value === "string" && values.includes(value) ? -values.indexOf(value) : null),
        hint: values.join(" > "),
      };
    }
    case "string": {
      return null;
    }
  }
}

/** Every declared metric, in check order, then files changed and lines added. */
export function metricColumns(metrics: Metric[]): MetricColumn[] {
  return [
    ...metrics.map((metric) => ({
      key: `metric:${metric.name}`,
      label: metric.name,
      unit: metric.type === "number" ? metric.unit : null,
      format: metric.type === "string" ? metric.format : null,
      ranking: rankingOf(metric),
      value: (a: ArenaAttempt) => metricValue(a.result, metric.name),
    })),
    ...BUILTIN_COLUMNS,
  ];
}

/** An attempt's rank on a column; null without a value, or on a column that doesn't rank. */
function rankOf(column: MetricColumn, attempt: ArenaAttempt): number | null {
  const value = column.value(attempt);
  return value === null || column.ranking === null ? null : column.ranking.rank(value);
}

/**
 * Each ranked column's best rank among passing attempts, by column key, even when only one passes.
 * A column has none when no passing attempt has a value for it, or when every attempt's value ties:
 * then there's nothing to point out. A string column never has one.
 */
export function bestValues(attempts: ArenaAttempt[], columns: MetricColumn[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const column of columns) {
    const ranks = (of: ArenaAttempt[]) => of.map((a) => rankOf(column, a)).filter((r) => r !== null);
    const all = ranks(attempts);
    const passing = ranks(attempts.filter(isPassing));
    if (passing.length === 0 || all.every((r) => r === all[0])) continue;
    best.set(column.key, Math.max(...passing));
  }
  return best;
}

/** Whether the attempt has the column's best value among passing attempts. */
export function isBest(column: MetricColumn, attempt: ArenaAttempt, best: Map<string, number>): boolean {
  const rank = rankOf(column, attempt);
  return rank !== null && rank === best.get(column.key) && isPassing(attempt);
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
    const [x, y] = [rankOf(column, a), rankOf(column, b)];
    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    return y - x;
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

/** A metric value with its unit, as the rail and scorecard print it: a boolean as Yes or No. */
export function formatValue(value: MetricValue | null, unit: string | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return unit === null ? String(value) : `${value}${unit === "%" ? "" : " "}${unit}`;
}
