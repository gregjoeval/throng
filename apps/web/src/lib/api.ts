// The platform API from the browser: a typed `hc` client over same-origin `/api/*`, which throng-web
// forwards to the platform with the signed-in user attached (see `src/server/forward.ts`).

import { queryOptions } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { AppType } from "@throng/platform/app";
import { hc, parseResponse } from "hono/client";
import type { ClientResponse } from "hono/client";

/**
 * Same-origin, so the browser's Access session rides along. Calls go through the global `fetch` at
 * request time, which is what Mock Service Worker intercepts in tests.
 */
export const client = hc<AppType>("/", { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) });

/**
 * Query options for one platform call. The data is the endpoint's success body, typed from the
 * platform's routes; any other status rejects with hono's `DetailedError`.
 *
 * @example useQuery(apiQuery(["me"], (init) => client.api.me.$get(undefined, { init })))
 */
export function apiQuery<const K extends QueryKey, R extends ClientResponse<unknown>>(
  queryKey: K,
  request: (init: RequestInit) => Promise<R>,
) {
  return queryOptions({ queryKey, queryFn: ({ signal }) => parseResponse(request({ signal })) });
}

/** The caller: their user, and the alias and token they act with (both null in the browser). */
export const meQuery = apiQuery(["me"], (init) => client.api.me.$get(undefined, { init }));

/** The projects the signed-in user owns, by handle. */
export const projectsQuery = apiQuery(["projects"], (init) => client.api.projects.$get(undefined, { init }));

/** One project by its owner's handle and its own; a 404 means there's no such project. */
export const projectQuery = (owner: string, project: string) =>
  apiQuery(["projects", owner, project], (init) =>
    client.api.projects[":owner"][":project"].$get({ param: { owner, project } }, { init }),
  );

/** Creates a project owned by the signed-in user. Rejects with hono's `DetailedError` on failure. */
export async function createProject(handle: string) {
  return parseResponse(client.api.projects.$post({ json: { handle } }));
}
