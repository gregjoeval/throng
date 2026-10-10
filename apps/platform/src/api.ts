import { Hono } from "hono";
import { accessSession, type AccessBindings, type AccessEnv, type AccessVerifier } from "./access.ts";

/**
 * The product API, mounted at `/api`. Access does not sit in front of it: machine clients will use
 * bearer tokens. Until those land, `/me` accepts an Access session.
 */
export function apiRoutes(verifierFor?: (env: AccessBindings) => AccessVerifier) {
  const api = new Hono<AccessEnv>();
  api.get("/me", accessSession(verifierFor), (c) => c.json(c.var.user));
  return api;
}
