// A directory's README, rendered below its entries.

import { useQuery } from "@tanstack/react-query";
import { isReadme } from "@throng/platform/readme";
import { Markdown } from "@/components/markdown";
import { ErrorState, Loading } from "@/components/states";
import { blobQuery } from "@/lib/api";
import type { TreeEntry } from "@/lib/api";
import { isMarkdown, markdownLinks, projectRefOf } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";

/** The entry that's a directory's README (`README.md` or `README`, in any case), if there is one. */
export function findReadme(entries: TreeEntry[]): TreeEntry | undefined {
  return entries.find((entry) => entry.type !== "tree" && isReadme(entry.name));
}

/** The README `entry` of the directory at `at`, rendered. */
export function Readme({ at, entry }: { at: BrowseLocation; entry: TreeEntry }) {
  const file: BrowseLocation = { ...at, view: "blob", path: entry.path };
  const blob = useQuery(blobQuery(projectRefOf(at), file));
  return (
    <section aria-label={entry.name} className="flex flex-col rounded-xl border">
      <h2 className="border-b px-4 py-2 font-mono text-sm">{entry.name}</h2>
      <div className="p-6">
        {blob.isPending && <Loading />}
        {blob.isError && <ErrorState error={blob.error} />}
        {blob.isSuccess && blob.data.content === null && (
          <p className="text-sm text-muted-foreground">This README is too large or binary to show.</p>
        )}
        {blob.isSuccess &&
          blob.data.content !== null &&
          (isMarkdown(entry.name) ? (
            <Markdown {...markdownLinks(file)}>{blob.data.content}</Markdown>
          ) : (
            <pre className="font-mono text-sm whitespace-pre-wrap">{blob.data.content}</pre>
          ))}
      </div>
    </section>
  );
}
