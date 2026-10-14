import type { ConflictDetails, ConflictFile, ConflictType } from "../../src/conflicts.ts";

/** A conflicting file for details built by hand: every side present, no hunks. */
export function conflictFile(path: string, type: ConflictType, blob = "b".repeat(40)): ConflictFile {
  return {
    path,
    type,
    blobs: { base: blob, main: blob, attempt: blob },
    modes: { base: "100644", main: "100644", attempt: "100644" },
    truncated: false,
  };
}

/** Conflict details built by hand for the given paths, each a `content` conflict. */
export function conflictDetails(paths: string[]): ConflictDetails {
  const sha = "c".repeat(40);
  return { attempt: "t1a1", head: sha, main: sha, base: sha, files: paths.map((p) => conflictFile(p, "content")) };
}
