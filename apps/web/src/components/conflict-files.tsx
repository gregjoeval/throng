// The conflict a landing's `merge` hit, file by file: each file's type, each hunk's three sides, and
// its diff from the merge base to `main` and to the approved head. A file whose hunks were too large,
// or that isn't a content conflict, still shows both diffs. The merge request's dequeue and the
// landing's run page both show it, each reading the diffs from its own route.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CommitFiles } from "@/components/commit-files";
import { ErrorState, Loading } from "@/components/states";
import type { ConflictDiffQueryOptions, ConflictSide } from "@/lib/api";
import type { Dequeue } from "@/lib/tasks";

/** A landing's conflict, as a dequeue's details and a run's `landed` carry it. */
export type ConflictDetails = Extract<NonNullable<Dequeue["details"]>, { files: unknown }>;
type ConflictFileDetails = ConflictDetails["files"][number];

/** The query of one conflicting file's diff from its merge base to `side`. */
export type ConflictDiffQuery = (path: string, side: ConflictSide) => ConflictDiffQueryOptions;

const CONFLICT_LABELS: Record<ConflictFileDetails["type"], string> = {
  content: "Both changed it",
  modifyDelete: "Deleted on one side, changed on the other",
  addAdd: "Both added it",
  rename: "Renamed differently on each side",
};

export function ConflictFiles({ details, diffQuery }: { details: ConflictDetails; diffQuery: ConflictDiffQuery }) {
  return (
    <div className="flex flex-col gap-3">
      {details.files.map((file) => (
        <ConflictFile key={file.path} attempt={details.attempt} file={file} diffQuery={diffQuery} />
      ))}
    </div>
  );
}

/** One conflicting file: its type, each hunk's three sides, and its diff from the base to each side. */
function ConflictFile({
  attempt,
  file,
  diffQuery,
}: {
  attempt: string;
  file: ConflictFileDetails;
  diffQuery: ConflictDiffQuery;
}) {
  return (
    <section aria-label={`Conflict in ${file.path}`} className="flex flex-col gap-2 rounded-lg border px-3 py-2">
      <h4 className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{file.path}</span>
        <span className="text-xs text-muted-foreground">{CONFLICT_LABELS[file.type]}</span>
      </h4>
      {file.truncated ? (
        <p role="note" className="text-muted-foreground">
          Its hunks were left out: they were too large to show. Its diffs to each side are below.
        </p>
      ) : null}
      {(file.hunks ?? []).map((hunk) => (
        <table
          key={hunk.startLine}
          aria-label={`Hunk at line ${hunk.startLine}`}
          className="w-full table-fixed text-xs"
        >
          <thead>
            <tr>
              {["Base", "main", attempt].map((side) => (
                <th key={side} className="px-2 py-1 text-left font-medium text-muted-foreground">
                  {side}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {[hunk.base, hunk.main, hunk.attempt].map((lines, i) => (
                <td key={i} className="border px-2 py-1 align-top">
                  <pre className="overflow-x-auto whitespace-pre">{lines.join("\n")}</pre>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      ))}
      <div className="grid gap-3 lg:grid-cols-2">
        <SideDiff query={diffQuery(file.path, "main")} side="main" label="Base → main" />
        <SideDiff query={diffQuery(file.path, "attempt")} side="attempt" label={`Base → ${attempt}`} />
      </div>
    </section>
  );
}

function SideDiff({ query, side, label }: { query: ConflictDiffQueryOptions; side: ConflictSide; label: string }) {
  const diff = useQuery(query);
  let body: ReactNode;
  if (diff.isPending) body = <Loading label="Loading diff…" />;
  else if (diff.isError) body = <ErrorState error={diff.error} />;
  else {
    const file = diff.data;
    const totals = { files: 1, additions: file.additions, deletions: file.deletions };
    body = <CommitFiles diff={{ files: [file], totals, truncated: false }} idPrefix={`conflict-${side}-`} />;
  }
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2">
      <h5 className="text-xs font-medium text-muted-foreground">{label}</h5>
      {body}
    </section>
  );
}
