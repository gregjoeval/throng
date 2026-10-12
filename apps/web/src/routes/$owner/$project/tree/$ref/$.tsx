import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BrowseLayout } from "@/components/browse-layout";
import { DirectoryEntries } from "@/components/directory";
import { LocationBar, ProjectView } from "@/components/project-view";
import { ErrorState, Loading } from "@/components/states";
import { treeQuery } from "@/lib/api";
import { attemptSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/tree/$ref/$")({
  validateSearch: attemptSearch,
  component: Directory,
});

/** One directory at a ref. */
function Directory() {
  const { owner, project, ref, _splat: path = "" } = Route.useParams();
  const location = { view: "tree", owner, project, ref, path, ...attemptSearch(Route.useSearch()) } as const;
  const tree = useQuery(treeQuery({ owner, project }, location, { sizes: true }));
  return (
    <ProjectView location={location}>
      <LocationBar location={location} />
      <BrowseLayout at={location}>
        {tree.isPending && <Loading />}
        {tree.isError && <ErrorState error={tree.error} />}
        {tree.isSuccess && <DirectoryEntries at={location} entries={tree.data.entries} />}
      </BrowseLayout>
    </ProjectView>
  );
}
