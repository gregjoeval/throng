# Artifacts namespace and ref limits

Research for [#75](https://github.com/gregjoeval/throng/issues/75) (part of map [#71](https://github.com/gregjoeval/throng/issues/71)). It feeds [#27](https://github.com/gregjoeval/throng/issues/27) (fork naming across projects), [#48](https://github.com/gregjoeval/throng/issues/48) (fork lifecycle cleanup) and [#69](https://github.com/gregjoeval/throng/issues/69) (stacked variants).
Researched 2026-10-07. Sources: the Artifacts docs (pages dated 2026-04-25 to 2026-10-01), Cloudflare's Artifacts OpenAPI schema, the Cloudflare blog, and `apps/platform/worker-configuration.d.ts` (workerd 1.20261001.1). No Cloudflare API was called.

Each claim is tagged by evidence level:

- **[docs]**: stated in a developers.cloudflare.com page.
- **[schema]**: stated in Cloudflare's Artifacts OpenAPI schema. The schema drives the generated `cf` CLI ([cloudflare/cf `artifacts/namespaces/delete.ts`](https://github.com/cloudflare/cf/blob/main/packages/cli/src/commands/_generated/artifacts/namespaces/delete.ts)). We read it from the [Cloudflare-Datamining mirror](https://github.com/Cloudflare-Mining/Cloudflare-Datamining/blob/main/data/api-schemas/schemas/Artifacts.json). It's machine-readable and first-party, but no human-written docs page backs it.
- **[types]**: stated in the generated binding types (`apps/platform/worker-configuration.d.ts`).
- **[example]**: only shown in an example or a blog post.
- **[unverified]**: not documented anywhere. A spike must test it.

## TL;DR

| #   | Question                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Namespaces per account, deletion | **Unlimited** **[docs]**. You can delete a namespace only when it is **empty**, and only over REST (`DELETE /artifacts/namespaces/:namespace`, 204, or 409 on conflict) **[schema]**. Neither the docs pages nor Wrangler mention namespace delete. The binding has no namespace methods, and each binding is pinned to one namespace in the Wrangler config **[docs][types]**. That last point matters more than the count.                                                                     |
| 2   | Max repo name length             | **Not published.** Repo names have a pattern (`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`) but no `maxLength` anywhere: docs, schema or types **[docs][schema][types]**. Namespace names are 2 to 63 characters and cannot end in `-` **[docs][schema]**. Branch names are at most 256 characters **[schema]**. Assume a hidden cap exists **[unverified]**: keep repo names at 63 characters or fewer.                                                                                                       |
| 3   | Custom refs (`refs/attempts/*`)  | **Probably yes, but not confirmed.** Push uses standard git v1 receive-pack **[docs]**. The best-practices page tells you to push `refs/notes/*`, which is a ref outside `refs/heads`/`refs/tags`, so the server accepts at least one custom ref namespace **[docs]**. Nothing says an arbitrary `refs/attempts/*` is accepted, kept, or survives a fork **[unverified]**. The push event carries the full ref name **[docs]**. Our router already ignores non-`main` pushes on canonical repos. |
| 4   | Fork of a fork                   | **Allowed by the API shape, not confirmed.** `fork()` is a method on every `ArtifactsRepo` handle, and nothing marks forks as non-forkable **[types]**. `source` is formatted `"artifacts:namespace/repo"` **[types]**. Forks have their "own tokens, routing, and lifecycle" **[docs]**. No page shows forking a fork, or says whether the chain is limited **[unverified]**.                                                                                                                   |

## 1. Namespaces: count, deletion, how a Worker reaches them

**Count.** The [Limits](https://developers.cloudflare.com/artifacts/platform/limits/) page (updated 2026-10-01) lists `Maximum number of namespaces | Unlimited` and `Maximum number of repositories | Unlimited` **[docs]**. The [beta blog post](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) says it supports "millions of Git repos per namespace" **[example]**. Limits are scoped per namespace, not per account:

- the control-plane rate of 2,000 requests per 10 s applies **per namespace**, which covers create, fork, delete and token calls **[docs]**;
- the git rate of 2,000 requests per 10 s applies per repo **[docs]**;
- storage is capped at 1 TB per account (raisable) and 1 GB per repo **[docs]**.

**Create.** Two routes create a namespace **[docs]**:

- **Implicitly**: the first repo created under a new namespace name creates it ([Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/)).
- **Explicitly**: `POST /artifacts/namespaces {namespace, jurisdiction?}` ([REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)). Jurisdiction is immutable after creation.

The OpenAPI summary reads "Creates an empty Artifacts namespace for an account" **[schema]**. Wrangler has only `artifacts namespaces list` and `artifacts namespaces get` ([Wrangler commands](https://developers.cloudflare.com/artifacts/api/wrangler/), updated 2026-05-18) **[docs]**. The dashboard can view and create namespaces (changelog 2026-06-17) **[docs]**.

**Delete.** No docs page documents namespace deletion. The REST page lists create, list and get only. The OpenAPI schema does define it **[schema]**:

- `DELETE /accounts/{account_id}/artifacts/namespaces/{namespace}`, operationId `artifacts_namespaces_delete`, summary "Delete a namespace", description **"Deletes an empty Artifacts namespace."**
- Responses: `204 Namespace deleted`, `404 Resource not found`, `409 Operation conflict`. The 409 is presumably what a non-empty namespace returns **[unverified]**.

To delete a namespace you therefore delete every repo first (`DELETE .../repos/:name` → 202, or binding `delete(name)` → `boolean`) **[docs][types]**, then delete the namespace over REST. Repo delete returns 202, so it is asynchronous, and a namespace delete issued right after may still return 409 **[unverified]**.

**How a Worker reaches a namespace.** This is the deciding fact for #27, more than the count:

- The binding is declared as `"artifacts": [{"binding": "ARTIFACTS", "namespace": "<ns>"}]`, which pins one namespace per binding at deploy time ([Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)) **[docs]**.
- The `Artifacts` interface has `create`, `get`, `import`, `list` and `delete`, all of them for repos. It has no namespace parameter or namespace methods **[types]**. A Worker cannot pick a namespace at runtime through the binding.
- The `triggers.events` push filter takes `namespace` plus an optional `repoName`. Omitting `repoName` covers every repo in that namespace ([Build and deploy on push](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/)) **[docs]**. Each namespace needs its own trigger entry in the Wrangler config.
- Cloudflare's own guidance partitions by environment (`staging`/`prod`), team or traffic class, and says to shard hot workloads ([Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)) **[docs]**. [Repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/) says "use namespaces to group those repositories by environment, tenant, or shard" **[docs]**.

A namespace per project would therefore mean one of two things:

- a redeploy that adds a binding and a trigger for each new project; or
- dropping the binding for project repos and using REST with an account API token, which also loses the direct Workflow trigger and falls back to per-namespace event subscriptions.

Both are inferences from the docs and types above.

## 2. Name lengths and patterns

| Name                           | Length             | Pattern                                                              | Source                                                                                                                                                                                                      |
| ------------------------------ | ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace                      | 2–63               | `^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9._])?$` (cannot end in `-`)   | Limits page **[docs]**. The pattern and the trailing-character rule come from every `{namespace}` parameter and from `POST /namespaces` **[schema]**.                                                       |
| Repo                           | **none published** | `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`                                       | Limits page gives the character rule only **[docs]**. Schema `name` and `repo` fields carry the pattern with no `maxLength` **[schema]**. Types say "alphanumeric, dots, hyphens, underscores" **[types]**. |
| Default branch / import branch | 1–256              | `^[a-zA-Z0-9][a-zA-Z0-9._/-]*$`, no `..`, must not end in `/` or `.` | **[schema]**                                                                                                                                                                                                |
| Description                    | ≤ 1024             | none                                                                 | **[schema]**                                                                                                                                                                                                |

Repo names are unique within a namespace, not across the account **[docs]**. A bad name throws `INVALID_REPO_NAME` (numeric 10101) **[docs][types]**. There must be some server-side cap (DO/KV keys, URL path) **[unverified]**. Nothing documents what it is.

**For us.** A fork name is `${project}--${attempt}` (`apps/platform/src/events.ts`), which fits the pattern. Once a project prefix is added for #27, keep the whole name at 63 characters or fewer, matching the namespace cap, until a spike measures the real limit. A spike can binary-search the cap with `create()` on lengths 64, 128, 256 and 1024 and watch for `INVALID_REPO_NAME`.

## 3. Custom refs (`refs/attempts/*`)

What is documented:

- Git smart HTTP. "Push uses the standard v1 receive-pack flow". v2 receive-pack isn't supported. Some optional v1 fetch capabilities (`filter`, `include-tag`) aren't supported either ([Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), 2026-04-25) **[docs]**. The page does not restrict which refs can be pushed, and it says nothing about force-push or ref deletion. Its only push example is `HEAD:main`.
- [Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/) says to "Push and fetch `refs/notes/*` with the rest of your repo data". The beta blog claims "native support for git-notes" **[docs][example]**. This is the only documented case of a ref outside `refs/heads`/`refs/tags`. It shows that the ref store isn't restricted to branches, but `refs/notes` may be special-cased.
- The `cf.artifacts.repo.pushed` payload has a full `ref` string (example `refs/heads/main`), plus `before` and `after` **[docs]**. The trigger filter cannot filter by ref **[docs]**, so a push to `refs/attempts/*` will start the push Workflow. `routePush` already returns `ignored` ("canonical push to …") for any non-default-branch ref on a canonical repo, and `ignored` "ref deleted" when `after` is all zeros. Archive pushes are therefore harmless, though each one costs a Workflow instance.
- `readFile({ref})`, `log({ref})` and REST `/file?ref=` / `/raw/:ref/:path` accept "branch, tag, or commit ID" **[docs][types]**. Whether a full custom ref name such as `refs/attempts/42` resolves there is **[unverified]**. The archived commit SHA always resolves, so store the SHA alongside the ref.
- `fork()` defaults to `defaultBranchOnly: true` **[types]**. Whether non-branch refs (notes, custom) are copied when it is `false` is **[unverified]**. Archived refs on a canonical repo would not flow into new forks by default, which is what we want.

What a spike must check before #48 relies on it:

1. `git push <canonical> <sha>:refs/attempts/<id>` with a write token succeeds, and `git ls-remote` lists the ref.
2. The ref survives a repo `info()` and a later unrelated push. In other words, there's no ref GC.
3. Whether `readFile({ref: "refs/attempts/<id>", ...})` resolves.
4. That archived objects count toward the canonical repo's 1 GB cap **[docs]**. Retention needs a bound.

**Fallback if custom refs are rejected:** push to a branch namespace instead, e.g. `refs/heads/archive/attempts/<id>`. Branch names allow `/` **[schema]**. These would show up as branches and could trigger Workers Previews where previews are wired to non-default branches ([Next Git platform blog](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)) **[example]**. Our router ignores them on canonical repos.

## 4. Fork of a fork (feeds #69)

- `ArtifactsRepo.fork(name, {description, readOnly, defaultBranchOnly})` exists on every repo handle. The types draw no distinction between forked and original repos. Errors are `INVALID_REPO_NAME`, `ALREADY_EXISTS` and `FORK_IN_PROGRESS` **[types]**. REST `POST /repos/:name/fork` is the same **[docs][schema]**.
- `ArtifactsRepoInfo.source` is a single string, e.g. `"artifacts:namespace/repo"` **[types]**. It records only the immediate parent. Lineage across a chain has to be tracked by us.
- "A fork creates a new repo that starts from an existing repo's history, then diverges independently with its own tokens, routing, and lifecycle" ([How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)) **[docs]**. Since a fork is an ordinary repo, forking it should work.
- The `repo.forked` event payload carries a target `namespace` separate from the source's **[docs]**. That hints at cross-namespace forks, but the binding `fork()` takes no namespace **[unverified]**.
- No doc, blog or example forks a fork. Chain-depth limits, and whether a fork of a fork shares storage or copies it, are **[unverified]**.
- `FORK_IN_PROGRESS` is thrown "if a fork is already running" on the source **[types]**. With stacked variants, forking N variants from one attempt fork in parallel may serialise or fail on the source. Fork sequentially or retry, and spike it.

## Implications

**#27 (namespace per project vs per-owner fallback).** The namespace count is not a constraint: it is unlimited. Deletion is not a blocker either, though it's REST-only and requires an empty namespace. The constraint is static wiring: one namespace per binding and one trigger entry per namespace, both set at deploy time. A namespace per project means a redeploy per project, or dropping the binding and direct trigger for REST plus event subscriptions. **Recommendation:** keep a single namespace per environment (or per owner) and make repo names project-scoped, e.g. `${project}--${attempt}`, which is already the code's shape. Collisions are then solved by naming, not by namespaces. Cap the full name at 63 characters until the real repo-name limit is measured. Shard into more namespaces only if the per-namespace control-plane rate (2,000 per 10 s) becomes hot.

**#48 (archive-before-delete via `refs/attempts/*`).** Custom refs are plausible: the protocol is plain receive-pack and `refs/notes/*` is documented as pushable. The plan still needs a short spike (section 3) before relying on it. Keep the branch-namespace fallback (`refs/heads/archive/...`) ready, and record the archived SHA, not only the ref. Then delete the fork (`delete()` revokes its tokens too **[types]**; REST returns 202, so deletion is async). Budget archived history against the canonical repo's 1 GB cap. Archive pushes will fire `pushed` events, which `routePush` already ignores.

**#69 (stacked variants).** Nothing forbids forking a fork, and the types allow it. Confirm it in the same spike, and watch for `FORK_IN_PROGRESS` when fanning out several variants from one base.
