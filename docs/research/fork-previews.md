# Workers Previews for an Artifacts-hosted fork

Research for [#6](https://github.com/gregjoeval/throng/issues/6), part of map [#3](https://github.com/gregjoeval/throng/issues/3). Sources were read on 2026-10-04. Wrangler source was checked at `wrangler@4.147.0`.

## Answer

**Workers Builds is the wrong tool for per-fork previews.** It does support Artifacts repos and builds non-`main` branches into Worker Previews. But a Workers Builds connection is one Worker linked to one repo. You set it up in the dashboard, and the documented API cannot create one for an Artifacts repo. Each attempt fork is a new repo, so every fork would need its own connection. Builds also runs only 6 at a time on paid plans.

**The cheapest path is to run `wrangler preview` ourselves.** Do it inside the Sandbox, in the Workflow that already runs the check on each push:

```sh
npx wrangler preview --worker-name <fixture-worker> --name <attempt-slug> --json
# URL: <attempt-slug>-<fixture-worker>.<account-subdomain>.workers.dev
```

All attempts are Previews under **one** Worker (up to 500 Previews per Worker on paid plans). Each Preview gets its own isolated Durable Object namespace. A failed check skips the preview. No new infrastructure is needed. The Sandbox only needs a Cloudflare API token that can deploy Workers, plus `wrangler >= 4.135.0` in the fixture repo.

Do **not** use `wrangler versions upload --preview-alias` (aliased Version URLs). Cloudflare now says not to use it for branch or PR previews. It shares production resources and does not work at all for Workers that define Durable Objects.

## What the docs state

### Workers Builds and Artifacts

- Workers Builds can "build and deploy a Worker directly from an Artifacts repository". To connect, use the dashboard: **Create application > Continue with Artifacts**, or **Settings > Builds > Connect** on an existing Worker. You pick one namespace and one repository. ([Artifacts integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/))
- "The Artifacts integration only supports `main` as the production branch." Pushes to other branches run the Preview command, `npx wrangler preview` by default, once **Builds for Preview branches** is on. "A successful build creates or updates a branch Preview URL in the Worker's **Previews** section." (same page)
- "To change the repository or source provider, disconnect Workers Builds and create another connection." Builds is one repo per Worker. (same page)
- Unlike GitHub and GitLab, Artifacts gets no automatic PR comments. ([Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/))
- The Builds REST API can create repo connections. The documented `provider_type` enum is `github | gitlab | gitlab_internal | origin`, with no `artifacts` value. The from-scratch API walkthrough covers GitHub only. ([connections upsert](https://developers.cloudflare.com/api/resources/workers_builds/subresources/repos/subresources/connections/methods/upsert/), [Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/))
- A Worker has at most two triggers: production and preview. You can start a manual build with `POST /builds/triggers/{uuid}/builds` and `{branch | commit_hash}`. ([Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/))
- Deploy Hooks: an unauthenticated POST URL builds one branch. Limit: 10 builds/min per Worker and 100/min per account. ([Deploy Hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/))
- Builds limits on paid plans: 6 concurrent builds per account (1 on free), 20-minute timeout, 6,000 build minutes per month and then $0.005/min. ([Limits & pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/))
- The Artifacts docs point to a custom alternative. A `cf.artifacts.repo.pushed` event can start a Workflow that uses the `@cloudflare/ci` SDK (Sandbox runners, snapshot cache), and its last step runs `wrangler deploy`. The trigger `filter` can name only the `namespace`, so "Cloudflare runs the same Workflow for every push to any repo in your Artifacts namespace." ([Build and deploy Artifacts repos](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/)) `@cloudflare/ci` is on npm at 0.2.0 under Apache-2.0.

### Worker Previews (`wrangler preview`)

Worker Previews launched on 2026-09-22 ([blog](https://blog.cloudflare.com/worker-previews/)). They are now the recommended way to test changes before production.

- `npx wrangler preview` "creates or updates a Preview for your current branch under the same Worker". `--name` overrides the branch name. Use `--worker-name` to pick the Worker, and `--json` for machine-readable output, where the URL is at `.preview.urls[0]`. The Worker does not need a production deployment first. Wrangler provisions the parent Worker if it is missing. ([Previews](https://developers.cloudflare.com/workers/previews/), [Get started](https://developers.cloudflare.com/workers/previews/get-started/), [wrangler preview](https://developers.cloudflare.com/workers/wrangler/commands/workers/#preview), [Examples](https://developers.cloudflare.com/workers/previews/examples/); `provisionParentWorker` in wrangler 4.147.0 source)
- Requires `Wrangler 4.135.0` or later as a **project** dependency.
- URL shapes ([Previews](https://developers.cloudflare.com/workers/previews/)):
  - Preview URL (always the latest deploy): `<preview-name>-<worker-name>.<subdomain>.workers.dev`
  - Deployment URL (immutable): `<deployment-id>-<worker-name>.<subdomain>.workers.dev`
  - Custom domain: `<preview-name>.app.example.com`. Deeper hostnames may need Advanced Certificate Manager. ([Custom domains](https://developers.cloudflare.com/workers/previews/custom-domains/))
- Limits: 500 Previews per Worker on paid plans (100 on free), and 100 deployments per Preview. When full, "the Preview that was deployed to least recently is deleted". Manual cleanup: `wrangler preview delete --name <n> --skip-confirmation`. ([Previews](https://developers.cloudflare.com/workers/previews/))
- Previews are public by default. `workers.dev` Preview URLs send `X-Robots-Tag: noindex`. Cloudflare Access can protect them. (same page)
- Isolation ([Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)):
  - Each Preview automatically gets its own Durable Object namespace and storage, and its own container app.
  - KV, D1, R2 and Queues producers are shared unless you bind each Preview to a different resource.
  - Workflow bindings point at an existing deployed Workflow.
  - Service bindings call the **production** target Worker.
  - Previews cannot consume Queues and get no Cron Triggers or routes.
  - Container support is "partial", and container apps can be left behind after `preview delete`.
- Preview settings live in the `previews` block of the Wrangler config. They do not inherit production settings. Secrets come from the Previews Base config, set with `wrangler preview base-config secret put`. ([Configuration](https://developers.cloudflare.com/workers/previews/configuration/))

### Version URLs (`wrangler versions upload --preview-alias`)

- These were formerly called "preview URLs". The shapes are `<version-prefix>-<worker>.<subdomain>.workers.dev` and `<alias>-<worker>.<subdomain>.workers.dev`. ([Version URLs](https://developers.cloudflare.com/workers/configuration/previews/))
- Alias rules: lowercase letters, digits and `-`, starting with a letter. alias + `-` + worker name must be 63 characters or fewer. Only the 1,000 most recently deployed aliases are kept. (same page)
- "Workers that implement a Durable Object get no Version URLs. This includes Containers and Sandbox Workers." Version URLs run on production resources. Their logs are not available in Workers Logs, tail, or Logpush. (same page)
- "Do not use Version URLs for branch or pull request testing. Use Previews instead." ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/))

### Artifacts facts that matter here

- `repo.fork(name, { defaultBranchOnly, readOnly, description })` returns metadata for a new repo, including `remote`. ([Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/))
- Events: `cf.artifacts.repo.forked` is an account-level event (`artifacts` source). `cf.artifacts.repo.pushed` is a repo-level event. For Queue event subscriptions, the `artifacts.repo` source needs a `namespace` and `repo_name`. Its payload has `ref`, `before`, `after`, and `commits[]`. ([Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/), [Events & schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/))
- Artifacts entered open beta on 2026-10-01. It needs the Workers Paid plan, and **billing starts 2026-10-14**, our deadline. ([Changelog](https://developers.cloudflare.com/artifacts/platform/changelog/))
- Limits: 1 GB per repo, a 32 MB blob limit, and 2,000 Git requests per 10 s per repo. ([Limits](https://developers.cloudflare.com/artifacts/platform/limits/))

## Options compared

| Path | Per-fork automation | Fits the map? | Cost / limits |
| --- | --- | --- | --- |
| A. Workers Builds connection per fork | No. Each fork needs a dashboard connection, and the API has no `artifacts` provider. | No | One Worker per fork, 6 concurrent builds |
| B. Push attempts as branches of the canonical repo, with one Builds connection | Yes. Each branch becomes a Preview automatically. | Breaks "one fork per attempt" and fork-scoped tokens | 6 concurrent builds, build minutes, no hook into our check result |
| C. Builds manual-trigger API / Deploy Hook | Only for the connected repo's branches | Same issue as A and B | 10/min per Worker |
| **D. `wrangler preview --name <attempt>` in our Sandbox** | Yes, fully programmatic | Yes. It reuses the Workflow and Sandbox from the spike. | 500 Previews per Worker with LRU eviction, no Builds minutes |
| E. `versions upload --preview-alias` in our Sandbox | Yes | Fails if the Worker has DOs, and uses production resources | 1,000 aliases |

**Recommendation: D.** After the check passes in the Sandbox, run `wrangler preview --name <attempt-slug> --worker-name <fixture-worker> --json`. Read `.preview.urls[0]` and store it on the attempt. Name Previews after the attempt or fork, not the branch: every fork's branch is `main`, and the default name comes from the git branch. When an attempt is merged or bounced, delete its Preview. Path B is the fallback if we ever want zero custom build code.

## Unverified: the spike must test these

1. **Preview name rules.** The docs give no length or charset rule for Preview names. Previews have a server-assigned `slug` (Wrangler reads `previewResource.slug`), so names are probably sanitized server-side. The 63-character DNS-label limit is documented only for Version URL aliases. Test a long name or an attempt ID with uppercase letters or `_`, and keep `<slug>-<worker>` at 63 characters or fewer to be safe.
2. **Latency.** No doc gives deploy-to-live time for `wrangler preview`. Measure the time from the start of the `wrangler preview` step to the first 200 response from the Preview URL. Add the time to install wrangler and its dependencies in the Sandbox.
3. **Running Wrangler inside a Sandbox.** Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the Sandbox env. Check the minimum token scope (Workers Scripts Edit, plus Containers if used). Check that `--json` output is stable.
4. **Namespace-wide push trigger.** The build-and-deploy guide shows `triggers.events` with only a `namespace` filter, covering every repo. The Queue event-subscription docs say `pushed` needs `namespace` + `repo_name`. If only per-repo subscriptions work for Queues, we must create a subscription per fork, perhaps on `repo.forked`, or use the Workflow `triggers.events` path. This affects the map's "push event on a Queue" hop.
5. **Whether `wrangler preview` honors `--name` with no git branch or a detached HEAD in the Sandbox checkout.** The source suggests `--name` skips branch detection. Confirm it.
6. **Workers Builds with an Artifacts fork, if Path B or A is ever wanted.** Does a fork made with `repo.fork()` show up in the dashboard connect list? Does any undocumented API `provider_type` accept Artifacts? Not needed for D.
7. **Fixture Worker constraints.** If the fixture uses Workflows, Queue consumers, or service bindings, Previews will hit production or shared targets. Keep the fixture to fetch + DO/KV.

## Sources

- https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
- https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/
- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- https://developers.cloudflare.com/api/resources/workers_builds/subresources/repos/subresources/connections/methods/upsert/
- https://developers.cloudflare.com/workers/previews/
- https://developers.cloudflare.com/workers/previews/get-started/
- https://developers.cloudflare.com/workers/previews/compare-workflows/
- https://developers.cloudflare.com/workers/previews/resources/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/previews/custom-domains/
- https://developers.cloudflare.com/workers/previews/examples/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/#preview
- https://developers.cloudflare.com/workers/configuration/previews/ (Version URLs)
- https://blog.cloudflare.com/worker-previews/
- https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/
- https://developers.cloudflare.com/artifacts/guides/event-subscriptions/
- https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/platform/limits/
- https://developers.cloudflare.com/artifacts/platform/changelog/
- https://www.npmjs.com/package/wrangler (4.147.0 `wrangler-dist/cli.js`: `runPreview`, `provisionParentWorker`)
- https://www.npmjs.com/package/@cloudflare/ci
