import { createFileRoute } from "@tanstack/react-router";
import { Breadcrumbs, Placeholder, ProjectView } from "@/components/project-view";
import { attemptSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/blob/$ref/$")({
  validateSearch: attemptSearch,
  component: File,
});

/** One file at a ref. */
function File() {
  const { owner, project, ref, _splat: path = "" } = Route.useParams();
  const location = { view: "blob", owner, project, ref, path, ...attemptSearch(Route.useSearch()) } as const;
  return (
    <ProjectView location={location}>
      <Breadcrumbs location={location} />
      <Placeholder>This file's contents will show here.</Placeholder>
    </ProjectView>
  );
}
