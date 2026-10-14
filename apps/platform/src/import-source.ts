// Importing a project's source: the HTTPS URL of a public git repository whose default branch a new
// project's origin starts from, copied once as `main` with its full history. This module checks the
// URL, asks the source for its default branch before anything is created, and turns Artifacts'
// import errors into the service's. See `docs/research/artifacts-import.md` (#223).

import { ServiceError } from "./errors.ts";
import { advertisedHead, concat, ProtocolError } from "./pkt-line.ts";
import { artifactsErrorCode } from "./repos.ts";

/** The longest source URL a project may name. */
export const MAX_SOURCE_URL = 2048;

/** How long the source's host has to answer the probe for its default branch. */
const PROBE_TIMEOUT_MS = 15_000;
/**
 * The most of an advertisement the probe reads: the service line, its flush and the first ref line,
 * which is at most one pkt-line long. A big repo's advertisement runs to megabytes past that.
 */
const MAX_PROBE_BYTES = 70 * 1024;
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
 * The source's default branch, read anonymously from its upload-pack advertisement (`symref=HEAD:…`)
 * before anything is created. Throws `notFound` when the host wants credentials or has no such repo
 * (GitHub answers both with 401), `invalidRequest` when the URL serves no git repository or doesn't
 * say which branch is the default, and `unavailable` when the host can't be reached.
 */
export async function sourceDefaultBranch(fetcher: typeof fetch, url: SourceUrl): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(advertisementUrl(url), {
      headers: { "User-Agent": "throng" },
      // A redirect isn't followed, so the probe only ever asks the host `checkSourceUrl` accepted.
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    throw unreachable(url);
  }
  // A redirect is how some hosts send an anonymous client to sign in to a private repo.
  if (response.status === 401 || response.status === 404 || isRedirect(response.status)) throw notFound(url);
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
  return branch;
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
  return `${repo.endsWith(".git") ? repo : `${repo}.git`}/info/refs?service=git-upload-pack`;
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
