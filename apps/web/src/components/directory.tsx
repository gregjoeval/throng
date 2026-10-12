// One directory's entries at a ref, as the directory view and project home list them.

import { Link } from "@tanstack/react-router";
import { FileIcon, FolderIcon } from "lucide-react";
import { EmptyState } from "@/components/states";
import type { TreeEntry } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { buildPath } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";

/** The view an entry opens in: a folder's directory view, or a file's file view. */
export function entryLocation(at: BrowseLocation, entry: Pick<TreeEntry, "path" | "type">): BrowseLocation {
  return { ...at, view: entry.type === "tree" ? "tree" : "blob", path: entry.path };
}

/** A folder's icon or a file's. */
export function EntryIcon({ type }: { type: TreeEntry["type"] }) {
  const Icon = type === "tree" ? FolderIcon : FileIcon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/** A file's size, "—" for one the platform didn't size, and nothing for a folder or a submodule. */
function entrySize(entry: TreeEntry): string {
  if (entry.type === "tree" || entry.type === "gitlink") return "";
  return entry.size == null ? "—" : formatBytes(entry.size);
}

/** A table of entries, folders first as the platform sends them, each with its size. */
export function DirectoryEntries({ at, entries }: { at: BrowseLocation; entries: TreeEntry[] }) {
  if (entries.length === 0) return <EmptyState title="This folder is empty" />;
  return (
    <table aria-label="Files" className="w-full overflow-hidden rounded-xl border text-sm">
      <thead className="sr-only">
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Size</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {entries.map((entry) => (
          <tr key={entry.path} className="hover:bg-muted/50">
            <td className="px-4 py-2">
              <span className="flex items-center gap-2">
                <EntryIcon type={entry.type} />
                <Link to={buildPath(entryLocation(at, entry))} className="truncate hover:underline">
                  {entry.name}
                </Link>
              </span>
            </td>
            <td className="px-4 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
              {entrySize(entry)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
