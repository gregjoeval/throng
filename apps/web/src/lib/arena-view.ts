// How a viewer has the arena laid out: which lanes, arranged by attempt or by file, diffed against
// each attempt's base or current main, split or unified. It lives in the task page's URL
// (`?lanes=t42a1,t42a3&by=file&ref=base&layout=split`), so a link reproduces it, and in
// `localStorage` per task, so the arena opens as the viewer left it. The URL wins on load.

import type { FileDiff } from "@/lib/api";
import { initialLanes } from "@/lib/arena";
import type { ArenaAttempt } from "@/lib/arena";
import { isActive } from "@/lib/tasks";

export const ARRANGEMENTS = ["attempt", "file"] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

/** What each lane is diffed against: its own base (ADR 0003), or `main`'s current head. */
export const REFERENCES = ["base", "main"] as const;
export type Reference = (typeof REFERENCES)[number];

export const LAYOUTS = ["split", "unified"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** The view as the URL and storage carry it: `lanes` comma-separated; anything absent takes its default. */
export interface ArenaSearch {
  lanes?: string;
  by?: Arrangement;
  ref?: Reference;
  layout?: Layout;
}

/** The view the arena shows. */
export interface ArenaView {
  lanes: string[];
  by: Arrangement;
  ref: Reference;
  layout: Layout;
}

const pick = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((v) => v === value);

/** The arena's fields of a search object (the URL's or a stored one), invalid ones dropped. */
export function parseArenaSearch(search: Record<string, unknown>): ArenaSearch {
  const fields: ArenaSearch = {
    lanes: typeof search["lanes"] === "string" && search["lanes"] !== "" ? search["lanes"] : undefined,
    by: pick(ARRANGEMENTS, search["by"]),
    ref: pick(REFERENCES, search["ref"]),
    layout: pick(LAYOUTS, search["layout"]),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/**
 * The view from `search` over `attempts`: lanes keep only active attempts, in the order given, and
 * fall back to `initialLanes` when none is left.
 */
export function arenaView(search: ArenaSearch, attempts: ArenaAttempt[]): ArenaView {
  const active = attempts.filter(isActive);
  const lanes = (search.lanes?.split(",") ?? []).filter((ref) => active.some((a) => a.ref === ref));
  return {
    lanes: lanes.length === 0 ? initialLanes(active) : [...new Set(lanes)],
    by: search.by ?? "attempt",
    ref: search.ref ?? "base",
    layout: search.layout ?? "split",
  };
}

/** Where one task's view is stored. */
export const storageKey = (owner: string, project: string, task: string) => `throng:arena:${owner}/${project}/${task}`;

/** The stored view of a task, or nothing when storage is empty, unreadable or unavailable. */
export function readStoredView(key: string): ArenaSearch {
  try {
    const stored = localStorage.getItem(key);
    const parsed: unknown = stored === null ? null : JSON.parse(stored);
    return typeof parsed === "object" && parsed !== null ? parseArenaSearch(parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Stores a task's view, quietly doing nothing where storage is unavailable or full. */
export function storeView(key: string, search: ArenaSearch): void {
  try {
    localStorage.setItem(key, JSON.stringify(search));
  } catch {
    // Remembering the view is a convenience; the URL still carries it.
  }
}

/** One row of the by-file arrangement: a path, and each shown lane's diff of it (null: left alone). */
export interface FileRow {
  path: string;
  diffs: (FileDiff | null)[];
}

/** Every path any of `changeSets` changed, sorted, with each change set's diff of it. */
export function fileRows(changeSets: FileDiff[][]): FileRow[] {
  const paths = [...new Set(changeSets.flatMap((files) => files.map((f) => f.path)))].toSorted();
  return paths.map((path) => ({ path, diffs: changeSets.map((files) => files.find((f) => f.path === path) ?? null) }));
}
