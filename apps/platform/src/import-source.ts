// Importing a project's source: the HTTPS URL of a public git repository whose default branch a new
// project's origin starts from, copied once as `main` with its full history. This module checks the
// URL, asks the source for its default branch before anything is created, and turns Artifacts'
// import errors into the service's. See `docs/research/artifacts-import.md` (#223).

import { ServiceError } from "./errors.ts";
import { advertisedHead, concat, ProtocolError } from "./pkt-line.ts";
import { artifactsErrorCode } from "./repos.ts";

/** The longest source URL a project may name. */
export const MAX_SOURCE_URL = 2048;

/** The most redirects the probe follows, each to the same host over https. */
const MAX_REDIRECTS = 3;
/** How long the source's host has to answer the probe for its default branch. */
const PROBE_TIMEOUT_MS = 15_000;
/**
 * The most of an advertisement the probe reads: the service line, its flush and the first ref line,
 * which is at most one pkt-line long. A big repo's advertisement runs to megabytes past that.
 */
const MAX_PROBE_BYTES = 70 * 1024;
const INFO_REFS = "/info/refs";
const ADVERTISEMENT_TYPE = "application/x-git-upload-pack-advertisement";

/** A source URL `checkSourceUrl` accepted, normalized (`new URL(…).href`). */
export type SourceUrl = string & { readonly __brand: "SourceUrl" };

/**
 * `url` normalized, if it is a source a project may import: an `https:` URL of at most
 * `MAX_SOURCE_URL` characters, with no credentials (Artifacts stores the URL as the repo's source,
 * so a token in it would leak), query or fragment. Its host must be a name with a dot in it, not an
 * IP address or a single label like `localhost`, so the probe can't be aimed at a private network.
 * Throws `invalidRequest` otherwise.
 */
export function checkSourceUrl(url: string): SourceUrl {
  const parsed = parseSourceUrl(url);
  if (typeof parsed === "string") throw new ServiceError("invalidRequest", `source url ${parsed}`);
  return parsed.href as SourceUrl;
}

/**
 * The source's URL and default branch, read anonymously from its upload-pack advertisement
 * (`symref=HEAD:…`) before anything is created. A redirect (a renamed repo, say) is followed only
 * while it stays on the same host over https and passes `checkSourceUrl`, at most `MAX_REDIRECTS`
 * times, and the URL it ends at is the one returned, to import. Throws `notFound` when the host wants
 * credentials, has no such repo (GitHub answers both with 401) or redirects anywhere else,
 * `invalidRequest` when the URL serves no git repository or doesn't say which branch is the default,
 * and `unavailable` when the host can't be reached.
 */
export async function resolveSource(
  fetcher: typeof fetch,
  source: SourceUrl,
): Promise<{ url: SourceUrl; branch: string }> {
  let url = source;
  let response = await probe(fetcher, url);
  for (let hops = 0; isRedirect(response.status); hops++) {
    const next = hops < MAX_REDIRECTS ? redirectTarget(url, response.headers.get("Location")) : null;
    if (next === null) throw redirectsElsewhere(source);
    url = next;
    response = await probe(fetcher, url);
  }
  if (response.status === 401 || response.status === 404) throw notFound(url);
  if (!response.ok) throw unreachable(url);
  if (mediaType(response.headers.get("Content-Type")) !== ADVERTISEMENT_TYPE || response.body === null) {
    throw notGit(url);
  }
  let branch: string | null;
  try {
    branch = advertisedHead(await readPrefix(response.body, MAX_PROBE_BYTES));
  } catch (error) {
    if (error instanceof ProtocolError) throw notGit(url);
    throw error;
  }
  if (branch === null) throw new ServiceError("invalidRequest", `${url} doesn't name its default branch`);
  return { url, branch };
}

/** One request for `url`'s advertisement, its redirects left to the caller. */
async function probe(fetcher: typeof fetch, url: SourceUrl): Promise<Response> {
  try {
    return await fetcher(advertisementUrl(url), {
      headers: { "User-Agent": "throng" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    throw unreachable(url);
  }
}

/**
 * The repo a redirect of `url`'s advertisement points at, when it is another advertisement
 * (`…/info/refs`) on the same host that `checkSourceUrl` accepts; null for anywhere else.
 */
function redirectTarget(url: SourceUrl, location: string | null): SourceUrl | null {
  if (location === null) return null;
  let target: URL;
  try {
    target = new URL(location, advertisementUrl(url));
  } catch {
    return null;
  }
  if (!target.pathname.endsWith(INFO_REFS)) return null;
  const repo = parseSourceUrl(`${target.origin}${target.pathname.slice(0, -INFO_REFS.length)}`);
  if (typeof repo === "string" || repo.host !== new URL(url).host) return null;
  return repo.href as SourceUrl;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** A Content-Type's media type, without its parameters (`; charset=…`) and lowercased. */
function mediaType(contentType: string | null): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/** Where a smart-HTTP host advertises a repo's refs: the repo URL, ending `.git`, then `info/refs`. */
function advertisementUrl(url: string): string {
  const repo = url.replace(/\/+$/u, "");
  return `${repo.endsWith(".git") ? repo : `${repo}.git`}${INFO_REFS}?service=git-upload-pack`;
}

/** The first `max` bytes of `body` (fewer if it ends first); the rest is never read. */
async function readPrefix(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concat(chunks).subarray(0, max);
}

/**
 * The service error for an Artifacts import that failed with `error`, saying what the caller can do
 * about it; `error` itself when it isn't one the caller can act on.
 */
export function importError(error: unknown, url: string): unknown {
  switch (artifactsErrorCode(error)) {
    case "REMOTE_AUTH_REQUIRED":
    case "NOT_FOUND": {
      return notFound(url);
    }
    case "INVALID_URL":
    case "INVALID_INPUT": {
      return notGit(url);
    }
    case "MEMORY_LIMIT": {
      return new ServiceError("invalidRequest", `${url} is too large to import (Artifacts' limit is 1 GB per repo)`);
    }
    case "UPSTREAM_UNAVAILABLE": {
      return unreachable(url);
    }
    default: {
      return error;
    }
  }
}

function notFound(url: string): ServiceError {
  return new ServiceError("notFound", `${url} was not found, or is private: only public repositories can be imported`);
}

function redirectsElsewhere(url: string): ServiceError {
  return new ServiceError(
    "notFound",
    `${url} redirects elsewhere: use the repository's current https URL on its own host`,
  );
}

function notGit(url: string): ServiceError {
  return new ServiceError("invalidRequest", `${url} is not a git repository`);
}

function unreachable(url: string): ServiceError {
  return new ServiceError("unavailable", `couldn't reach ${new URL(url).host}; try again`);
}

/**
 * Whether `hostname` is an IP address. The URL parser has already normalized IPv4 written any other
 * way (`0x7f.1`, `2130706433`) to dotted decimal, and brackets IPv6.
 */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/u.test(hostname);
}

/** `url` parsed, or what is wrong with it. */
function parseSourceUrl(url: string): URL | string {
  if (url.length > MAX_SOURCE_URL) return `is over ${MAX_SOURCE_URL} characters`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "isn't a URL";
  }
  if (parsed.protocol !== "https:") return "must be https";
  if (isIpLiteral(parsed.hostname)) return "must name its host, not an IP address";
  if (!parsed.hostname.replace(/\.$/u, "").includes(".")) return "must name a public host, not one like localhost";
  if (parsed.username !== "" || parsed.password !== "") return "may not carry credentials";
  if (url.includes("?") || url.includes("#")) return "may not have a query or a fragment";
  return parsed;
}
