# API style for the web UI, agents, MCP and the CLI

Research for [#113](https://github.com/gregjoeval/throng/issues/113), part of map [#71](https://github.com/gregjoeval/throng/issues/71). This is input for [#77](https://github.com/gregjoeval/throng/issues/77) and the tasks spec [#11](https://github.com/gregjoeval/throng/issues/11), not a decision. It builds on [openapi-mcp.md](openapi-mcp.md), which assumed REST and compared OpenAPI tooling. This note asks the step before that: whether REST is the right style at all. Sources were read on 2026-10-09. Package versions are the npm `latest` tags on that date.

Source labels: **[docs]** official documentation, **[readme]** the project's own README, **[npm]** npm registry metadata, **[inference]** my reasoning, not stated by any source.

## Answer

- **Keep REST + OpenAPI with `@hono/zod-openapi`.** The tasks spec's assumption holds. Of the options compared, it is the only one that does all of the following without adding a second framework or relying on prerelease packages:
  - it extends the Hono app the platform Worker already is
  - it emits a real OpenAPI 3.0/3.1 document
  - it serves plain resource URLs that a curl user or a non-TS agent can call
  - it gives TS clients end-to-end types with no codegen, through Hono's `hc`
- **oRPC is the only serious alternative.** It is typed RPC that also serves real REST routes and emits OpenAPI 3.x. Its native streaming (SSE from async generators) is better than what Hono's client offers. It loses on two points for Throng today:
  - It replaces Hono's routing model inside the Worker (mounted as a handler under Hono).
  - Its MCP adapter is community-built and needs the **v2 beta**. v1.15.x is stable, but v2 has been in beta through 43 prereleases.

  It is the fallback to revisit if typed streaming becomes central, or once v2 ships.

- **tRPC: no.** It is best in class for TS-to-TS, but its own OpenAPI generator is **alpha**. That generator describes tRPC's envelope protocol (`?input=<JSON>`, `result.data`) rather than REST, and it excludes subscriptions. This makes it poor for agents and arbitrary HTTP callers.
- **GraphQL (Yoga + Pothos): no.** It is mature and runs on Workers. However:
  - It emits no OpenAPI.
  - Agents must write queries, or a separate MCP gateway (Apollo MCP Server, Hive Gateway plugin) must be stood up.
  - Its subscriptions over WebSocket on Workers need a third-party library plus Durable Objects and D1.

  The query flexibility buys little for roughly 25 resource-shaped endpoints [inference].

- **Workers RPC (`WorkerEntrypoint`) over the service binding** is worth knowing about only as a UI-to-API transport. It is Worker-to-Worker only, so it would be a second API surface beside REST, not a replacement [inference].
- **Streaming is the one real gap in the recommendation.** Hono's `streamSSE()` works on Workers, but the `hc` docs don't cover typed SSE consumption. If the bounce channel or live UI updates need streaming, expect hand-typed `EventSource` handling on the client, or a small typed wrapper.

## Comparison

|                              | REST: `@hono/zod-openapi` + `hc`                                                     | oRPC (`@orpc/server` + `@orpc/openapi`)                                                                 | tRPC v11                                                                           | GraphQL: Yoga + Pothos                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Version / last publish       | 1.6.3 / 2026-09-04; `hono` 4.13.13 [npm]                                             | 1.15.5 stable; 2.0.0-beta.43 both 2026-10-09 [npm]                                                      | 11.19.0 / 2026-09-28 [npm]                                                         | `graphql-yoga` 5.24.4, `@pothos/core` 4.15.1, `graphql` 17.0.2 [npm]                                   |
| Weekly downloads (Oct 1–7)   | 2.60 M [npm]                                                                         | 1.49 M [npm]                                                                                            | 5.43 M [npm]                                                                       | Yoga 1.89 M; Pothos 0.43 M [npm]                                                                       |
| TS end-to-end types          | `hc<typeof app>()`, no codegen; reads validator inputs and `c.json()` outputs [docs] | Native typed client; also typed client over REST via `OpenAPILink` + contract [docs]                    | Best in class, inferred from router [docs]                                         | Needs codegen (`@graphql-codegen`) or `gql.tada` [inference]                                           |
| OpenAPI spec                 | 3.0 (`app.doc`) and 3.1 (`app.doc31`) [readme]                                       | `OpenAPIGenerator`, 3.2 by default, downgrades to 3.0/3.1 [docs]                                        | `@trpc/openapi` **alpha**, describes tRPC wire protocol, not REST [docs]           | None                                                                                                   |
| Plain HTTP / non-TS callers  | Normal REST resources                                                                | Real REST via `OpenAPIHandler` with `.route({method, path})` [docs]                                     | `GET /proc.path?input=<JSON>`, `POST /proc.path`; transformers break non-TS [docs] | One `POST /graphql`; caller must write GraphQL                                                         |
| MCP                          | Hand-thin tools on `createMcpHandler` reusing Zod schemas (see openapi-mcp.md)       | Community `orpc-mcp` 0.1.3, peer-depends on oRPC **v2 beta** [npm]; or hand-thin                        | `trpc-mcp` 0.0.1, last published 2025-02 [npm]; or hand-thin                       | External gateways: Apollo MCP Server (Rust), Hive Gateway `@graphql-hive/plugin-mcp` 0.2.1 [docs; npm] |
| Streaming / subscriptions    | `streamSSE()` helper [docs]; `hc` client typing for SSE not documented               | Async-generator handlers → SSE with typed events, resume via `lastEventId` [docs]                       | SSE (`httpSubscriptionLink`, recommended) or WebSocket; async generators [docs]    | SSE needs compat date ≥ 2022-11-30; WebSocket subs need third-party lib + DO + D1 [docs]               |
| Workers / Hono fit           | Is Hono; `hc` takes a service binding `fetch` [docs]                                 | Fetch adapter mounted in Hono middleware; Hono body parsing before it throws "Body Already Used" [docs] | Fetch adapter, Workers named [docs]; separate from Hono routing                    | Fetch handler, Workers integration documented [docs]; separate from Hono routing                       |
| Change from the current spec | None                                                                                 | Rewrite routes as procedures                                                                            | Rewrite + lose REST                                                                | Rewrite + schema design                                                                                |

## 1. REST + OpenAPI with `@hono/zod-openapi` (current assumption)

- `OpenAPIHono` "supports RPC mode", so `hc<typeof routes>()` gets typed inputs and outputs from the same `createRoute()` definitions that produce the spec [readme]. Tooling was compared in detail in [openapi-mcp.md](openapi-mcp.md#1-openapi-first-on-workers).
- **`hc` limits [docs: hono rpc]:**
  - Status codes become part of the type only when passed explicitly to `c.json()`.
  - Responses from `app.onError()` and global middleware are not inferred without `ApplyGlobalResponse`.
  - Path and query values are sent as strings.
- **`hc` and IDE speed [docs: hono rpc]:** the docs warn that "the more routes you have, the slower your IDE will become." The recommended fix is to compile the client type ahead of time (`hcWithType`), or to split clients per sub-app.
- **Web UI over the service binding:** `hc` accepts a custom `fetch`. The Hono docs show exactly this with `c.env.AUTH.fetch.bind(c.env.AUTH)` [docs: hono rpc]. The UI Worker can therefore call the API Worker through the binding with full types.
- **Non-TS and agent consumers:** they get plain REST paths and a published OpenAPI document. Any generator can work from that document (`openapi-typescript`, `@hey-api/openapi-ts`, Stainless; see openapi-mcp.md §3).
- **Streaming:** `streamSSE(c, async (stream) => { … stream.writeSSE({data, event, id}) })` [docs: hono streaming]. Under `wrangler dev`, set `Content-Encoding: Identity` [docs]. The RPC guide says nothing about SSE, so treat client-side typing of streams as manual [inference]. The zod-openapi README also doesn't cover `text/event-stream`. It validates request bodies "only for JSON and form media types", and passes other media types through unvalidated [readme].

## 2. oRPC

- **Stability:** v1.15.5 is the stable line. Meanwhile **v2.0.0-beta.43** shipped the same day, and v2 betas have been released every few days since at least mid-September. Recent ones carry breaking changes, e.g. beta.37 removed adapter interceptors and plugins. No stable date is given [GitHub releases]. The current docs site appears to document v2 (`.meta(openapi(...))`, OpenAPI 3.2 by default) [docs; version inferred].
- **REST output:** an unconfigured procedure is `POST /planet/create`. With `.route({ method: 'GET', path: '/planets/{id}' })` (or `.meta(openapi(...))`), it becomes a normal resource route with path params bound to required input fields. Prefixes nest per router [docs: openapi/getting-started].
- **Spec:** `OpenAPIGenerator` with `ZodToJsonSchemaConverter`, plus converters for Valibot and ArkType. It always builds 3.2 and downgrades to 3.0/3.1 on request. Security is added per operation or router via a `spec` callback [docs: openapi-specification].
- **Typed clients:**
  - The native `RPCHandler` + `createORPCClient` pair is fully typed.
  - Against the REST endpoints, `OpenAPILink` gives a typed client, but it needs a **contract** (contract-first) [docs: openapi-link].
- **Streaming:**
  - Handlers can be `async function*`, validated with `asyncIteratorObject(...)`, and emit SSE with ids and retry hints. On reconnect, `lastEventId` comes back to the server.
  - Completion is an oRPC-specific signal. Plain `EventSource` "will automatically attempt to reconnect" after the stream ends [docs: event-iterator].
  - `OpenAPIHandler` has `keepAlive` and `initialComment` options for event iterators [docs: openapi-handler].
- **Hono:**
  - It mounts as `app.use('/rpc/*', …handler.handle(c.req.raw, {prefix, context})…)`.
  - Any Hono middleware that reads the body first causes a "Body Already Used" error. The documented workaround proxies body parsing through `c.req` [docs: adapters/hono].
- **MCP:** there is no first-party package. The ecosystem page lists `mi3lix9/orpc-mcp` [web search → orpc.dev/docs/ecosystem]. On npm it is version 0.1.3, from a single maintainer, and its peer dependencies are `@orpc/* ^2.0.0-beta.16` [npm]. oRPC's first-party AI package targets Vercel AI SDK tools, not MCP [web search → GitHub repo].

## 3. tRPC

- v11 runs on Workers through the fetch adapter, which names Cloudflare Workers explicitly [docs: adapters/fetch]. Subscriptions use SSE through `httpSubscriptionLink` (which the docs recommend) or WebSockets. Both work with async generators and `tracked(id, …)` for resume [docs: subscriptions].
- **OpenAPI:** the official `@trpc/openapi` package is "in alpha. APIs may change without notice". It is versioned `11.x.x-alpha` [docs: trpc.io/docs/openapi; npm].
  - It documents tRPC's own protocol: queries are `GET /procedure.path` with `?input=<JSON>`, and mutations are `POST /procedure.path`. Responses are wrapped in `result.data`.
  - Subscriptions are excluded.
  - Non-TS clients must match the data transformer, or "Dates, Maps, Sets … may be silently wrong."
  - A REST translation layer is listed only under "Maybes" [readme: packages/openapi].
- The community `trpc-to-openapi` 3.3.0 (last published 2026-05) [npm] serves REST routes. The older `trpc-openapi` stopped at 1.2.0 in 2023 [npm]. Neither is first-party.
- MCP: `trpc-mcp` is 0.0.1, last published 2025-02 [npm]. In effect, nothing.

## 4. GraphQL (Yoga + Pothos)

- **Yoga on Workers:** Yoga has "an agnostic HTTP handler using Fetch API's Request and Response objects". It is exported as `{ fetch: yoga.fetch }`, and bindings come through context [docs: yoga cloudflare-workers].
- **Subscriptions:**
  - SSE needs a compatibility date after 2022-11-30 (or the `streams_enable_constructors` flag).
  - Topic-based WebSocket subscriptions are delegated to the third-party `graphql-workers-subscriptions`, which "uses Durable Objects and D1" [docs].
- **Pothos** (code-first schema builder) is 4.15.1 [npm]. TS clients still need GraphQL codegen or `gql.tada` to get typed operations [inference].
- **No OpenAPI.** MCP requires a gateway that maps chosen operations to tools [web search; vendor docs]:
  - Apollo MCP Server, a standalone Rust server, "best alongside GraphOS"
  - The Guild's `@graphql-hive/plugin-mcp` for Hive Gateway, with `@mcpTool` directives

  Either one is an extra deployable, beside the Worker.

- **Fit [inference]:** Throng's API is resource- and state-machine-shaped: create, list, get, patch, and verb transitions like `/close` and `/handoff`. GraphQL's selection flexibility helps the web UI a little but costs every other consumer.

## 5. Other options considered

- **Hono RPC alone (plain Hono + `@hono/zod-validator`, no OpenAPI):** this gives the same `hc` types with less ceremony, but no spec. That fails the agent and arbitrary-HTTP requirement [inference]. `@hono/zod-openapi` is a strict superset of it.
- **`hono-openapi` (rhinobase):** a middleware-style OpenAPI layer over plain Hono, at version 1.3.5 [npm]. It was covered in openapi-mcp.md, where its README says "still in development".
- **ts-rest:** a contract-first REST library with a typed client, but its last publish was 3.52.1 in 2025-06 [npm]. It is less active than the options above.
- **Workers RPC (`WorkerEntrypoint`):** a Worker exposes public methods to "other Workers on your Cloudflare account that declare a binding" [docs: service-bindings/rpc]. This is useful only for UI-to-API, and it would duplicate the REST surface. With `hc` + a service-binding `fetch`, it gains little [inference].

## Does the tasks spec (#11) need to change?

No [inference]. "REST under `/api`, defined with `@hono/zod-openapi` so the OpenAPI spec is generated" remains the best fit. Two small additions are worth considering when #77 is decided:

1. Have the `apps/platform` route modules export their composed type, so the web UI and CLI can use `hc` (ideally a precompiled `hcWithType`). This avoids generating a client inside the monorepo.
2. Return errors via `c.json({error}, status)` with explicit statuses, so `hc` types the error shapes. Global `onError` responses are not inferred without `ApplyGlobalResponse` [docs: hono rpc].

## Open questions

- **Will any consumer need typed streaming?** Candidates are the bounce channel (openapi-mcp.md listed polling vs live updates as open) and live attempt status in the arena UI. If yes, test whether a `@hono/zod-openapi` route can declare `text/event-stream` and still be useful in `hc`. If that is painful, oRPC v2's event iterators are the strongest argument for switching.
- **When does oRPC v2 go stable?** No date is published. If it ships and `orpc-mcp` (or a first-party equivalent) matures, re-run this comparison.
- **Type-check cost of `hc` at about 25 routes:** worth a quick measurement once the slices from #11 land, to decide whether `hcWithType` is needed from the start.
- **Does the web UI need anything REST can't cover cheaply?** Examples are batching several resource reads per page, which oRPC and tRPC batch natively. If so, a BFF in the UI Worker may be simpler than changing the API style.

## Sources

- Hono RPC guide: https://hono.dev/docs/guides/rpc
- Hono streaming helper: https://hono.dev/docs/helpers/streaming
- @hono/zod-openapi README: https://github.com/honojs/middleware/tree/main/packages/zod-openapi
- oRPC OpenAPI routing: https://orpc.dev/docs/openapi/getting-started
- oRPC OpenAPI specification: https://orpc.dev/docs/openapi/openapi-specification
- oRPC OpenAPIHandler: https://orpc.dev/docs/openapi/openapi-handler
- oRPC OpenAPILink: https://orpc.dev/docs/openapi/client/openapi-link
- oRPC event iterator: https://orpc.dev/docs/event-iterator
- oRPC Hono adapter: https://orpc.dev/docs/adapters/hono
- oRPC ecosystem: https://orpc.dev/docs/ecosystem
- oRPC releases: https://github.com/middleapi/orpc/releases
- tRPC fetch adapter: https://trpc.io/docs/server/adapters/fetch
- tRPC subscriptions: https://trpc.io/docs/server/subscriptions
- tRPC OpenAPI: https://trpc.io/docs/openapi and https://github.com/trpc/trpc/tree/main/packages/openapi
- GraphQL Yoga on Cloudflare Workers: https://the-guild.dev/graphql/yoga-server/docs/integrations/integration-with-cloudflare-workers
- Apollo MCP Server: https://www.apollographql.com/docs/apollo-mcp-server
- Hive Gateway MCP plugin: https://the-guild.dev/graphql/hive/docs/gateway/mcp
- Cloudflare Workers RPC: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
- npm registry metadata (`npm view`, `api.npmjs.org/downloads`) for all packages listed, 2026-10-09
