import { createFileRoute } from "@tanstack/react-router";
import { Placeholder, ProjectView } from "@/components/project-view";
import { attemptSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/commit/$sha")({
  validateSearch: attemptSearch,
  component: Commit,
});

/** One commit: its message, author, parents and diff. */
function Commit() {
  const { owner, project, sha } = Route.useParams();
  return (
    <ProjectView location={{ view: "commit", owner, project, sha, ...attemptSearch(Route.useSearch()) }}>
      <h2 className="font-heading font-medium">
        Commit <span className="font-mono">{sha.slice(0, 7)}</span>
      </h2>
      <Placeholder>The commit and its diff will show here.</Placeholder>
    </ProjectView>
  );
}
