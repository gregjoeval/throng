// A task branch's runs (line `t42`), newest first, shown on the task page beside the merge-request
// banner, so a maintainer can see whether the task branch is green.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorState } from "@/components/states";
import { runsQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { buildPath } from "@/lib/paths";
import { RUN_STATUS_LABELS, runHead } from "@/lib/runs";
import { GATE_LABELS } from "@/lib/tasks";
import type { Task } from "@/lib/tasks";

/** How many of the task branch's latest runs are shown; the runs tab, filtered to its line, has the rest. */
const SHOWN = 3;

/** The task branch's latest runs, each linking to its run page; nothing while it has none. */
export function TaskBranchRuns({ projectRef, task }: { projectRef: ProjectRef; task: Pick<Task, "ref"> }) {
  const runs = useQuery(runsQuery(projectRef, { line: task.ref, limit: SHOWN }));
  if (runs.isError) return <ErrorState error={runs.error} />;
  if (!runs.isSuccess || runs.data.runs.length === 0) return null;
  return (
    <section aria-label="Task branch runs" className="flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm">
      <h3 className="flex flex-wrap items-baseline justify-between gap-2 font-medium">
        Task branch runs
        <Link
          to={buildPath({ view: "runs", ...projectRef, line: task.ref })}
          className="text-xs font-normal text-muted-foreground hover:underline"
        >
          All runs on {task.ref}
        </Link>
      </h3>
      <ul className="flex flex-col gap-1 text-xs">
        {runs.data.runs.map((run) => (
          <li
            key={run.id}
            aria-label={`Run ${run.id}`}
            data-superseded={run.superseded}
            className="flex flex-wrap items-center gap-x-2 data-[superseded=true]:opacity-50"
          >
            <Link to={buildPath({ view: "run", ...projectRef, run: run.id })} className="font-medium hover:underline">
              Run {run.id}
            </Link>
            <span className="font-mono text-muted-foreground">{runHead(run)}</span>
            <span>{RUN_STATUS_LABELS[run.status]}</span>
            {run.gate === null ? null : <span>Gate {GATE_LABELS[run.gate].toLowerCase()}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
