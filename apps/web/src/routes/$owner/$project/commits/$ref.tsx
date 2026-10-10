import { createFileRoute } from "@tanstack/react-router";
import { Placeholder, ProjectView } from "@/components/project-view";
import { attemptSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/commits/$ref")({
  validateSearch: attemptSearch,
  component: CommitLog,
});

/** The first-parent commit log at a ref. */
function CommitLog() {
  const { owner, project, ref } = Route.useParams();
  return (
    <ProjectView location={{ view: "commits", owner, project, ref, ...attemptSearch(Route.useSearch()) }}>
      <h2 className="font-heading font-medium">
        Commits on <span className="font-mono">{ref}</span>
      </h2>
      <Placeholder>The commit log will show here.</Placeholder>
    </ProjectView>
  );
}
