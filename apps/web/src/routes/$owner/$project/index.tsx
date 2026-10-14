import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { About } from "@/components/about";
import { DirectoryEntries } from "@/components/directory";
import { LocationBar, ProjectView } from "@/components/project-view";
import { findReadme, Readme } from "@/components/readme";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { WaitingForYou } from "@/components/waiting-runs";
import { refsQuery, treeQuery } from "@/lib/api";
import type { BrowseLocation } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/")({ component: ProjectHome });

/**
 * Project home: the runs waiting for the owner, then the root directory at `main` with the README
 * below, beside the About sidebar.
 */
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
      <WaitingForYou projectRef={{ owner, project }} />
      <LocationBar location={home} />
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {(refs.isPending || (pushed && tree.isPending)) && <Loading />}
          {refs.isError && <ErrorState error={refs.error} />}
          {tree.isError && <ErrorState error={tree.error} />}
          {refs.isSuccess && !pushed && (
            <EmptyState title="This project is empty">Clone it and push to main to add the first files.</EmptyState>
          )}
          {tree.isSuccess && <DirectoryEntries at={root} entries={tree.data.entries} />}
          {readme === undefined ? null : <Readme at={root} entry={readme} />}
        </div>
        <About projectRef={{ owner, project }} />
      </div>
    </ProjectView>
  );
}
