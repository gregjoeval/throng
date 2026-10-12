import { createFileRoute } from "@tanstack/react-router";
import { ProjectView } from "@/components/project-view";
import { TaskPage } from "@/components/task-page";
import { parseArenaSearch } from "@/lib/arena-view";

/** The arena's view rides in the search params (`?lanes=t42a1,t42a3&by=file&ref=base&layout=split`). */
export const Route = createFileRoute("/$owner/$project/tasks/$t")({
  validateSearch: parseArenaSearch,
  component: Task,
});

/** One task: its header, then a body that depends on its state. */
function Task() {
  const { owner, project, t } = Route.useParams();
  const projectRef = { owner, project };
  return (
    <ProjectView location={{ view: "task", owner, project, task: t }}>
      <TaskPage projectRef={projectRef} task={t} />
    </ProjectView>
  );
}
