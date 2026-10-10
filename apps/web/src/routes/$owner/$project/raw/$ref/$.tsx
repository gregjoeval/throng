import { createFileRoute } from "@tanstack/react-router";
import { Breadcrumbs, ProjectView } from "@/components/project-view";
import { EmptyState } from "@/components/states";
import { attemptSearch, buildPath } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/raw/$ref/$")({
  validateSearch: attemptSearch,
  component: Raw,
});

/**
 * A full page load of a raw URL never gets here: `src/server.ts` proxies it to the platform's raw
 * endpoint. This only renders after a client-side navigation, so it offers the real thing.
 */
function Raw() {
  const { owner, project, ref, _splat: path = "" } = Route.useParams();
  const location = { view: "raw", owner, project, ref, path, ...attemptSearch(Route.useSearch()) } as const;
  return (
    <ProjectView location={location}>
      <Breadcrumbs location={location} />
      <EmptyState title="Raw file">
        <a href={buildPath(location)} className="underline underline-offset-4">
          Open the raw file
        </a>
      </EmptyState>
    </ProjectView>
  );
}
