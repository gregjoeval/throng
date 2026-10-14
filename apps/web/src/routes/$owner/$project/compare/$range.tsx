import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CommitFiles } from "@/components/commit-files";
import { ProjectView } from "@/components/project-view";
import { ErrorState, Loading, NotFound } from "@/components/states";
import { compareQuery } from "@/lib/api";
import { shortSha } from "@/lib/commits";
import { attemptSearch, parseRange } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/compare/$range")({
  validateSearch: attemptSearch,
  component: Compare,
});

/** A ref as the heading names it: a sha short, any other ref as it is. */
const named = (ref: string) => (/^[0-9a-f]{40}$/iu.test(ref) ? shortSha(ref) : ref);

/**
 * The diff from one ref's tree to another's (`from...to`), every file that differs: what a run
 * waiting for the owner would run, from its base to its head.
 */
function Compare() {
  const { owner, project, range } = Route.useParams();
  const hint = attemptSearch(Route.useSearch());
  const refs = parseRange(range);
  const diff = useQuery({
    ...compareQuery({ owner, project }, refs?.from ?? "", refs?.to ?? "", hint.attempt),
    enabled: refs !== null,
  });
  if (refs === null) return <NotFound />;

  return (
    <ProjectView location={{ view: "compare", owner, project, ...refs, ...hint }}>
      <h2 className="font-heading text-lg font-medium">
        Changes from <span className="font-mono">{named(refs.from)}</span> to{" "}
        <span className="font-mono">{named(refs.to)}</span>
      </h2>
      {diff.isPending && <Loading label="Loading the diff…" />}
      {diff.isError && <ErrorState error={diff.error} />}
      {diff.isSuccess && <CommitFiles diff={diff.data} />}
    </ProjectView>
  );
}
