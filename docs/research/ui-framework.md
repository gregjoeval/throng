# UI framework: TanStack Start vs React Router on Workers

Research for [#112](https://github.com/gregjoeval/throng/issues/112), part of
map [#71](https://github.com/gregjoeval/throng/issues/71). Input for the UI
framework decision, not the decision itself. Sources were read on 2026-10-09.
Package versions are the npm `latest` tags on that date.

The setup this is measured against: `apps/web` is its own Worker behind
Cloudflare Access. It calls the platform Worker over a service binding. It
starts as an SPA and adds SSR route by route later. Data goes through TanStack
Query. The toolchain is Vite 8, `@cloudflare/vite-plugin` and Vitest 4.1.11
([vite-plus-readiness.md](./vite-plus-readiness.md)).

Source labels:

- **[docs]**: official documentation (tanstack.com, reactrouter.com,
  developers.cloudflare.com).
- **[release]**: a changelog, a GitHub release, or a release announcement.
- **[npm]**: npm registry metadata (dist-tags, publish times, peer
  dependencies, weekly downloads).
- **[gh]**: GitHub issues or repo metadata.
- **[inference]**: my own reasoning from the sources.
- **[unverified]**: not confirmed against a primary source.

## Answer

**Use TanStack Start, with `defaultSsr: false` instead of SPA mode.** Start
routes in the Worker from day one, and the routes we want server-rendered get
switched over one at a time later.

Why:

1. **It is the only option that covers "SPA now, SSR per route later" in one
   app on the Cloudflare Vite plugin.** Start has route-level `ssr`
   (`true` / `false` / `'data-only'` / a function) and a global `defaultSsr`
   [docs]. React Router's `ssr: false` is all or nothing [docs], and
   Cloudflare's own guide says _"SPA mode and prerendering are not currently
   supported when using the Cloudflare Vite plugin"_ [docs].
2. **Its TanStack Query integration is first-party.**
   `@tanstack/react-router-ssr-query` dehydrates and hydrates the
   `QueryClient` and streams queries that resolve during SSR [docs]. Loaders
   call `queryClient.ensureQueryData`. In React Router you wire this up
   yourself in `clientLoader` / `loader` [inference].
3. **Its type safety goes further.** Params, loader data and **search
   params** are typed and validated through `validateSearch`, which takes
   any Standard Schema validator such as Zod 4 or Valibot [docs]. React
   Router's typegen covers params and loader data, but not search params
   [docs]. A git UI leans heavily on search params (diff options, file
   filters, pagination), so this matters [inference].
4. **Binding access fits the service-binding design.** Server functions
   `import { env } from "cloudflare:workers"` and call
   `env.PLATFORM.someMethod()`. Cloudflare's Start guide shows exactly this,
   with a `WorkerEntrypoint` on the target Worker [docs].

What you give up: **Start is still a Release Candidate**, about 12.5 months
after the RC was announced. It also has much higher churn and open
Cloudflare-related bugs (see [Risks](#risks-that-could-make-either-a-bad-fit)).
React Router v8 is stable, older, and on a predictable yearly major cadence.
If the RC label or the churn is a deal-breaker, the fallback is **React Router
v8 in framework mode with `ssr: true` from day one**, not SPA mode (see
[§6](#6-fallback-if-start-is-rejected)).

## 1. Maturity and release status

|                                   | TanStack Start                                                                                                                                                                                  | React Router                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm `latest`                      | `@tanstack/react-start@1.168.60` (2026-09-30) [npm]                                                                                                                                             | `react-router@8.4.0` (2026-09-15) [npm]                                                                                                                      |
| Status                            | **Release Candidate**: _"TanStack Start is currently in the Release Candidate stage! … considered feature-complete and its API is considered stable. This does not mean it is bug-free"_ [docs] | **Stable.** v8.0.0 shipped 2026-06-17 as _"the first major release on our new planned yearly major release cadence"_, aiming at v9 around May 2027 [release] |
| RC announced                      | 2025-09-23, _"the build we expect to ship as 1.0"_ [release]. No 1.0 announcement appears on the TanStack blog as of 2026-10-09 [docs]                                                          | n/a                                                                                                                                                          |
| Other dist-tags                   | `pre: 1.168.33-pre.0` [npm]                                                                                                                                                                     | `version-7: 7.18.4` (v7 still patched), `pre: 8.0.0-pre.1` [npm]                                                                                             |
| Versions published                | 748 `1.x` versions of `@tanstack/react-start` [npm]                                                                                                                                             | 8.0.0 → 8.4.0 in about 3 months [npm]                                                                                                                        |
| Weekly downloads (2026-10-01..07) | `@tanstack/react-start` 11.2M, `@tanstack/react-router` 18.6M [npm]                                                                                                                             | `react-router` 56.5M [npm]                                                                                                                                   |
| Repo                              | TanStack/router: 15.2k stars, 723 open issues + PRs [gh]                                                                                                                                        | remix-run/react-router: 56.6k stars, 223 open [gh]                                                                                                           |
| Recent security                   | _"TanStack Start security update: CVE-2026-102989"_, a reflected XSS fix, 2026-09-30 [docs]. Affected and fixed versions are not on the listing [unverified]                                    | none found in this pass [unverified]                                                                                                                         |

Notes:

- Start's package version is already `1.x` because it shares a release train
  with TanStack Router. "RC" is a docs label, not a semver prerelease
  [npm][inference].
- React Router breaking changes arrive first as `future.v8_*` flags, so its
  majors are meant to be _"relatively boring"_ [release]. v8 removed the old
  `@react-router/dev/vite/cloudflare` dev proxy in favour of
  `@cloudflare/vite-plugin` [release].

## 2. Running on Workers with `@cloudflare/vite-plugin`

Cloudflare's Vite plugin docs list both TanStack Start and React Router (v8)
as framework guides [docs].

### TanStack Start

From Cloudflare's [TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
[docs]:

```ts
// vite.config.ts
plugins: [
  cloudflare({ viteEnvironment: { name: "ssr" } }),
  tanstackStart(),
  react(),
],
```

```jsonc
// wrangler.jsonc
"main": "@tanstack/react-start/server-entry",
"compatibility_flags": ["nodejs_compat"],
```

- For Queues, Cron, DOs or Workflows, set `main` to a custom `src/server.ts`
  that re-exports `handler.fetch` [docs].
- Bindings come from `import { env } from "cloudflare:workers"` inside
  `createServerFn` handlers [docs].
- The guide includes a service binding example (`env.AUTH_SERVICE.verify()`)
  and says _"the target Worker must extend `WorkerEntrypoint`"_. Types for
  both Workers come from `wrangler types -c ./wrangler.jsonc -c
../other/wrangler.jsonc` [docs].
- TanStack's hosting page lists Cloudflare as an official hosting partner
  [docs].

### React Router v8

From Cloudflare's [React Router guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/)
[docs]:

- C3 scaffolds `main: ./workers/app.ts`, which calls
  `requestHandler(request, { cloudflare: { env, ctx } })`. Loaders and actions
  read `context.cloudflare.env.*`. You own the entry, so extra exports
  (DOs, Workflows) are straightforward.
- `react-router.config.ts` has `ssr: true`.
- **"SPA mode and prerendering are not currently supported when using the
  Cloudflare Vite plugin."** For an SPA, the guide says to start from the
  React template and use React Router _as a library_ (data or declarative
  mode) [docs]. Those modes lose typegen, which is _"Not available with Data
  or Declarative"_ [docs].

## 3. "SPA first, SSR per route later"

**TanStack Start.** There are two mechanisms [docs]:

- **SPA mode** (`tanstackStart({ spa: { enabled: true } })`) prerenders a
  `/_shell.html` at build time. It expects a CDN rewrite of 404s to the
  shell, plus allow-listed `/_serverFn/*` and `/api/*`. Server functions and
  server routes keep working.
- **Selective SSR.** Each route takes `ssr: true | false | 'data-only' |
(params, search) => …`, and `createStart({ defaultSsr: false })` flips the
  global default. Children inherit and _"can only be changed to be more
  restrictive"_. For the first route that isn't fully server-rendered, the
  server renders its `pendingComponent`.

**Prefer selective SSR to SPA mode on Cloudflare.** SPA mode depends on
build-time prerendering, which has open bugs when `@cloudflare/vite-plugin` is
present:

- [TanStack/router#7740](https://github.com/TanStack/router/issues/7740)
  (open). With the Cloudflare plugin, `_shell.html` contains the `/` route's
  HTML and loader data. A commenter traced it to the prerenderer setting
  `TSS_PRERENDERING` on the Node process while SSR runs in workerd [gh].
- [#7481](https://github.com/TanStack/router/issues/7481) (open): _"Static
  prerendering breaks with Cloudflare plugin"_ (0 pages prerendered) [gh].
- [#6330](https://github.com/TanStack/router/issues/6330) (open): build with
  Cloudflare + prerender fails under turbo in a monorepo [gh].

`defaultSsr: false` needs no prerender step. The Worker renders the root
shell per request and routes hydrate on the client. Later, a route opts in
with `ssr: true` or `'data-only'` [docs][inference]. Behind Cloudflare Access,
paying for a Worker invocation per page load costs nothing that matters
[inference].

**React Router.** `ssr: false` is app-wide [docs], and it is unsupported
with the Cloudflare plugin anyway [docs]. With `ssr: true` you can still get
mostly-client routes: give a route only a `clientLoader` plus a
`HydrateFallback`, so the server renders the fallback [docs][inference]. But
there is no per-route switch and no shell-only mode.

## 4. Data loading with TanStack Query

- **Start/Router:** `@tanstack/react-router-ssr-query@1.167.3` (peer
  `@tanstack/react-query >=5.102.0`, `@tanstack/react-router >=1.170.33`)
  [npm]. `setupRouterSsrQueryIntegration({ router, queryClient })` gives
  _"Automatic SSR dehydration/hydration of your `QueryClient`"_ and
  _"Streaming of queries that resolve during initial server render"_. The
  docs ask for _"a fresh `QueryClient` … per request in SSR environments"_
  [docs]. Current `@tanstack/react-query` is `5.104.1` [npm].
  - Open issue
    [#7529](https://github.com/TanStack/router/issues/7529):
    `router-core@1.171.7+`, _"SSR query stream never closes with ssr-query →
    Serialization timeout"_, labelled `information needed` [gh]. It only
    bites once SSR is on.
- **React Router:** no first-party Query adapter. The usual pattern is
  `clientLoader` → `queryClient.ensureQueryData(...)` with the `QueryClient`
  in a module or context, plus manual dehydrate/`HydrationBoundary` once SSR
  loaders are used [inference]. It works, but it is our code to maintain.
- **Calling the platform:** in either framework, server-side code reaches the
  platform Worker over the service binding. In SPA-style routes the browser
  needs an HTTP path on `apps/web` that forwards to the binding. In Start
  that is a server function or server route. In React Router it is a
  resource route or the custom `workers/app.ts` [docs][inference]. If the
  platform exposes an OpenAPI/Hono client
  ([openapi-mcp.md](./openapi-mcp.md)), the server function body is a single
  call to it [inference].

## 5. Type-safe routing

|                       | TanStack Router/Start                                                                                                                                            | React Router v8 (framework mode)                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism             | File-based route tree generated by `@tanstack/router-plugin`, with types inferred from route definitions [docs]                                                  | `react-router typegen` writes `.react-router/types/+types/<route>.d.ts` per route, kept current by the Vite plugin in dev [docs] |
| Path params           | typed [docs]                                                                                                                                                     | typed, inferred from the path pattern [docs]                                                                                     |
| Loader data           | typed [docs]                                                                                                                                                     | typed (`Route.ComponentProps['loaderData']`) [docs]                                                                              |
| Search params         | **typed and validated** via `validateSearch`. Standard Schema (Zod 4, Valibot, ArkType) works with no adapter, and the typed object flows to child routes [docs] | **not typed** by typegen. You parse `URLSearchParams` yourself [docs][inference]                                                 |
| Links                 | `<Link to params search>` checked against the route tree [docs]                                                                                                  | `href()` checks paths and params [docs]                                                                                          |
| Data/declarative mode | n/a                                                                                                                                                              | typegen is _"Not available"_ [docs]                                                                                              |

## 6. Fallback if Start is rejected

React Router v8 **framework mode with `ssr: true`** on `@cloudflare/vite-plugin`,
which is Cloudflare's documented, C3-scaffolded path [docs]. Make routes
client-first with `clientLoader` + `HydrateFallback` and turn on server
`loader`s per route later [docs][inference]. **Avoid** React Router's SPA mode
(unsupported on the plugin [docs]) and **avoid** data/declarative mode (no
typegen, and moving to framework mode later is a migration) [docs][inference].

## 7. Vite 8 and Vitest 4.1

|             | TanStack Start                                                                        | React Router v8                                                                          |
| ----------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Vite peer   | `@tanstack/react-start`: `vite >=7.0.0`. `@tanstack/router-plugin`: `>=5 … >=8` [npm] | `@react-router/dev`: `vite ^7.0.0 \|\| ^8.0.0`, `wrangler ^4.0.0` [npm]                  |
| React       | `>=18 \|\| >=19` [npm]                                                                | **`>=19.2.7`** (raised in v8) [npm][release]. `react@latest` is 19.3.0 [npm]             |
| Node        | `>=22.12.0` [npm]                                                                     | `>=22.22.0` [npm][release]. The repo's `engines` is `>=22`, local Node is 24 [inference] |
| Other peers | optional `@rsbuild/core ^2` [npm]                                                     | optional `@vitejs/plugin-rsc ~0.5.26`, `react-server-dom-webpack` [npm]                  |

- `@cloudflare/vite-plugin@1.63.1` (latest) peers `vite ^6.1 || ^7 || ^8`
  and **`wrangler ^4.149.0`** [npm]. `apps/platform` pins plugin `1.62.5`
  and wrangler `4.147.0`, so moving `apps/web` to the latest plugin means
  bumping wrangler workspace-wide [inference].
- Vitest: neither framework ships its own test runner. Component and route
  tests use Vitest 4.1 (jsdom or browser mode) with the framework's Vite
  plugin left out or stubbed. Worker-level tests use
  `@cloudflare/vitest-pool-workers`, which is still Vitest 4.x only
  ([vite-plus-readiness.md](./vite-plus-readiness.md)) [inference]. Neither
  framework's docs were checked for a Vitest recipe in this pass
  [unverified].

## 8. Migration risk

- **TanStack Start:** still RC, so a 1.0 might rename things, though the RC
  post promised _"no significant API changes"_ [release]. It publishes
  often (patch releases every few days, 748 versions) and depends on a
  cluster of internal packages pinned to exact versions
  (`start-plugin-core 1.171.49`, `start-server-core 1.169.39`, …) [npm].
  Keep `@tanstack/*` together with Renovate grouping [inference]. A recent
  upgrade regression ("SSR crash … after upgrading to react-start@1.168.60",
  #8584) shows patch bumps can break things [gh].
- **React Router:** one breaking major a year, staged behind future flags
  [release]. v9 is expected around May 2027 [release]. v7 → v8 dropped
  Node 20, raised React to 19.2.7, and removed the Cloudflare dev proxy
  [release]. All of that is already true for a greenfield app.
- **Switching later:** the two have different route-module and data models,
  so moving between them later is a rewrite of the routing layer. Components
  and TanStack Query hooks carry over [inference].

## Risks that could make either a bad fit

- **React Router: SPA mode does not work with `@cloudflare/vite-plugin`**
  [docs]. If we insisted on a static SPA built by React Router _on the
  plugin_, it would be a bad fit. Use framework mode with SSR on, or library
  mode with no typegen.
- **React Router: search params are untyped**, and TanStack Query is
  integrated by hand [docs][inference].
- **TanStack Start: still "Release Candidate"** a year after the RC
  announcement, with high churn and a reflected-XSS CVE fixed on
  2026-09-30 [docs][npm].
- **TanStack Start: prerendering and SPA mode are buggy with the Cloudflare
  plugin** (#7740, #7481, #6330, all open) [gh]. Avoid them and use
  `defaultSsr: false`. If we ever need build-time prerendering on Cloudflare,
  this is a real gap.
- **TanStack Start: the ssr-query streaming timeout** (#7529, open) could
  bite when SSR is turned on for Query-backed routes [gh].

## Open questions

1. Does `createStart({ defaultSsr: false })` on `@cloudflare/vite-plugin`
   give a clean shell with no loader execution on the server? A short spike
   should confirm it before committing, since #7740 shows the Cloudflare
   plugin changes shell behavior in SPA mode [unverified].
2. Can a Start server function call a `WorkerEntrypoint` RPC method on the
   platform Worker with end-to-end types (`wrangler types -c` for both
   configs), or should `apps/web` call the platform's HTTP API through the
   binding's `fetch`? This depends on the
   [#77](https://github.com/gregjoeval/throng/issues/77) API decision.
3. How does Cloudflare Access identity (`Cf-Access-Jwt-Assertion`) reach
   server functions? Do we pass it to the platform Worker, or does the
   platform trust the binding? [unverified]
4. Which versions does CVE-2026-102989 affect, and is `1.168.60` the fixed
   one? It wasn't on the blog listing [unverified].
5. Does TanStack ship Start 1.0 before `apps/web` is built? There's no
   announced date [unverified].
6. Will workspace-wide wrangler move to `>=4.149.0` for
   `@cloudflare/vite-plugin@1.63.x`, or will `apps/web` pin plugin `1.62.5`
   to match `apps/platform`?

## Sources

- TanStack Start overview (RC status): https://tanstack.com/start/latest/docs/framework/react/overview
- TanStack Start v1 RC announcement (2025-09-23): https://tanstack.com/blog/announcing-tanstack-start-v1
- TanStack Start SPA mode: https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode
- TanStack Start selective SSR: https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr
- TanStack Start hosting: https://tanstack.com/start/latest/docs/framework/react/guide/hosting
- TanStack Router + Query integration: https://tanstack.com/router/latest/docs/integrations/query
- TanStack Router search params: https://tanstack.com/router/latest/docs/framework/react/guide/search-params
- TanStack blog (CVE-2026-102989 post, 2026-09-30): https://tanstack.com/blog
- React Router CHANGELOG (v8.0.0 … v8.4.0): https://github.com/remix-run/react-router/blob/main/CHANGELOG.md
- React Router releases: https://github.com/remix-run/react-router/releases
- React Router SPA mode: https://reactrouter.com/how-to/spa
- React Router type safety: https://reactrouter.com/explanation/type-safety
- Cloudflare: TanStack Start guide: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
- Cloudflare: React Router guide: https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/
- Cloudflare Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/
- Cloudflare static assets SPA routing: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- GitHub issues: TanStack/router #7740, #7481, #6330, #7529, #8584
- npm registry: `npm view <pkg> dist-tags|time|peerDependencies|engines` for
  `react-router`, `@react-router/dev`, `@react-router/cloudflare`,
  `@tanstack/react-start`, `@tanstack/react-router`,
  `@tanstack/router-plugin`, `@tanstack/react-router-ssr-query`,
  `@tanstack/react-query`, `@cloudflare/vite-plugin`, `vite`, `vitest`;
  api.npmjs.org weekly downloads.
