# Vite / Vite+ readiness for a Cloudflare Workers project

Research for [#7](https://github.com/gregjoeval/throng/issues/7) (part of map [#3](https://github.com/gregjoeval/throng/issues/3)).
Researched 2026-10-04. Versions are npm `latest` on that date.

## TL;DR

- **Vite+ 1.0 is stable and MIT, but don't adopt it yet.** It shipped 2026-09-28 and bundles **Vitest 5.0.1**. Cloudflare's Workers test integration (`@cloudflare/vitest-plugin` 1.3.6) still requires **Vitest ^4.1**. Vitest 5 support is in an open PR.
- **`@cloudflare/vite-plugin` covers every binding we need.** D1, Durable Objects, Queues, Workflows and Containers (and so Sandbox) run locally. Artifacts is an always-remote binding: it has no local simulator and connects to the real service during dev.
- **Recommended toolchain for the scaffold:** plain Vite 8 + `@cloudflare/vite-plugin` + Vitest 4.1.11 + `@cloudflare/vitest-plugin`, with standalone Oxlint and Oxfmt. These are the same lint and format tools Vite+ bundles, so switching later means running `vp migrate` and swapping imports.
- **Switch to Vite+ when** `@cloudflare/vitest-plugin` publishes a release whose peer range includes `vitest ^5`.

## 1. Vite+ (VoidZero): status, license, install, contents

| Fact                 | Value                                                                                                                                                                                                                    | Source                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Release              | `vite-plus@1.0.0`, published 2026-09-28 (rc.0 2026-09-22). The previous line was 0.3.x.                                                                                                                                  | npm metadata (`npm view vite-plus time`)                                      |
| Status               | "Vite+ 1.0 is out, stable, MIT licensed". The team also says it "is far from feature-complete". Remote caching, `vp release` and `vp docs` are planned for later.                                                        | [Announcing Vite+ 1.0](https://voidzero.dev/posts/announcing-vite-plus-1-0)   |
| License              | MIT, with no paid tier mentioned                                                                                                                                                                                         | npm `license`; announcement                                                   |
| Node engines         | `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`                                                                                                                                                                                   | npm `engines`                                                                 |
| Install              | `pnpm add -D vite-plus` and run with `pnpm exec vp ...`. A global `vp` is optional (`curl -fsSL https://vite.plus \| bash`) and also manages Node and the package manager. `vp env off` opts out of that.                | [viteplus.dev/guide](https://viteplus.dev/guide/)                             |
| Bundles (1.0.0 deps) | `vite` → `@voidzero-dev/vite-plus-core@1.0.0` (Vite 8 with Rolldown), `vitest@5.0.1`, `oxlint@1.85.0`, `oxlint-tsgolint` (type-aware lint), `oxfmt@0.70.0`, tsdown (`vp pack`), Vite Task (`vp run`, cached task runner) | `npm view vite-plus@1.0.0 dependencies`; [guide](https://viteplus.dev/guide/) |
| Commands             | `vp dev / build / preview / test / lint / fmt / check / pack / run / migrate / install`                                                                                                                                  | [guide](https://viteplus.dev/guide/)                                          |
| Test specifics       | `vp test` uses the bundled Vitest 5.0.1. Import from `vite-plus/test`. Test config belongs in `vite.config.ts` (a separate `vitest.config.ts` is "not recommended"). Custom Vitest pools and plugins are not documented. | [viteplus.dev/guide/test](https://viteplus.dev/guide/test)                    |

**Usable today?** Yes for a plain web app. For a Workers project it's blocked on the test runner (§3). Vite+ pins Vitest exactly (`5.0.1`), so you can't run it on Vitest 4. The last release that bundled Vitest 4 was `vite-plus@0.3.3` (`vitest 4.1.11`). It's pre-1.0, and we don't recommend it.

The Vite+ issue tracker also has open issues involving Cloudflare:

- [vite-plus#2481](https://github.com/voidzero-dev/vite-plus/issues/2481): the dev server wedges on restart with `@cloudflare/vite-plugin`, but only on the Vite+/Rolldown pipeline.
- [vite-plus#1671](https://github.com/voidzero-dev/vite-plus/issues/1671): React duplication with TanStack Start in workerd (not relevant to us).

An earlier `vp test` + pool-workers crash ([#1076](https://github.com/voidzero-dev/vite-plus/issues/1076)) is closed. The issue thread blames stale lockfiles and running a global `vp` that doesn't match the project's own `vite-plus` install. Always run the project-local `vp`.

## 2. `@cloudflare/vite-plugin` binding support

- Version: `@cloudflare/vite-plugin@1.62.5`. Peers: `vite ^6.1 || ^7 || ^8` and `wrangler ^4.147.0` (wrangler latest = 4.147.0). A `2.0.0-beta` is on the `beta` tag.
- It runs the Worker in workerd through Miniflare and reads the same Wrangler config, so local binding support matches `wrangler dev`. Cloudflare says remote bindings "are supported by Wrangler, the Cloudflare Vite plugin, and `@cloudflare/vitest-plugin`" ([Local development](https://developers.cloudflare.com/workers/development-testing/)). The one exception is legacy `wrangler dev --remote`, which the Vite plugin doesn't support.

| Binding                               | Local simulation      | Remote binding         | Notes                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                                    | yes                   | yes                    |                                                                                                                                                                                                                                                                                                                                        |
| Durable Objects                       | yes                   | no (always local)      |                                                                                                                                                                                                                                                                                                                                        |
| Queues                                | yes                   | yes                    |                                                                                                                                                                                                                                                                                                                                        |
| Workflows                             | yes                   | no (always local)      | Plugin changelog: Workflows exposed on `ctx.exports`; the local explorer (`e` in `vite dev`) inspects D1/R2/KV/DO/Workflows                                                                                                                                                                                                            |
| Containers                            | yes                   | no                     | The plugin builds or pulls container images in dev and cleans them up on close ([changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/vite-plugin-cloudflare/CHANGELOG.md)). Needs a local container engine.                                                                                                        |
| Sandbox (`@cloudflare/sandbox@1.0.0`) | via Containers + DO   | n/a                    | Sandbox is built on Containers + Durable Objects, so Containers support covers it                                                                                                                                                                                                                                                      |
| Artifacts                             | **no** (no simulator) | **yes, always remote** | Wrangler rejects `remote: false` on "always-remote bindings (AI, AI Search, Media, Artifacts, …)" (wrangler 4.84.0 [changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)). Dev needs Cloudflare auth and touches real repos. Artifacts entered open beta per the wrangler 4.146.0 changelog. |

Sources: [binding support per environment](https://developers.cloudflare.com/workers/local-development/bindings-per-env/) (updated 2026-06-25; it doesn't list Artifacts or Sandbox), [Vite plugin docs](https://developers.cloudflare.com/workers/vite-plugin/), wrangler and vite-plugin changelogs.

**Answer:** yes, every binding we need is supported. Artifacts is the exception to local dev: it's always remote, so dev and tests that use it need credentials or a test seam (stub the binding behind an interface).

## 3. Vitest / Vite+ test with the Workers pool

- **`@cloudflare/vitest-pool-workers` has been replaced** by **`@cloudflare/vitest-plugin`** (first published 2026-08-20). You configure it as a Vite plugin with `cloudflareTest({ wrangler: { configPath } })`. A migration codemod exists: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`. See [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) and [Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/). Final versions: `vitest-pool-workers@0.22.0` and `vitest-plugin@1.3.6`.
- **Both require `vitest ^4.1.0`** (peers `vitest`, `@vitest/runner`, `@vitest/snapshot` ^4.1.0). Under Vitest 5 the pool fails before running any test (`SyntaxError: Unexpected identifier 'file'`) ([workers-sdk#15618](https://github.com/cloudflare/workers-sdk/issues/15618), open).
- **Vitest 5 support is in progress, but there's no ETA:**
  - [workers-sdk#15500](https://github.com/cloudflare/workers-sdk/pull/15500) (open, updated 2026-10-02) adds Vitest 5 and switches to workerd's new module registry, as a major release. A consumer reported it passing 1,308 tests on a suite heavy on DO, D1 and KV.
  - Follow-up [#15993](https://github.com/cloudflare/workers-sdk/pull/15993) would make it **Vitest 5 only** and auto-detect `cloudflare.config.ts`.
  - A maintainer said "No current timeline … but it should be soon."
- **Second gotcha:** `@cloudflare/vite-plugin` ≥ 1.58.0 breaks `vitest run` when `cloudflare()` and a `test` block share one Vite config ("There is already a server associated with the config") ([workers-sdk#15969](https://github.com/cloudflare/workers-sdk/issues/15969), open; fix PR [#16022](https://github.com/cloudflare/workers-sdk/pull/16022)). Vite+'s advice to keep tests in `vite.config.ts` runs straight into this bug. Keep a separate `vitest.config.ts` that uses `cloudflareTest()`, not `cloudflare()`.
- Test helpers in `cloudflare:test` cover what we need:
  - Durable Objects: `runInDurableObject`, `runDurableObjectAlarm`
  - D1: `applyD1Migrations`
  - Queues: `createMessageBatch`, `getQueueResult`
  - Workflows: `introspectWorkflowInstance`

  Source: [Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/). Containers aren't covered on the test-API or known-issues pages. Treat Containers and Sandbox as integration-test territory, or mock them.

- Known limits:
  - Coverage must use Istanbul, not V8.
  - Fake timers don't affect the KV, R2 and cache simulators.
  - DO WebSockets need `--max-workers=1 --no-isolate`.

  Source: [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/).

**Answer:** Vitest 4.1 works today with `@cloudflare/vitest-plugin`. Vitest 5, and therefore Vite+ 1.0's `vp test`, does not work yet.

## 4. Fallbacks and the recommended toolchain

### Recommended now (scaffold)

| Concern             | Package                                                         | Version                                                            |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Dev/build           | `vite`                                                          | `8.3.2`                                                            |
| Workers integration | `@cloudflare/vite-plugin`                                       | `1.62.5` (or `1.57.3` if you hit #15969 and must share one config) |
| Deploy/types/CLI    | `wrangler`                                                      | `4.147.0`                                                          |
| Test runner         | `vitest`                                                        | `4.1.11` (pin `~4.1`, **not** `latest`, which is 5.x)              |
| Workers test pool   | `@cloudflare/vitest-plugin`                                     | `1.3.6`                                                            |
| Coverage (optional) | `@vitest/coverage-istanbul`                                     | `~4.1`                                                             |
| Lint                | `oxlint`                                                        | `1.86.0`                                                           |
| Format              | `oxfmt`                                                         | `0.71.0`                                                           |
| Typecheck           | `tsc --noEmit` (or `oxlint --type-aware` via `oxlint-tsgolint`) |                                                                    |
| Tasks               | `pnpm` scripts                                                  |                                                                    |

Config shape:

- `vite.config.ts` holds `cloudflare()`.
- A separate `vitest.config.ts` holds `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`.
- Pin `vitest` exactly, because pnpm will otherwise resolve 5.x.

### Fallbacks

- **Biome** (`@biomejs/biome@2.5.15`) if Oxlint or Oxfmt rule coverage falls short. It's a mature single tool for lint and format, but it isn't what Vite+ uses, so it would add migration cost later.
- **Plain `wrangler dev` / `wrangler deploy` (esbuild)** if `@cloudflare/vite-plugin` misbehaves. It reads the same config and supports the same bindings, and the Vitest plugin doesn't need the Vite plugin.
- **`vite-plus@0.3.3`** (Vitest 4.1.11) if you want `vp` today. It's pre-1.0, so we don't recommend it.

### Upgrade trigger

When `npm view @cloudflare/vitest-plugin peerDependencies` includes `vitest ^5`:

1. Run `vp migrate`.
2. Drop `vite`, `vitest`, `oxlint` and `oxfmt` in favour of `vite-plus@^1`.
3. Change imports to `vite-plus/test`.
4. Keep `vitest.config.ts` until #15969 is fixed.
5. Follow the Vite+ guide "Upgrade to Vitest 5" first.

The plugin will likely bump its major version and require workerd's new module registry (#15500).

## Other observations

- The Vite plugin docs say it "Produces standard Build Output for `cf build` and `cf deploy`". That points to a newer `cf` CLI alongside wrangler. This research didn't cover it.
- #15993 adds auto-detection of a new `cloudflare.config.ts` config format. Expect config-format churn.
