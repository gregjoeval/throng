# Deploying to a user's Cloudflare account with an edge-injected token

Research for [#246](https://github.com/gregjoeval/throng/issues/246), part of map [#242](https://github.com/gregjoeval/throng/issues/242). It follows decision [#243](https://github.com/gregjoeval/throng/issues/243): the preview becomes a check that deploys into the user's own account, and the secrets for setup and check steps are added only at the network edge. It also builds on [#228](https://github.com/gregjoeval/throng/issues/228) and its findings (`docs/research/preview-binding.md` on branch `research/preview-binding`).

Researched 2026-10-13 against `origin/main` at `bcd3d95`, with `wrangler@4.149.0` (the repo's pin; the sandbox image installs 4.147.0). Wrangler was read in its bundled `wrangler-dist/cli.js`. No live API calls were made for this ticket.

Evidence tags:

- **[docs]**: stated on developers.cloudflare.com or blog.cloudflare.com.
- **[source]**: read in wrangler's bundled source or in this repo.
- **[verified]**: shown live, here or in the #228 research, as marked.
- **[inferred]**: follows from the above but hasn't been tested.

## Answer

1. **Yes, an edge-injected token works for `wrangler preview`, `wrangler deploy` and `wrangler versions upload`.** Wrangler only checks that `CLOUDFLARE_API_TOKEN` is set. It never verifies the token before it deploys. It sends the token as `Authorization: Bearer <value>` on every API call, and the intercept can swap that header. Throng already does this for Previews (`export CLOUDFLARE_API_TOKEN=added-by-worker` in `previewScript`) **[source][verified by Throng's e2e preview scenario]**. Two changes are needed for user accounts:
   - The intercept must replace **only the placeholder**. Wrangler's static-assets upload sends its own upload JWT as the bearer, so it must pass through unchanged.
   - The path allowlist must cover what `deploy` calls. That is more than what `preview` calls.
2. **Narrowest token:** an account-owned API token with the Workers **Editor** role, scoped to the one Worker it deploys. That covers deploying, uploading versions and managing secrets **[docs]**. Creating a Worker needs product-level **Admin**, so the Worker should exist before the first run **[docs]**. Changing routes or custom domains also needs **Workers Routes Write** on each affected zone **[docs]**. Whether per-Worker Editor also covers the Previews API (`workers/workers/{w}/previews…`) isn't documented, so it needs a live test **[unverified]**.
3. **The account ID comes from `CLOUDFLARE_ACCOUNT_ID`, which Throng sets from project settings.** Without it, wrangler lists `/accounts` and `/memberships` to find one, which the intercept would refuse **[source]**. Note that `account_id` in the repo's Wrangler config **overrides** the env var **[source]**. So the intercept must pin the account ID in every path it allows. A repo that names another account then gets a 403 instead of a deploy.
4. **No. Scoping a token to one Worker doesn't limit what that Worker can bind.** Cloudflare: to deploy a Worker with bindings to KV, R2 or D1, "you need `Editor` access to the Worker. You do not need separate permissions on the bound resources to deploy the Worker." **[docs]** The #228 research showed the same for service bindings, and the bindings come from the uploader's own config **[verified in #228]**. So a Preview deployed by an attempt can bind any D1, KV, R2, Queue, Workflow or Worker **in the same account** as its parent Worker. This is the #228 hole moved into the user's account.
5. **The #242 bar therefore needs separate Cloudflare accounts.** Token scoping can't keep a Preview from binding production resources in its own account. That stays true when resource-level roles reach KV, D1 and R2, because binding never checks them. Bindings never cross accounts. So the only boundary Cloudflare enforces is a **Preview account** that holds nothing from production. See [Minimal setup](#minimal-setup-that-meets-the-bar).

## 1. Wrangler with a placeholder token

### How wrangler authenticates

- `getAuthFromEnv` reads `CLOUDFLARE_API_TOKEN` (or the deprecated `CF_API_TOKEN`). `loginOrRefreshIfRequired` returns `loggedIn: true` as soon as `hasEnvCredentials()` is true. Nothing checks the value first **[source]**.
- Every API request goes through `addAuthorizationHeader`, which sets `Authorization: Bearer ${apiToken}` unless the request already has an `Authorization` header **[source]**. The placeholder must be a valid header value (`validateAuthorizationHeaderValue`). Plain ASCII like `added-by-worker` passes.
- Token verification (`/user/tokens/verify`) and `/user` run only inside `whoami`. Wrangler runs `whoami` for the `whoami` command and after an authentication error, to print diagnostics **[source]**. A normal deploy never calls them. After an auth failure these calls get the intercept's 403, which only affects the diagnostic output.
- Wrangler calls `/accounts` and `/memberships` only when it has no account ID (`getOrSelectAccountId` → `fetchAllAccounts`) **[source]**.

### Account ID precedence

`getActiveAccountId` uses, in order: a temporary account (unused here), then `account_id` from the Wrangler config, then `CLOUDFLARE_ACCOUNT_ID` (or `CF_ACCOUNT_ID`), then a cached account **[source]**. `wrangler deploy` has no account-ID flag. If Throng sets `CLOUDFLARE_ACCOUNT_ID` from project settings, an attempt can still steer wrangler to another account by writing `account_id` in its config. The intercept stops this by allowing only paths under `/client/v4/accounts/<settings account id>/…`, which `previewAllows` already does **[source]**.

### What each command calls

These are the requests made by commands that Throng could run (`wrangler-dist/cli.js` 4.149.0) **[source]**:

| Command                                    | Requests (under `/accounts/{a}` unless noted)                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler preview`                         | `GET workers/workers/{w}` (Previews Base config); `POST workers/workers` if the parent Worker is missing; `GET/POST/PATCH workers/workers/{w}/previews[/{id}]`; `POST workers/workers/{w}/previews/{id}/deployments`; `GET workers/subdomain`                                                                                                         |
| `wrangler versions upload`                 | `GET workers/services/{w}`; `POST workers/scripts/{w}/versions`                                                                                                                                                                                                                                                                                       |
| `wrangler deploy`                          | `GET workers/services/{w}`; `GET workers/scripts/{w}/deployments`; the script upload under `workers/scripts/{w}` (or its `versions`); `workers/scripts/{w}/subdomain` and `workers/scripts/{w}/schedules`. It may also call `PUT workflows/{name}`, `PUT triggers/{w}`, `/zones/{z}/workers/routes` and the containers APIs, depending on the config. |
| any of them, with static assets            | `POST workers/scripts/{w}/assets-upload-session` with the API token, then `POST workers/assets/upload?base64=true` with **the session JWT** as the bearer                                                                                                                                                                                             |
| any of them, with bindings that have no ID | automatic provisioning: `POST d1/database`, `storage/kv/namespaces`, `r2/buckets`                                                                                                                                                                                                                                                                     |

### What Throng's intercept would have to change

- **Replace the placeholder, not every `Authorization` header.** Today `withBearer` always sets `Authorization` (`sandbox.ts`), and `previewAllows` doesn't allow `workers/assets/upload` at all. So a Preview with static assets fails today. The upload JWT would either be refused or overwritten **[source; inferred, since the e2e fixture has no assets]**. The fix: add the token only when the incoming bearer is the placeholder, and let `workers/assets/upload` through with the JWT the request already carries. That endpoint takes "the JWT (upload token) from the aforementioned manifest upload call" ([direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)) **[docs]**.
- **Allow `deploy`'s paths, still pinned to one account and one Worker:** `workers/services/{w}`, `workers/scripts/{w}/**` and `workers/subdomain`. Allow `workflows`, `triggers` and `/zones/…/workers/routes` only if the user's production setup needs them. Keep refusing `DELETE` and account-wide creation (`d1/database`, `storage/kv/namespaces`, `r2/buckets`, `workers/workers` POST). Configs then have to name existing resources by ID. That is right anyway, because automatic provisioning would create resources in the user's account from attempt code.
- **Take the token from the project's secrets, not `CF_PREVIEW_TOKEN`.** The `preview-token` decision becomes a bearer decision carrying the secret that settings allow for the pipeline (#243). The platform's `CF_PREVIEW_TOKEN` and the `p<projectId>` Workers in `preview-workers.ts` retire, as #243 decided.

## 2. Narrowest token permissions

From [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/) and [Roles and permissions](https://developers.cloudflare.com/workers/authorization/), both last updated 2026-09-15, and the [2026-09-15 changelog](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/) **[docs]**:

- Four Workers roles: Metadata Read-Only, Content Read-Only, **Editor** ("Read, update, deploy and rename existing Workers… cannot create or delete Workers") and Admin.
- Each role can apply at the Workers product scope or to **individual Workers**. "You cannot grant per-Worker access to a Worker that does not exist yet." "Creating new Workers requires product-level `Admin` access."
- Minimum role per command: `wrangler deploy`, `versions upload`, `versions deploy`, `rollback` and `secret put` each need **Editor for that Worker**. Changing Routes or Custom Domains also needs `Workers Routes Write` on every affected zone. Custom Domains don't support per-Worker roles yet.
- "To use granular permissions with Wrangler, authenticate with an account-owned API token." "If the token is scoped to a specific Worker, Wrangler can only perform actions allowed for that Worker."
- Legacy `Workers Scripts Edit` maps to Editor at the **product** scope, so every Worker in the account. Throng's README asks for that today.
- Previews: the docs don't say which role creates a Preview. The Previews CI example asks only for "permission to edit Workers Scripts and the resources used by the Preview" ([automation examples](https://developers.cloudflare.com/workers/previews/automation-examples/)).
- `GET /accounts/{a}/workers/subdomain` accepts "Workers Scripts Write" or "Workers Scripts Read" ([API reference](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/)). It's account-level, so a token scoped to one Worker may be refused. In `deploy`, wrangler uses `getWorkersDevSubdomainIfAccessible`, which treats an unauthorized reply as "unknown" rather than failing **[source]**.

So:

| Use                                       | Token                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production deploy (`main`'s other steps)  | Account-owned token in the **production account**. Workers Editor on the production Worker(s) only. Add Workers Routes Write on the zone only if the deploy changes routes.          |
| Preview upload (`default` pipeline check) | Account-owned token in the **Preview account**. Workers Editor on the one parent Worker that holds the Previews. Create that Worker once beforehand, so the token never needs Admin. |

**[unverified]** Whether per-Worker Editor is enough for `POST workers/workers/{w}/previews` and its deployments, and whether `wrangler preview` tolerates a 403 on `workers/subdomain`. Test both before the slice that ships this. If either fails, fall back to product-scope Editor **in the Preview account only**. That account holds nothing else, so the wider scope costs little.

## 3. Does a token scoped to one Worker stop bindings to the account's other resources?

No.

- "To deploy a Worker that has bindings to resources like Workers KV, R2, or D1, you need `Editor` access to the Worker. You do not need separate permissions on the bound resources to deploy the Worker. Permissions on bound resources are only required if you need to access those resources directly." ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)) **[docs]**
- The blog post on granular access says the same: CI can "deploy the application without also giving it access to your domains, databases, or storage" ([blog](https://blog.cloudflare.com/workers-granular-authorization/)) **[docs]**. Resource-level roles for KV, D1 and R2 are "coming" (same post). They govern direct access to the resource, not who may bind it, so they won't close this **[inferred]**.
- A Preview's bindings come from the uploader's `previews` block. That covers KV, D1, R2, Queues, Workflows, services, dispatch namespaces, Durable Objects with `script_name`, tail consumers, Secrets Store, Hyperdrive, VPC services and more (`PreviewsConfig` in `config-schema.json`) **[source]**. They bind "by `id`", "by `database_id`" and "by `bucket_name`". A service binding "can only bind to the production Worker B" ([Previews: resources](https://developers.cloudflare.com/workers/previews/resources/)) **[docs]**.
- #228 showed live that a Preview's uploaded service binding reaches another Worker's named entrypoint. It also showed that the parent's Previews Base config can't override an uploaded binding, because the upload wins on a clash **[verified in #228]**.
- Per-Worker Editor doesn't separate Previews from production deployments either. Editor covers "versions, deployments". So a Preview token scoped to the **production** Worker could also run `wrangler deploy` or `versions deploy` on it **[docs; inferred for the Previews API]**. Even within one account, Previews would have to live under a separate parent Worker.

**Consequence.** If attempt Previews deploy into the account that holds production, any attempt's code can deploy a Preview that binds production D1, KV, R2 or Queues, or a production Worker's entrypoint, with no further permission. It can then read and write that data from a public URL. Throng could inspect deploy bodies at the edge with a binding allowlist, the fallback named in #228. That is fragile: every new binding type or API field is a bypass, and the user's own Wrangler config decides what is legitimate **[inferred]**.

## 4. Can preview and production tokens be scoped to meet the bar?

**Within one account, no.** A token's scope limits which Workers it may change, not what those Workers may bind. The bound resource's permissions aren't consulted at deploy time. Nothing in the token model lets "Worker X may only bind resource Y" be expressed **[docs; inferred]**.

**Across accounts, yes.** Bindings resolve inside the Worker's own account: service bindings let a Worker call "other Workers on your Cloudflare account" ([service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)), and KV, D1 and R2 bind by an ID in that account **[docs]**. An account-owned token belongs to one account (["account-owned API token"](https://developers.cloudflare.com/workers/authorization/)) **[docs]**. So a Preview account with no production resources leaves an attempt nothing to bind. Its token can't touch the production account at all **[inferred]**. Production stays reachable only through its public URLs, like for anyone on the internet.

So **the #242 bar needs a separate Preview account**. Throng's own account is already out once `CF_PREVIEW_TOKEN` and the `p<projectId>` Workers retire.

## Minimal setup that meets the bar

The bar: nothing deploys into Throng's account, and no token a `default` pipeline gets can reach what `main` deploys.

1. **Two Cloudflare accounts owned by the user.**
   - **Production account:** the user's existing one.
   - **Preview account:** a new account holding only the Preview parent Worker and any test-only D1, KV or R2 that Previews bind. A Super Administrator whose user is at least seven days old can create "up to five additional Free accounts" ([create account](https://developers.cloudflare.com/fundamentals/account/create-account/)) **[docs]**. On the Free plan, Previews cap at 100 per Worker, against 500 on Paid ([Previews](https://developers.cloudflare.com/workers/previews/)) **[docs]**. Containers, and anything else that needs Workers Paid, need Paid on the Preview account too **[inferred]**.
2. **Preview account setup, done once by the user:**
   - Create the parent Worker. Any name works, for example the app's own name, since the account holds nothing else.
   - Create test resources and put their IDs in the repo's `previews` block.
   - Create an account-owned token with **Workers Editor on that Worker only**.
   - In Throng project settings, store the token as a secret allowed for the `default` pipeline, along with the Preview account ID and Worker name.
3. **Production account setup:**
   - Create an account-owned token with **Workers Editor on the production Worker(s) only**, plus Workers Routes Write on the zone if routes change.
   - Store it as a secret allowed **only** for the `main` pipeline. Per #243, `main`'s other steps may receive it as an env var. Its checks get it only through the edge.
4. **Throng side.** Each part below is a change to `network.ts` or `sandbox.ts`, plus settings:
   - The preview check's intercept allows only `/client/v4/accounts/<preview account>/workers/{workers|scripts}/<worker>…`, `workers/subdomain` and `workers/assets/upload`. It refuses every `DELETE` and all account-wide creation.
   - It swaps only the placeholder bearer and passes the upload JWT through.
   - It sets `CLOUDFLARE_ACCOUNT_ID` from settings and relies on path pinning to defeat a repo-set `account_id`.
   - A `default` pipeline run never gets the production secret. #243's rules already enforce this: the config is read from `origin/main`, settings gate each secret per pipeline, and an unallowed name fails the run.
   - Retire `CF_PREVIEW_TOKEN`, `preview-workers.ts` and the `p<projectId>` Workers.

What this still allows:

- An attempt's Preview can bind anything in the **Preview account**, including other attempts' Preview data and the shared test resources. It can't delete other attempts' Previews, because the intercept refuses `DELETE`. But it can redeploy any Preview under the same parent, since Previews are named by the attempt and the grant covers the whole Worker **[inferred]**.
- The Preview account's secrets are readable by Preview code, as for any Worker. Put nothing there that matters outside the Preview account.
- Previews are public by default ([Previews](https://developers.cloudflare.com/workers/previews/)) **[docs]**.

## Risks and open items

- **Per-Worker Editor and the Previews API.** Undocumented. Test `wrangler preview` with a token scoped to one existing Worker. If it fails, use product-scope Editor in the Preview account.
- **Static assets.** Today's intercept breaks the assets upload JWT and refuses `workers/assets/upload`. Needs the placeholder-only swap and a test with an assets fixture.
- **Production deploys from the edge.** `deploy` touches more endpoints than `preview`, depending on the config: workflows, triggers, routes, containers, queues consumers. A path allowlist strict enough to be safe may refuse a legitimate production deploy. Since `main`'s other steps run reviewed code and may take the token as an env var (#243), it's simpler to give the production token to `main`'s other steps as an env var and keep the edge-only path for Previews **[inferred]**.
- **Users with one account.** If the user won't create a Preview account, the bar can't be met. The options then are no Previews, or edge body inspection with a binding allowlist, which is the fragile #228 fallback.
- **The repo's `account_id`.** A repo that sets `account_id` to its production account fails its Preview with a 403. That's safe, but users need to know to leave `account_id` out of the config, or to set it in `env.preview`.
- **Wrangler drift.** The behaviours above were read in 4.149.0. A later wrangler that verifies tokens up front (`/user/tokens/verify`) would hit the intercept's 403 and fail. Throng's e2e preview scenario would catch that.

## Sources

- https://developers.cloudflare.com/workers/authorization/ (last updated 2026-09-15)
- https://developers.cloudflare.com/workers/authorization/workers/ (last updated 2026-09-15)
- https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/
- https://blog.cloudflare.com/workers-granular-authorization/
- https://developers.cloudflare.com/workers/previews/ (last updated 2026-09-24)
- https://developers.cloudflare.com/workers/previews/resources/ (last updated 2026-09-22)
- https://developers.cloudflare.com/workers/previews/automation-examples/ (last updated 2026-10-01)
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developers.cloudflare.com/workers/static-assets/direct-upload/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
- https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
- https://developers.cloudflare.com/fundamentals/account/create-account/ (last updated 2026-09-17)
- `wrangler@4.149.0`:
  - `wrangler-dist/cli.js`: `getAuthFromEnv`, `loginOrRefreshIfRequired`, `addAuthorizationHeader`, `getActiveAccountId`, `getOrSelectAccountId`, `fetchAllAccounts`, `whoami`/`getTokenType`, `deployWorker`, `preUploadApiChecks`, `triggersDeploy`, `syncAssets`, `runPreview`, `provisionParentWorker`, `createPreview*`, `getWorkersDevSubdomainIfAccessible`, `provisionBindings`
  - `config-schema.json`: `PreviewsConfig`
- This repo at `bcd3d95`: `apps/platform/src/{sandbox,network,grants,preview,preview-workers,scripts}.ts`, `apps/platform/README.md`, `apps/platform/container/Dockerfile`, `apps/platform/fixtures/fixture-worker/wrangler.jsonc`, `apps/platform/scripts/e2e.ts`, `docs/research/fork-previews.md`
- `docs/research/preview-binding.md` on branch `research/preview-binding` (#228)
