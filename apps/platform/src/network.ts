// Hosts a check may reach without a grant. Requests pass through unchanged: no credentials are added.

export const NPM_REGISTRY_HOST = "registry.npmjs.org";

/** Installs only read from the registry; anything that would publish or log in is refused. */
export function registryAllows(method: string, url: URL): boolean {
  return url.protocol === "https:" && url.host === NPM_REGISTRY_HOST && (method === "GET" || method === "HEAD");
}
