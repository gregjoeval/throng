import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Author, RelativeTime } from "@/components/commit-meta";
import { ProjectView } from "@/components/project-view";
import { RefSwitcher } from "@/components/ref-switcher";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { commitsQuery } from "@/lib/api";
import { shortSha, subject } from "@/lib/commits";
import { attemptHint, buildPath, commitsSearch } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/commits/$ref")({
  validateSearch: commitsSearch,
  component: CommitLog,
});

/** The first-parent commit log at a ref, a page at a time. */
function CommitLog() {
  const { owner, project, ref } = Route.useParams();
  const search = commitsSearch(Route.useSearch());
  const page = useQuery(commitsQuery({ owner, project }, ref, search));
  const attempt = attemptHint(search.attempt);
  const location = { view: "commits", owner, project, ref, ...search } as const;
  const pageAt = (offset: number) => buildPath({ view: "commits", owner, project, ref, ...attempt, offset });

  return (
    <ProjectView location={location}>
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher at={location} />
        <h2 className="font-heading font-medium">
          Commits on <span className="font-mono">{ref}</span>
        </h2>
      </div>
      {page.isPending && <Loading />}
      {page.isError && <ErrorState error={page.error} />}
      {page.isSuccess && page.data.commits.length === 0 && <EmptyState title="No commits yet" />}
      {page.isSuccess && page.data.commits.length > 0 && (
        <>
          <ul aria-label="Commits" className="divide-y rounded-xl border">
            {page.data.commits.map((commit) => {
              const title = subject(commit.message);
              const to = buildPath({ view: "commit", owner, project, sha: commit.sha, ...attempt });
              return (
                <li key={commit.sha} aria-label={title} className="flex items-center gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Link to={to} className="truncate font-medium hover:underline">
                      {title}
                    </Link>
                    <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                      <Author name={commit.author.name} />
                      <span>committed</span>
                      <RelativeTime date={commit.author.date} />
                    </p>
                  </div>
                  <Link to={to} className="rounded-md border px-2 py-0.5 font-mono text-xs hover:bg-muted">
                    {shortSha(commit.sha)}
                  </Link>
                </li>
              );
            })}
          </ul>
          <nav aria-label="Pages" className="flex justify-between text-sm">
            {page.data.offset > 0 ? (
              <Link to={pageAt(Math.max(0, page.data.offset - page.data.limit))} className="hover:underline">
                Newer
              </Link>
            ) : (
              <span />
            )}
            {page.data.next === null ? null : (
              <Link to={pageAt(page.data.next)} className="hover:underline">
                Older
              </Link>
            )}
          </nav>
        </>
      )}
    </ProjectView>
  );
}
