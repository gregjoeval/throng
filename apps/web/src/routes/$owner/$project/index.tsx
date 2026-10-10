import { createFileRoute } from "@tanstack/react-router";
import { Breadcrumbs, Placeholder, ProjectView } from "@/components/project-view";

export const Route = createFileRoute("/$owner/$project/")({ component: ProjectHome });

/** Project home: the root directory at `main`, with the README below. */
function ProjectHome() {
  const { owner, project } = Route.useParams();
  return (
    <ProjectView location={{ view: "home", owner, project }}>
      <Breadcrumbs location={{ view: "tree", owner, project, ref: "main", path: "" }} />
      <Placeholder>The root directory at main, and its README, will show here.</Placeholder>
    </ProjectView>
  );
}
