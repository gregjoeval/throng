import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DirectoryEntries } from "@/components/directory";
import { LocationBar, ProjectView } from "@/components/project-view";
import { findReadme, Readme } from "@/components/readme";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { refsQuery, treeQuery } from "@/lib/api";
import type { BrowseLocation } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/")({ component: ProjectHome });

/** Project home: the root directory at `main`, with the README below. */
function ProjectHome() {
  const { owner, project } = Route.useParams();
  const home = { view: "home", owner, project } as const;
  const root: BrowseLocation = { view: "tree", owner, project, ref: "main", path: "" };
  const refs = useQuery(refsQuery({ owner, project }));
  const pushed = refs.isSuccess && refs.data.main.sha !== null;
  const tree = useQuery({ ...treeQuery({ owner, project }, root, { sizes: true }), enabled: pushed });
  const readme = tree.isSuccess ? findReadme(tree.data.entries) : undefined;

  return (
    <ProjectView location={home}>
      <LocationBar location={home} />
      {(refs.isPending || (pushed && tree.isPending)) && <Loading />}
      {refs.isError && <ErrorState error={refs.error} />}
      {tree.isError && <ErrorState error={tree.error} />}
      {refs.isSuccess && !pushed && (
        <EmptyState title="Nothing pushed yet">Push to this project's main to see its files here.</EmptyState>
      )}
      {tree.isSuccess && <DirectoryEntries at={root} entries={tree.data.entries} />}
      {readme === undefined ? null : <Readme at={root} entry={readme} />}
    </ProjectView>
  );
}
