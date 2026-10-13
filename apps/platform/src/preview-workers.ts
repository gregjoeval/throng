// Each project's own preview Worker, `p<projectId>`, in the Cloudflare account: created with the
// project and deleted with it. The API token stays in the platform Worker's env; a `preview` container
// can only deploy Previews under its project's Worker (`previewGrant`), never create one.

import { CLOUDFLARE_API_HOST } from "./network.ts";
import { previewWorkerName, workersApiPath } from "./preview.ts";

/** The API's error codes for a missing Worker, as `wrangler` reads them (`isWorkerNotFoundError`). */
const WORKER_NOT_FOUND_CODES = [10_007, 10_090];

/** The project's preview Worker, by project id. */
export interface PreviewWorkers {
  /**
   * Creates the project's Worker unless it already exists, so it's safe to retry. True only when
   * this call created it, so a caller rolling back deletes only what it made.
   */
  ensure: (project: string) => Promise<boolean>;
  /** Deletes the project's Worker and its Previews. A missing Worker counts as deleted. */
  delete: (project: string) => Promise<void>;
}

/** `PreviewWorkers` over the Cloudflare API's Workers endpoints, with a token that can edit Workers. */
export function cloudflarePreviewWorkers({
  accountId,
  token,
  fetch = (input, init) => globalThis.fetch(input, init),
}: {
  accountId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): PreviewWorkers {
  const workers = `https://${CLOUDFLARE_API_HOST}${workersApiPath(accountId)}/workers`;
  const call = (method: string, url: string, body?: object) =>
    fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** Whether the Worker exists; throws on anything but found or not found. */
  const exists = async (name: string) => {
    const found = await call("GET", `${workers}/${name}`);
    if (found.ok) return true;
    if (await notFound(found)) return false;
    throw await apiError(`look up Worker ${name}`, found);
  };

  return {
    async ensure(project) {
      const name = previewWorkerName(project);
      if (await exists(name)) return false;
      // As `wrangler preview` creates a missing parent Worker: workers.dev and its Preview URLs on.
      const created = await call("POST", workers, { name, subdomain: { enabled: true, previews_enabled: true } });
      if (created.ok) return true;
      // A concurrent call may have created it in between; then it's there, but not ours.
      const error = await apiError(`create Worker ${name}`, created);
      if (await exists(name)) return false;
      throw error;
    },

    async delete(project) {
      const name = previewWorkerName(project);
      const deleted = await call("DELETE", `${workers}/${name}`);
      if (!deleted.ok && !(await notFound(deleted))) throw await apiError(`delete Worker ${name}`, deleted);
    },
  };
}

/** The environment's preview Workers: its account, with the Worker's Preview token. */
export function previewWorkersFor(env: { CF_ACCOUNT_ID: string; CF_PREVIEW_TOKEN: string }): PreviewWorkers {
  return cloudflarePreviewWorkers({ accountId: env.CF_ACCOUNT_ID, token: env.CF_PREVIEW_TOKEN });
}

/** Whether a failed response says the Worker doesn't exist: a 404, or the API's not-found code. */
async function notFound(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { errors?: { code?: unknown }[] } | null;
  return body?.errors?.some((e) => WORKER_NOT_FOUND_CODES.includes(Number(e.code))) ?? false;
}

async function apiError(what: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`could not ${what}: ${response.status} ${body.slice(0, 500)}`);
}
