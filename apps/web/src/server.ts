// The Worker's entry: `/api/*` goes to the platform, and so do raw file URLs
// (`/:owner/:project/raw/:ref/*`, as the platform's raw endpoint). Everything else is TanStack Start.

import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { rawApiUrl } from "./lib/paths";
import { devAccessVerifier, remoteAccessVerifier } from "./server/access";
import { forwardToPlatform, isApiRequest } from "./server/forward";

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    const raw = rawApiUrl(url);
    if (raw === null && !isApiRequest(url)) return handler.fetch(request);
    const verify =
      THRONG_DEV_EMAIL === null
        ? remoteAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD })
        : devAccessVerifier(THRONG_DEV_EMAIL);
    return forwardToPlatform(raw === null ? request : new Request(raw, request), env.PLATFORM, verify);
  },
});
