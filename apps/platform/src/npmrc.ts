// The registry hosts a project's `.npmrc` names. Like `.throng/config.yml`, it is read from the
// origin's `main` only, so an attempt can't add hosts to its own allowlist. The hosts are reached
// read-only and without credentials (see `network.ts`); private registry credentials are #66.

import { HOSTNAME, isHttpsOnDefaultPort } from "./network.ts";
import { readOriginFile } from "./repos.ts";
import type { Repos } from "./repos.ts";

export const NPMRC_PATH = ".npmrc";

/** `registry=` and `@scope:registry=`, with the URL as the value. */
const REGISTRY_LINE = /^\s*(?:@[^\s:=]+:)?registry\s*=\s*(.*?)\s*$/u;

/**
 * The hostnames of the default and scoped registries in an `.npmrc`, each once, in file order. Only
 * `https:` URLs on the default port whose host is a `HOSTNAME` count; every other line, auth lines
 * included, is ignored.
 */
export function parseRegistries(npmrc: string): string[] {
  const hosts = new Set<string>();
  for (const line of npmrc.split(/\r?\n/u)) {
    const value = REGISTRY_LINE.exec(line)?.[1];
    if (value === undefined || !URL.canParse(value)) continue;
    const url = new URL(value);
    if (isHttpsOnDefaultPort(url) && HOSTNAME.test(url.hostname)) hosts.add(url.hostname);
  }
  return [...hosts];
}

/**
 * The registry hosts in the `.npmrc` on the origin's `main`, or at the commit of it `ref` names; none
 * when there's no `.npmrc`. A read that fails throws, as reading the config does, so a Workflow step
 * retries it rather than going on without the registries.
 */
export async function loadRegistries(repos: Repos, projectId: string, ref = "main"): Promise<string[]> {
  const npmrc = await readOriginFile(repos, projectId, NPMRC_PATH, ref);
  return npmrc === null ? [] : parseRegistries(npmrc);
}
