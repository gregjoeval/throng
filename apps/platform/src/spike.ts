// The spike control plane's way into real projects, for the e2e suite (`scripts/e2e.ts`). The suite
// has no Access session, so it can't mint its first Throng token; and its projects must be named
// after the run (E2E_PROJECT_PREFIX) so cleanup finds their repos. Goes with the `/spike/*` routes.

import { type Project, projectService } from "./projects.ts";
import { originRepo, type Repos } from "./repos.ts";
import { mintToken } from "./tokens.ts";
import { type Database, type User, userForEmail } from "./users.ts";

/** The e2e suite's user. `.invalid` never resolves, so nothing is ever sent to it. */
export const SPIKE_EMAIL = "e2e@throng.invalid";
/** Long enough for a whole e2e run. */
const SPIKE_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const ORIGIN_TOKEN_TTL_SECONDS = 60 * 60;

/** Mints a Throng token for the e2e user, creating the user on first use. */
export async function spikeToken(db: Database, now: Date): Promise<{ token: string; user: User }> {
  const user = await userForEmail(db, SPIKE_EMAIL);
  const { plaintext } = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: SPIKE_TOKEN_TTL_SECONDS, now });
  return { token: plaintext, user };
}

/**
 * Creates a project owned by the e2e user whose id and handle are both `id`, and returns a write
 * token for its origin. The git proxy refuses pushes to the origin's `main`, so the suite seeds it
 * straight through Artifacts with that token.
 */
export async function spikeProject(
  db: Database,
  repos: Repos,
  id: string,
): Promise<{ project: Project; remote: string; token: string }> {
  const user = await userForEmail(db, SPIKE_EMAIL);
  const project = await projectService({ db, repos, newId: () => id }).create({ user, agent: null }, { handle: id });
  const [origin, { token }] = await Promise.all([
    repos.get(originRepo(id)),
    repos.mintToken(originRepo(id), "write", ORIGIN_TOKEN_TTL_SECONDS),
  ]);
  return { project, remote: origin.remote, token };
}
