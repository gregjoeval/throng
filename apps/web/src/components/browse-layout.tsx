import type { ReactNode } from "react";
import { FileTree } from "@/components/file-tree";
import type { BrowseLocation } from "@/lib/paths";

/** A directory or file page: the file tree sidebar beside the page's own content. */
export function BrowseLayout({ at, children }: { at: BrowseLocation; children: ReactNode }) {
  return (
    <div className="grid items-start gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-label="Files sidebar" className="max-h-[80vh] overflow-auto rounded-xl border p-2">
        {/* A new ref is a new tree: nothing it had open carries over. */}
        <FileTree key={`${at.ref}?${at.attempt ?? ""}`} at={at} />
      </aside>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </div>
  );
}
