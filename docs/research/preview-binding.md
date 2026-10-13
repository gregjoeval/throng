# A web app Preview reaching `throng-ci`

Research for [#228](https://github.com/gregjoeval/throng/issues/228), part of map [#222](https://github.com/gregjoeval/throng/issues/222). It feeds demo option B on [#32](https://github.com/gregjoeval/throng/issues/32): Throng demos a change to its own web app, and that change's Preview runs against `throng-ci`, never production.

Researched 2026-10-12 against `origin/main` at `3c51b68` (PR #213, Previews under `p<projectId>`), with `wrangler@4.149.0` (the repo's pin; the sandbox image has 4.147.0). Live tests used only throwaway Workers (`research-preview-target`, `research-preview-parent`) in the account `wrangler` is logged into. Both were deleted afterwards, and their URLs and API records now return 404. Against `throng-ci` and `throng-web-ci` I only read the deployment list and secret names and made two unauthenticated GETs.

Evidence tags:

- **[verified]**: tested live on the throwaway Workers.
- **[docs]**: stated on developers.cloudflare.com.
- **[source]**: read in wrangler's bundled source (`wrangler-dist/cli.js`) or in this repo.
- **[inferred]**: follows from the above, not tested directly.

## Answer

1. **Yes, a Preview can carry a service binding to another Worker, and it keeps the named entrypoint.** The binding goes in the `previews.services` block of the Wrangler config: `{ "binding": "PLATFORM", "service": "throng-ci", "entrypoint": "WebEntrypoint" }`. `wrangler preview --worker-name <parent>` uploads it with that deployment. A Preview's calls reach the target's named entrypoint, not its default export **[verified]**. The call goes to the target Worker's production deployment **[docs][verified]**. For `throng-ci` that is the CI platform: wrangler's `ci` environment deploys it as a separate Worker named `throng-ci`.
2. **Previews are not limited to the parent Worker's bindings. They don't inherit them at all.** Each Preview deployment carries its own bindings, taken from the uploader's `previews` block, plus the parent's Previews Base config **[docs][verified]**. The parent needs no production deployment and no binding of its own. `p<projectId>` has neither.
3. **This is a security problem, and not only for option B.** The bindings come from the attempt's own Wrangler config, so they're chosen by untrusted code. The Preview grant (`previewAllows`) limits which API **paths** the sandbox may call. It never looks at the **body**. So any attempt that gets a Preview can bind `throng`'s `WebEntrypoint` (production) as easily as `throng-ci`'s, set `X-Throng-Access-Email` to anyone, and act as any production user. It could also bind production D1, R2 or Artifacts directly **[verified mechanism; inferred for `throng`, not tested against it]**. The binding route therefore doesn't "only expose CI data" until this is closed.
4. **The token route works with small changes to `apps/web`.** It exposes exactly one `throng-ci` user. But it doesn't close hole 3 by itself, since the attempt still writes its own bindings.

**Recommended shape for option B:** close hole 3 first, as its own ticket and a prerequisite for B. Then use the **token route**: the web app's Preview calls `throng-ci`'s public hostname with a Throng token for a dedicated `throng-ci` demo user, and has no `PLATFORM` binding at all. Details are under [Recommendation](#recommendation).

## 1. Can a Preview bind to another Worker's named entrypoint?

### What the docs say

- "If Worker A has a service binding to Worker B, the Preview of Worker A can only bind to the production Worker B. It does not automatically bind to a matching Preview of Worker B." The resource table says service bindings "always point to the production target Worker". ([Previews: resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)) **[docs]**
- "Previews do not inherit production settings." A `previews` block is required, though it can be `{}`. Bindings that Previews need are declared under `previews`. ([Previews: configuration](https://developers.cloudflare.com/workers/previews/configuration/)) **[docs]** That page doesn't spell out `previews.services` or `entrypoint`, but wrangler's schema does (below).
- A named entrypoint is selected with `"entrypoint": "<ExportName>"`. Service bindings "allow one Worker to call into another, without going through a publicly-accessible URL", and their methods can be "called by other Workers on your Cloudflare account that declare a binding to this Worker". ([Service bindings: RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)) **[docs]**
- Secrets in the Previews Base config are copied into each Preview when it's created. `wrangler preview secret put --name <preview>` sets one on a single Preview. ([Previews: configuration](https://developers.cloudflare.com/workers/previews/configuration/)) **[docs]**

### What wrangler does

- `config-schema.json` (4.149.0) lists `services` under `PreviewsConfig`, with `binding`, `service`, `entrypoint`, `props` and `remote`. **[source]**
- `wrangler preview` sends the uploader's `previews.services` as `env[binding] = { type: "service", service, environment, entrypoint, props }` in the deployment's multipart `metadata`. The request is `POST /accounts/{a}/workers/workers/{worker}/previews/{id}/deployments`. **[source]**
- Before that, it reads the parent's Previews Base config (`GET /workers/workers/{worker}`) unless `--ignore-base-config` is passed. It creates the Preview with `POST …/previews`, which carries `observability`, `logpush` and `tail_consumers`. **[source]**
- If the parent Worker doesn't exist, wrangler creates it (`POST /workers/workers`). **[source][verified]**

### Live tests

The setup was a target Worker, `research-preview-target`, with a default export and a named `TargetEntrypoint`. Each echoed which one answered and the `X-Throng-Access-Email` header it got. The parent, `research-preview-parent`, called `env.PLATFORM.fetch()` with a forged `X-Throng-Access-Email: someone-else@example.com`.

| #   | Setup                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Parent has **no** top-level binding and no production deployment. `previews.services` binds `PLATFORM` to `TargetEntrypoint`. `wrangler preview --worker-name research-preview-parent --name t1a1 --json`. | Parent created on the fly. Deployment `env` echoed `{"PLATFORM":{"type":"service","service":"research-preview-target","entrypoint":"TargetEntrypoint","environment":"production"}}`. The Preview answered `{"via":"TargetEntrypoint","forwarded":"someone-else@example.com"}`. **The entrypoint is kept, and the Preview's code chose the identity header.** |
| 2   | Same target's public `workers.dev` URL, sent the same header                                                                                                                                               | `{"via":"default"}`: the named entrypoint can't be reached publicly, as Throng's design assumes.                                                                                                                                                                                                                                                             |
| 3   | The parent's Previews Base config pins `PLATFORM` to the target's **default** entrypoint and adds a var, `BASE_ONLY`. A new Preview `t1a2` uploads `PLATFORM` → `TargetEntrypoint`.                        | Deployment `env` had `BASE_ONLY` from the base, but `PLATFORM` was the **uploader's** `TargetEntrypoint`. The base config merges in, but the upload wins on a clash, so **base config can't pin a binding**.                                                                                                                                                 |
| 4   | Parent's **production** deployment binds `PLATFORM` → `TargetEntrypoint`; `"previews": {}`. New Preview `t1a3`.                                                                                            | Production had `PLATFORM`. The Preview's `env` was empty (`{"bindings":[]}`): **production bindings are not inherited**.                                                                                                                                                                                                                                     |

Also checked, read-only: `https://throng-ci.<subdomain>.workers.dev/api/me` answers 401 with no credentials, and 401 `X-Throng-Access-Email is only accepted from throng-web` when sent the header. The public hostname's `rejectForwardedIdentity` works. **[verified]**

## 2. Security: what each route exposes

### How identity reaches the platform today

- `WebEntrypoint` (`apps/platform/src/index.ts`) serves `webApp`, which builds the API with `trustForwardedIdentity: true`. Any request with no `Authorization` header and with `X-Throng-Access-Email: <email>` runs as that email's user (`bearerOrAccess`, `bearerOrForwarded` in `auth.ts`). That includes `POST /api/tokens`, so a forwarded identity can mint Throng tokens for that user. **[source]**
- That trust rests on one assumption: only `throng-web` can bind to `WebEntrypoint`. Named entrypoints can't be reached from the internet **[docs][verified]**. But **any Worker in the same account** can bind to them **[docs]**, and the account itself puts no limit on who binds what **[inferred]**.

### Hole: the attempt picks its own bindings

- The sandbox's Preview grant (`apps/platform/src/preview.ts` `previewAllows`, enforced by `OutboundAuth` in `sandbox.ts`) checks only the method and path. It allows any non-`DELETE` call under `workers/scripts/p<id>` and `workers/workers/p<id>`. **[source]**
- The deployment body, including its `env` bindings, comes from the attempt's checkout: its `wrangler.jsonc` `previews` block, or a hand-made API call. Test 1 shows the uploader can name any Worker and entrypoint **[verified]**. Test 3 shows the Previews Base config can't override it **[verified]**.
- Cloudflare: "To deploy a Worker that has bindings to resources like Workers KV, R2, or D1, you need `Editor` access to the Worker. You do not need separate permissions on the bound resources to deploy the Worker." ([Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)) **[docs]** So even a narrowly scoped `CF_PREVIEW_TOKEN` (the README asks for Workers Scripts Edit only) doesn't stop a Preview binding production D1 `throng` or R2 `throng-logs` **[inferred]**. In `throng-ci`, `CF_PREVIEW_TOKEN` is in fact the full CI deploy token (`e2e.yml`) **[source]**.
- The grant also lets the attempt `PATCH /workers/workers/p<id>`, which is where the Previews Base config lives, and upload a production script to `p<id>` (`PUT workers/scripts/p<id>`). That production script would get its own public `workers.dev` URL **[source; inferred]**.
- **Consequence.** Anyone who can push an attempt to a project whose `main` config has a `preview` section can deploy a Preview that binds `throng`'s `WebEntrypoint` and acts as **any production user**. The same holds on `throng-ci`. This doesn't depend on demo option B. **[inferred from verified mechanism; deliberately not tested against `throng`]**

Two ways to close it:

- **Inspect the deploy bodies in `OutboundAuth`.** Parse the multipart `metadata` of `POST …/previews/{id}/deployments`, the `env` of `PATCH …/deployments/*`, `previews_base_config` on `PATCH /workers/workers/p<id>`, and `tail_consumers` on `POST …/previews`. Refuse any `service`, `d1`, `r2_bucket`, `kv_namespace`, `artifacts`, `workflow`, `dispatch_namespace` and similar binding that isn't on an allowlist, for example `service: "throng-ci"` only in a CI-demo project. Also refuse `PUT workers/scripts/p<id>` (Previews don't need it). This is fragile: every new binding type or API field is a new bypass. **[inferred]**
- **Move Previews to their own Cloudflare account.** Service bindings and other bindings only work within an account, so a Preview there can't bind `throng` or its data. The `p<projectId>` Workers, `CF_PREVIEW_TOKEN` and `CF_ACCOUNT_ID` for Previews move to that account. This is the robust fix, and it is also what makes the token route below the only way to reach a platform. **[inferred]**

### The binding route to `throng-ci` (after the hole is closed)

With the binding allowlisted to `throng-ci` only, the Preview runs the attempt's code with `env.PLATFORM` → `throng-ci`'s `WebEntrypoint`. That code can set any forwarded email, so it can act as **any `throng-ci` user**: read and write their projects and tasks, mint their tokens, and through those tokens use `/mcp` and `/git` on the public hostname. That is only CI data. Today `throng-ci` holds the e2e users' throwaway `e2e…` projects and whatever the demo creates. Nobody signs into `throng-web-ci` (it must not be behind Access, per the README), so no real person's data is there **[source]**. The binding route to `throng-ci` is impossible if Previews move to a separate account.

### The token route

The Preview holds a Throng token (`thr_…`) for one `throng-ci` user, a dedicated demo user, and sends it as `Authorization: Bearer`. It exposes exactly what that user can do on `throng-ci`:

- every `/api` route (all accept bearer; `apps/platform/src/api.ts`);
- `/mcp`;
- the git proxy for that user's projects;
- minting more tokens for that user, each up to 7 days (`MAX_TOKEN_TTL_SECONDS`), so the access can be renewed until the user's tokens are revoked. **[source]**

It can't act as anyone else, and it can't reach production. The attempt's code can read the token: it's a Preview secret in an untrusted Worker. And anyone who opens the public Preview URL acts as the demo user. So the demo user must own nothing but demo data **[inferred]**.

## 3. What `apps/web` would need

### Either route

- **A `previews` block in `apps/web/wrangler.jsonc`.** `wrangler preview` refuses to run without one **[source]**. It also warns that the config has named environments (`env.ci`) and targets the top-level Worker unless `--env` is passed **[source]**. Throng's `previewScript` passes no `--env` **[source]**.
- **No Access check in the Preview.** `forwardToPlatform` (`apps/web/src/server/forward.ts`) returns 401 unless the request carries a valid Access JWT for throng-web's `ACCESS_AUD` **[source]**. A `*-p<projectId>.<subdomain>.workers.dev` Preview isn't behind that Access application, so every `/api` call would fail. How a `workers.dev` Preview handles Access sign-in is the other open question on #32 and isn't covered here.
- **Monorepo layout.** `previewScript` runs `wrangler preview` at the checkout's root, and installs only from a `package-lock.json` (`npm ci`) **[source]**. Throng is a pnpm workspace with no root Wrangler config. `.throng/config.yml`'s `preview.command` would have to install with pnpm, build `apps/web` (`vite build` writes `apps/web/dist/server/wrangler.json`), and leave a root `.wrangler/deploy/config.json` whose `configPath` points at that file. Wrangler follows such a redirect when the directory has no user config of its own (`findRedirectedWranglerConfig`) **[source; untested]**. I couldn't confirm that `@cloudflare/vite-plugin` 1.63.1 copies `previews` into `dist/server/wrangler.json`, because a local build with a modified config was blocked in this session **[unverified]**. The alternative is a Throng change: let `previewScript` take a working directory or config path.

### Token route specifics

- Add a Preview-only path in `apps/web/src/server.ts`. When `env.PLATFORM_URL` and `env.PLATFORM_TOKEN` are set, forward `/api/*` (and raw file URLs) with `fetch(PLATFORM_URL + path, …)`, as `Authorization: Bearer ${PLATFORM_TOKEN}`, dropping `Cookie`, `Cf-Access-Jwt-Assertion` and `X-Throng-Access-Email`. This is what `apps/platform/scripts/e2e-browser.ts` already does from the browser side. Production keeps the binding path.
- Settings: `previews.vars.PLATFORM_URL = "https://throng-ci.<subdomain>.workers.dev"`, and no `previews.services` at all. The token is set by an operator, once per demo project, with `wrangler preview base-config secret put PLATFORM_TOKEN --worker-name p<projectId>` (copied into each new Preview), or per Preview with `wrangler preview secret put`. It never goes in the repo **[docs]**. The demo user and its token come from `throng-ci`, for example through `POST /e2e/token` with `SPIKE_TOKEN`. That token lasts up to 7 days, and the next CI run's cleanup or a revoke ends it.
- The `WebEntrypoint` trust model is unchanged. The Preview never touches it.

## Recommendation

1. **Prerequisite, separate ticket:** stop untrusted Previews from choosing their own bindings. Best is a separate Cloudflare account for Previews. The fallback is body inspection in `OutboundAuth` with a binding allowlist and no `PUT workers/scripts/p<id>`. Until then, no project should have a `preview` section on production Throng whose attempts come from anyone but the platform's operator.
2. **Option B over the token route:**
   - `apps/web` gets a `previews` block with `PLATFORM_URL` pointing at `throng-ci`, plus the bearer-forwarding path above.
   - The demo project's `p<projectId>` base config holds a `throng-ci` demo user's token.
   - The demo project's `preview.command` handles the pnpm monorepo build and config redirect, or Throng learns a preview working directory.
3. Use the **binding route** only if Previews stay in the platform's account **and** the allowlist pins `service: "throng-ci"`. Even then the Preview can act as any `throng-ci` user, so it's acceptable only while `throng-ci` holds nothing but test data.

## Open items

- Whether `@cloudflare/vite-plugin` 1.63.1 keeps the `previews` block in `dist/server/wrangler.json`. Check: add a `previews` block, run `vite build`, and read the output.
- Whether a root `.wrangler/deploy/config.json` redirect works for `wrangler preview` from the checkout's root. Check: run it in a scratch copy of the repo against a `research-preview-*` Worker.
- Access sign-in on a `workers.dev` Preview (#32's other question).
- Confirming the hole end to end: a Preview binding a D1 database it has no other access to, using a token that has only Workers Scripts Edit. Do this on a throwaway D1 and Worker, never `throng`.

## Sources

- https://developers.cloudflare.com/workers/previews/resources/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
- https://developers.cloudflare.com/workers/authorization/workers/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/#preview
- `wrangler@4.149.0`: `config-schema.json` (`PreviewsConfig.services`), `wrangler-dist/cli.js` (`runPreview`, `assemblePreviewDeploymentSettings`, the `previews.services` → `env` mapping, `createPreview`, `getPreviewBaseConfig`, `findRedirectedWranglerConfig`)
- This repo: `apps/web/wrangler.jsonc`, `apps/web/src/server.ts`, `apps/web/src/server/forward.ts`, `apps/platform/src/{index,app,auth,forwarded,preview,preview-workers,sandbox,scripts,workflows,api,tokens}.ts`, `apps/platform/README.md`, `.github/workflows/e2e.yml`, `docs/research/fork-previews.md`
