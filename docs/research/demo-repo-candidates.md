# Demo repo candidates

Research for [#224](https://github.com/gregjoeval/throng/issues/224), part of map [#222](https://github.com/gregjoeval/throng/issues/222) (import a repo from GitHub, demo first).
Researched 2026-10-12. Repo facts come from the GitHub API (`gh api repos/<o>/<r>`: `size` is GitHub's packed size in KB, history included). Every candidate was shallow-cloned outside the repo. Each was installed with `npm ci --ignore-scripts` or `pnpm install --frozen-lockfile --ignore-scripts`, and its tests were run with the network cut off (`unshare -rn`, loopback only). Bundles were checked with `wrangler deploy --dry-run`. Peak memory is the summed RSS of the test process tree. The machine was faster than a Sandbox, and Node was 24 here against 22 in the image. No candidate was deployed: we have no Cloudflare account to deploy them with.

## Answer

Ranked shortlist:

1. **[willswire/unifi-ddns](https://github.com/willswire/unifi-ddns)**. MIT, 1.3k stars, 500 KB, active. It is one plain Worker with **no bindings or secrets**, and npm with a lockfile. It has 18 vitest tests that finish in under 1 s offline, and its coverage summary is already JSON (98.6 % lines). It needs the least from Throng: add `previews: {}` and a `.throng/config.yml`. **Recommended.**
2. **[G4brym/authentication-using-d1-example](https://github.com/G4brym/authentication-using-d1-example)**. MIT, by the author of chanfana (a Cloudflare engineer), 558 KB. It is a Hono + chanfana API whose Preview shows a Swagger UI. It has 11 workers-pool tests (2.5 s offline) and a clean `tsc`. Its catch is one **D1 binding**: Previews need a staging D1 database that someone creates and migrates outside Throng.
3. **[yusukebe/ramen-api](https://github.com/yusukebe/ramen-api)**. MIT, by Hono's author, the most fun to show (REST + GraphQL + MCP over ramen shops), 10.6 MB. It has 48 workers-pool tests in about 2 s. But it has **no npm lockfile** (only `bun.lock`), and it uses **static assets**, which Throng's Preview egress blocks today (see "Throng-side findings" below).
4. **[HaveIBeenPwned/PwnedPasswordsCloudflareWorker](https://github.com/HaveIBeenPwned/PwnedPasswordsCloudflareWorker)**. BSD-3, by Troy Hunt, the most recognisable name, 286 KB. It has 33 workers-pool tests in about 3 s. But its Wrangler config sits in a subdirectory, it needs 7 Azure secrets plus service bindings to itself, it uses pnpm 11, and its tests peak at 1.3 GB. It works for a **scoring-only** demo, and its Preview would not do anything useful.
5. **[cloudflare/workers-chat-demo](https://github.com/cloudflare/workers-chat-demo)**. BSD-3, 1.1k stars, 32 KB, Cloudflare's own Durable Objects chat. It has **no tests and no dependencies**, so Throng has nothing to score. It is listed only as a Preview showcase (each Preview gets its own DO namespace), and is not recommended.

**Throng-side findings that apply to any real repo:**

- **The Sandbox is `lite`.** `RunSandbox` starts every container with `instance: "lite"` (`apps/platform/src/sandbox.ts`), which is 1/16 vCPU, 256 MiB and 2 GB disk ([Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/)). Each candidate's `node_modules` is 267–415 MB. Their test runs peaked at 192–1,340 MiB, while the fixture's `node --test` peaked at 108 MiB. Only unifi-ddns, run with `--maxWorkers=1`, fits under 256 MiB. Plan on `basic` (1 GiB) or `standard-1` (4 GiB) before the demo. The prior research flagged this as unverified ([sandbox-git-licenses.md](sandbox-git-licenses.md)).
- **Scoring does not install.** `scoreScript` runs `setup` and the checks, and only `previewScript` runs `npm ci --ignore-scripts`, and only when `package-lock.json` exists (`apps/platform/src/scripts.ts`). So every config below starts `setup` with the install. A repo without a `package-lock.json` gets no install in the preview step, so its `preview.command` must install.
- **Previews of Workers with static assets are denied today.** Wrangler 4.147.0 uploads assets in two steps. First it POSTs `/accounts/<id>/workers/scripts/<worker>/assets-upload-session`, which `previewPathAllowed` allows. Then it POSTs `/accounts/<id>/workers/assets/upload?base64=true` with `Authorization: Bearer <session JWT>` (`wrangler-dist/cli.js` `syncAssets`, called from `assemblePreviewDeploymentSettings`). `previewPathAllowed` does not allow `assets/upload`. If it did, the `preview-token` action would replace the JWT with the API token. Supporting assets needs a pass-through rule that keeps the JWT. Only ramen-api is affected.
- **`wrangler preview` runs at the repo root with no `--config`.** The repo's Wrangler config must therefore be at the root and contain a `previews` block. None of the candidates has a `previews` block today: Wrangler refuses with "your Wrangler configuration must include a `previews` block" (`cli.js`). With the git proxy refusing pushes to `main` (#222), the easy route is to **import a GitHub fork that already carries `previews` and `.throng/config.yml`**. The other route is to land them as the demo's first task.
- **No candidate needs `network.allow`.** Every test suite passed with the network cut off.

## What Throng needs from a repo

These requirements come from `apps/platform/src/config.ts`, `network.ts`, `scripts.ts`, `preview.ts` and `container/Dockerfile`, with the fixture at `apps/platform/fixtures/fixture-worker` as the known-good shape.

- **Toolchain.** The image is `node:22-trixie-slim` with git and a global `wrangler@4.147.0`, and nothing else: no pnpm or bun. pnpm can come from `npx pnpm@<v>` or corepack, both fetched from the registry with GET.
- **Egress.** It allows GET/HEAD on `registry.npmjs.org`, plus `network.allow` hosts over HTTPS on the default port with no credentials. The `preview` role also gets `api.cloudflare.com` for `workers/scripts/<worker>`, `workers/workers/<worker>` and `workers/subdomain` only.
- **Config.** It takes `setup` (run once, with a 10 min timeout each), `checks` (each gets `$THRONG_OUTPUT`, with a 10 min default timeout and 30 min max), `metrics` (`from: <check>.<file>.<json.path>`, reading `<file>.json` from that check's `$THRONG_OUTPUT`), `preview: { command? }` and `attempts.limit`.
- **Previews.** A Preview gets only the `previews` block plus the top-level `compatibility_*`, `assets`, migrations and placement. Vars and storage bindings (KV, D1, R2) must be repeated under `previews`, and they are _shared_, not isolated. Each Preview gets its own Durable Object namespace. Secrets come from the Previews Base config. Service bindings call the target's production deployment ([Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/); [fork-previews.md](fork-previews.md)).

## Candidates

### 1. willswire/unifi-ddns (recommended)

|                         |                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                     | https://github.com/willswire/unifi-ddns                                                                                                                                                                                                                                |
| Size / branch / licence | 500 KB · `main` · MIT · 1,292 stars · last push 2026-10-12 (Renovate/dependabot keep it current)                                                                                                                                                                       |
| Largest files           | `package-lock.json` 106 KB; source is `src/index.ts` (162 lines), test `test/index.spec.ts` (293 lines)                                                                                                                                                                |
| What it is              | A Worker that lets UniFi gateways update Cloudflare DNS A/AAAA records (a DDNS endpoint: `GET /update?ip=…&hostname=…` with Basic auth carrying a Cloudflare API token)                                                                                                |
| Install                 | `npm ci --ignore-scripts`: **passed**, 148 packages, 4 s, 415 MB `node_modules`                                                                                                                                                                                        |
| Test                    | `npx vitest run`: **passed offline**, 18/18 in 0.7 s; peak 248 MiB, or 192 MiB with `--maxWorkers=1`. `--coverage` (v8, already a devDependency) writes `coverage-summary.json`. The suite mocks the `cloudflare` SDK and runs in plain Node, without the workers pool |
| Typecheck               | `npx tsc --noEmit` **fails**: 18 errors inside `node_modules/cloudflare/src` (missing Node types), so it can't be a check as is                                                                                                                                        |
| Bundle                  | `wrangler deploy --dry-run`: 1.6 MB upload, **no bindings**                                                                                                                                                                                                            |
| Bindings / secrets      | None. The API token arrives per request, so a Preview needs nothing provisioned                                                                                                                                                                                        |

A `.throng/config.yml` it would need. The check command was run locally with a real directory standing in for `$THRONG_OUTPUT`, and it wrote both files.

```yaml
setup:
  - npm ci --ignore-scripts --no-audit --no-fund
checks:
  - name: test
    command: >-
      npx vitest run --coverage --coverage.reportsDirectory="$THRONG_OUTPUT"
      --reporter=default --reporter=json --outputFile.json="$THRONG_OUTPUT/vitest.json"
    timeout: 5m
metrics:
  - name: tests_passed
    from: test.vitest.numPassedTests
    type: number
  - name: line_coverage
    from: test.coverage-summary.total.lines.pct
    type: number
    unit: "%"
preview: {}
```

`wrangler.toml` also needs an empty `[previews]` table. Its `[placement] mode = "smart"` carries over, and its observability settings are optional for Previews.

Demo task ideas (independent, each a few lines plus tests):

- Answer `GET /` (and any non-`/update` path) with a short usage page instead of a 401. This change is visible on the Preview URL.
- Validate `hostname` as a proper FQDN and reject bad input with 422 and a clear message.
- Return JSON error bodies (`{ "error": "…" }`) when the client sends `Accept: application/json`.
- Accept an optional `ttl` query parameter, validated as 1 or 60–86400.

Risks:

- A Preview can only show error paths and the usage page, because a real update needs a real Cloudflare token and zone. That is fine for a demo.
- The repo is less famous than a Cloudflare- or Hono-branded one, but it is easy to explain.
- The `cloudflare` SDK makes `node_modules` large (415 MB), so the install dominates scoring time on a small container.

### 2. G4brym/authentication-using-d1-example

|                         |                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                     | https://github.com/G4brym/authentication-using-d1-example                                                                                    |
| Size / branch / licence | 558 KB · `main` · MIT · 77 stars · last push 2026-03-08                                                                                      |
| Largest files           | `docs/*.png` screenshots (63–152 KB), `package-lock.json` 91 KB                                                                              |
| What it is              | Register/login/session auth on Hono + [chanfana](https://github.com/cloudflare/chanfana) (OpenAPI), with D1 storage. `/` serves a Swagger UI |
| Install                 | `npm ci --ignore-scripts`: **passed**, 100 packages, 2 s, 267 MB                                                                             |
| Test                    | `npx vitest run` (`@cloudflare/vitest-pool-workers`, local D1 in Miniflare): **passed offline**, 11/11 in 2.5 s, peak 405–501 MiB            |
| Typecheck               | `npx tsc --noEmit`: **passed**                                                                                                               |
| Bundle                  | 801 KB upload; bindings `DB` (D1) and var `SALT_TOKEN`                                                                                       |
| Bindings / secrets      | **D1 `DB`**, plus `SALT_TOKEN` as a plain var. No secrets                                                                                    |

A `.throng/config.yml` it would need:

```yaml
setup:
  - npm ci --ignore-scripts --no-audit --no-fund
checks:
  - name: typecheck
    command: npx tsc --noEmit
  - name: test
    command: npx vitest run --reporter=default --reporter=json --outputFile.json="$THRONG_OUTPUT/vitest.json"
    timeout: 5m
metrics:
  - name: tests_passed
    from: test.vitest.numPassedTests
    type: number
preview: {}
```

`wrangler.toml` needs a `previews` block that repeats the D1 binding and the var, pointed at a staging database:

```toml
[previews]
[previews.vars]
SALT_TOKEN = "…"
[[previews.d1_databases]]
binding = "DB"
database_name = "throng-demo-auth"
database_id = "<created once on Throng's account>"
```

Someone with account access must run `wrangler d1 create` and apply `migrations/0000_initial_setup.sql` once. The Preview grant only reaches `workers/*` paths. Every attempt's Preview shares that one database.

Demo task ideas:

- Add `GET /api/auth/me`, which returns the current user from the bearer token.
- Add `POST /api/auth/logout`, which deletes the session row.
- Enforce a minimum password length and email format on register, with a 400 and an OpenAPI schema update.
- Add `@vitest/coverage-istanbul` and a coverage metric. This is a meta-task that changes the scoring itself.

Risks:

- Preview setup is out-of-band: a D1 database and its migration.
- The Previews share data, so a user registered on one attempt's Preview exists on all of them.
- The repo is small and not famous, though the author is.
- The workers-pool tests need about 0.5 GB, so a `lite` Sandbox will not do.

### 3. yusukebe/ramen-api

|                         |                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL                     | https://github.com/yusukebe/ramen-api                                                                                                                                                                                                                                                                        |
| Size / branch / licence | 10,582 KB · **`master`** · MIT · 229 stars · last push 2026-07-11                                                                                                                                                                                                                                            |
| Largest files           | 109 photos under `content/` (11 MB in all, the largest 406 KB); code is 837 lines in `src/`                                                                                                                                                                                                                  |
| What it is              | Hono's author's demo API: REST `/shops`, `/shops/:id`, `/authors/:id`, a GraphQL endpoint and an MCP server, serving JSON and images from static assets ([ramen-api.dev](https://ramen-api.dev/))                                                                                                            |
| Install                 | **No `package-lock.json`** (`bun.lock` only). `npm install --ignore-scripts` resolves fresh: 470 packages, 16 s                                                                                                                                                                                              |
| Test                    | `npx vitest run` (workers pool): 47/48 with npm's fresh resolve. One MCP test fails because npm picks `@modelcontextprotocol/sdk` 1.32.1, while `bun.lock` pins 1.12.1. Pinning 1.12.1 made it **48/48 offline**, in about 2 s, with a peak of 489–578 MiB. There is also a `validate` suite over `content/` |
| Typecheck               | `npx tsc --noEmit` **fails** (rc 2)                                                                                                                                                                                                                                                                          |
| Bundle                  | 1.7 MB upload plus 162 asset files; bindings `ASSETS` and var `ENV_BASE_URL` (unused by the code)                                                                                                                                                                                                            |
| Bindings / secrets      | **Static assets** (`assets.directory: ./content`, `run_worker_first`). Nothing else                                                                                                                                                                                                                          |

A `.throng/config.yml` it would need, assuming the demo fork commits a `package-lock.json` with the pins from `bun.lock`:

```yaml
setup:
  - npm ci --ignore-scripts --no-audit --no-fund
checks:
  - name: test
    command: npx vitest run --reporter=default --reporter=json --outputFile.json="$THRONG_OUTPUT/vitest.json"
    timeout: 5m
  - name: content
    command: npx vitest run --config vitest.validation.config.ts
    required: false
metrics:
  - name: tests_passed
    from: test.vitest.numPassedTests
    type: number
preview: {}
```

Without a lockfile, `preview.command` would have to run `npm install`, which is unpinned, and `setup` would have to do the same.

Demo task ideas:

- Add `GET /prefectures`, listing each prefecture with its shop count.
- Add `?q=` name search to `/shops`.
- Add `?sort=name` to `/shops`.
- Expose `prefecture` and a new filter in the GraphQL schema.

Risks:

- **Previews fail on Throng today** because of the asset-upload egress gap described above. This needs a platform change before the demo.
- The lockfile mismatch needs a prepared fork.
- The default branch is `master`. Import maps the default branch to `main` (#222), so this only matters for docs.
- At 10.6 MB it is the largest candidate, though it is still far under the Artifacts limits (1 GB per repo, 32 MB per blob).

### 4. HaveIBeenPwned/PwnedPasswordsCloudflareWorker

|                         |                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                     | https://github.com/HaveIBeenPwned/PwnedPasswordsCloudflareWorker                                                                                                                                                                                                                                                             |
| Size / branch / licence | 286 KB · `main` · BSD-3-Clause · 414 stars · last push 2026-08-20                                                                                                                                                                                                                                                            |
| Largest files           | `src/range-worker/worker-configuration.d.ts` 575 KB (generated types), `pnpm-lock.yaml` 81 KB                                                                                                                                                                                                                                |
| What it is              | The production Worker behind `api.pwnedpasswords.com/range/*`, which serves k-anonymity hash ranges from Azure Blob storage, with padding and cache purge                                                                                                                                                                    |
| Install                 | `pnpm install --frozen-lockfile --ignore-scripts` (`packageManager: pnpm@11.22.0`): **passed**, 3 s                                                                                                                                                                                                                          |
| Test                    | `npx vitest run` (workers pool): **passed offline**, 33/33 in about 3 s. Peak **1,340 MiB**, or 564 MiB with `--maxWorkers=1`                                                                                                                                                                                                |
| Typecheck               | `tsc --noEmit --project src/range-worker/tsconfig.json`: **passed**                                                                                                                                                                                                                                                          |
| Bundle                  | 14 KB with `--config src/range-worker/wrangler.jsonc`                                                                                                                                                                                                                                                                        |
| Bindings / secrets      | **7 required secrets** (Azure storage account, client ID/secret, tenant, two container names, purge secret). It also has **service bindings to itself** (`BLOB_ENTRYPOINT`, `PURGE_ENTRYPOINT`, `RANGE_ENTRYPOINT`) and per-env `routes`. The config lives at `src/range-worker/wrangler.jsonc` with `stage` and `prod` envs |

A `.throng/config.yml` it would need:

```yaml
setup:
  - npx --yes pnpm@11.22.0 install --frozen-lockfile --ignore-scripts
checks:
  - name: typecheck
    command: npx tsc --noEmit --project src/range-worker/tsconfig.json
  - name: test
    command: npx vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json="$THRONG_OUTPUT/vitest.json"
    timeout: 10m
metrics:
  - name: tests_passed
    from: test.vitest.numPassedTests
    type: number
# no preview section: see risks
```

Demo task ideas:

- Reject non-hex or wrong-length prefixes with a clearer 400 body.
- Add a `mode=ntlm` vs `sha1` response header.
- Make padding size configurable through a var, with tests.

Risks:

- **No Preview without platform work.** `wrangler preview` runs at the root, but the config is in a subdirectory. The service bindings would call a production Worker that does not exist on Throng's account. The Worker cannot serve anything without Azure secrets.
- The workers-pool memory use is the highest of all the candidates.
- pnpm is not in the image.
- It is someone's production service, so how it is described in a public demo needs care.

### 5. cloudflare/workers-chat-demo (Preview showcase only)

|                         |                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                     | https://github.com/cloudflare/workers-chat-demo                                                                                                                                                                         |
| Size / branch / licence | 32 KB · `master` · BSD-3-Clause · 1,121 stars · last push 2026-04-23                                                                                                                                                    |
| What it is              | Cloudflare's classic edge chat: one `src/chat.mjs` (565 lines) with the `ChatRoom` and `RateLimiter` Durable Objects, plus `chat.html`                                                                                  |
| Install / test          | No dependencies and **no tests**. `node --check src/chat.mjs` is the only thing to run                                                                                                                                  |
| Bindings                | Two Durable Object bindings (SQLite classes, `v1` migration). Each Preview gets its own DO namespace, and the bindings would be repeated under `previews.durable_objects.bindings`, so no external resources are needed |

A `.throng/config.yml` would contain only a syntax check and `preview: {}`, so there is nothing to rank attempts by. It would make a vivid Preview (open two attempts' chat rooms side by side), but it fails the "tests Throng can score" criterion. It would only work if the demo's first task were "add tests".

## Rejected along the way

- **cloudflare/templates** (23 MB pnpm monorepo of 30+ templates): it is not one Worker at the root.
- **benvinegar/counterscale** (pnpm + turbo monorepo, Analytics Engine): same reason.
- **cloudflare/agents-starter**: it is built on a remote Workers AI binding (`"ai": { "remote": true }`) and has no test script.
- **llegomark/url-shortener**, **xyTom/Url-Shorten-Worker** and **Erisa/worker-links**: no tests.
- **catskull/likes**: a two-test smoke suite on vitest 1 and pool-workers 0.1, with a D1 database and a custom-domain route. It is weaker than #2 on every count.
- **cloudflare/workflows-starter**: in Previews, a Workflow binding points at a deployed production Workflow.
- **replicate/hype**: needs `REPLICATE_API_TOKEN` and makes live fetches, and its `test` script references `tests/`, which isn't in the repo.
- **supermemoryai/backend-api-kit**: bun-only, with D1 and auth secrets.

## Recommendation

Use **unifi-ddns** for the first demo. It is the only candidate that needs no Throng platform change and no provisioned resources. It is the fastest to score, and it already produces a coverage metric. Its tasks are small, independent and produce visibly different Previews. Prepare a GitHub fork with `[previews]` in `wrangler.toml` and the `.throng/config.yml` above, and import the fork.

Keep **authentication-using-d1-example** as the second demo. Its Swagger UI Preview is more visual, and it shows D1, but it needs a staging D1 database set up once. **ramen-api** is the most charming option, but it waits on two things: Throng allowing the asset-upload path (with the JWT passed through), and a fork with a `package-lock.json`.

Whatever is picked, move the Sandbox off `lite` first. Real test suites need 0.2–1.3 GiB.

## Sources

- GitHub REST/GraphQL API for repo metadata (`size`, `default_branch`, `license`, stars, `pushed_at`), 2026-10-12.
- The candidates' own `package.json`, `wrangler.*`, `vitest.config.*` and CI workflows at their default branch heads on 2026-10-12.
- Cloudflare docs: [Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/), [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/) and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) (`instance_type` defaults to `lite`).
- `wrangler@4.147.0` (npm tarball) `wrangler-dist/cli.js`: `syncAssets`, `assemblePreviewDeploymentSettings` and the `previews`-block error.
- Throng at `origin/main` 8af60f3: `apps/platform/src/{config,network,preview,scripts,sandbox}.ts`, `apps/platform/container/Dockerfile`, `apps/platform/fixtures/fixture-worker`, and `docs/research/{fork-previews,sandbox-git-licenses}.md`.
