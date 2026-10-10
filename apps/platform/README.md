# throng (platform)

The platform Worker: the API, the git-facing repos in Artifacts, and checks.

## E2E job

The **E2E** workflow (`.github/workflows/e2e.yml`) runs `pnpm e2e` against real Artifacts. It deploys the `ci` environment in `wrangler.jsonc`: the `throng-ci` Worker, Artifacts namespace `throng-ci` and D1 database `throng-ci`. It never runs on pull requests or forks, only when started by hand on `gregjoeval/throng`. Runs queue rather than overlap.

Each run:

1. Generates a random `SPIKE_TOKEN`.
2. Applies D1 migrations to `throng-ci`.
3. Builds with `CLOUDFLARE_ENV=ci` and deploys `throng-ci`, setting `SPIKE_TOKEN` and `CF_PREVIEW_TOKEN` (the deploy's own API token).
4. Runs the e2e scenarios. Every project id starts with `ci<run id>r<attempt>p`.
5. Always deletes every repo under that prefix with `pnpm e2e cleanup`, even when the suite fails or is cancelled.

### Running it

Go to **Actions → E2E → Run workflow** on `main`. Leave **scenarios** empty to run them all, or name some, such as `happy conflict`. From a terminal:

```bash
gh workflow run e2e.yml -f scenarios="happy"
```

### Setup (once per account)

1. **D1 database.** `throng-ci` exists and its id is in `env.ci.d1_databases` in `wrangler.jsonc`. For a new account, run `pnpm --filter @throng/platform exec wrangler d1 create throng-ci` and replace the id.
2. **API token.** In the Cloudflare dashboard, create an account API token for the account in `CF_ACCOUNT_ID` with edit access to Workers Scripts, Artifacts, D1, Workflows and Containers. The deploy uses it, and so does the Worker to upload Worker Previews of `throng-fixture-worker`. That Worker is shared with production and must already exist; if it doesn't, run `npx wrangler deploy` once in `fixtures/fixture-worker`.
3. **GitHub environment.** Under **Settings → Environments**, create an environment named `ci`. Optionally, limit its **Deployment branches** to `main`. Give it two secrets:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id (the same as `CF_ACCOUNT_ID` in `wrangler.jsonc`).
4. **Run it once** and check the suite passes and the run's repos are gone afterwards.

The first run creates the `throng-ci` Worker, its Workflows (`throng-ci-ingest`, `throng-ci-check`), its container and its Artifacts push trigger. `pnpm e2e cleanup` needs `THRONG_URL`, `SPIKE_TOKEN` and an explicit `E2E_PROJECT_PREFIX`, so it can also clear up after a local run.
