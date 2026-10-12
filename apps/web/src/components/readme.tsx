// A directory's README, rendered below its entries.

import { useQuery } from "@tanstack/react-query";
import { Markdown } from "@/components/markdown";
import { ErrorState, Loading } from "@/components/states";
import { blobQuery } from "@/lib/api";
import type { TreeEntry } from "@/lib/api";
import { buildPath, splitPath } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";

const README = /^readme(?:\.md)?$/iu;

/** The entry that's a directory's README (`README.md` or `README`, in any case), if there is one. */
export function findReadme(entries: TreeEntry[]): TreeEntry | undefined {
  return entries.find((entry) => entry.type !== "tree" && README.test(entry.name));
}

/** Whether a path names a Markdown file. */
export function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkd)$/iu.test(path);
}

/**
 * The URLs a Markdown file's relative links and images resolve against: its directory in the file
 * view, and the same directory under `/raw`. Each ends in `/`.
 */
export function markdownBases(at: BrowseLocation): { baseUrl: string; imageBaseUrl: string } {
  const dir = splitPath(at.path).slice(0, -1).join("/");
  // Without the `?attempt=` hint: a query on the base would be dropped by every relative URL anyway.
  const { owner, project, ref } = at;
  const base = (view: "blob" | "raw") => `${buildPath({ view, owner, project, ref, path: dir })}/`;
  return { baseUrl: base("blob"), imageBaseUrl: base("raw") };
}

/** The README `entry` of the directory at `at`, rendered. */
export function Readme({ at, entry }: { at: BrowseLocation; entry: TreeEntry }) {
  const file: BrowseLocation = { ...at, view: "blob", path: entry.path };
  const blob = useQuery(blobQuery({ owner: at.owner, project: at.project }, file));
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
            <Markdown {...markdownBases(file)}>{blob.data.content}</Markdown>
          ) : (
            <pre className="font-mono text-sm whitespace-pre-wrap">{blob.data.content}</pre>
          ))}
      </div>
    </section>
  );
}
