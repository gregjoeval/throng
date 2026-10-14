import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProjectView } from "@/components/project-view";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { runsQuery } from "@/lib/api";
import type { ProjectRef, Run } from "@/lib/api";
import { buildPath, runsSearch } from "@/lib/paths";
import type { RunsSearch } from "@/lib/paths";
import {
  formatDuration,
  LINE_FILTERS,
  lineHref,
  RUN_STATUS_LABELS,
  runDuration,
  runHead,
  TRIGGER_LABELS,
  triggeredBy,
} from "@/lib/runs";
import { GATE_LABELS } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/** The list's filters and page ride in the search params (`?line=main&status=waiting&cursor=40`). */
export const Route = createFileRoute("/$owner/$project/runs/")({
  validateSearch: runsSearch,
  component: RunList,
});

/** The status filter's choices: every status, then each one. */
const STATUS_FILTERS = [
  { value: undefined, label: "All statuses" },
  ...Object.entries(RUN_STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

/** Every run on the project's lines, newest first, a page at a time, filtered by line and status. */
function RunList() {
  const { owner, project } = Route.useParams();
  const search = runsSearch(Route.useSearch());
  const projectRef = { owner, project };
  const page = useQuery(runsQuery(projectRef, search));
  const at = (changes: RunsSearch) => buildPath({ view: "runs", owner, project, ...changes });
  // A filter starts the list over from its newest run.
  const filters = { line: search.line, status: search.status };

  return (
    <ProjectView location={{ view: "runs", owner, project, ...search }}>
      <div className="flex flex-col gap-2">
        <Filters label="Line">
          {LINE_FILTERS.map(({ value, label }) => (
            <Filter key={label} to={at({ ...filters, line: value })} active={search.line === value}>
              {label}
            </Filter>
          ))}
        </Filters>
        <Filters label="Status">
          {STATUS_FILTERS.map(({ value, label }) => (
            <Filter key={label} to={at({ ...filters, status: value })} active={search.status === value}>
              {label}
            </Filter>
          ))}
        </Filters>
      </div>
      {page.isPending && <Loading />}
      {page.isError && <ErrorState error={page.error} />}
      {page.isSuccess && page.data.runs.length === 0 && <EmptyState title="No runs" />}
      {page.isSuccess && page.data.runs.length > 0 && (
        <>
          <RunTable projectRef={projectRef} runs={page.data.runs} />
          <nav aria-label="Pages" className="flex justify-between text-sm">
            {search.cursor === undefined ? (
              <span />
            ) : (
              <Link to={at(filters)} className="hover:underline">
                Newest
              </Link>
            )}
            {page.data.next === null ? null : (
              <Link to={at({ ...filters, cursor: page.data.next })} className="hover:underline">
                Older
              </Link>
            )}
          </nav>
        </>
      )}
    </ProjectView>
  );
}

function Filters({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1">
      {children}
    </nav>
  );
}

function Filter({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted",
        active && "bg-muted font-medium text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function RunTable({ projectRef, runs }: { projectRef: ProjectRef; runs: Run[] }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Runs</caption>
      <thead className="border-b text-left text-muted-foreground">
        <tr>
          <Th>Run</Th>
          <Th>Line</Th>
          <Th>Pipeline</Th>
          <Th>Trigger</Th>
          <Th>Sha</Th>
          <Th>Status</Th>
          <Th>Gate</Th>
          <Th>Duration</Th>
          <Th>Triggered by</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const duration = runDuration(run);
          return (
            <tr key={run.id} aria-label={`Run ${run.id}`} className="border-b last:border-0">
              <td className="px-2 py-2">
                <Link
                  to={buildPath({ view: "run", ...projectRef, run: run.id })}
                  className="font-medium hover:underline"
                >
                  {run.id}
                </Link>
              </td>
              <td className="px-2 py-2 font-mono">
                <Link to={lineHref(projectRef, run)} className="hover:underline">
                  {run.line}
                </Link>
              </td>
              <td className="px-2 py-2">{run.pipeline}</td>
              <td className="px-2 py-2">{TRIGGER_LABELS[run.trigger]}</td>
              <td className="px-2 py-2 font-mono text-muted-foreground">{runHead(run)}</td>
              <td className="px-2 py-2">{RUN_STATUS_LABELS[run.status]}</td>
              <td className="px-2 py-2">{run.gate === null ? "—" : GATE_LABELS[run.gate]}</td>
              <td className="px-2 py-2 tabular-nums">{duration === null ? "—" : formatDuration(duration)}</td>
              <td className="px-2 py-2">{triggeredBy(run)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-2 py-2 font-medium">{children}</th>;
}
