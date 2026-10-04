# Artifacts binding behaviour: file reads, fork lifecycle, push events

Research for [#4](https://github.com/gregjoeval/throng/issues/4) (part of map [#3](https://github.com/gregjoeval/throng/issues/3)).
Researched 2026-10-04 against docs dated up to 2026-10-01 (Artifacts open beta) and Wrangler 4.147.0.

Each claim is tagged by evidence level:

- **[docs]**: stated in developers.cloudflare.com reference or guide pages.
- **[example]**: only shown in an example, blog post, or official SDK/example repo code.
- **[issue]**: reported in a public GitHub issue (third-party report, not confirmed by Cloudflare).
- **[unverified]**: not documented. The spike must test it.

## TL;DR

1. **File reads exist now.** The binding reference (updated 2026-10-01) lists `readFile({ref, path})`, `readBlob`, `readTree`, `readCommit` and `log`. The blog example is correct. We don't need isomorphic-git just to read. The binding still has **no write/commit method**, so writes go over git (isomorphic-git in a Worker, or the git CLI in a Sandbox).
2. **Fork lifecycle.** `fork()` returns `{name, remote, token, ...}` synchronously. Until the copy finishes, the repo shows `status: "forking"` in `list()`, `get()` throws, and the REST API returns `FORK_IN_PROGRESS` (10303 / 409, retriable). A `cf.artifacts.repo.forked` event exists, but only on the account-level event-subscription (Queue) path. Fork latency is not documented. Tokens come from `repo.createToken("read"|"write", ttlSeconds)`. Over REST the TTL range is 60 s to 1 year, with a default of 24 h.
3. **Push events.** There are two delivery paths:
   - **(a) Direct Workflow trigger.** `triggers.events` in the Wrangler config takes a `filter` of `namespace` plus optional `repo_name`. Each push starts its own Workflow instance with no Queue involved. A namespace-wide filter covers every fork.
   - **(b) Queue event subscription.** `pushed` is a **repo-level** event: the subscription needs `namespace` and `repo_name`. That means **one subscription per fork**, created through the REST API (Wrangler can't create it yet). The consumer then calls `env.WF.create()`.

   Queues delivery is at-least-once.

**Recommendation for the map:** route pushes through `triggers.events` (namespace filter) straight into the Workflow, not through a Queue. If the "push event on a Queue" hop is kept, the fork flow must also create a per-fork event subscription through the REST API.

---

## 1. File reads

### What the docs state

The [Workers binding reference](https://developers.cloudflare.com/artifacts/api/workers-binding/) (last updated Oct 1, 2026) says the repo handle supports "metadata lookup, token management, Git object inspection, path-based file reads, commit history, and forking" **[docs]**. Repository capability methods:

| Method | Returns | Notes |
| --- | --- | --- |
| `info()` | `ArtifactsRepoInfo` | Fresh metadata lookup. Metadata is **not** exposed as properties on the handle. |
| `log({ref?, limit?, offset?})` | `ArtifactsCommitMetadata[]` | First-parent chain, newest first. Default 50, max 1000. Unresolvable ref returns `[]`. |
| `readCommit(hash)` | `ArtifactsCommitMetadata \| null` | |
| `readTree(hash)` | `ArtifactsTreeEntry[] \| null` | Immediate children only, so walk recursively for a full tree. |
| `readBlob(hash)` | `Blob \| null` | Untyped `Blob` (`type` is empty). Hash must be a lowercase 40-char SHA-1. |
| `readFile({ref, path})` | `Blob \| null` | MIME-typed `Blob`. `null` if the path is missing or is a directory. Throws `INVALID_INPUT` on an empty ref or path. |
| `createToken(scope?, ttl?)`, `listTokens()`, `revokeToken(tokenOrId)` | | `scope` defaults to `"write"`. |
| `fork(name, {description?, readOnly?, defaultBranchOnly?})` | `ArtifactsCreateRepoResult` | |

- Blob-returning methods over a `remote` binding in local dev need **Wrangler ≥ 4.145.0** **[docs]**.
- `npx wrangler types` generates the `Artifacts` type. The docs say to treat `worker-configuration.d.ts` as the source of truth **[docs]**.
- The REST API has matching routes: `/log`, `/commit/:hash`, `/tree/:hash`, `/blob/:hash`, `/file?ref=&path=`, `/raw/:ref/:path` ([REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)) **[docs]**.

### Stale material to ignore

- The [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) (May 21, 2026) still says "The Artifacts binding creates and manages repos, but it cannot read or write files inside them". The read half is out of date. Reads were added by the Oct 1 open-beta release ([changelog](https://developers.cloudflare.com/artifacts/platform/changelog/): "inspect files and commits, read files by path").
- The [launch blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (Apr 2026) uses `import({source, target})`. The binding reference still documents that shape. Some third-party pages show `import(name, {url, branch})`. Trust the generated types.
- The [Sandbox SDK + Artifacts example](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) reads `repo.defaultBranch` / `repo.remote` straight off a `get()` handle. That contradicts the binding reference, which says to use `await repo.info()` **[example vs docs]**.

### Writes

There is no write/commit/merge method on the binding or the REST API **[docs, by absence]**. Writing means git smart-HTTP push:

- From a Worker, use isomorphic-git with an in-memory FS (the [official example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) shows `init`/`add`/`commit`/`push`). Auth is `onAuth: () => ({ username: "x", password: token.split("?expires=")[0] })` **[example]**.
- From a Sandbox, use the git CLI with `https://x:<secret>@<remote-host-path>` or `-c http.extraHeader="Authorization: Bearer <full token>"` ([Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)) **[docs]**.
- Push is **protocol v1 receive-pack only**. Clone/fetch support v1 and v2. The optional v1 capabilities `filter` (partial clone) and `include-tag` are not supported **[docs]**.

### If we still want isomorphic-git for reads

- The isomorphic-git functions `log`, `readCommit`, `readTree` and `readBlob` need a local object store. In a Worker that means `git.clone`/`git.fetch` into a MemoryFS with `http` from `isomorphic-git/http/web` and the same `onAuth`. Partial clone (`filter`) is unsupported, so this has to be a full or shallow (`depth`) fetch.
- The binding methods do the same job without a clone. **We don't need isomorphic-git for reads.**

### Unverified (spike)

- The exact shape of `ArtifactsCommitMetadata` and `ArtifactsTreeEntry`. Read it from the generated `worker-configuration.d.ts`.
- Whether the read methods work on a repo that is still `forking`. `get()` is documented to throw until the repo is ready, so probably not.
- Read latency per call, and whether binding reads count against the 2,000 git requests / 10 s per repo limit or the control-plane limit.

## 2. Fork lifecycle

### What the docs state

- `fork()` returns `ArtifactsCreateRepoResult`: `name`, `remote`, `defaultBranch`, and a `token` string **[docs]**. The REST fork response also has `objects` (count) **[docs]**.
- The token returned by create, fork or import is a plain string `art_v1_<40 hex>?expires=<unix_seconds>`. Only `createToken()` returns a structured `{plaintext, expiresAt, ...}` ([REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)) **[docs]**.
- The scope and TTL of the fork-returned token are **not documented**. The get-started guide calls the create token an "initial write token" **[docs, create only]**.
- `list()` entries carry `status: "ready" | "importing" | "forking"` **[docs]**.
- `get(name)` "Throws if the repo does not exist or is not ready yet" **[docs]**.
- Error `FORK_IN_PROGRESS` (10303): "The repository is being forked and is not yet available." REST routes on a forking repo "can return `409 Conflict` with a retriable error message" ([Errors](https://developers.cloudflare.com/artifacts/api/errors/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)) **[docs]**.
- `cf.artifacts.repo.forked` event: **account-level** (source `artifacts`). `source` is the parent repo. `payload` carries the target `namespace`, `repoName`, `repoId`, `createdAt` and `updatedAt` ([Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)) **[docs]**. It is only available through a Queue event subscription; the docs don't show it as a Workflow trigger. The Wrangler 4.147 schema does accept every `cf.artifacts.repo.*` type, including `forked`, in `triggers.events` **[source code]**.

### When is it safe to hand out the write token?

Not documented **[unverified]**. Evidence:

- The doc example for `forked` shows `createdAt 15:53:52.384`, `updatedAt 15:53:54.579` and event `15:53:54.641`. That suggests about 2 s from fork start to ready for a small repo. It is illustrative only **[example]**.
- The [Oct 1 blog](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) forks and then immediately `get(workspace.name)` + `readFile` on the fork, and hands `workspace.token` to the agent. That implies the fork is ready, or nearly ready, by the time `fork()` resolves **[example]**.
- `defaultBranchOnly: true` should shrink the copy **[docs, effect on latency unverified]**.
- The Workers SDK issue [#15429](https://github.com/cloudflare/workers-sdk/issues/15429) says the fork-returned token cloned the fork successfully from a Worker **[issue]**.

**Spike recipe:** after `fork()`, poll `env.ARTIFACTS.get(name)` (or `info()`) with a short backoff until it stops throwing `FORK_IN_PROGRESS`, then hand out the token. Record the latency. Keep the `forked` event as an optional optimisation, not a dependency.

### Minting repo-scoped write tokens

- Binding: `using repo = await env.ARTIFACTS.get(name); const t = await repo.createToken("write", ttlSeconds);` returns `{plaintext, expiresAt, ...}` **[docs]**. The scope defaults to `"write"`, so always pass it explicitly.
- REST: `POST /accounts/:id/artifacts/namespaces/:ns/tokens` with `{repo, scope, ttl}`. `ttl` minimum 60 s, maximum 31,536,000 s (1 y), default 86,400 s (24 h) **[docs]**. The binding page gives no bounds; assume they match **[unverified]**.
- Wrangler: `wrangler artifacts repos issue-token <repo> --namespace --scope --ttl` **[docs]**.
- `read` allows clone, fetch and pull. `write` adds push. Tokens are strictly repo-scoped, even within a namespace **[docs]**.
- Tokens can be revoked with `revokeToken(tokenOrId)`. `token.created` and `token.revoked` events exist (repo-level) **[docs]**.
- **Known bug [issue]:** [workers-sdk#15429](https://github.com/cloudflare/workers-sdk/issues/15429) (open, Wrangler 4.125). A token from `repo.createToken("read", 300)` on an *existing* repo got **HTTP 403** on `info/refs` when used from a Worker via isomorphic-git, but worked from a standalone process. The create and fork tokens worked. Our spike pushes from a dev machine with plain `git push`, which is the case reported as working. The Sandbox rebase-and-push hop, however, uses a Worker-minted token. **Test it early.**
- Local dev: under `wrangler dev` with `remote: true`, every RPC result needs `dispose()`, otherwise the runtime logs warnings ([workers-sdk#15830](https://github.com/cloudflare/workers-sdk/issues/15830)) **[issue]**. Use `using`.

## 3. Push events

### Event shape [docs]

From [Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/):

```json
{
  "type": "cf.artifacts.repo.pushed",
  "source": { "type": "artifacts.repo", "namespace": "my-namespace", "repoName": "my-repo" },
  "payload": {
    "ref": "refs/heads/main",
    "before": "<40-hex>",
    "after": "<40-hex>",
    "commits": [{ "id": "...", "message": "...", "messageTruncated": false, "timestamp": "...",
                  "author": {"name": "...", "email": "..."}, "committer": {...}, "parents": ["..."] }],
    "totalCommitsCount": 1,
    "commitsTruncated": false
  },
  "metadata": { "accountId": "...", "eventSubscriptionId": "...", "eventSchemaVersion": 1, "eventTimestamp": "..." }
}
```

- The payload has no `repoId`. Identify repos by `source.namespace` + `source.repoName`.
- `@cloudflare/ci` treats `after === 0000…0000` as a ref deletion and skips it, which implies deletes also emit `pushed` ([cloudflare/ci `src/artifacts/events.ts`](https://github.com/cloudflare/ci/blob/main/src/artifacts/events.ts)) **[example]**.
- One event per ref or per push when several refs are pushed at once: **[unverified]**.

### Path A: direct Workflow trigger (`triggers.events`) [docs + source]

Announced in [Run CI/CD for millions of repos](https://blog.cloudflare.com/ci-workflows/) (Aug 2026) and documented in [Build and deploy Artifacts repos](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/) (Oct 1, 2026). It skips the subscription, Queue, and consumer:

```jsonc
"triggers": {
  "events": [{
    "type": "cf.artifacts.repo.pushed",
    "filter": { "namespace": "throng" },          // omit repo_name => every repo in the namespace
    "targets": [{ "type": "workflow", "workflow_name": "attempt-check" }]
  }]
}
```

- **Config key spelling conflicts between sources.** The docs guide shows `filter.repoName` and `target: {scriptName, workflowName}`. The blog shows `target: {type, workflow_name}`. The **Wrangler 4.147.0 schema and validator** (`config-schema.json`, `validateTriggers`) accept only `filter: {namespace?, repo_name?}` and `targets: [{type: "workflow", workflow_name}]`, and reject other keys. The official [cloudflare/ci example `wrangler.jsonc`](https://github.com/cloudflare/ci/blob/main/examples/cloudflare-artifacts/wrangler.jsonc) uses the same Wrangler form. **Use the Wrangler/ci-example form.**
- On deploy, Wrangler `PUT`s these to `/accounts/:id/triggers/:scriptName`, adding `script_name` to each target. It skips the PUT if a targeted Workflow failed to deploy **[source code, wrangler 4.147.0 dist]**.
- "When you omit `repoName`, Cloudflare runs the same Workflow for every push to any repo in your Artifacts namespace. … Each push still starts its own Workflow instance" **[docs]**. That covers forks created at runtime with no per-fork setup.
- **What the Workflow receives:** the raw event envelope as `event.payload`. `@cloudflare/ci`'s `CIWorkflow.run()` parses `event.payload` with the same zod schema it uses for Queue bodies ([`src/pipeline/ci-workflow.ts`](https://github.com/cloudflare/ci/blob/main/src/pipeline/ci-workflow.ts)) **[example/source]**.
- Delivery guarantees, instance-ID scheme or dedup, and trigger latency are **not documented** **[unverified]**. Make the Workflow idempotent on `(repo, after)`.
- Workers Builds can alternatively build or deploy an Artifacts repo on push ([Workers Builds Artifacts integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/)). That is a separate track (#3 "Workers Previews for forks").

### Path B: Queue event subscription [docs + issues]

- `pushed`, `cloned`, `fetched`, `token.created` and `token.revoked` are **repository-level** events. The subscription source is `artifacts.repo` with a `namespace` **and** `repo_name` **[docs]**. The account-level `artifacts` source carries only `repo.created`, `repo.deleted`, `repo.forked` and `repo.imported` **[docs]**. **No account-wide or namespace-wide Queue subscription for pushes is documented, so a Queue design needs one subscription per fork.**
- Create via REST: `POST /accounts/:id/event_subscriptions/subscriptions` with the body below. The API accepts only the short event names (`pushed`); `cf.artifacts.repo.pushed` is rejected. Delivered messages use camelCase `repoName` ([workers-sdk#16043](https://github.com/cloudflare/workers-sdk/issues/16043)) **[issue]**.

  ```json
  {"name":"...","enabled":true,"events":["pushed"],
   "source":{"type":"artifacts.repo","namespace":"<ns>","repo_name":"<repo>"},
   "destination":{"type":"queues.queue","queue_id":"<id>"}}
  ```

- **Wrangler can't create it yet.** `wrangler queues subscription create --source artifacts.repo` has no `--namespace`/`--repo-name` flags and always fails validation (Wrangler 4.146/4.147). Fix PR [workers-sdk#16051](https://github.com/cloudflare/workers-sdk/pull/16051) is open **[issue, confirmed in 4.147.0 source]**.
- Consumer → Workflow ([Oct 1 blog](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)) **[example]**:

  ```ts
  async queue(batch, env) {
    for (const m of batch.messages) {
      const e = m.body;
      if (e.type !== "cf.artifacts.repo.pushed") continue;
      await env.REVIEW_WORKFLOW.create({ params: { namespace: e.source.namespace, repo: e.source.repoName, ref: e.payload.ref, commit: e.payload.after } });
    }
  }
  ```

  Pass `id` (for example `${repo}-${after}`) to `create()`. Instance IDs "Must be unique within the Workflow", so a redelivered message can't start a second run ([Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)) **[docs]**. Whether `create()` with a duplicate id throws or returns the existing instance is **[unverified]**.
- Queues delivery is **at-least-once** ([Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)) **[docs]**. Batching defaults are `max_batch_size` 10 and `max_batch_timeout` 5 s, which adds up to about 5 s of latency ([Batching, retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)) **[docs]**. Tune both down for the spike.
- Event-to-queue latency is **[unverified]**.

### Feedback-loop hazard

The Sandbox's own push to `main` of the upstream repo also emits `pushed`. With a namespace-wide trigger, that would start another Workflow run. Filter by repo (upstream vs fork) and/or ref inside the Workflow, or keep upstream repos in a different namespace from forks **[design note]**.

## 4. Limits, namespaces, jurisdiction

From [Limits](https://developers.cloudflare.com/artifacts/platform/limits/) **[docs]**:

| Limit | Value |
| --- | --- |
| Control-plane requests | 2,000 / 10 s **per namespace** |
| Git requests | 2,000 / 10 s **per repo** |
| Repo size | 1 GB |
| File/blob size | 32 MB |
| Account storage | 1 TB (raisable) |
| Repos, namespaces | unlimited |
| Names | Namespace 2–63 chars. Namespace and repo names start with a letter or digit, then letters, digits, `.`, `_`, `-`. |

Namespaces and jurisdiction:

- Namespaces are created implicitly by the first repo create, or explicitly with `POST /accounts/:id/artifacts/namespaces {namespace, jurisdiction?: "eu"|"us"}` ([How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/), [Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/)) **[docs]**.
- **Jurisdiction can only be set at namespace creation and is immutable.** Omitting it gives an unrestricted namespace **[docs]**. For the spike, leave it unrestricted, but create the namespace explicitly if we might ever want `eu`.
- The binding is bound to one namespace (`"artifacts": [{"binding": "ARTIFACTS", "namespace": "<ns>"}]`). Use multiple bindings for multiple namespaces **[docs]**. Best practice is to split namespaces per environment (`staging`/`prod`) and shard hot workloads ([Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)) **[docs]**.
- A fork's `forked` event payload has its own `namespace` field, distinct from the source, which hints that cross-namespace forks are possible. The binding `fork()` has no namespace parameter **[unverified]**.

Plan and billing: Workers Paid plan required. **Billing starts Oct 14, 2026**, the same day as our deadline ([changelog](https://developers.cloudflare.com/artifacts/platform/changelog/), [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)) **[docs]**.

## 5. What the binding cannot do

- No write, commit, merge, rebase, or ref-update method on the binding or REST. All mutations go through git push **[docs, by absence]**.
- No `waitUntilReady` or fork-completion promise. Readiness is found by `get()` throwing or by `list()` status **[docs]**.
- No server-side diff or merge-conflict API. Conflict detection (Task B) must run git in a Sandbox or isomorphic-git **[docs, by absence]**.
- No protocol-v2 push and no partial clone (`filter`) **[docs]**.
- `log()` follows first parents only **[docs]**.

## 6. Spike checklist (unverified items)

1. `wrangler types` output: exact `Artifacts*` types (commit and tree entry shapes, `fork()` result, list `status`).
2. Fork → ready latency (with and without `defaultBranchOnly`), and how `get()` fails while forking.
3. Scope and TTL of the fork-returned token (parse `?expires=`, try a push).
4. Whether `repo.createToken("write")` tokens minted in a Worker can push from a Sandbox and from isomorphic-git ([#15429](https://github.com/cloudflare/workers-sdk/issues/15429)).
5. `triggers.events` with a namespace-only filter: does a push to a just-created fork start the Workflow? Measure latency, check for duplicate deliveries, and dump the `event.payload` shape.
6. If a Queue is kept: per-fork REST subscription creation, latency, and that `create({id})` dedups redeliveries.
7. Multi-ref push: one event or many. Branch deletion (`after` = zero SHA).

## Sources

- Artifacts docs: [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [Errors](https://developers.cloudflare.com/artifacts/api/errors/), [Wrangler commands](https://developers.cloudflare.com/artifacts/api/wrangler/), [Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/), [Build and deploy on push](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/), [Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/), [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/), [Sandbox SDK example](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/), [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/), [Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/), [Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/), [Limits](https://developers.cloudflare.com/artifacts/platform/limits/), [Changelog](https://developers.cloudflare.com/artifacts/platform/changelog/)
- Queues docs: [Event subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/), [Manage subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/), [Events & schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/), [Wrangler commands](https://developers.cloudflare.com/queues/reference/wrangler-commands/), [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Batching, retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- Workflows docs: [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- Blog: [We want you to build the next Git platform on Cloudflare](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) (2026-10-01), [Run CI/CD for millions of repos](https://blog.cloudflare.com/ci-workflows/) (2026-08-04), [Artifacts: versioned storage that speaks Git](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (2026-04-16)
- GitHub: [cloudflare/ci](https://github.com/cloudflare/ci) (`@cloudflare/ci` 0.2.0, Apache-2.0; `src/artifacts/events.ts`, `src/pipeline/ci-workflow.ts`, `examples/cloudflare-artifacts/wrangler.jsonc`), wrangler 4.147.0 npm package (`config-schema.json`, `validateTriggers`, `parseSourceArgument`), [workers-sdk#16043](https://github.com/cloudflare/workers-sdk/issues/16043), [workers-sdk#16051](https://github.com/cloudflare/workers-sdk/pull/16051), [workers-sdk#15429](https://github.com/cloudflare/workers-sdk/issues/15429), [workers-sdk#15830](https://github.com/cloudflare/workers-sdk/issues/15830)
