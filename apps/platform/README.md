# throng (platform)

The platform Worker: the API, the git-facing repos in Artifacts, and checks.

## Entrypoints

- **Default export**: the public hostname. Agents and git use Throng tokens; humans can use an Access JWT on `/api/me` and `/api/tokens`. Any request carrying `X-Throng-Access-Email` is rejected with a 401.
- **`WebEntrypoint`**: throng-web's `PLATFORM` service binding targets it by name. It serves `/api` and trusts `X-Throng-Access-Email`, which throng-web sets only after verifying the Access JWT itself. Named entrypoints can't be reached from the internet, so this is the only path where the header counts. Deploy the platform before throng-web, so the entrypoint exists when the binding is created.

`src/app.ts` builds both, and exports `AppType` for throng-web's typed `hc` client.

## Scoring logs

Each scoring run copies the log of every `setup` command, check and preview to the `LOGS` R2 bucket at `logs/<projectId>/<t42a3>/<sha>/<runId>/<name>.log` (`src/logs.ts`). A setup command's log is named `setup.<n>`, a check's is its name, and the preview's is `preview.deploy`; check names can't contain a dot, so they never collide. Logs over 5 MB keep their head and tail with a `[throng: truncated …]` marker between them. The run's result lists the logs it stored, and `GET /api/projects/{owner}/{project}/runs/{runId}/logs/{name}` streams one as text, or answers `not_found` once it's missing or expired.

There's one bucket per environment: `throng-logs`, and `throng-ci-logs` for `ci`. Logs are deleted after 30 days by an R2 lifecycle rule. Wrangler's config can't declare lifecycle rules, so add the rule by hand once per bucket (see the setup below).

## E2E job

The **E2E** workflow (`.github/workflows/e2e.yml`) runs `pnpm e2e` against real Artifacts. It deploys the `ci` environment in `wrangler.jsonc`: the `throng-ci` Worker, Artifacts namespace `throng-ci` and D1 database `throng-ci`. It never runs on pull requests or forks, only when started by hand on `gregjoeval/throng`. Runs queue rather than overlap.

Each run:

1. Generates a random `SPIKE_TOKEN`.
2. Applies D1 migrations to `throng-ci`.
3. Builds with `CLOUDFLARE_ENV=ci` and deploys `throng-ci`, setting `SPIKE_TOKEN` and `CF_PREVIEW_TOKEN` (the deploy's own API token).
4. Runs the e2e scenarios. Every project id starts with `ci<run id>r<attempt>p`.
5. Always deletes every repo under that prefix with `pnpm e2e cleanup`, even when the suite fails or is cancelled.

### Running it

Go to **Actions → E2E → Run workflow** on `main` (or a branch, to test it before merging). Leave **scenarios** empty to run them all, or name some, such as `zeroconfig conflict`. From a terminal:

```bash
gh workflow run e2e.yml -f scenarios="zeroconfig"
gh workflow run e2e.yml --ref my-branch     # every scenario, against a branch
```

### Scenarios

- `zeroconfig`, `conflict`, `metrics`, `failing`, `invalid`, `preview`, `coalesce`, `intrusion`, `deps`: scoring, and the spike's landing until the merge queue replaces it; see the header of `scripts/e2e.ts`.
- `refs`: attempt archives. Closing an attempt pushes its fork's `main` to `refs/attempts/t42a3` in the origin (`ARCHIVE_REF_PREFIX` in `src/archive.ts`), and reopening copies it back. The scenario checks, against real Artifacts, that:
  1. a plain `git push` to a ref under that prefix succeeds and `git ls-remote` lists it;
  2. the Worker's own git client (`src/git-client.ts`, behind `POST /spike/repos/:name/copy-ref`) copies one origin's `main` into another origin's archive ref, and an archive ref back out again;
  3. both refs are still there after a later push to `main`;
  4. no archive push started a check.

  If step 1 fails because Artifacts rejects or drops custom refs, set `ARCHIVE_REF_PREFIX` to `refs/heads/archive/attempts/` and run the scenario again.

### Setup (once per account)

1. **D1 database.** `throng-ci` exists and its id is in `env.ci.d1_databases` in `wrangler.jsonc`. For a new account, run `pnpm --filter @throng/platform exec wrangler d1 create throng-ci` and replace the id.
2. **API token.** In the Cloudflare dashboard, create an account API token for the account in `CF_ACCOUNT_ID` with edit access to Workers Scripts, Artifacts, D1, Workflows, Containers and R2. The deploy uses it, and so does the Worker to upload Worker Previews of `throng-fixture-worker`. That Worker is shared with production and must already exist; if it doesn't, run `npx wrangler deploy` once in `fixtures/fixture-worker`.
3. **Logs buckets.** Create each environment's bucket and its 30-day lifecycle rule on `logs/`:

   ```bash
   cd apps/platform
   for bucket in throng-logs throng-ci-logs; do
     pnpm exec wrangler r2 bucket create "$bucket"
     pnpm exec wrangler r2 bucket lifecycle add "$bucket" expire-logs logs/ --expire-days 30 --force
   done
   ```

   Check with `pnpm exec wrangler r2 bucket lifecycle list <bucket>`.

4. **GitHub environment.** Under **Settings → Environments**, create an environment named `ci`. Optionally, limit its **Deployment branches** to `main`. Give it two secrets:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id (the same as `CF_ACCOUNT_ID` in `wrangler.jsonc`).
5. **Run it once** and check the suite passes and the run's repos are gone afterwards.

The first run creates the `throng-ci` Worker, its Workflow (`throng-ci-scoring`) and its container. `pnpm e2e cleanup` needs `THRONG_URL`, `SPIKE_TOKEN` and an explicit `E2E_PROJECT_PREFIX`, so it can also clear up after a local run.
