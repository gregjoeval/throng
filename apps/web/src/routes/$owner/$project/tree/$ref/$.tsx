import { createFileRoute } from "@tanstack/react-router";
import { Breadcrumbs, Placeholder, ProjectView } from "@/components/project-view";
import { attemptSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/tree/$ref/$")({
  validateSearch: attemptSearch,
  component: Directory,
});

/** One directory at a ref. */
function Directory() {
  const { owner, project, ref, _splat: path = "" } = Route.useParams();
  const location = { view: "tree", owner, project, ref, path, ...attemptSearch(Route.useSearch()) } as const;
  return (
    <ProjectView location={location}>
      <Breadcrumbs location={location} />
      <Placeholder>This directory's entries will show here.</Placeholder>
    </ProjectView>
  );
}
