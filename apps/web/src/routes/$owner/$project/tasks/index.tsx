import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { ProjectView } from "@/components/project-view";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { tasksQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { buildPath } from "@/lib/paths";
import { GATE_LABELS, mergeRequestLabel } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/** The list's tabs: open by default, then closed and obsolete through `?state=`. */
const TABS = [
  { state: "open", label: "Open" },
  { state: "closed", label: "Closed" },
  { state: "obsolete", label: "Obsolete" },
] as const;
type TabState = (typeof TABS)[number]["state"];

export const Route = createFileRoute("/$owner/$project/tasks/")({
  validateSearch: (search: Record<string, unknown>): { state?: "closed" | "obsolete" } =>
    search["state"] === "closed" || search["state"] === "obsolete" ? { state: search["state"] } : {},
  component: TaskList,
});

/** The project's tasks, open by default, with tabs for closed and obsolete ones. */
function TaskList() {
  const { owner, project } = Route.useParams();
  const projectRef = { owner, project };
  const state: TabState = Route.useSearch().state ?? "open";
  const [creating, setCreating] = useState(false);
  return (
    <ProjectView location={{ view: "tasks", owner, project }}>
      <div className="flex items-end justify-between gap-2 border-b">
        <nav aria-label="Task states" className="flex gap-1 text-sm">
          {TABS.map((tab) => (
            <Link
              key={tab.state}
              to="/$owner/$project/tasks"
              params={projectRef}
              search={tab.state === "open" ? {} : { state: tab.state }}
              activeOptions={{ exact: true }}
              aria-current={tab.state === state ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 border-transparent px-3 py-1.5 text-muted-foreground hover:text-foreground",
                tab.state === state && "border-foreground text-foreground",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <Button size="sm" className="mb-1.5" onClick={() => setCreating(true)}>
          <PlusIcon />
          New task
        </Button>
      </div>
      <Tasks projectRef={projectRef} state={state} />
      <NewTaskDialog projectRef={projectRef} open={creating} onOpenChange={setCreating} />
    </ProjectView>
  );
}

function Tasks({ projectRef, state }: { projectRef: ProjectRef; state: TabState }) {
  const tasks = useQuery(tasksQuery(projectRef, state));
  if (tasks.isPending) return <Loading />;
  if (tasks.isError) return <ErrorState error={tasks.error} />;
  if (tasks.data.tasks.length === 0) return <EmptyState title={`No ${state} tasks`} />;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-muted-foreground">
        <tr>
          <Th>Task</Th>
          <Th>Title</Th>
          <Th>Attempts</Th>
          <Th>Best gate</Th>
          <Th>Merge request</Th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {tasks.data.tasks.map((task) => (
          <tr key={task.ref}>
            <td className="px-2 py-2 font-mono text-muted-foreground">{task.ref}</td>
            <td className="px-2 py-2">
              <Link
                to={buildPath({ view: "task", owner: projectRef.owner, project: projectRef.project, task: task.ref })}
                className="font-medium hover:underline"
              >
                {task.title}
              </Link>
            </td>
            <td className="px-2 py-2 tabular-nums">{task.attemptCount}</td>
            <td className="px-2 py-2">{task.bestGate === null ? "—" : GATE_LABELS[task.bestGate]}</td>
            <td className="px-2 py-2">
              {task.mergeRequestState === null ? "—" : mergeRequestLabel(task.mergeRequestState)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-2 py-2 font-medium">{children}</th>;
}
