import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CommitFiles } from "@/components/commit-files";
import { Author, RelativeTime } from "@/components/commit-meta";
import { ProjectView } from "@/components/project-view";
import { ErrorState, Loading } from "@/components/states";
import { commitDiffQuery, commitQuery } from "@/lib/api";
import { body, shortSha, subject } from "@/lib/commits";
import { attemptSearch, buildPath } from "@/lib/paths";

export const Route = createFileRoute("/$owner/$project/commit/$sha")({
  validateSearch: attemptSearch,
  component: Commit,
});

/** One commit: its message, author, committer, parents and diff. */
function Commit() {
  const { owner, project, sha } = Route.useParams();
  const hint = attemptSearch(Route.useSearch());
  const commit = useQuery(commitQuery({ owner, project }, sha, hint.attempt));
  const diff = useQuery(commitDiffQuery({ owner, project }, sha, hint.attempt));

  return (
    <ProjectView location={{ view: "commit", owner, project, sha, ...hint }}>
      {commit.isPending && <Loading />}
      {commit.isError && <ErrorState error={commit.error} />}
      {commit.isSuccess && (
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <h2 className="font-heading text-lg font-medium break-words">{subject(commit.data.message)}</h2>
          {body(commit.data.message) !== "" && (
            <pre data-testid="commit-message" className="font-sans text-sm whitespace-pre-wrap text-muted-foreground">
              {body(commit.data.message)}
            </pre>
          )}
          <ul aria-label="People" className="flex flex-col gap-1 text-sm">
            {(
              [
                ["Authored by", commit.data.author],
                ["Committed by", commit.data.committer],
              ] as const
            ).map(([label, who]) => (
              <li key={label} className="flex flex-wrap items-center gap-1">
                <span className="text-muted-foreground">{label}</span>
                <Author name={who.name} />
                <RelativeTime date={who.date} />
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
            <span>commit {commit.data.sha}</span>
            {commit.data.parents.length === 0 ? (
              <span className="font-sans">Root commit</span>
            ) : (
              <span className="flex items-center gap-1">
                {commit.data.parents.length === 1 ? "parent" : "parents"}
                {commit.data.parents.map((parent) => (
                  <Link
                    key={parent}
                    to={buildPath({ view: "commit", owner, project, sha: parent, ...hint })}
                    className="rounded-md border px-1.5 hover:bg-muted"
                  >
                    {shortSha(parent)}
                  </Link>
                ))}
              </span>
            )}
          </p>
          {commit.data.parents.length > 1 && (
            <p className="text-sm text-muted-foreground">
              A merge commit: its changes are shown against its first parent.
            </p>
          )}
        </div>
      )}
      {commit.isSuccess && diff.isPending && <Loading label="Loading the diff…" />}
      {commit.isSuccess && diff.isError && <ErrorState error={diff.error} />}
      {commit.isSuccess && diff.isSuccess && <CommitFiles diff={diff.data} />}
    </ProjectView>
  );
}
