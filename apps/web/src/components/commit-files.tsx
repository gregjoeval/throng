// A commit's changed files: the list with +/- counts, then one section per file holding its diff,
// or a notice where a server cap left the diff out. Diffs render as their section nears the view.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Diff } from "@/components/diff";
import type { CommitDiff, DiffFlag, FileDiff } from "@/lib/api";

/** Why a file has no patch, for each flag that leaves one out. */
const NOTICES: Record<DiffFlag, string> = {
  tooLarge: "This file is too large to diff.",
  binary: "Binary file not shown.",
  tooComplex: "This file's changes are too complex to diff.",
  truncated: "This file's diff was left out: the commit's diff reached its size limit.",
};

/** How far outside the viewport a file's diff starts rendering. */
const LAZY_MARGIN = "800px 0px";

/**
 * The files of a commit diff, or of any answer shaped like one (the compare endpoint's). `idPrefix`
 * keeps the file anchors apart when several diffs share a page, as the arena's lanes do.
 */
export function CommitFiles({
  diff,
  idPrefix = "",
}: {
  diff: Pick<CommitDiff, "files" | "totals" | "truncated">;
  idPrefix?: string;
}) {
  const { files, totals } = diff;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <span>
          {totals.files} {totals.files === 1 ? "file" : "files"} changed
        </span>{" "}
        <Counts additions={totals.additions} deletions={totals.deletions} />
      </p>
      {diff.truncated && (
        <p role="note" aria-label="Files left out" className="rounded-md border px-3 py-2 text-sm">
          Only the first {files.length} of {totals.files} changed files are listed.
        </p>
      )}
      <ul aria-label="Files changed" className="divide-y rounded-xl border text-sm">
        {files.map((file) => (
          <li key={file.path} aria-label={file.path} className="flex items-center gap-3 px-4 py-2">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{file.status}</span>
            <a href={`#${anchor(file.path, idPrefix)}`} className="min-w-0 flex-1 truncate font-mono hover:underline">
              {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
            </a>
            <Counts additions={file.additions} deletions={file.deletions} />
          </li>
        ))}
      </ul>
      {files.map((file) => (
        <FileSection key={file.path} file={file} idPrefix={idPrefix} />
      ))}
    </div>
  );
}

function FileSection({ file, idPrefix }: { file: FileDiff; idPrefix: string }) {
  const id = anchor(file.path, idPrefix);
  const titleId = `${id}-title`;
  const [ref, visible] = useNearViewport<HTMLElement>();
  const { patch } = file;
  const left = file.flags.find((flag) => flag !== "truncated") ?? (patch === undefined ? "truncated" : undefined);
  let body: ReactNode;
  if (left !== undefined) body = <Notice>{NOTICES[left]}</Notice>;
  else if (patch === undefined || !patch.includes("\n@@")) body = <Notice>{describeHeaderOnly(file)}</Notice>;
  else {
    body = (
      <>
        {file.flags.includes("truncated") && (
          <Notice>This file's diff was cut short: the commit's diff reached its size limit.</Notice>
        )}
        {visible ? <Diff patch={patch} /> : <div className="h-24" aria-hidden />}
      </>
    );
  }
  return (
    <section ref={ref} id={id} aria-labelledby={titleId} className="rounded-xl border">
      <h3 id={titleId} className="border-b px-4 py-2 font-mono text-sm">
        {file.path}
      </h3>
      {body}
    </section>
  );
}

/** What a patch with headers and no hunks says: a pure rename, a mode change or an empty file. */
function describeHeaderOnly(file: FileDiff): string {
  if (file.status === "renamed") return "Renamed without changes.";
  if (file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode) {
    return `Mode changed from ${file.oldMode} to ${file.newMode}.`;
  }
  return "No content changes.";
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-green-700 dark:text-green-400">+{additions}</span>{" "}
      <span className="text-red-700 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

/** The fragment a file's section is at. */
function anchor(path: string, prefix: string): string {
  return `${prefix}diff-${encodeURIComponent(path)}`;
}

/**
 * Whether an element has come near the viewport; it stays true once it has. Without an
 * IntersectionObserver, everything counts as near.
 */
function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: LAZY_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}
