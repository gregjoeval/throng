# Sign-in on a web app Preview

Research for [#229](https://github.com/gregjoeval/throng/issues/229), part of map [#222](https://github.com/gregjoeval/throng/issues/222), for demo option B on [#32](https://github.com/gregjoeval/throng/issues/32): a Throng web change, previewed against `throng-ci`. Sources were read on 2026-10-12. Code is `origin/main` at `3c51b68`.

Each claim is tagged:

- **verified**: checked against this repo's code or a live, read-only request to the account.
- **docs**: stated by Cloudflare's documentation.
- **inferred**: follows from the two above but wasn't tested.

Nothing on Cloudflare was created, changed or deleted.

## Answer

- **A Preview of the web app is not behind Access.** Throng deploys each attempt's Preview under the project's own Worker as `<attempt>-p<projectId>.gregjoeval.workers.dev`. No Access application covers that hostname, and Previews are public by default.
- **Access can cover Preview hostnames.** You can protect one Worker's Previews, every Worker's Previews in the account, or a hostname pattern such as `*-p<projectId>.gregjoeval.workers.dev`.
- **With no JWT, the web app still loads but shows "Signed out".** The page shell loads, and every `/api/*` call it makes returns a 401.
- **The web app has no token sign-in.** It accepts only an Access JWT. Only the e2e harness gets around this, by rerouting the browser's API calls.
- **Recommended for the demo:** a new Access application for the demo project's Previews only, with its own audience (AUD) tag. Put that AUD in the demo branch's `previews` vars. It costs one dashboard action and one config value.
- **Security cost of the recommendation:** the attempt's code receives every viewer's Access JWT and email. Those JWTs are worthless anywhere else only because nothing else trusts that AUD.
- **Never put Preview hostnames under the existing `throng-web` application.** That application's AUD is also trusted by the production platform's `POST /api/tokens`. An attempt could replay a viewer's JWT there and mint a production Throng token as that viewer.

## How the web app signs in today

- Access sends a signed JWT in `Cf-Access-Jwt-Assertion`. `throng-web` checks it itself: the issuer must be `https://${ACCESS_TEAM_DOMAIN}` and the audience must be `ACCESS_AUD` (`apps/web/src/server/access.ts`). **verified**
- Only `/api/*` and raw file URLs are checked. Everything else goes to TanStack Start with no auth check (`apps/web/src/server.ts`). Routes render on the client by default (`defaultSsr: false`, `apps/web/src/start.ts`). **verified**
- On a valid JWT, `forwardToPlatform` deletes `Authorization`, `Cookie` and `Cf-Access-Jwt-Assertion`. It sets `X-Throng-Access-Email` and calls the `PLATFORM` service binding, which targets the platform's `WebEntrypoint` (`apps/web/src/server/forward.ts`). With no JWT, or an invalid one, it returns `401 {"error":{"code":"unauthorized","message":"a valid Access session is required"}}`. **verified**
- The UI shows a 401 as "Signed out" (`apps/web/src/components/states.tsx`). There is no sign-in form and nowhere to enter a token. Sign-out links to `/cdn-cgi/access/logout`. **verified**
- `WebEntrypoint` trusts the forwarded email and creates a user for an unknown email on first use (`userForEmail`, `apps/platform/src/users.ts`). The platform's public hostname rejects any request that carries the header (`rejectForwardedIdentity`). **verified**
- The public platform also takes an Access JWT, checked against the same `ACCESS_AUD`, on `/api/me` and `/api/tokens`, including `POST /api/tokens`, which mints a token (`apps/platform/src/api.ts`, `bearerOrAccess`). **verified**
- Both Workers use the same AUD, `2a713dce…6712b`, in production and in `env.ci` (`apps/web/wrangler.jsonc`, `apps/platform/wrangler.jsonc`). So a JWT from the `throng-web` Access app is accepted by `throng`, `throng-ci`, `throng-web` and `throng-web-ci`. **verified**
- Any signed-in user may read any project and its tasks in P0 (`apps/platform/src/projects.ts`, `apps/platform/src/tasks.ts`). A viewer who signs in with their own email can therefore browse a demo project that someone else owns. **verified**

## Live state of the account (read-only probes)

These are unauthenticated `GET`s to public hostnames, plus read-only API calls with the local Wrangler OAuth token.

| Hostname | Result | Meaning |
| --- | --- | --- |
| `throng-web.gregjoeval.workers.dev` | `302` to `gregjoeval.cloudflareaccess.com`, AUD `2a713dce…` | Behind the `throng-web` Access app |
| `nope-throng-web.gregjoeval.workers.dev` (a would-be Preview of `throng-web`) | `302` to Access, **same AUD** | That app also covers the `throng-web` Worker's Preview hostnames |
| `throng-web-ci.gregjoeval.workers.dev` | `200` HTML shell; `/api/me` returns the 401 above | `throng-web-ci` is not behind Access. The e2e workflow requires this (`.github/workflows/e2e.yml`, "Wait for throng-web-ci") |
| `nope-throng-web-ci.gregjoeval.workers.dev` | `404`, no Access | |
| `t1a1-research-preview-parent.gregjoeval.workers.dev` (a real Preview) | `200`, `x-robots-tag: noindex`, no Access | **Account-wide Access on Previews is off** |

All **verified**. More:

- The account's workers.dev subdomain is `gregjoeval` (`GET …/workers/subdomain`). **verified**
- **Not verified:** whether the `throng-web` app covers `nope-throng-web` through a Worker-level (`worker`) destination or a hostname wildcard. The OAuth token has no Access scopes. `GET …/access/apps` and `…/access/policies` came back as empty lists, but the redirect above proves at least one app exists, so the empty list is a scope artifact. To check, open the `throng-web` application's destinations in Zero Trust → Access → Applications. Either way, the AUD on those Preview hostnames is the production one.

## What Cloudflare documents

### Previews and Access

- "Preview URLs are public by default." Cloudflare Access can be added "to require sign-in". "You can protect all Previews on an account, one Worker's Previews, or specific hostnames." ([Previews](https://developers.cloudflare.com/workers/previews/)) **docs**
- Preview URL: `<preview-name>-<worker-name>.<subdomain>.workers.dev`. Deployment URL: `<deployment-id>-<worker-name>.<subdomain>.workers.dev`. (same page) **docs**
- Access can "require visitors to authenticate before accessing Version URLs, Preview URLs, and Deployment URLs". "Disabling your `workers.dev` route does not disable Version URLs, Preview URLs, or Deployment URLs." ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)) **docs**
- Use Access "to restrict access to custom domain and `workers.dev` Preview URLs". ([Previews custom domains, Protect Preview content](https://developers.cloudflare.com/workers/previews/custom-domains/)) **docs**

### Scopes of a Workers Access rule

Source: [Workers: Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). **docs**

| Scope | Dashboard | API `destinations[].type` |
| --- | --- | --- |
| Every Worker's Previews | Workers & Pages → **Protect all Workers** → *Previews only* | `all_preview_workers` |
| Every Worker, production and Previews | same card → *All traffic* | `all_workers` |
| One Worker's Previews | the Worker → **Access** tab → Previews | `preview_worker` + `worker_id` |
| One Worker, production and Previews | same tab | `worker` + `worker_id` |
| A hostname or path | Zero Trust → Access → Applications → self-hosted | `public` + `uri` |

More rules from that page:

- The most specific rule wins: hostname or path first, then Worker, then account. Removing a narrower rule "can reveal account-level Access underneath."
- A Worker-level rule covers "every domain associated with the Worker, including its routes, Custom Domains, `workers.dev` hostname, and previews."
- Worker-level policies do not support WebSockets (the upgrade fails with a `403`).
- `ctx.access` isn't passed through Service Bindings or RPC, nor by the static-assets router to the user Worker. That router can be added by the Vite plugin that TanStack Start uses. It doesn't matter here: `throng-web` reads the header itself.

The API reference adds: `preview_worker`: "Only requests to preview deployments of the Worker will be protected." `public` destinations "support sub-domain and path. Wildcard '\*' can be used". ([Create Access application](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)) **docs**

### Wildcards in hostnames

Source: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). **docs**

- A wildcard may be part of a label. `*test.example.com` covers `alphatest.example.com` (and `test.example.com`), but not `beta.test.example.com`.
- "At most one wildcard in between each dot". A wildcard covers one level only, never the apex.
- So `*-p<projectId>.gregjoeval.workers.dev` matches exactly the project's Preview and Deployment URLs. That's **inferred**: the docs give no workers.dev example. The live redirect on `nope-throng-web` shows Access does match Preview-shaped workers.dev hostnames.

### The AUD and the JWT

Source: [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). **docs**

- "Cloudflare Access assigns a unique AUD tag to each application." "The `aud` claim in the token payload specifies which application the JWT is valid for." It never changes unless the app is deleted and recreated.
- The token reaches the origin as the `Cf-Access-Jwt-Assertion` header, and from browsers also as a `CF_Authorization` cookie. Validate `iss` (the team domain) and `aud`.
- Every application in the account is signed with the same team key pair. Only `aud` keeps one application's token from being accepted by another.

### Preview configuration

Source: [Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/). **docs**

- "Previews do not inherit production settings. Define them in the `previews` block". Vars go in `previews.vars`. Wrangler uses "the configuration file from your current branch".
- Service bindings from a Preview "call the bound Worker's production deployment". Whether a Preview can bind to `throng-ci`'s `WebEntrypoint` is a separate open question on #32.

## What happens on a web app Preview today

Suppose a Preview of an attempt's `apps/web` is deployed as `t42a3-p<projectId>.gregjoeval.workers.dev`.

1. No Access app matches `*-p<projectId>`, and account-level Previews Access is off. The Preview is public, and the browser sends no JWT. **verified** (the live probe of a real Preview)
2. The page shell loads. Each `/api/*` call hits `forwardToPlatform`, finds no `Cf-Access-Jwt-Assertion` and returns 401. The UI shows "Signed out", with no way to sign in. **verified** (the same code, live on `throng-web-ci`)
3. Even behind Access, the Preview needs `previews.vars.ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, because top-level and `env.ci` vars are not inherited. Without them, `remoteAccessVerifier` builds `https://undefined/cdn-cgi/access/certs`, verification throws, and every call is a 401. **inferred** from the code and the docs

## Options for a demo viewer

### 1. A new Access app on the demo project's Previews, with its own AUD (recommended)

Steps:

1. Create the app with either of these:
   - **Dashboard:** Workers & Pages → `p<projectId>` → **Access** → protect Previews only, with the existing `throng-web users` policy.
   - **Self-hosted app:** hostname `*-p<projectId>.gregjoeval.workers.dev` under Zero Trust → Access → Applications, with the same policy and One-time PIN.
2. Copy the new app's AUD into the demo branch's `apps/web/wrangler.jsonc`, under `previews`:
   - `vars`: `ACCESS_TEAM_DOMAIN` and the new `ACCESS_AUD`.
   - `services`: `PLATFORM` → `throng-ci`, entrypoint `WebEntrypoint`.

How it works:

- A viewer opens the Preview, signs in through Access with a PIN (or not at all, while their team session lasts), and the Preview's server verifies the JWT and forwards their email to `throng-ci`. **inferred**
- `throng-ci` creates a user for that email on first use. P0 lets any user read the demo project. **verified** in code

Effort and fit:

- **Effort:** one dashboard action, plus one value in the demo's config. The AUD isn't secret. No Throng code changes. The Worker-level route needs `p<projectId>` to exist first; Throng creates it with the project. The hostname route can be set up as soon as the project id is known. **docs / verified**
- Gating is per project. Other projects' Previews and Throng's automation are untouched; the platform never fetches Preview URLs. **verified** (no fetch of a Preview URL in `apps/platform/src`)

Security cost:

- The attempt's code is the Preview's server. It receives each viewer's JWT (header and cookie) and email. The JWT is valid only for the new AUD, and nothing else trusts that AUD. That holds only while the AUD stays out of every other Worker's config. **verified** for today's config
- The JWT is replayable to the same project's other Previews until it expires (the app's session duration). Those Previews run attempt code that can forge identity anyway, so this adds nothing. **inferred**
- Sign-in protects nothing on `throng-ci`. An attempt can forge `X-Throng-Access-Email` for any email over the binding, with or without a viewer. This is option B's existing cost, which is why it must point only at `throng-ci`. **verified** (`WebEntrypoint` trusts the header)
- Attempt code can show anything on an Access-gated hostname, including a fake sign-in page. Keep the policy to the team. **inferred**

An equal-effort variant is the account-wide **Protect all Workers → Previews only** card. It also puts every other project's Previews behind sign-in, which is arguably right for untrusted code but changes behaviour beyond the demo. Its single AUD would be shared by all projects' Previews. Never pick *All traffic*: it would put the `throng` platform behind Access and break agents' and git's bearer-token access. **docs / inferred**

### 2. Reuse the existing `throng-web` Access app (do not)

Adding `*-p<projectId>.gregjoeval.workers.dev` to the `throng-web` app means no new app and no new AUD. But every viewer's JWT then carries the production AUD, which the public `throng` platform accepts on `POST /api/tokens`. The attempt's code could mint a **production** Throng token as the viewer and act as them on production. **verified** (the code path and the shared AUD)

The same applies to anything previewed under the `throng-web` Worker itself: its Preview hostnames already get this AUD (the `nope-throng-web` probe). Throng's own Previews never deploy there; they go under `p<projectId>`. Keep it that way.

### 3. A demo-only identity for CI Previews

The Preview's server would forward a fixed email, such as a demo user, whenever a `previews` var is set, with no Access at all.

- **Effort:** a code change in `apps/web` (a branch around `forwardToPlatform`, plus tests) landed in the demo repo's `main`.
- **Security cost:** the Preview is public, so anyone holding the URL acts as the demo user on `throng-ci`. Preview hostnames are guessable: the attempt name plus the project id. This option also puts an auth-bypass switch into trusted code that production builds too, where one misplaced var turns off sign-in.
- It adds nothing an attempt can't already do (forge the header), but it removes the gate on who can see the Preview. Worse than option 1 on both effort and risk.

### 4. The app's own token sign-in

It doesn't exist. `forwardToPlatform` deletes `Authorization` and accepts only an Access JWT, and the UI has no token field. **verified**

`WebEntrypoint` does accept bearer tokens (`bearerOrForwarded`), so a token sign-in would be a web feature: a form, storage, and forwarding the token. That's more work than option 1.

The one existing workaround is the e2e harness (`apps/platform/scripts/e2e-browser.ts`). Playwright intercepts the page's `/api/*` and sends it to the platform's public hostname with a Throng token. A presenter could drive the Preview that way with a `throng-ci` token and no Cloudflare changes. But only the presenter's scripted browser is signed in, and the Preview's own `/api` forwarding is bypassed, so this only fits a UI-only change. **verified** (how the harness works) / **inferred** (its use for a demo)

## Tests worth running (not run: they change Cloudflare)

1. Create option 1's app for a throwaway project's Worker, and deploy a Preview of a tiny Worker that echoes `Cf-Access-Jwt-Assertion`. Then check four things:
   - the Preview redirects to Access;
   - the decoded `aud` is the new app's, not `2a713dce…`;
   - the same JWT sent to `https://throng.gregjoeval.workers.dev/api/me` returns 401;
   - another project's Preview stays public.
2. Repeat with the self-hosted `*-p<projectId>` hostname pattern, to confirm a partial-label wildcard on workers.dev matches both Preview and Deployment URLs.
3. In the Zero Trust dashboard, read the `throng-web` app's destinations to learn why it covers `*-throng-web` hostnames. If it's a `worker` destination, consider narrowing it, so nothing under the `throng-web` Worker ever runs untrusted code with the production AUD.
