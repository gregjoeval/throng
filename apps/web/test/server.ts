import type { InferResponseType } from "hono/client";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { client } from "@/lib/api";

/** `GET /api/me` for a human signed in through Access, typed from the platform's routes. */
export const me: InferResponseType<typeof client.api.me.$get, 200> = {
  user: { id: "u1", handle: "ada", email: "ada@example.com", created_at: "2026-10-10T12:00:00.000Z" },
  agent: null,
  token: null,
};

/** Default platform API handlers; override per test with `server.use(...)`. */
export const handlers = [http.get("*/api/me", () => HttpResponse.json(me))];

export const server = setupServer(...handlers);
