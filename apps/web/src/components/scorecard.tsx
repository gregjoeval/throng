// An attempt's current result: the single-attempt view's scorecard, and the checks table and metric
// values it's made of, which the attempt details sheet shows too.

import { formatValue, linkTarget } from "@/lib/arena";
import type { ArenaAttempt, MetricColumn } from "@/lib/arena";

type CheckOutcome = NonNullable<ArenaAttempt["result"]>["checks"][number]["outcome"];

const OUTCOME_LABELS: Record<CheckOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  errored: "Errored",
  skipped: "Skipped",
};

const SCORING_STATES: Record<ArenaAttempt["status"], string> = {
  none: "it hasn't been asked for",
  queued: "scoring is queued",
  running: "scoring is running",
  done: "scoring is done",
  errored: "scoring errored",
};

/** The attempt's current result: each check's outcome and duration, then every metric. */
export function Scorecard({ attempt, columns }: { attempt: ArenaAttempt; columns: MetricColumn[] }) {
  const { result } = attempt;
  return (
    <section aria-labelledby="scorecard-title" className="flex flex-col gap-3 rounded-xl border px-3 py-2.5 text-sm">
      <h3 id="scorecard-title" className="font-heading font-medium">
        Scorecard
      </h3>
      {result === undefined ? (
        <p className="text-muted-foreground">Not scored yet: {SCORING_STATES[attempt.status]}.</p>
      ) : (
        <>
          <ChecksTable checks={result.checks} />
          <MetricValues attempt={attempt} columns={columns} />
        </>
      )}
    </section>
  );
}

/** Each check of a result: its name, whether it's required, its outcome and how long it took. */
export function ChecksTable({ checks }: { checks: NonNullable<ArenaAttempt["result"]>["checks"] }) {
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">Checks</caption>
      <tbody>
        {checks.map((check) => (
          <tr key={check.name} aria-label={check.name}>
            <td className="py-0.5 font-mono">{check.name}</td>
            <td className="text-muted-foreground">{check.required ? "Required" : "Optional"}</td>
            <td>{OUTCOME_LABELS[check.outcome]}</td>
            <td className="text-right tabular-nums">{(check.durationMs / 1000).toFixed(1)} s</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The attempt's value in each column, with its unit; a `url` string as a link. */
export function MetricValues({ attempt, columns }: { attempt: ArenaAttempt; columns: MetricColumn[] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
      {columns.map((column) => {
        const value = column.value(attempt);
        const href = column.format === "url" ? linkTarget(value) : null;
        return (
          <div key={column.key} className="contents">
            <dt className="text-muted-foreground">{column.label}</dt>
            <dd className="min-w-0 truncate text-right font-mono tabular-nums">
              {href === null ? (
                formatValue(value, column.unit)
              ) : (
                <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-3">
                  {href}
                </a>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
