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

/** Preview names become a DNS label (`<name>-<worker>.<subdomain>.workers.dev`), so keep them tame. */
export function previewName({ project, attempt }: { project: string; attempt: string }): string {
  return `${project}-${attempt}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}
