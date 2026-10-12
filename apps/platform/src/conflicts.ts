// Conflict details for a merge request dequeued with reason `conflict`. See the merge queue spec's
// "Conflict details" section. The Landing Workflow's conflict check runs
// `git merge-tree --write-tree --name-only --messages -z <main> <approvedHead>` and hands its raw
// output here. This slice records each conflicting path and its type; the blob hashes and the zdiff3
// hunks extend `ConflictFile` and `ConflictDetails`.

export const CONFLICT_TYPES = ["content", "modify_delete", "add_add", "rename"] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

export interface ConflictFile {
  path: string;
  type: ConflictType;
}

/** What `lastDequeue.details` holds for a `conflict`. */
export interface ConflictDetails {
  /** The source attempt, `t42a3`. */
  attempt: string;
  /** The approved head that conflicted. */
  head: string;
  /** `main`'s sha it conflicted with. */
  main: string;
  /** Every conflicting path. */
  files: ConflictFile[];
}

/** The merged tree (with conflict markers when it conflicted) and each conflicting path, in order. */
export interface MergeTree {
  tree: string;
  files: ConflictFile[];
}

/**
 * Parses `merge-tree --write-tree --name-only --messages -z` output: the tree, the conflicted paths
 * (NUL-separated, ended by an empty one), then the messages, each `<n>\0<path>×n\0<type>\0<text>\0`.
 * A path's type comes from the `CONFLICT` messages naming it; one with none is a content conflict.
 */
export function parseMergeTree(output: string): MergeTree {
  const fields = output.split("\0");
  let i = 0;
  const tree = fields[i++] ?? "";
  const paths: string[] = [];
  while (i < fields.length && fields[i] !== "") paths.push(fields[i++] as string);
  i++;
  const types = new Map<string, ConflictType>();
  while (i < fields.length) {
    const count = Number(fields[i++]);
    if (!Number.isInteger(count) || count <= 0) break;
    const named = fields.slice(i, i + count);
    i += count;
    const kind = fields[i++] ?? "";
    const text = fields[i++] ?? "";
    const type = conflictType(kind, text);
    if (type === null) continue;
    for (const path of named) if (!types.has(path) || types.get(path) === "content") types.set(path, type);
  }
  return { tree, files: paths.map((path) => ({ path, type: types.get(path) ?? "content" })) };
}

/** A message's conflict type, or null for one that isn't a conflict (`Auto-merging`, say). */
function conflictType(kind: string, text: string): ConflictType | null {
  if (!kind.startsWith("CONFLICT")) return null;
  if (kind.includes("rename")) return "rename";
  if (kind.includes("modify/delete")) return "modify_delete";
  if (text.startsWith("CONFLICT (add/add)")) return "add_add";
  return "content";
}
