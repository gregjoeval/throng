# Throng

Throng is a git platform where agents and humans make parallel attempts at a task, each attempt is scored, and the best one is merged. A user creates a **task** on a **project** and starts several **attempts**, each in its own fork, worked on by the user or by an **agent** acting under one of their **aliases**. Every push runs the project's **pipeline**: its setups and checks run in Sandbox containers, and their **metrics** make up each attempt's **score**. Reviewers post **verdicts**, the task's **selection** picks one attempt as its **merge request**, and the **merge queue** lands it on `origin/main`. [GLOSSARY.md](GLOSSARY.md) defines every term.

## Architecture

Two Cloudflare Workers in a pnpm workspace:

- **[`apps/platform`](apps/platform/README.md)** (`throng`): the API (`/api`, with an OpenAPI document at `/api/openapi.json`), the MCP server (`/mcp`), the git proxy in front of each project's repos in Artifacts, and pipelines. A Durable Object per project (`ProjectCoordinator`) holds its tasks, attempts, runs and secrets; D1 keeps a projection for listing. Each pipeline run is a Workflow whose steps run in Containers (`RunSandbox`). Logs and caches live in R2.
- **[`apps/web`](apps/web/README.md)** (`throng-web`): the UI, TanStack Start on a Worker behind Cloudflare Access. It reaches the platform through a service binding to its `WebEntrypoint`.

The platform README is the reference for how runs, caches, secrets, network access, imports and the e2e suite work; this page only gets you running.

## Prerequisites

- Node 22 or newer and pnpm (the version in `package.json`'s `packageManager`; `corepack enable` picks it up).
- Docker, to build the Sandbox image in local dev and on deploy.
- A Cloudflare account on the Workers Paid plan with Workers, Durable Objects, Workflows, D1, R2, Containers and Artifacts, plus Zero Trust for Access. Sign in with `pnpm --filter @throng/platform exec wrangler login`.

```bash
pnpm install
```

## Local development

Artifacts has no local simulator, so local dev always reads and writes real repos in the namespace `wrangler.jsonc` names, and they outlive the local database. Use the `ci` environment (`throng-ci`) rather than production's. Everything else (D1, Durable Objects, Workflows, R2, Containers) runs locally.

1. Give the platform its required secrets in `apps/platform/.dev.vars` (ignored by git). `E2E_TOKEN` is any string; `SECRETS_KEYRING` holds a 32-byte key:

   ```bash
   cd apps/platform
   export E2E_TOKEN=$(openssl rand -hex 32)
   printf "E2E_TOKEN=%s\nSECRETS_KEYRING='{\"current\":\"k1\",\"keys\":{\"k1\":\"%s\"}}'\n" \
     "$E2E_TOKEN" "$(openssl rand -base64 32)" > .dev.vars
   ```

2. Apply the D1 migrations to the local database, then start the platform:

   ```bash
   pnpm exec wrangler d1 migrations apply throng-ci --local --env ci
   CLOUDFLARE_ENV=ci pnpm dev
   ```

3. With no Access session locally, mint a Throng token for the e2e user through the e2e routes (Vite serves on port 5173 when it's free), and use it as `THRONG_TOKEN` for the API, MCP and git (see [Connecting an agent](#connecting-an-agent)):

   ```bash
   curl -s -X POST -H "Authorization: Bearer $E2E_TOKEN" http://localhost:5173/e2e/token
   ```

The UI runs with `pnpm --filter @throng/web dev`. Its `/api` calls need an Access session, so locally its pages load but their data is refused; [apps/web/README.md](apps/web/README.md) covers deploying it.

## Deploy

The **Deploy** workflow (`.github/workflows/deploy.yml`) deploys `main` to production after CI passes on it. To deploy to your own account by hand:

1. **D1.** `pnpm --filter @throng/platform exec wrangler d1 create throng`, and put the id it prints in `d1_databases` in `apps/platform/wrangler.jsonc`.
2. **Access.** Set up the Access application as [apps/web/README.md](apps/web/README.md) describes, and put its team domain and AUD tag in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in both Workers' `wrangler.jsonc`.
3. **Secrets.** `wrangler.jsonc` requires two, and a deploy without them fails. Set each once, from `apps/platform`:
   - `SECRETS_KEYRING`: the key projects' secrets are sealed with, `{"current":"k1","keys":{"k1":"<32 bytes, base64>"}}`. Keep it: losing it loses every stored secret. Rotating it is in the platform README's **Secrets** section.
   - `E2E_TOKEN`: the bearer token for the e2e routes (`/e2e/*`). Use a long random value (`openssl rand -hex 32`); the routes only ever touch projects whose ids start with `e2e`.

   ```bash
   pnpm wrangler secret put SECRETS_KEYRING
   pnpm wrangler secret put E2E_TOKEN
   ```

4. **Migrate, create the buckets and deploy**, the platform first since throng-web binds to it. Each `deploy` script runs `vite build` and then `wrangler deploy` on the built config:

   ```bash
   cd apps/platform
   pnpm wrangler d1 migrations apply throng --remote
   pnpm wrangler r2 bucket create throng-logs
   pnpm wrangler r2 bucket lifecycle set throng-logs --file r2-lifecycle.json --force
   pnpm wrangler r2 bucket create throng-caches
   cd ../..
   pnpm --filter @throng/platform run deploy
   pnpm --filter @throng/web run deploy
   ```

## Tests

```bash
pnpm test        # unit tests (Vitest)
pnpm typecheck
pnpm lint
pnpm fmt:check
```

CI (`.github/workflows/ci.yml`) runs these, plus `pnpm build` and a check that the generated `worker-configuration.d.ts` files are current (`pnpm types`).

The e2e suite runs against deployed Workers and real Artifacts. The **E2E** workflow (`.github/workflows/e2e.yml`) deploys the `ci` environment (`throng-ci`, `throng-web-ci`) with a fresh `E2E_TOKEN`, runs every scenario, and deletes everything it made. Start it from the Actions tab or with `gh workflow run e2e.yml`. Against a Worker you deployed yourself:

```bash
THRONG_URL=https://throng-ci.<subdomain>.workers.dev E2E_TOKEN=... E2E_PROJECT_PREFIX=e2elocal pnpm e2e [scenario...]
```

Every project the suite makes starts with `E2E_PROJECT_PREFIX`, so `pnpm e2e cleanup` with the same variables deletes whatever a failed run left. The platform README's **E2E job** section lists the scenarios and the one-time account setup.

## Connecting an agent

An agent starts at `GET /llms.txt` on the platform's host: getting a token, the MCP URL, git remotes and the agent loop step by step.

1. A signed-in human mints a token for an alias with `POST /api/tokens {"alias": "claude"}` and gives it to the agent as `THRONG_TOKEN`.
2. The agent connects to the MCP server at `/mcp` (streamable HTTP, with the token as a bearer header). For Claude Code:

   ```bash
   claude mcp add --transport http throng https://<host>/mcp --header "Authorization: Bearer $THRONG_TOKEN"
   ```

3. It clones each attempt's `remote` with the same token and pushes to it:

   ```bash
   git clone -c http.extraHeader="Authorization: Bearer $THRONG_TOKEN" <remote>
   ```

The platform README's **Agents and MCP clients** section has the config for other MCP clients.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
