import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { BrowseLayout } from "@/components/browse-layout";
import { FileView } from "@/components/file-view";
import { LocationBar, ProjectView } from "@/components/project-view";
import { ErrorState, Loading } from "@/components/states";
import { blobQuery, treeQuery } from "@/lib/api";
import { attemptSearch, buildPath, splitPath } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/blob/$ref/$")({
  validateSearch: attemptSearch,
  component: File,
});

/** One file at a ref. A folder, as a relative Markdown link names one, opens in the directory view. */
function File() {
  const { owner, project, ref, _splat: path = "" } = Route.useParams();
  const location = { view: "blob", owner, project, ref, path, ...attemptSearch(Route.useSearch()) } as const;
  const blob = useQuery(blobQuery({ owner, project }, location));
  // The folder the path is in, which the file tree reads too: it says whether the path is a folder.
  const parts = splitPath(path);
  const parent = useQuery(treeQuery({ owner, project }, { ...location, path: parts.slice(0, -1).join("/") }));
  const folder = parent.data?.entries.some((entry) => entry.path === parts.join("/") && entry.type === "tree");
  if (folder) return <Navigate to={buildPath({ ...location, view: "tree" })} replace />;
  return (
    <ProjectView location={location}>
      <LocationBar location={location} />
      <BrowseLayout at={location}>
        {(blob.isPending || (blob.isError && parent.isPending)) && <Loading />}
        {blob.isError && !parent.isPending && <ErrorState error={blob.error} />}
        {blob.isSuccess && <FileView key={blob.data.path} at={location} blob={blob.data} />}
      </BrowseLayout>
    </ProjectView>
  );
}
