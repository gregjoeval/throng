import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

/** Default platform API handlers; override per test with `server.use(...)`. */
export const handlers = [http.get("*/api/me", () => HttpResponse.json({ name: "ada" }))];

export const server = setupServer(...handlers);
