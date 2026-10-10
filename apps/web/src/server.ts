// The Worker's entry: `/api/*` goes to the platform, everything else to TanStack Start.

import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { remoteAccessVerifier } from "./server/access";
import { forwardToPlatform, isApiRequest } from "./server/forward";

export default createServerEntry({
  async fetch(request) {
    if (!isApiRequest(new URL(request.url))) return handler.fetch(request);
    const verify = remoteAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    return forwardToPlatform(request, env.PLATFORM, verify);
  },
});
