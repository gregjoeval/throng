// Worker Previews of an attempt: who may deploy them, and what they're called.

/** Lets the sandbox deploy Previews of one Worker; the API token itself stays in the Worker's env. */
export interface PreviewGrant {
  accountId: string;
  workerName: string;
}

/** Only the Worker being previewed (and the account's workers.dev subdomain lookup). */
export function previewPathAllowed(path: string, { accountId, workerName }: PreviewGrant): boolean {
  const workers = `/client/v4/accounts/${accountId}/workers/`;
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

/** A DNS label's limit; a Preview's host label is `<previewName>-<workerName>`. */
export const MAX_LABEL = 63;
const HASH_LENGTH = 8;

/**
 * A Preview's name, per the fork-naming decision: `<forkName>-p<projectId>`, e.g. `t42a3-pabc123`.
 * When the host label (`<name>-<workerName>`) would pass 63 characters, the name keeps its start
 * plus a short hash of the full name, so distinct attempts keep distinct Previews.
 */
export function previewName({ project, attempt }: { project: string; attempt: string }, workerName: string): string {
  const full = `${attempt}-p${project}`;
  const room = MAX_LABEL - workerName.length - 1;
  if (full.length <= room) return full;
  const start = full.slice(0, Math.max(0, room - HASH_LENGTH - 1)).replace(/-+$/u, "");
  return `${start}-${hash(full)}`;
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
