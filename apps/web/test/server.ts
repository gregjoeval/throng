import type { InferResponseType } from "hono/client";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { client } from "@/lib/api";

/** `GET /api/me` for a human signed in through Access, typed from the platform's routes. */
export const me: InferResponseType<typeof client.api.me.$get, 200> = {
  user: { id: "u1", handle: "ada", email: "ada@example.com", createdAt: "2026-10-10T12:00:00.000Z" },
  alias: null,
  token: null,
};

type Project = InferResponseType<typeof client.api.projects.$get, 200>["projects"][number];

/** A project owned by `ada`, as the platform returns it. */
export function project(handle: string, owner = me.user): Project {
  return { id: `id-${handle}`, handle, owner: { id: owner.id, handle: owner.handle }, createdAt: me.user.createdAt };
}

/** `ada`'s projects in the default handlers. */
export const projects: Project[] = [project("alpha"), project("beta")];

export const notFound = (message: string) =>
  HttpResponse.json({ error: { code: "notFound", message } }, { status: 404 });

/** Default platform API handlers; override per test with `server.use(...)`. */
export const handlers = [
  http.get("*/api/me", () => HttpResponse.json(me)),
  http.get("*/api/projects", () => HttpResponse.json({ projects })),
  http.get("*/api/projects/:owner/:project", ({ params }) => {
    const found = projects.find((p) => p.owner.handle === params["owner"] && p.handle === params["project"]);
    return found === undefined
      ? notFound(`no project ${params["owner"]}/${params["project"]}`)
      : HttpResponse.json(found);
  }),
];

export const server = setupServer(...handlers);
