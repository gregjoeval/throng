import { createFileRoute } from "@tanstack/react-router";
import { ProjectView } from "@/components/project-view";
import { RunPage } from "@/components/run-page";
import { NotFound } from "@/components/states";
import { runId } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/runs/$run")({ component: Run });

/** One run: its header, then its steps by stage, then its metrics. */
function Run() {
  const { owner, project, run } = Route.useParams();
  const id = runId(run);
  if (id === null) return <NotFound />;
  return (
    <ProjectView location={{ view: "run", owner, project, run: id }}>
      <RunPage projectRef={{ owner, project }} run={id} />
    </ProjectView>
  );
}
