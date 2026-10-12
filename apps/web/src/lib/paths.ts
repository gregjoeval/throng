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
 * trailing slash, and is `""` for the root directory.
 */
export type ProjectLocation =
  | (InProject & { view: "home" })
  | (InProject & { view: "tree" | "blob" | "raw"; ref: string; path: string; attempt?: string })
  | (InProject & { view: "commits"; ref: string; attempt?: string })
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
  return location.attempt === undefined ? path : `${path}?${new URLSearchParams({ attempt: location.attempt })}`;
}

/**
 * The location an href or pathname points at, or null when it isn't one of a project's views. Only
 * the pathname and the `attempt` query parameter are read.
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
  if (!ref) return null;
  if (view === "commit" && rest.length === 0) return { owner, project, view, sha: ref, ...hint };
  if (view === "commits" && rest.length === 0) return { owner, project, view, ref, ...hint };
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
