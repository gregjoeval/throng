// The single-attempt view, for a task with exactly one active attempt and no merge request: the
// attempt's lane against its base, its scorecard, and Merge for whoever may select it.

import { useQuery } from "@tanstack/react-query";
import { Lane } from "@/components/lane";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { meQuery, projectQuery, taskArenaQuery } from "@/lib/api";
import { formatValue, metricColumns } from "@/lib/arena";
import type { ArenaAttempt, MetricColumn } from "@/lib/arena";
import type { Attempt, Task } from "@/lib/tasks";

interface InProject {
  owner: string;
  project: string;
}

/**
 * Whether the viewer may select an attempt of `task`: the platform lets its creator and the project
 * owner. False until both the viewer and the project are known.
 */
export function useMaySelect(owner: string, project: string, task: Task): boolean {
  const me = useQuery(meQuery);
  const found = useQuery(projectQuery(owner, project));
  if (!me.isSuccess || !found.isSuccess) return false;
  return me.data.user.id === task.creator.id || me.data.user.id === found.data.owner.id;
}

export function SingleAttemptView({ owner, project, task, attempt }: InProject & { task: Task; attempt: Attempt }) {
  const arena = useQuery(taskArenaQuery(owner, project, task.ref));
  const maySelect = useMaySelect(owner, project, task);
  if (arena.isPending) return <Loading />;
  if (arena.isError) return <ErrorState error={arena.error} />;
  const scored = arena.data.attempts.find((a) => a.ref === attempt.ref);
  if (scored === undefined) return <Loading />;
  return (
    <div data-testid="single-attempt-view" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <Lane owner={owner} project={project} attempt={scored} note={attempt.note} />
      <aside className="flex flex-col gap-3 lg:sticky lg:top-4">
        {/* Selection (#156) wires this to `POST …/tasks/{t}/selection` with its inline confirmation. */}
        {maySelect ? <Button disabled>Merge</Button> : null}
        <Scorecard attempt={scored} columns={metricColumns(arena.data.metrics)} />
      </aside>
    </div>
  );
}

type CheckOutcome = NonNullable<ArenaAttempt["result"]>["checks"][number]["outcome"];

const OUTCOME_LABELS: Record<CheckOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
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
          <table className="w-full text-xs">
            <caption className="sr-only">Checks</caption>
            <tbody>
              {result.checks.map((check) => (
                <tr key={check.name} aria-label={check.name}>
                  <td className="py-0.5 font-mono">{check.name}</td>
                  <td className="text-muted-foreground">{check.required ? "Required" : "Optional"}</td>
                  <td>{OUTCOME_LABELS[check.outcome]}</td>
                  <td className="text-right tabular-nums">{(check.durationMs / 1000).toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
            {columns.map((column) => (
              <div key={column.key} className="contents">
                <dt className="text-muted-foreground">{column.label}</dt>
                <dd className="text-right font-mono tabular-nums">{formatValue(column.value(attempt), column.unit)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
