// The file tree sidebar on directory and file pages: React Aria's `Tree`, each folder's contents
// read from `/tree` once it's expanded. A placeholder until the design pass.

import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type { Key, Selection } from "react-aria-components";
import { EntryIcon, entryLocation } from "@/components/directory";
import { treeQuery } from "@/lib/api";
import { buildPath, splitPath } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** The folders a path is in, outermost first; for a directory, the directory too. */
function foldersOf(at: BrowseLocation): string[] {
  const parts = splitPath(at.path);
  const count = at.view === "tree" ? parts.length : parts.length - 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => parts.slice(0, i + 1).join("/"));
}

export function FileTree({ at }: { at: BrowseLocation }) {
  const navigate = useNavigate();
  const projectRef = { owner: at.owner, project: at.project };
  const [expanded, setExpanded] = useState<Set<Key>>(() => new Set(foldersOf(at)));
  // Arriving somewhere new opens the folders it's in, leaving the others as they were.
  const [shownPath, setShownPath] = useState(at.path);
  if (shownPath !== at.path) {
    setShownPath(at.path);
    setExpanded((keys) => new Set([...keys, ...foldersOf(at)]));
  }

  // The root is always read; each other folder once it's open.
  const dirs = ["", ...[...expanded].map(String)];
  const results = useQueries({ queries: dirs.map((path) => treeQuery(projectRef, { ...at, path })) });
  const reads = new Map(dirs.map((path, i) => [path, results[i]]));
  const entries = new Map(results.flatMap((read) => read.data?.entries ?? []).map((e) => [e.path, e]));

  const goToSelected = (keys: Selection) => {
    const [key] = keys === "all" ? [] : [...keys];
    const entry = key === undefined ? undefined : entries.get(String(key));
    if (entry !== undefined) void navigate({ href: buildPath(entryLocation(at, entry)) });
  };

  const items = (parent: string, level: number): ReactNode => {
    const read = reads.get(parent);
    const list = read?.data?.entries;
    if (list === undefined) {
      const note = read?.isError ? "Couldn't load this folder" : "Loading…";
      return (
        <TreeItem id={`note:${parent}`} textValue={note} isDisabled>
          <TreeItemContent>
            <span style={{ paddingLeft: `${level}rem` }} className="text-muted-foreground">
              {note}
            </span>
          </TreeItemContent>
        </TreeItem>
      );
    }
    return list.map((entry) => {
      const folder = entry.type === "tree";
      return (
        <TreeItem
          key={entry.path}
          id={entry.path}
          textValue={entry.name}
          hasChildItems={folder}
          className={cn(
            "cursor-default rounded-md px-1 py-0.5 outline-none",
            "data-hovered:bg-muted data-focus-visible:ring-2 data-focus-visible:ring-ring data-selected:bg-muted data-selected:font-medium",
          )}
        >
          <TreeItemContent>
            {({ isExpanded }) => (
              <span style={{ paddingLeft: `${level}rem` }} className="flex items-center gap-1">
                {folder ? (
                  <Button slot="chevron" className="rounded-sm text-muted-foreground hover:text-foreground">
                    <ChevronRightIcon className={cn("size-4 transition-transform", isExpanded && "rotate-90")} />
                  </Button>
                ) : (
                  <span className="w-4" />
                )}
                <EntryIcon type={entry.type} />
                <span className="truncate">{entry.name}</span>
              </span>
            )}
          </TreeItemContent>
          {/* Tree only marks a row expandable when it has children, so a shut folder not yet read gets the placeholder. */}
          {folder ? items(entry.path, level + 1) : null}
        </TreeItem>
      );
    });
  };

  return (
    <Tree
      aria-label="File tree"
      selectionMode="single"
      selectionBehavior="replace"
      selectedKeys={at.path === "" ? [] : [at.path]}
      onSelectionChange={goToSelected}
      expandedKeys={expanded}
      onExpandedChange={setExpanded}
      className="flex flex-col text-sm"
    >
      {items("", 0)}
    </Tree>
  );
}
