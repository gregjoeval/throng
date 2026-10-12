// The two ways into the platform's HTTP API. The public hostname (the Worker's default export) serves
// agents and git with Throng tokens. throng-web reaches the `WebEntrypoint` named entrypoint over its
// `PLATFORM` service binding, which is the only path that trusts a forwarded Access identity: named
// entrypoints aren't routable from the internet, so public traffic can't reach that code at all.

import { Hono } from "hono";
import type { AccessBindings } from "./access.ts";
import { apiRoutes } from "./api.ts";
import type { ApiOptions } from "./api.ts";
import { rejectForwardedIdentity } from "./auth.ts";

type Options = Omit<ApiOptions, "trustForwardedIdentity">;

/** The public hostname's app: `/api` with bearer and Access auth, refusing forwarded identities. */
export function publicApp<B extends AccessBindings>(options: Options = {}) {
  const app = new Hono<{ Bindings: B }>();
  app.use(rejectForwardedIdentity());
  app.route("/api", apiRoutes(options));
  return app;
}

/** The service binding's app: `/api`, where throng-web's forwarded identity counts as an Access session. */
export function webApp<B extends AccessBindings>(options: Options = {}) {
  return new Hono<{ Bindings: B }>().route("/api", apiRoutes({ ...options, trustForwardedIdentity: true }));
}

/** The routes throng-web reaches over the binding, for its typed `hc` client. */
export type AppType = ReturnType<typeof webApp>;
