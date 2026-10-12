// The browser's URLs for a project's views (see the spec's **Views**), built and parsed in one place
// so every link agrees with the routes. Each segment is percent-encoded on its own: a file path keeps
// its slashes, and spaces, `#`, `?`, `%` and unicode survive the round trip.

/** The views addressed by a ref and, except for the commit log, a path. */
export const REF_VIEWS = ["tree", "blob", "raw", "commits"] as const;
export type RefView = (typeof REF_VIEWS)[number];

interface InProject {
  owner: string;
  project: string;
}

/**
 * One place in a project. A `ref` is `main`, an attempt (`t42a3`) or a full sha; `attempt` is the
 * `?attempt=` hint that tells the platform which fork to look up a sha in. `path` has no leading or
 * trailing slash, and is `""` for the root directory. `offset` is the commit log's page: how many
 * commits to skip, absent for the first page.
 */
export type ProjectLocation =
  | (InProject & { view: "home" })
  | (InProject & { view: "tasks" })
  | (InProject & { view: "task"; task: string })
  | (InProject & { view: "tree" | "blob" | "raw"; ref: string; path: string; attempt?: string })
  | (InProject & { view: "commits"; ref: string; attempt?: string; offset?: number })
  | (InProject & { view: "commit"; sha: string; attempt?: string });

const segment = (value: string) => encodeURIComponent(value);

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
    default: {
      const rest = splitPath(location.path).map(segment).join("/");
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
  const hint = attempt === null ? {} : { attempt };
  if (view === undefined) return { owner, project, view: "home" };
  if (view === "tasks" && ref === undefined) return { owner, project, view };
  if (!ref) return null;
  if (view === "tasks" && rest.length === 0) return { owner, project, view: "task", task: ref };
  if (view === "commit" && rest.length === 0) return { owner, project, view, sha: ref, ...hint };
  if (view === "commits" && rest.length === 0) {
    return { owner, project, view, ref, ...commitsSearch(Object.fromEntries(url.searchParams)) };
  }
  if (view === "tree" || view === "blob" || view === "raw") {
    if (rest.some((part) => part === "")) return null;
    return { owner, project, view, ref, path: rest.join("/"), ...hint };
  }
  return null;
}

/** The search params of a ref-addressed route: only the `?attempt=` hint, when it's a string. */
export function attemptSearch(search: Record<string, unknown>): { attempt?: string } {
  return typeof search["attempt"] === "string" ? { attempt: search["attempt"] } : {};
}

/** The commit log's search params: the `?attempt=` hint, and `?offset=` when it's a positive integer. */
export function commitsSearch(search: Record<string, unknown>): { attempt?: string; offset?: number } {
  const offset = Number(search["offset"]);
  return { ...attemptSearch(search), ...(Number.isSafeInteger(offset) && offset > 0 ? { offset } : {}) };
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
