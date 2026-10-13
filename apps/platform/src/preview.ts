// Worker Previews of an attempt: who may deploy them, and what they're called.

/** Lets the sandbox deploy Previews of one Worker; the API token itself stays in the Worker's env. */
export interface PreviewGrant {
  accountId: string;
  workerName: string;
}

/** The Cloudflare API path every Workers endpoint of the account sits under. */
export function workersApiPath(accountId: string): string {
  return `/client/v4/accounts/${accountId}/workers`;
}

/**
 * Only the Worker being previewed (and the account's workers.dev subdomain lookup), and never a
 * `DELETE`: a Preview never deletes anything, and one attempt's build mustn't delete its project's
 * Worker, which holds every other attempt's Preview too.
 */
export function previewAllows(method: string, path: string, { accountId, workerName }: PreviewGrant): boolean {
  if (method === "DELETE") return false;
  const workers = `${workersApiPath(accountId)}/`;
  if (!path.startsWith(workers)) return false;
  const rest = path.slice(workers.length);
  return (
    rest === "subdomain" ||
    rest.startsWith(`scripts/${workerName}/`) ||
    rest === `scripts/${workerName}` ||
    rest.startsWith(`workers/${workerName}/`) ||
    rest === `workers/${workerName}`
  );
}

/**
 * A project's own Worker, `p<projectId>`, per the fork-naming decision. Every Preview of the project's
 * attempts deploys under it, so projects never share a Worker's Previews, limits or settings.
 */
export function previewWorkerName(project: string): string {
  return `p${project}`;
}

/** The Preview deploy grant for one project: its own Worker, never another project's. */
export function previewGrant(accountId: string, project: string): PreviewGrant {
  return { accountId, workerName: previewWorkerName(project) };
}

/** A DNS label's limit; a Preview's host label is `<previewName>-<workerName>`. */
export const MAX_LABEL = 63;
const HASH_LENGTH = 8;

/**
 * A Preview's name: the attempt's fork name (`t42a3`), so under the project's Worker its host label
 * is `<forkName>-p<projectId>`, per the fork-naming decision. When that label would pass 63
 * characters, the name keeps the fork name's start plus a short hash of it, so distinct attempts keep
 * distinct Previews.
 */
export function previewName({ project, attempt }: { project: string; attempt: string }): string {
  const room = MAX_LABEL - previewWorkerName(project).length - 1;
  if (attempt.length <= room) return attempt;
  const start = attempt.slice(0, Math.max(0, room - HASH_LENGTH - 1)).replace(/-+$/u, "");
  return `${start}-${hash(attempt)}`;
}

/** FNV-1a, as 8 base-36 characters: short, stable and synchronous. Not for anything secret. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(HASH_LENGTH, "0").slice(-HASH_LENGTH);
}
