import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BrowseLayout } from "@/components/browse-layout";
import { FileView } from "@/components/file-view";
import { LocationBar, ProjectView } from "@/components/project-view";
import { ErrorState, Loading } from "@/components/states";
import { blobQuery } from "@/lib/api";
import { attemptSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/blob/$ref/$")({
  validateSearch: attemptSearch,
  component: File,
});

/** One file at a ref. */
function File() {
  const { owner, project, ref, _splat: path = "" } = Route.useParams();
  const location = { view: "blob", owner, project, ref, path, ...attemptSearch(Route.useSearch()) } as const;
  const blob = useQuery(blobQuery({ owner, project }, location));
  return (
    <ProjectView location={location}>
      <LocationBar location={location} />
      <BrowseLayout at={location}>
        {blob.isPending && <Loading />}
        {blob.isError && <ErrorState error={blob.error} />}
        {blob.isSuccess && <FileView key={blob.data.path} at={location} blob={blob.data} />}
      </BrowseLayout>
    </ProjectView>
  );
}
