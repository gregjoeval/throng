// Each project's own preview Worker, `p<projectId>`, in the Cloudflare account: created with the
// project and deleted with it. The API token stays in the platform Worker's env; a `preview` container
// can only deploy Previews under its project's Worker (`previewGrant`), never create or delete one.

import { previewWorkerName } from "./preview.ts";

const API = "https://api.cloudflare.com/client/v4";

/** The project's preview Worker, by project id. */
export interface PreviewWorkers {
  /** Creates the project's Worker unless it already exists, so it's safe to retry. */
  ensure: (project: string) => Promise<void>;
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
  const workers = `${API}/accounts/${accountId}/workers/workers`;
  const call = (method: string, url: string, body?: object) =>
    fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    async ensure(project) {
      const name = previewWorkerName(project);
      const found = await call("GET", `${workers}/${name}`);
      if (found.ok) return;
      if (found.status !== 404) throw await apiError(`look up Worker ${name}`, found);
      // As `wrangler preview` creates a missing parent Worker: workers.dev and its Preview URLs on.
      const created = await call("POST", workers, { name, subdomain: { enabled: true, previews_enabled: true } });
      if (!created.ok) throw await apiError(`create Worker ${name}`, created);
    },

    async delete(project) {
      const name = previewWorkerName(project);
      const deleted = await call("DELETE", `${workers}/${name}`);
      if (!deleted.ok && deleted.status !== 404) throw await apiError(`delete Worker ${name}`, deleted);
    },
  };
}

/** The environment's preview Workers: its account, with the Worker's Preview token. */
export function previewWorkersFor(env: { CF_ACCOUNT_ID: string; CF_PREVIEW_TOKEN: string }): PreviewWorkers {
  return cloudflarePreviewWorkers({ accountId: env.CF_ACCOUNT_ID, token: env.CF_PREVIEW_TOKEN });
}

async function apiError(what: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`could not ${what}: ${response.status} ${body.slice(0, 500)}`);
}
