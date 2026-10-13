// The registry hosts a project's `.npmrc` names. Like `.throng/config.yml`, it is read from the
// origin's `main` only, so an attempt can't add hosts to its own allowlist. The hosts are reached
// read-only and without credentials (see `network.ts`); private registry credentials are #66.

import { originRepo } from "./repos.ts";
import type { Repos } from "./repos.ts";

export const NPMRC_PATH = ".npmrc";

/** `registry=` and `@scope:registry=`, with the URL as the value. */
const REGISTRY_LINE = /^\s*(?:@[^\s:=]+:)?registry\s*=\s*(.*?)\s*$/u;

/**
 * The hostnames of the default and scoped registries in an `.npmrc`, each once, in file order.
 * Only `https:` URLs on the default port count; auth lines and every other setting are ignored.
 */
export function parseRegistries(npmrc: string): string[] {
  const hosts = new Set<string>();
  for (const line of npmrc.split(/\r?\n/u)) {
    const value = REGISTRY_LINE.exec(line)?.[1];
    if (value === undefined || !URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.protocol === "https:" && url.port === "") hosts.add(url.hostname);
  }
  return [...hosts];
}

/** The registry hosts in the `.npmrc` on the origin's `main`; none when it is missing or can't be read. */
export async function loadRegistries(repos: Repos, projectId: string): Promise<string[]> {
  try {
    const file = await repos.readFile(originRepo(projectId), { ref: "main", path: NPMRC_PATH });
    return file === null ? [] : parseRegistries(await file.text());
  } catch (error) {
    console.warn({ event: "scoring.npmrc_unreadable", project: projectId, error: String(error) });
    return [];
  }
}
