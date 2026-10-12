import { createFileRoute } from "@tanstack/react-router";
import { ProjectView } from "@/components/project-view";
import { TaskPage } from "@/components/task-page";

export const Route = createFileRoute("/$owner/$project/tasks/$t")({ component: Task });

/** One task: its header, then a body that depends on its state. */
function Task() {
  const { owner, project, t } = Route.useParams();
  return (
    <ProjectView location={{ view: "task", owner, project, task: t }}>
      <TaskPage owner={owner} project={project} task={t} />
    </ProjectView>
  );
}
