// One directory's entries at a ref, as the directory view and project home list them.

import { Link } from "@tanstack/react-router";
import { FileIcon, FolderIcon } from "lucide-react";
import type { TreeEntry } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { buildPath } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";

/** The view an entry opens in: a folder's directory view, or a file's file view. */
export function entryLocation(at: BrowseLocation, entry: Pick<TreeEntry, "path" | "type">): BrowseLocation {
  return { ...at, view: entry.type === "tree" ? "tree" : "blob", path: entry.path };
}

/** A table of entries, folders first as the platform sends them, each with its size. */
export function DirectoryEntries({ at, entries }: { at: BrowseLocation; entries: TreeEntry[] }) {
  return (
    <table aria-label="Files" className="w-full overflow-hidden rounded-xl border text-sm">
      <thead className="sr-only">
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Size</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {entries.map((entry) => {
          const Icon = entry.type === "tree" ? FolderIcon : FileIcon;
          return (
            <tr key={entry.path} className="hover:bg-muted/50">
              <td className="px-4 py-2">
                <span className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <Link to={buildPath(entryLocation(at, entry))} className="truncate hover:underline">
                    {entry.name}
                  </Link>
                </span>
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                {entry.size == null ? "" : formatBytes(entry.size)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
