# OpenAPI-first API on Workers, and deriving MCP and a CLI from it

Research for [#76](https://github.com/gregjoeval/throng/issues/76), part of map [#71](https://github.com/gregjoeval/throng/issues/71). Input for the decision in [#77](https://github.com/gregjoeval/throng/issues/77), not the decision itself. Sources were read on 2026-10-07. Package versions are the npm `latest` tags on that date.

Source labels: **[docs]** official documentation, **[readme]** the project's own README, **[npm]** npm registry metadata, **[types]** the published package's `.d.ts` files, **[inference]** my reasoning, not stated by any source.

## Answer

- **API, OpenAPI-first:** `@hono/zod-openapi` is the smallest step from today's code. The platform Worker is already a plain `Hono` app (`apps/platform/src/index.ts`), and `OpenAPIHono` is a drop-in subclass. Chanfana is the Cloudflare-owned, production-proven alternative, but it uses class-based endpoints, which is a bigger rewrite. `hono-openapi` is lighter but says it is "still in development".
- **MCP from the spec:** Nothing turns a spec into a _good_ MCP server for free. There are three real options:
  1. **Hand-thin wrapper.** A few curated MCP tools whose handlers call the same service functions (or `app.request()`) as the HTTP routes, served with `createMcpHandler` from `agents/mcp`. They reuse the same Zod schemas. Cloudflare's and FastMCP's own docs both say to curate tools around goals rather than mirror the API.
  2. **Cloudflare Code Mode `openApiMcpServer()`.** It derives `search` and `execute` tools straight from the spec, with auth kept in the host Worker. It is marked **experimental** and needs a Worker Loader binding.
  3. **Generators** (`openapi-mcp-generator`, Stainless). They emit one tool per operation as a separate project that calls the API over HTTP. This adds a second deployable and drifts from the spec unless you regenerate in CI.
- **CLI:** A generated typed client (`openapi-typescript` + `openapi-fetch`, or `@hey-api/openapi-ts`, or Hono's own `hc` with zero codegen inside this monorepo) covers request and response shapes. The CLI still has to supply by hand: the login and token flow (storage, refresh), command ergonomics, and output formatting. Off-the-shelf spec-to-CLI tools exist (specli, the Stainless CLI target), but specli can't fetch OAuth tokens itself, and Stainless requires a Go SDK target.
- **Suggested starting point for #77 [inference]:** use `@hono/zod-openapi` as the spec source, add a hand-thin MCP layer on `createMcpHandler` mounted in the same Worker, and build a CLI on a generated or `hc` client. Re-evaluate Code Mode `openApiMcpServer()` when it leaves experimental status.

## 1. OpenAPI-first on Workers

|                        | `@hono/zod-openapi`                                                                         | chanfana                                                                  | `hono-openapi`                                                         | oRPC (`@orpc/openapi`)                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Owner                  | honojs/middleware (Hono org) [npm]                                                          | Cloudflare [npm]                                                          | rhinobase (third party) [npm]                                          | middleapi (third party) [npm]                                              |
| Version / last publish | 1.6.3 / 2026-09-04 [npm]                                                                    | 3.4.0 / 2026-08-17 [npm]                                                  | 1.3.5 / 2026-10-07 [npm]                                               | 1.15.5 / 2026-10-07 [npm]                                                  |
| Schema lib             | Zod 4 (peer `zod ^4`, `hono >=4.10`) [npm]                                                  | Zod 4 [readme]                                                            | Any Standard Schema validator [readme]                                 | Zod and others (not verified here)                                         |
| Style                  | `createRoute()` + `app.openapi(route, handler)` on `OpenAPIHono` [readme]                   | Classes extending `OpenAPIRoute` with `schema` + `handle()` [readme]      | Middleware on a plain Hono app (per its docs site; README doesn't say) | Procedures; OpenAPI paths via `.meta(openapi({...}))` or `.route()` [docs] |
| OpenAPI out            | 3.0 (`app.doc`) and 3.1 (`app.doc31`) [readme]                                              | 3 and 3.1; `npx chanfana` dumps `schema.json` via `wrangler dev` [readme] | Not stated in README                                                   | Not verified                                                               |
| Auth in spec           | `openAPIRegistry.registerComponent('securitySchemes', ...)` + per-route `security` [readme] | Supported via schema (not detailed in README)                             | —                                                                      | —                                                                          |
| Typed client           | Hono RPC `hc<typeof routes>()` works [readme]                                               | No                                                                        | Hono `hc` (plain Hono) [inference]                                     | Own typed client                                                           |
| Maturity               | Official Hono middleware                                                                    | "stable and production ready", powers Radar 2.0 API [readme]              | "still in development" [readme]                                        | Active, separate framework                                                 |

Notes:

- `@hono/zod-openapi` caveats [readme]: `.use()` returns plain `Hono`, so you need `$()` to get the `OpenAPIHono` type back. Long `.openapi()` chains slow type-checking, so split into sub-apps mounted with `.route()`. Header keys in schemas must be lowercase. Request validation covers only JSON and form bodies.
- Both `@hono/zod-openapi` and chanfana build on `@asteasolutions/zod-to-openapi` [npm]. They are close in what they can express, and differ mainly in authoring style.
- Moving to oRPC would mean replacing Hono's routing model. That is out of proportion for this repo [inference].

## 2. Deriving MCP from the spec

### Cloudflare building blocks (package `agents` 0.27.0, `@cloudflare/codemode` 0.5.3) [npm]

- **`createMcpHandler(factory, options)`** from `agents/mcp` is the recommended path for a **new stateless** server. `McpAgent` is labelled "Deprecated Durable Object and RPC servers" and is for migration only [docs: remote-mcp-server]. In the published types, passing an SDK v2 _factory_ returns a `StatelessMcpHandler`. Passing an SDK v1 `McpServer` takes the legacy overload, and `experimental_createMcpHandler` is deprecated [types].
- **Auth** [docs: authorization]: MCP uses an OAuth 2.1 subset.
  - `@cloudflare/workers-oauth-provider` (`new OAuthProvider({ apiRoute, apiHandler, defaultHandler, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint })`) lets the Worker be its own OAuth server, or front GitHub, Access, Auth0 and others. It issues its own tokens to MCP clients.
  - In stateless handlers, tools read `context.http.authInfo` and `getMcpAuthContext()`.
  - You can gate tools per permission by checking inside the handler or by registering tools conditionally.
  - The docs don't describe a plain API-key mode, but the Code Mode example (below) does accept a raw `Authorization: Bearer` header.
- **`openApiMcpServer({ spec, executor, request })`** from `@cloudflare/codemode/mcp` [docs: build-codemode-openapi-mcp-server; types]:
  - It exposes two tools. `search` runs model-written JS against the spec. `execute` adds a host-side `codemode.request()` that your `request` callback fulfils, so tokens never enter the sandbox.
  - It needs a `worker_loaders` binding, `nodejs_compat`, and `DynamicWorkerExecutor`, which blocks outbound `fetch` by default.
  - It returns an SDK v1 server, mounted with `createLegacyMcpHandler(server, { route: "/mcp" })`.
  - Responses are capped at about 6,000 tokens.
  - Status: "experimental and may have breaking changes" [docs].
  - Fit [inference]: this is designed for _large_ APIs where listing every tool would bloat the context. Throng's agent surface is small (about 7 operations in #77), so plain curated tools are simpler and need no Worker Loader.
- **Best-practice guidance** [docs: MCP overview]: "Design tools around specific user goals rather than mirroring your whole API", prefer narrowly permissioned servers, write detailed parameter descriptions, and run evals.

### Hono-side

- **`@hono/mcp`** 0.3.2 [npm, readme]: `StreamableHTTPTransport` lets you mount an MCP SDK `McpServer` on a Hono route (`app.all('/mcp', ...)`). It also ships auth-router helpers (peer deps include `pkce-challenge` and `hono-rate-limiter`). It is the Hono-native alternative to `agents/mcp`, but it doesn't integrate with `workers-oauth-provider` or Cloudflare's stateless handler [inference].

### Generators

|         | `openapi-mcp-generator` 4.1.0 [npm]                                                                                                                         | Stainless MCP target                                                                                                                                               | FastMCP `from_openapi`                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Output  | Standalone TS project, one tool per operation, Zod input validation [readme]                                                                                | npm package next to the TS SDK; now "code-mode" servers [docs via search]                                                                                          | Python server                                                                                    |
| Workers | `--transport cloudflare-worker`: stateless Streamable HTTP `/mcp`, no DO or KV [readme]                                                                     | `generate_cloudflare_worker: true` emits a Worker that is its own OAuth server; the code-execution tool can't run on Workers [docs: stainless.com/docs/mcp/remote] | No                                                                                               |
| Auth    | Env-var credentials per security scheme. On Workers, `--header-passthrough` and `--custom-auth` are ignored, so it uses a single shared credential [readme] | OAuth consent screen collects the upstream token [docs]                                                                                                            | —                                                                                                |
| Caveat  | A second deployable that calls the API over HTTP; regenerate on spec change                                                                                 | Commercial SaaS; hosted servers deprecated [docs]                                                                                                                  | Own docs: use for prototyping, "not for mirroring your API to LLM clients" [docs: gofastmcp.com] |

For Throng, the generator's Worker target uses one shared credential, which breaks per-agent tokens. That rules it out unless it is patched [inference].

### Hand-thin wrapper (in-process) [inference]

- Define each operation once: Zod input and output schemas plus a service function. Register it twice, as an `OpenAPIHono` route and as an MCP tool (`server.registerTool(name, { inputSchema }, handler)`). Both front ends then share validation and logic, and the spec stays the source of truth for shapes.
- It could even be generated from `app.openAPIRegistry` at startup. For about 7 operations, explicit registration is cheap and lets MCP tool descriptions be written for models.
- MCP auth can reuse the API's own bearer-token check, or be fronted by `workers-oauth-provider` if interactive MCP clients (Claude Desktop and similar) need OAuth discovery.

## 3. CLI client

| Option                                                 | What you get                                               | Left to do by hand                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Hono `hc<typeof app>()` [readme: zod-openapi]          | Fully typed client, no codegen, works within the monorepo  | Auth flow, commands, output; tied to TS + same repo                             |
| `openapi-typescript` 7.13 + `openapi-fetch` 0.17 [npm] | Types from the spec plus a tiny typed fetch                | Same; plus a codegen step in CI                                                 |
| `@hey-api/openapi-ts` 0.99 [npm]                       | Generated SDK functions (pre-1.0)                          | Same                                                                            |
| specli 0.0.39 (vercel-labs) [npm, readme]              | Whole CLI from the spec, `--json`, compile to binary (Bun) | "can't fetch OAuth2 tokens itself", early-stage, limited body and array support |
| Stainless CLI target [docs: stainless.com/docs/cli]    | Polished Go CLI, completions, Homebrew                     | Requires a Go SDK target; commercial                                            |

In every option, the CLI still owns by hand [inference]:

- getting the agent or human token (device or browser login, or pasting a token)
- storing it and renewing it (#77's "renew the token")
- git-side actions (cloning or pushing the fork)
- the bounce channel (polling vs live updates)

## Trade-offs worth carrying into #77 [inference]

- **The spec as source of truth vs code as source of truth.** With zod-openapi or chanfana the _code_ produces the spec. "OpenAPI-first" here means schema-first-in-code, not a hand-written YAML file. To get contract-first in the strict sense, you would have to commit the generated spec and diff it in CI.
- **Generated MCP drifts toward 1:1 endpoint mirroring.** Cloudflare's and FastMCP's docs both warn against this. A curated layer costs a little duplication of descriptions, not of logic.
- **One Worker vs three deployables.** Hosting the MCP inside the platform Worker keeps one auth check, one deploy, and one spec. Generators add a second service.
- **Experimental status.** Code Mode is attractive for large APIs, but Throng's surface is small, and Code Mode is experimental and needs Worker Loader.

## Sources

- @hono/zod-openapi README: https://github.com/honojs/middleware/tree/main/packages/zod-openapi
- chanfana README: https://github.com/cloudflare/chanfana
- hono-openapi README: https://github.com/rhinobase/hono-openapi
- oRPC OpenAPI routing: https://orpc.dev/docs/openapi/getting-started
- @hono/mcp README: https://github.com/honojs/middleware/tree/main/packages/mcp
- Cloudflare MCP overview: https://developers.cloudflare.com/agents/model-context-protocol/
- Cloudflare remote MCP server guide: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Cloudflare MCP authorization: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- Cloudflare search+execute OpenAPI MCP server: https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/
- Cloudflare Code Mode OpenAPI connector: https://developers.cloudflare.com/agents/tools/codemode/openapi/
- `agents@0.27.0` and `@cloudflare/codemode@0.5.3` published `.d.ts` (`createMcpHandler` overloads, `OpenApiMcpServerOptions`)
- openapi-mcp-generator README: https://github.com/harsha-iiiv/openapi-mcp-generator
- Stainless MCP remote deployment: https://www.stainless.com/docs/mcp/remote/
- Stainless CLI generator: https://www.stainless.com/docs/cli/
- FastMCP OpenAPI integration: https://gofastmcp.com/integrations/openapi
- specli README: https://github.com/vercel-labs/specli
- npm registry metadata (`npm view`) for all packages listed, 2026-10-07
