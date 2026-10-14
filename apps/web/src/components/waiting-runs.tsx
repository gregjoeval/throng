// Runs waiting for the project owner: runs of code that isn't the owner's that name a secret, and
// landings of merge requests no owner approved whose `main` names one. Each shows the secrets it
// would hold, its head with a link to its diff, and, for the owner, Start, pinned to that head.
// The project home and the runs tab list them as "Waiting for you"; a task page lists its own as
// "Waiting for the owner".

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { StartRun } from "@/components/run-actions";
import { ErrorState } from "@/components/states";
import { waitingRunsQuery } from "@/lib/api";
import type { ProjectRef, Run } from "@/lib/api";
import { shortSha } from "@/lib/commits";
import { useIsOwner } from "@/lib/owner";
import { buildPath } from "@/lib/paths";
import { runTask, waitingHref } from "@/lib/runs";
import type { Waiting } from "@/lib/runs";

/** The project's runs waiting for the owner, for the owner alone; nothing while there are none. */
export function WaitingForYou({ projectRef }: { projectRef: ProjectRef }) {
  const isOwner = useIsOwner(projectRef);
  const runs = useQuery({ ...waitingRunsQuery(projectRef), select: waitingOf, enabled: isOwner });
  if (!isOwner) return null;
  return <WaitingList projectRef={projectRef} title="Waiting for you" runs={runs} />;
}

/** The task's runs waiting for the owner: its attempts', its task branch's and its merge request's landing. */
export function TaskWaitingRuns({ projectRef, task }: { projectRef: ProjectRef; task: string }) {
  const runs = useQuery({
    ...waitingRunsQuery(projectRef),
    select: (all: Run[]) => waitingOf(all).filter(({ run }) => runTask(run) === task),
  });
  return <WaitingList projectRef={projectRef} title="Waiting for the owner" runs={runs} />;
}

/** A run waiting for the owner, with what starting it means. */
interface WaitingRun {
  run: Run;
  waiting: Waiting;
}

/** The runs that wait for the owner, with what starting each means. */
function waitingOf(runs: Run[]): WaitingRun[] {
  return runs.flatMap((run) => (run.waiting === null ? [] : [{ run, waiting: run.waiting }]));
}

function WaitingList({
  projectRef,
  title,
  runs,
}: {
  projectRef: ProjectRef;
  title: string;
  runs: UseQueryResult<WaitingRun[]>;
}) {
  if (runs.isError) return <ErrorState error={runs.error} />;
  const waiting = runs.data ?? [];
  if (waiting.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm">
      <h3 className="font-medium">{title}</h3>
      <ul className="flex flex-col gap-2">
        {waiting.map(({ run, waiting: w }) => (
          <WaitingItem key={run.id} projectRef={projectRef} run={run} waiting={w} />
        ))}
      </ul>
    </section>
  );
}

function WaitingItem({ projectRef, run, waiting }: { projectRef: ProjectRef; run: Run; waiting: Waiting }) {
  return (
    <li aria-label={`Run ${run.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Link to={buildPath({ view: "run", ...projectRef, run: run.id })} className="font-medium hover:underline">
        Run {run.id}
      </Link>
      <span className="font-mono">{run.line}</span>
      <span className="font-mono text-muted-foreground">{shortSha(waiting.head)}</span>
      <Link to={waitingHref(projectRef, waiting)} className="hover:underline">
        Diff
      </Link>
      <span className="text-muted-foreground">
        {waiting.secrets.length === 0 ? "No secrets" : `Secrets: ${waiting.secrets.join(", ")}`}
      </span>
      <StartRun projectRef={projectRef} run={run} />
    </li>
  );
}
