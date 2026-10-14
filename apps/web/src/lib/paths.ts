// The browser's URLs for a project's views (see the spec's **Views**), built and parsed in one place
// so every link agrees with the routes. Each segment is percent-encoded on its own: a file path keeps
// its slashes, and spaces, `#`, `?`, `%` and unicode survive the round trip.

import { isRunStatus } from "@throng/platform/run-status";
import type { RunStatus } from "@throng/platform/run-status";

/** The views addressed by a ref and, except for the commit log, a path. */
export const REF_VIEWS = ["tree", "blob", "raw", "commits"] as const;
export type RefView = (typeof REF_VIEWS)[number];

interface InProject {
  owner: string;
  project: string;
}

/** The project a location is in, without the rest of the location. */
export function projectRefOf({ owner, project }: InProject): InProject {
  return { owner, project };
}

/**
 * One place in a project. A `ref` is `main`, an attempt (`t42a3`) or a full sha; `attempt` is the
 * `?attempt=` hint that tells the platform which fork to look up a sha in. `path` has no leading or
 * trailing slash, and is `""` for the root directory. `offset` is the commit log's page: how many
 * commits to skip, absent for the first page. The runs list's `line` and `status` filter it, and its
 * `cursor` is the run id a page starts below. A compare is the diff from `from`'s tree to `to`'s,
 * each a ref.
 */
export type ProjectLocation =
  | (InProject & { view: "home" })
  | (InProject & { view: "tasks" })
  | (InProject & { view: "settings" })
  | (InProject & { view: "runs" } & RunsSearch)
  | (InProject & { view: "run"; run: number })
  | (InProject & { view: "task"; task: string })
  | (InProject & { view: "tree" | "blob" | "raw"; ref: string; path: string; attempt?: string })
  | (InProject & { view: "commits"; ref: string; attempt?: string; offset?: number })
  | (InProject & { view: "commit"; sha: string; attempt?: string })
  | (InProject & { view: "compare"; from: string; to: string; attempt?: string });

/** A place addressed by a ref and a path: a directory, a file or a file's raw bytes. */
export type BrowseLocation = Extract<ProjectLocation, { path: string }>;

const segment = (value: string) => encodeURIComponent(value);

/** A repository path as a URL path: each segment percent-encoded, empty segments dropped. */
export function encodePath(path: string): string {
  return splitPath(path).map(segment).join("/");
}

/** The pathname (and `?attempt=` query, if any) for a location. */
export function buildPath(location: ProjectLocation): string {
  const base = `/${segment(location.owner)}/${segment(location.project)}`;
  let path: string;
  switch (location.view) {
    case "home": {
      return base;
    }
    case "tasks": {
      return `${base}/tasks`;
    }
    case "settings": {
      return `${base}/settings`;
    }
    case "runs": {
      const { line, status, cursor } = location;
      const query = new URLSearchParams({
        ...(line === undefined ? {} : { line }),
        ...(status === undefined ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor: String(cursor) }),
      }).toString();
      return query === "" ? `${base}/runs` : `${base}/runs?${query}`;
    }
    case "run": {
      return `${base}/runs/${location.run}`;
    }
    case "task": {
      return `${base}/tasks/${segment(location.task)}`;
    }
    case "commit": {
      path = `${base}/commit/${segment(location.sha)}`;
      break;
    }
    case "commits": {
      path = `${base}/commits/${segment(location.ref)}`;
      break;
    }
    case "compare": {
      path = `${base}/compare/${segment(compareRange(location))}`;
      break;
    }
    default: {
      const rest = encodePath(location.path);
      path = `${base}/${location.view}/${segment(location.ref)}${rest === "" ? "" : `/${rest}`}`;
    }
  }
  const query = new URLSearchParams();
  if (location.attempt !== undefined) query.set("attempt", location.attempt);
  if (location.view === "commits" && location.offset) query.set("offset", String(location.offset));
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
}

/**
 * The location an href or pathname points at, or null when it isn't one of a project's views. Only
 * the pathname and the `attempt` query parameter (and the commit log's `offset`) are read.
 */
export function parsePath(href: string): ProjectLocation | null {
  const url = new URL(href, "http://throng.invalid");
  const parts = url.pathname.split("/").slice(1);
  if (parts.at(-1) === "") parts.pop();
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [owner, project, view, ref, ...rest] = decoded;
  if (!owner || !project) return null;
  const attempt = url.searchParams.get("attempt");
  const hint = attemptHint(attempt ?? undefined);
  if (view === undefined) return { owner, project, view: "home" };
  if ((view === "tasks" || view === "settings") && ref === undefined) return { owner, project, view };
  if (view === "runs" && ref === undefined) {
    return { owner, project, view, ...runsSearch(Object.fromEntries(url.searchParams)) };
  }
  if (!ref) return null;
  if (view === "runs" && rest.length === 0) {
    const run = runId(ref);
    return run === null ? null : { owner, project, view: "run", run };
  }
  if (view === "tasks" && rest.length === 0) return { owner, project, view: "task", task: ref };
  if (view === "commit" && rest.length === 0) return { owner, project, view, sha: ref, ...hint };
  if (view === "compare" && rest.length === 0) {
    const range = parseRange(ref);
    return range === null ? null : { owner, project, view, ...range, ...hint };
  }
  if (view === "commits" && rest.length === 0) {
    return { owner, project, view, ref, ...commitsSearch(Object.fromEntries(url.searchParams)) };
  }
  if (view === "tree" || view === "blob" || view === "raw") {
    if (rest.some((part) => part === "")) return null;
    return { owner, project, view, ref, path: rest.join("/"), ...hint };
  }
  return null;
}

/** The `attempt` hint to spread into a location or a query: there only when there is one. */
export function attemptHint(attempt: string | undefined): { attempt?: string } {
  return attempt === undefined ? {} : { attempt };
}

/** The search params of a ref-addressed route: only the `?attempt=` hint, when it's a string. */
export function attemptSearch(search: Record<string, unknown>): { attempt?: string } {
  const attempt = search["attempt"];
  return attemptHint(typeof attempt === "string" ? attempt : undefined);
}

/** The commit log's search params: the `?attempt=` hint, and `?offset=` when it's a positive integer. */
export function commitsSearch(search: Record<string, unknown>): { attempt?: string; offset?: number } {
  const offset = Number(search["offset"]);
  return { ...attemptSearch(search), ...(Number.isSafeInteger(offset) && offset > 0 ? { offset } : {}) };
}

/** A compare's two refs as its URL segment carries them: `from...to`. */
export function compareRange({ from, to }: { from: string; to: string }): string {
  return `${from}...${to}`;
}

/** The two refs of a compare's `from...to` segment, or null when it isn't one. */
export function parseRange(range: string): { from: string; to: string } | null {
  const [from, to, ...rest] = range.split("...");
  return from && to && rest.length === 0 ? { from, to } : null;
}

/** The runs list's filters and page, as its URL carries them: each only when set. */
export interface RunsSearch {
  /** `main`, `tasks` (every line but `main`), or one line; every line when absent. */
  line?: string | undefined;
  status?: RunStatus | undefined;
  cursor?: number | undefined;
}

/** The runs list's search params: `?line=`, `?status=` (a run status) and `?cursor=`, each kept only when well-formed. */
export function runsSearch(search: Record<string, unknown>): RunsSearch {
  const { line, status } = search;
  const cursor = runId(String(search["cursor"]));
  return {
    ...(typeof line === "string" && line !== "" ? { line } : {}),
    ...(typeof status === "string" && isRunStatus(status) ? { status } : {}),
    ...(cursor === null ? {} : { cursor }),
  };
}

/** A run id from a URL: a positive integer, or null. */
export function runId(value: string): number | null {
  return /^[1-9]\d{0,14}$/u.test(value) ? Number(value) : null;
}

const MARKDOWN = /\.(?:md|markdown|mdown|mkd)$/iu;

/** Whether a path names a Markdown file. */
export function isMarkdown(path: string): boolean {
  return MARKDOWN.test(path);
}

/**
 * What a Markdown file's relative links and images resolve against: its directory in the file view
 * and under `/raw` (each ending in `/`), and the `?attempt=` hint each resolved URL carries.
 */
export function markdownLinks(at: BrowseLocation) {
  const dir = splitPath(at.path).slice(0, -1).join("/");
  const { owner, project, ref } = at;
  const base = (view: "blob" | "raw") => `${buildPath({ view, owner, project, ref, path: dir })}/`;
  return { baseUrl: base("blob"), imageBaseUrl: base("raw"), search: attemptHint(at.attempt) };
}

/** A path's segments, ignoring leading, trailing and doubled slashes. */
export function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/**
 * The platform endpoint behind a `/raw/` URL: the same path under `/api/projects`, with its query.
 * Null for any other URL.
 */
export function rawApiUrl(url: URL): URL | null {
  const location = parsePath(url.href);
  if (location?.view !== "raw" || location.path === "") return null;
  return new URL(`/api/projects${buildPath(location)}`, url);
}
