// The origin agents and git reach the platform at, for every URL it hands out: the mint response's
// `url`, `llms.txt`, the MCP server's and attempts' git remotes.

/** What `publicOrigin` reads from the Worker's env. */
export interface PublicOriginBindings {
  /** The platform's public URL, e.g. `https://throng.example.workers.dev`. */
  PUBLIC_URL?: string;
}

/**
 * `PUBLIC_URL`, or when that's unset or empty (tests, local dev), the origin `url` came in on. Over
 * throng-web's binding the request's origin is throng-web's, which serves only `/api`, so deployed
 * environments set it.
 */
export function publicOrigin(env: PublicOriginBindings, url: string): string {
  return env.PUBLIC_URL || new URL(url).origin;
}
