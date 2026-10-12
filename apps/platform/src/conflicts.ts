export const CONFLICT_TYPES = ["content", "modifyDelete", "addAdd", "rename"] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

/** One value per side of a merge: the merge base, `main`, and the attempt's approved head. Null where the side has no file. */
export interface Sides<T> {
  base: T | null;
  main: T | null;
  attempt: T | null;
}

/** A conflicting path as `merge-tree` reports it: its type, and each side's blob sha and git mode. */
export interface MergeTreeFile {
  path: string;
  type: ConflictType;
  blobs: Sides<string>;
  modes: Sides<string>;
}

/**
 * One conflicting region of a content conflict, from a zdiff3 re-merge: each side's lines (without
 * line endings), and the 1-based line in the base where it starts (where it would go, for a region
 * with no base lines).
 */
export interface ConflictHunk {
  startLine: number;
  base: string[];
  main: string[];
  attempt: string[];
}

/**
 * A conflicting path in the details. Content conflicts carry `hunks`, unless the caps left them out
 * (`truncated`) or the three blobs couldn't be merged as text (binary, say).
 */
export interface ConflictFile extends MergeTreeFile {
  truncated: boolean;
  hunks?: ConflictHunk[];
}

/** What `lastDequeue.details` holds for a `conflict`. */
export interface ConflictDetails {
  /** The source attempt, `t42a3`. */
  attempt: string;
  /** The approved head that conflicted. */
  head: string;
  /** `main`'s sha it conflicted with. */
  main: string;
  /** Their merge base, or null when they share no history. */
  base: string | null;
  /** Every conflicting path. */
  files: ConflictFile[];
}

/** The merged tree (with conflict markers when it conflicted) and each conflicting path, in order. */
export interface MergeTree {
  tree: string;
  files: MergeTreeFile[];
}

/**
 * How the conflict check re-merged one content conflict's blobs: `merged` with the zdiff3 output (the
 * lines outside the conflicts may be blanked), `tooLarge` when the output was over its transport
 * limit, `failed` when `git merge-file` couldn't merge them (binary blobs).
 */
export type Remerge =
  | { path: string; status: "merged"; output: string }
  | { path: string; status: "tooLarge" }
  | { path: string; status: "failed" };

/** Hunk byte caps, counting each line's UTF-8 bytes plus its newline. */
export interface ConflictCaps {
  fileBytes: number;
  totalBytes: number;
}

export const CONFLICT_CAPS: ConflictCaps = { fileBytes: 64 * 1024, totalBytes: 512 * 1024 };

const STAGES = { "1": "base", "2": "main", "3": "attempt" } as const;

/**
 * Parses `merge-tree --write-tree --messages -z` output: the tree, the conflicted index entries
 * (`<mode> <oid> <stage>\t<path>`, NUL-separated, ended by an empty one), then the messages, each
 * `<n>\0<path>×n\0<type>\0<text>\0`. A path's type comes from the `CONFLICT` messages naming it; one
 * with none is a content conflict. Each path is listed once, in order of its first entry.
 */
export function parseMergeTree(output: string): MergeTree {
  const fields = output.split("\0");
  let i = 0;
  const tree = fields[i++] ?? "";
  const entries = new Map<string, { blobs: Sides<string>; modes: Sides<string> }>();
  while (i < fields.length && fields[i] !== "") {
    const field = fields[i++] as string;
    const tab = field.indexOf("\t");
    const [mode = "", oid = "", stage = ""] = field.slice(0, tab).split(" ");
    const path = field.slice(tab + 1);
    const side = STAGES[stage as keyof typeof STAGES];
    let sides = entries.get(path);
    if (sides === undefined) {
      sides = { blobs: { base: null, main: null, attempt: null }, modes: { base: null, main: null, attempt: null } };
      entries.set(path, sides);
    }
    if (side !== undefined) {
      sides.blobs[side] = oid;
      sides.modes[side] = mode;
    }
  }
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
  const files = [...entries].map(([path, sides]) => ({ path, type: types.get(path) ?? "content", ...sides }));
  return { tree, files };
}

/** A message's conflict type, or null for one that isn't a conflict (`Auto-merging`, say). */
function conflictType(kind: string, text: string): ConflictType | null {
  if (!kind.startsWith("CONFLICT")) return null;
  if (kind.includes("rename")) return "rename";
  if (kind.includes("modify/delete")) return "modifyDelete";
  if (text.startsWith("CONFLICT (add/add)")) return "addAdd";
  return "content";
}

/** The labels the conflict check gives `git merge-file -L`, which name its markers. */
export const MERGE_LABELS = ["main", "base", "attempt"] as const;

const MARKERS = {
  start: `<<<<<<< ${MERGE_LABELS[0]}`,
  base: `||||||| ${MERGE_LABELS[1]}`,
  split: "=======",
  end: `>>>>>>> ${MERGE_LABELS[2]}`,
};

/**
 * Parses `git merge-file -p --zdiff3 -L main -L base -L attempt` output into its conflicting hunks.
 * Lines lose their `\n` or `\r\n` ending. Lines outside the hunks only count toward `startLine`.
 */
export function parseZdiff3(output: string): ConflictHunk[] {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: ConflictHunk[] = [];
  let baseLine = 1;
  let hunk: ConflictHunk | null = null;
  let side: "main" | "base" | "attempt" = "main";
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (hunk === null) {
      if (line === MARKERS.start) {
        hunk = { startLine: baseLine, base: [], main: [], attempt: [] };
        side = "main";
      } else baseLine++;
      continue;
    }
    if (side === "main" && line === MARKERS.base) side = "base";
    else if (side === "base" && line === MARKERS.split) side = "attempt";
    else if (side === "attempt" && line === MARKERS.end) {
      hunks.push(hunk);
      baseLine += hunk.base.length;
      hunk = null;
    } else hunk[side].push(line);
  }
  return hunks;
}

/**
 * The details' files: each conflicting path with the hunks of its content conflict re-merge. Every
 * path is listed. A file whose hunks are over `caps.fileBytes`, or would take the details over
 * `caps.totalBytes`, is `truncated` with no hunks; later, smaller files still get theirs.
 */
export function conflictFiles(
  files: MergeTreeFile[],
  remerges: Remerge[],
  caps: ConflictCaps = CONFLICT_CAPS,
): ConflictFile[] {
  const byPath = new Map(remerges.map((r) => [r.path, r]));
  let total = 0;
  return files.map((file) => {
    const remerge = file.type === "content" ? byPath.get(file.path) : undefined;
    if (remerge === undefined || remerge.status === "failed") return { ...file, truncated: false };
    if (remerge.status === "tooLarge") return { ...file, truncated: true };
    const hunks = parseZdiff3(remerge.output);
    const bytes = hunkBytes(hunks);
    if (bytes > caps.fileBytes || total + bytes > caps.totalBytes) return { ...file, truncated: true };
    total += bytes;
    return { ...file, truncated: false, hunks };
  });
}

const encoder = new TextEncoder();

function hunkBytes(hunks: ConflictHunk[]): number {
  let bytes = 0;
  for (const hunk of hunks) {
    for (const line of [...hunk.base, ...hunk.main, ...hunk.attempt]) bytes += encoder.encode(line).length + 1;
  }
  return bytes;
}
