# throng (platform)

The platform Worker: the API, the git-facing repos in Artifacts, and checks.

## Entrypoints

- **Default export**: the public hostname. Agents and git use Throng tokens; humans can use an Access JWT on `/api/me` and `/api/tokens`. Any request carrying `X-Throng-Access-Email` is rejected with a 401.
- **`WebEntrypoint`**: throng-web's `PLATFORM` service binding targets it by name. It serves `/api` and trusts `X-Throng-Access-Email`, which throng-web sets only after verifying the Access JWT itself. Named entrypoints can't be reached from the internet, so this is the only path where the header counts. Deploy the platform before throng-web, so the entrypoint exists when the binding is created.

`src/app.ts` builds both, and exports `AppType` for throng-web's typed `hc` client.

## Scoring logs

Each scoring run copies the log of every `setup` command, check and preview to the `LOGS` R2 bucket at `logs/<projectId>/<t42a3>/<sha>/<runId>/<name>.log` (`src/logs.ts`). A setup command's log is named `setup.<n>`, a check's is its name, and the preview's is `preview.deploy`; check names can't contain a dot, so they never collide. Logs over 5 MB keep their head and tail with a `[throng: truncated …]` marker between them. The run's result lists the logs it stored, and `GET /api/projects/{owner}/{project}/runs/{runId}/logs/{name}` streams one as text, or answers `notFound` once it's missing or expired.

There's one bucket per environment: `throng-logs`, and `throng-ci-logs` for `ci`. Logs are deleted after 30 days by an R2 lifecycle rule. Wrangler's config can't declare lifecycle rules, so they live in `r2-lifecycle.json`, which CI applies before each deploy (see the setup below).

## E2E job

The **E2E** workflow (`.github/workflows/e2e.yml`) runs `pnpm e2e` against real Artifacts. It deploys the `ci` environment in `wrangler.jsonc`: the `throng-ci` Worker, Artifacts namespace `throng-ci` and D1 database `throng-ci`. It also deploys throng-web's `ci` environment, `throng-web-ci`, bound to `throng-ci`, for the `arena` scenario. It never runs on pull requests or forks, only when started by hand on `gregjoeval/throng`. Runs queue rather than overlap.

Each run:

1. Generates a random `SPIKE_TOKEN`.
2. Applies D1 migrations to `throng-ci`.
3. Builds with `CLOUDFLARE_ENV=ci` and deploys `throng-ci`, setting `SPIKE_TOKEN` and `CF_PREVIEW_TOKEN` (the deploy's own API token).
4. Builds and deploys `throng-web-ci` the same way, installs Playwright's Chromium, and waits for `throng-web-ci` to answer.
5. Runs the e2e scenarios. Every project id starts with `e2eci<run id>r<attempt>p`. Each scenario deletes what its projects made, and the suite revokes its Throng token when it ends.
6. Always deletes everything under that prefix with `pnpm e2e cleanup`, even when the suite fails or is cancelled: each project's D1 row, its Durable Object's storage, its logs in R2 and its repos.

The suite reaches the Worker through its e2e routes, `/e2e/*`, behind the `SPIKE_TOKEN` bearer secret. They refuse any project or repo whose id doesn't start with `e2e`, so they can't reach a real project, and `E2E_PROJECT_PREFIX` must start with `e2e` too.

### Running it

Go to **Actions → E2E → Run workflow** on `main` (or a branch, to test it before merging). Leave **scenarios** empty to run them all, or name some, such as `zeroconfig conflict`. From a terminal:

```bash
gh workflow run e2e.yml -f scenarios="zeroconfig"
gh workflow run e2e.yml --ref my-branch     # every scenario, against a branch
```

### Scenarios

- `zeroconfig`, `conflict`, `needsreview`: the merge queue. These make real projects (with task rows) owned by an e2e user, `e2e@throng.invalid`, through `POST /e2e/projects/:project`, then drive them only through `/api` and the git proxy with that user's Throng token (`POST /e2e/token`). The fixture is the one push that goes around the proxy, since the proxy refuses pushes to the origin's `main`.
  - `zeroconfig`: a project with no `.throng/config.yml`. Selecting `t1a1` closes `t1a2`, and the merge request lands as a merge commit whose parents are the old `main` and the approved head, with the `Throng-Task`, `Throng-Attempt`, `Throng-Merge-Request` and `Approved-by` trailers. It also checks custom refs after landing: both attempts are archived under `refs/attempts/` in the origin.
  - `conflict`: two tasks whose attempts edit the same line. `t1`'s merge request lands, and `t2`'s is dequeued with reason `conflict` and the expected three-way hunk. Its author merges `main` and pushes, which moves it to `needsReview`. Once approved, it lands.
  - `needsreview`: a slow required check keeps the landing in its retest. A push to the source while it's queued or landing dequeues it with `newPush` to `needsReview`. Once the new head passes, it still doesn't requeue on its own.
- `arena`: the attempt arena in a browser. Like `zeroconfig`, it makes a real project as the e2e user, with task `t1` and two attempts: `t1a1` edits `src/greeting.js`, and `t1a2` edits it and `src/index.js`. Once both are scored, Playwright's Chromium opens `t1` on `throng-web-ci` (`THRONG_WEB_URL`) and checks that:
  1. the arena shows lanes `t1a1` and `t1a2`, each with its own files, and each compared against its base (`main`, since the task has no branch);
  2. **By file** lists `src/greeting.js` (changed by 2 of 2) and then `src/index.js` (changed by 1 of 2, which `t1a1` left alone);
  3. **Select** on `t1a1`'s lane, confirmed, opens the merge request view, and once it lands the page shows the task closed, with `t1a1` merged in the merge commit the API reports. `t1a2` is closed.

  The e2e user has no Access session, so throng-web can't forward the page's API calls. Instead the browser sends each `/api/*` request to `THRONG_URL` with the e2e user's Throng token (`scripts/e2e-browser.ts`). Everything else is the deployed UI; only throng-web's Access check and forwarding are skipped, and those have unit tests in `apps/web`. For the same reason `throng-web-ci` must not be behind a Cloudflare Access application: the workflow fails at **Wait for throng-web-ci** if it is.

- `metrics`, `failing`, `invalid`, `preview`, `coalesce`, `intrusion`, `deps`: scoring, through the e2e routes' attempts (forks with no task rows); see the header of `scripts/e2e.ts`.
- `taskmetrics`: a task's own metric over a project check, through `/api` on a project with task rows. A clashing name is refused on save; the saved metric is scored with `source: task`; once `main`'s config adds a metric with the task's name, the attempt's next run is `config: invalid`, naming the clash.
- `refs`: attempt archives. Closing an attempt pushes its fork's `main` to `refs/attempts/t42a3` in the origin (`ARCHIVE_REF_PREFIX` in `src/archive.ts`), and reopening copies it back. The scenario checks, against real Artifacts, that:
  1. a plain `git push` to a ref under that prefix succeeds and `git ls-remote` lists it;
  2. the Worker's own git client (`src/git-client.ts`, behind `POST /e2e/repos/:name/copy-ref`) copies one origin's `main` into another origin's archive ref, and an archive ref back out again;
  3. both refs are still there after a later push to `main`;
  4. no archive push started a check.

  If step 1 fails because Artifacts rejects or drops custom refs, set `ARCHIVE_REF_PREFIX` to `refs/heads/archive/attempts/` and run the scenario again.

### Setup (once per account)

1. **D1 database.** `throng-ci` exists and its id is in `env.ci.d1_databases` in `wrangler.jsonc`. For a new account, run `pnpm --filter @throng/platform exec wrangler d1 create throng-ci` and replace the id.
2. **API token.** In the Cloudflare dashboard, under **My Profile → API Tokens**, create a token named `Throng CI` for the account in `CF_ACCOUNT_ID` with these permissions: Workers Scripts, Containers, D1, Workers R2 Storage and Workers Observability at Edit, plus Account Settings at Read. Both the `ci` and `production` GitHub environments use it, and so does the Worker to upload Worker Previews of `throng-fixture-worker`. That Worker is shared with production and must already exist; if it doesn't, run `npx wrangler deploy` once in `fixtures/fixture-worker`.
3. **Logs buckets.** Nothing to do by hand. Before each deploy, the deploy and E2E workflows create the environment's bucket (`throng-logs`, `throng-ci-logs`) if it's missing and set its lifecycle rules from `r2-lifecycle.json`: logs under `logs/` expire after 30 days, and R2's default rule aborts incomplete multipart uploads after 7. `lifecycle set` replaces the bucket's whole rule set, so edit the file rather than the dashboard. Check with `pnpm exec wrangler r2 bucket lifecycle list <bucket>`.
4. **GitHub environment.** Under **Settings → Environments**, create an environment named `ci`. Optionally, limit its **Deployment branches** to `main`. Give it two secrets:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id (the same as `CF_ACCOUNT_ID` in `wrangler.jsonc`).
5. **Run it once** and check the suite passes and the run's projects and repos are gone afterwards.

To run `arena` from your machine, install Chromium once with `pnpm --filter @throng/platform exec playwright install chromium` and point `THRONG_WEB_URL` at any throng-web, such as `pnpm --filter @throng/web dev` (`http://localhost:5173`). Its own platform binding isn't used, since the browser sends API calls to `THRONG_URL`:

```bash
THRONG_URL=https://throng-ci.<subdomain>.workers.dev SPIKE_TOKEN=... THRONG_WEB_URL=http://localhost:5173 pnpm e2e arena
```

The first run creates the `throng-ci` Worker, its Workflow (`throng-ci-scoring`) and its container. `pnpm e2e cleanup` needs `THRONG_URL`, `SPIKE_TOKEN` and an explicit `E2E_PROJECT_PREFIX`, so it can also clear up after a local run.
