# Declaring Cloudflare resources: wrangler steps vs Terraform/OpenTofu

Research for [PR #185](https://github.com/gregjoeval/throng/pull/185), which adds the `LOGS` R2 binding. Its buckets need a 30-day lifecycle rule on `logs/`, and `wrangler.jsonc` can't declare that rule. The note also covers follow-up [#186](https://github.com/gregjoeval/throng/issues/186). Sources were read on 2026-10-11. Wrangler source was checked at `wrangler@4.149.0`, the version in `apps/platform`. Other versions checked: terraform-provider-cloudflare `v5.27.0` (2026-10-03), pulumi-cloudflare `v6.22.0` (2026-10-06), and alchemy `2.0.0-beta.81` (2026-10-05).

Source labels: **[docs]** vendor documentation, **[source]** code read directly (wrangler's bundled `cli.js` or the provider repo), **[changelog]** release notes, **[issue]** a GitHub issue, **[npm]** registry metadata, **[inference]** my reasoning, not stated by a source.

## Answer

**Recommendation: Option 2 now.** Commit the lifecycle JSON. Apply it with idempotent `wrangler` steps in `deploy.yml` and `e2e.yml`, the same way `d1 migrations apply` already runs. Leave everything else with wrangler.

Why:

- **Only one thing is missing.** The gap is a single bucket setting. Wrangler already creates the bucket on deploy: automatic provisioning is on by default and covers R2 when `bucket_name` names a bucket that doesn't exist [source; changelog]. `wrangler r2 bucket lifecycle set --file` replaces the bucket's whole rule set with one `PUT`, so running it again is safe [source]. That adds one JSON file and one CI step per workflow, and needs no new secrets or state.
- **Terraform would split ownership.** throng's Worker has Durable Objects, a container image and DO migrations. Cloudflare's own IaC guide says that for Workers like this, Terraform should own at most the Worker shell, while "Wrangler [handles] build and Version management" [docs]. Terraform has no resource for container images, Artifacts namespaces or D1 migrations [source]. So adopting it now leaves two tools that share ownership of the Worker. It also adds a state backend, an R2 S3 key pair, and a token broad enough to manage tokens. In return it would manage two buckets and two lifecycle rules.
- **#186 is runtime provisioning, which neither option covers.** Per-project `p<projectId>` Workers are created by the platform Worker calling the Cloudflare API when a project is created. Neither CI-time IaC tool fits that [inference; see §6].

**Trigger to move to Terraform/OpenTofu.** Move when either condition holds:

- There are about 3 or more account resources that neither wrangler.jsonc nor deploy-time wrangler can declare. Examples are a second bucket setting (CORS, custom domain, event notifications), Access applications, DNS or zone settings, or a queue's consumer config.
- You want least-privilege API tokens created as code instead of the one dashboard token, which is broad today (see §5).

If you move, use OpenTofu or Terraform for **non-Worker** resources only: buckets, lifecycle, tokens, Access, DNS. Keep wrangler for the Worker, containers, Workflows bindings and D1 migrations. Start Terraform with `import` blocks for the existing buckets.

**Trigger to revisit Alchemy.** Alchemy 2.0 ships a stable release and its API settles. Unlike Terraform, it would replace wrangler outright, so weigh it as a move of the whole deploy, not an addition. Before deciding, check what this note didn't: API tokens and drift detection.

## Comparison

| Criterion                      | Option 2: wrangler steps in CI                                                                  | Option 3: Terraform/OpenTofu, provider v5                                                                                                                       | Alchemy 2.0 beta (TypeScript)                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| R2 bucket                      | Created on `wrangler deploy` by auto-provisioning, or by an explicit guarded `r2 bucket create` | `cloudflare_r2_bucket` [source]                                                                                                                                 | `Cloudflare.R2.Bucket` [source]                                                                 |
| Lifecycle rule                 | `r2 bucket lifecycle set --file` (full replace, idempotent) [source]                            | `cloudflare_r2_bucket_lifecycle`, `max_age` in **seconds** [source; issue]                                                                                      | `lifecycleRules` prop on the bucket. Omitting it clears all rules [source: `R2/Bucket.ts`]      |
| D1 + migrations                | `d1 migrations apply` (today)                                                                   | `cloudflare_d1_database` only. **No migrations** [source]                                                                                                       | D1 database plus `ApplyMigrations` [source]                                                     |
| Worker, versions, deployments  | `wrangler deploy` (today)                                                                       | `cloudflare_worker`, `cloudflare_worker_version`, `cloudflare_workers_deployment`. DO migrations need a two-pass apply. Bundling stays outside Terraform [docs] | Alchemy deploys the Worker itself, **replacing `wrangler deploy`** [README; inference]          |
| Workflows                      | Provisioned by `wrangler deploy` from `workflows` [changelog]                                   | `cloudflare_workflow` [source]                                                                                                                                  | Workflows module [source]                                                                       |
| Containers                     | Image build/push and application via `wrangler deploy`                                          | `worker_version.containers` attaches a container to a DO class. **No resource for the image or container application** found [source]                           | Containers module [source]                                                                      |
| Artifacts                      | Binding in wrangler.jsonc. Wrangler has only `artifacts namespaces list/get` [source]           | `artifacts` binding type accepted. **No namespace resource** [source; changelog]                                                                                | `examples/cloudflare-git-artifacts` example; namespace resource not confirmed [source]          |
| API tokens                     | Dashboard, by hand (today)                                                                      | `cloudflare_api_token` / `cloudflare_account_token` + permission-group data sources [source]                                                                    | Not checked                                                                                     |
| Single source of truth         | wrangler.jsonc + one lifecycle JSON per bucket. No duplication                                  | Bindings live in wrangler.jsonc. Bucket names are repeated in `.tf`                                                                                             | One TS program replaces wrangler.jsonc, but only if it fully replaces wrangler [inference]      |
| Drift detection                | None built in. Add a `lifecycle list` diff step if wanted                                       | `plan` shows drift, but v5 has open perpetual-diff bugs [issue]                                                                                                 | Not checked                                                                                     |
| Secrets / state                | No state. Existing token needs R2 write (already listed in README)                              | State backend + S3 keys. Token values stored in state as `Sensitive` [source]                                                                                   | State: local, Postgres, HTTP or a Durable Object-backed `StateStore` [source]                   |
| CI complexity                  | +1 step per workflow                                                                            | `init/plan/apply` job, backend creds, lock, ordering vs deploy                                                                                                  | Replace the deploy job with an Alchemy program; adds Effect as a dependency [README; inference] |
| Reversibility                  | Delete the step and JSON. Rules stay on the bucket                                              | `state rm` or `removed` blocks to stop managing without destroying [inference]                                                                                  | Hard: undoing it means rebuilding the wrangler deploy path [inference]                          |
| Runtime-created Workers (#186) | Not covered                                                                                     | Not covered                                                                                                                                                     | Not covered (CI-time tool) [inference]                                                          |

## 1. What throng provisions today

Read from `apps/platform/wrangler.jsonc`, `apps/platform/README.md` (Setup), `.github/workflows/deploy.yml` and `e2e.yml`:

- **Worker** `throng` (prod) and `throng-ci` (`env.ci`), deployed by `wrangler deploy --config dist/throng/wrangler.json` after `vite build`. Durable Objects `ProjectCoordinator` (sqlite) and `RunSandbox` (container, `./container/Dockerfile`), with a declarative `exports` rename tombstone for `CheckSandbox`.
- **Workflows** `throng-scoring` and `throng-ci-scoring`. Names are account-wide, hence the different names.
- **D1** `throng` and `throng-ci`, ids committed. Migrations are applied by `wrangler d1 migrations apply <db> --remote` before deploy in both workflows. The README creates `throng-ci` by hand with `wrangler d1 create`.
- **Artifacts** namespaces `throng-spike` and `throng-ci`, as bindings only.
- **R2** (PR #185) `throng-logs` and `throng-ci-logs`. The README tells you to create them by hand and add the rule with `wrangler r2 bucket lifecycle add … --expire-days 30 --force`.
- **Secrets** `SPIKE_TOKEN` and `CF_PREVIEW_TOKEN`, declared in `secrets.required`. In `e2e.yml`, `CF_PREVIEW_TOKEN` _is_ the deploy token, passed via `--secrets-file`.
- **Shared preview Worker** `throng-fixture-worker`, deployed once by hand from `fixtures/fixture-worker` (README step 2).
- **Tokens.** One dashboard-created account token with edit on Workers Scripts, Artifacts, D1, Workflows, Containers and R2. It is stored as `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID`, in the GitHub environments `production` and `ci`.

## 2. Option 2: committed config applied by wrangler in CI

### Wrangler config can't express lifecycle or CORS

The `r2_buckets` entry schema in `wrangler@4.149.0`'s `config-schema.json` has only `binding`, `bucket_name`, `preview_bucket_name`, `jurisdiction`, `remote` and `local_dev` [source]. The configuration reference lists the same keys and doesn't mention lifecycle or CORS ([docs: configuration#r2-buckets](https://developers.cloudflare.com/workers/wrangler/configuration/#r2-buckets)). Both are only available as commands: `wrangler r2 bucket lifecycle {list,add,remove,set}` (added in wrangler 3.88.0) and `wrangler r2 bucket cors {list,set,delete}` (3.95.0) ([changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)).

### Automatic resource provisioning on deploy

- **History** ([changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)):
  - 3.103.0: "Uses `database_name` and `bucket_name` for provisioning if specified. For R2, this only happens if there is not a bucket with that name already."
  - **4.45.0:** "Enable automatic resource provisioning by default … It currently works for R2, D1, and KV bindings." You can turn it off with `--no-x-provision`.
  - **4.113.0:** the "Experimental:" prefix was dropped "now that automatic provisioning is generally available". The same release expanded provisioning to Queues, Dispatch Namespaces and Flagship.
  - **4.129.0:** if the token gets a 403 when Wrangler lists a resource type, Wrangler "skips automatic provisioning for that resource type and continues the deploy".
- **Covered types** in 4.149.0 (`HANDLERS` in `provision-bindings.ts`) [source]: KV, D1, R2, AI Search namespaces, Agent Memory, Queues, Dispatch Namespaces and Flagship. That matches the docs list ([docs: #automatic-provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)). **Not covered:** Artifacts, and anything that isn't a binding, such as lifecycle, CORS, tokens and Access.
- **R2 with `bucket_name` set (throng's case).** `R2Handler.isConnectedToExistingResource()` calls `getR2Bucket`. A missing bucket (API error 10006) means Wrangler **creates the bucket with that exact name** before uploading. An existing bucket means nothing is done [source]. So `wrangler deploy` (4.149.0) already creates `throng-logs` and `throng-ci-logs`, with **no lifecycle rule**.
- **R2 with `bucket_name` omitted.** Wrangler first tries to inherit the bucket the deployed Worker already binds under that binding name. Failing that, in non-interactive or CI runs (`--x-auto-create` defaults to true), it creates `<worker-name>-<binding-lowercased>`, e.g. `throng-logs`. It writes the name back to the config only in interactive runs [source; docs]. Not recommended here, because the lifecycle step needs a known name [inference].
- **D1 with `database_id` set** is "fully specified", so no provisioning happens. That is throng's case today [source].
- **Workflows and container applications** are also created by `wrangler deploy`, but by the deploy itself, not the binding-provisioning path ([changelog 4.139.0, 4.136.0](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)).

### Idempotency of the commands

- **`r2 bucket create`** `POST`s `/r2/buckets` unconditionally and fails if the bucket exists [source]. In CI, guard it: `wrangler r2 bucket info "$b" >/dev/null 2>&1 || wrangler r2 bucket create "$b"`. Alternatively, run the lifecycle step after `wrangler deploy`, which creates the bucket anyway.
- **`r2 bucket lifecycle add`**, as used in the README, reads the existing rules, **appends** the new rule and `PUT`s the list back [source]. I did not verify whether the API rejects a second rule with the same `id`. Either way it isn't safely re-runnable [inference].
- **`r2 bucket lifecycle set <bucket> --file <json> --force`** reads a JSON file with a `rules` array and `PUT`s it as the whole configuration [source]. It is idempotent. `--force` skips the overwrite prompt, and Wrangler proceeds automatically in non-interactive runs ([changelog 4.78.0](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)). The file uses the API body format ([docs: object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)). `maxAge` is in **seconds** ([docs: API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)). The CLI's `--expire-days` multiplies by 86400 [source].
- **Watch out: `set` replaces the default rule.** Every bucket comes with a default rule that aborts multipart uploads after 7 days ([docs](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)). `set` replaces all rules, so put that rule in the file to keep it [inference]:

```json
{
  "rules": [
    {
      "id": "Default Multipart Abort Rule",
      "enabled": true,
      "conditions": { "prefix": "" },
      "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
    },
    {
      "id": "expire-logs",
      "enabled": true,
      "conditions": { "prefix": "logs/" },
      "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 2592000 } }
    }
  ]
}
```

I did not verify the default rule's exact `id`. Check with `wrangler r2 bucket lifecycle list throng-logs` and copy it. Rules take effect within about 24 hours ([docs](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).

### CI wiring

One step before `pnpm --filter @throng/platform run deploy` in `deploy.yml`, and the same step with `throng-ci-logs` in `e2e.yml`, next to `d1 migrations apply`:

```bash
b=throng-logs
pnpm wrangler r2 bucket info "$b" >/dev/null 2>&1 || pnpm wrangler r2 bucket create "$b"
pnpm wrangler r2 bucket lifecycle set "$b" --file r2/logs-lifecycle.json --force
```

The bucket name is repeated in the workflow and in `wrangler.jsonc`. That's the same duplication the `d1 migrations apply throng` step already has [inference]. The deploy token needs "Workers R2 Storage Write" ([docs](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)), which the README's token already covers. **Drift:** nothing detects drift, but every deploy re-asserts the rule, so a dashboard edit lasts only until the next deploy [inference].

## 3. Option 3: Terraform/OpenTofu with cloudflare provider v5

### Resource coverage

These are checked against `docs/resources/` in [terraform-provider-cloudflare](https://github.com/cloudflare/terraform-provider-cloudflare/tree/main/docs/resources) on main (v5.27.0) [source]:

- **R2.** [`r2_bucket`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket), [`r2_bucket_lifecycle`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket_lifecycle), `r2_bucket_cors`, `r2_bucket_lock`, `r2_bucket_event_notification`, `r2_custom_domain`, `r2_managed_domain` and more.
- **D1.** [`d1_database`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/d1_database) (name, `primary_location_hint`, `read_replication`). There is no migrations support, so `wrangler d1 migrations apply` stays.
- **Workers.**
  - `worker` (the shell: name, observability, logpush), `worker_version` (immutable, with bindings, compatibility, modules, `exports`, `containers`), and `workers_deployment`. The older `workers_script` resource is also still available.
  - Binding types include `r2_bucket`, `d1`, `durable_object_namespace`, `workflow` and `artifacts`. Support for the `artifacts` binding was added in a recent release ([CHANGELOG](https://github.com/cloudflare/terraform-provider-cloudflare/blob/main/CHANGELOG.md)).
- **Workflows.** [`workflow`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workflow) (`workflow_name`, `class_name`, `script_name`, limits, schedules, retention).
- **Containers.** `worker_version.containers` only attaches an existing container to a DO class ("Containers can only be attached to Durable Object classes of this Worker script"). I found **no resource that builds or pushes an image or creates the container application**, and no matching CHANGELOG entry. Wrangler builds and pushes images during deploy.
- **Artifacts.** The provider has **no namespace resource**, only the binding type. Wrangler itself has only `artifacts namespaces list/get` [source]. How namespaces are created wasn't covered here.
- **Tokens.** `api_token`, and `account_token` (requires "Account API Tokens Write"). Permission IDs come from the `account_api_token_permission_groups_list` / `api_token_permission_groups_list` data sources. The token `value` is a `Sensitive` attribute, so it lands in state.

### Coexisting with wrangler

- Cloudflare's IaC page shows the three-resource Worker setup. It says "you do not have to manage all of these resources in Terraform" and that you can manage the Worker in Terraform while you "seamlessly use Wrangler … for Versions or Deployments" ([docs: Workers IaC](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)).
- Bundling stays outside Terraform (`wrangler deploy --dry-run --outdir`) [docs].
- **DO migrations are applied with deployments.** A first apply that binds a DO "will fail", and the workaround is two applies with parts commented out. For that case the page suggests letting Wrangler handle build and versions [docs]. throng has DO migrations (the `exports` tombstone) and containers, so Terraform should not own versions or deployments [inference].
- **Practical split [inference]:**
  - Terraform/OpenTofu: buckets, lifecycle, D1 database (import the existing ids), Workflow settings if desired, tokens, Access, DNS.
  - wrangler: Worker code, versions and deploys, containers, DO migrations and D1 migrations.
  - Don't put `cloudflare_worker` in Terraform while `wrangler deploy` also sets observability and similar settings. Both tools would write the same settings, and plans would flap. One example is open issue [#7155](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7155): `cloudflare_worker` observability "never persist — perpetual diff".

### Known v5 issues relevant here

- **Lifecycle units.** `max_age` is in seconds: "Condition for lifecycle transitions to apply after an object reaches an age in seconds" ([registry doc](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket_lifecycle)). Users who set days saw "0 days" in the dashboard ([#6135](https://github.com/cloudflare/terraform-provider-cloudflare/issues/6135)). 30 days is `2592000`.
- **Lifecycle plan noise.** [#7338](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7338) (v5.24.0) showed an empty `delete_objects_transition = { condition = {} }` on every plan. It was closed 2026-08-25 after the reporter said it "just stopped reproducing", with no linked fix.
- **Perpetual diffs** are still open on several v5 resources: `cloudflare_worker` [#7099](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7099) and [#7155](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7155), and `account_member`, `notification_policy` and others. There are also schema/state mismatches, for example [#7309](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7309) (`workers_script` `worker_loader` binding) and [#7383](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7383). The provider ships weekly-to-biweekly (v5.24 to v5.27 between 2026-08-24 and 2026-10-03), so pin the version [issue; source].

### State backend and CI

- **R2 as an S3 backend.** Cloudflare documents a `backend "s3"` block with these settings ([docs: remote backend](https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/)):
  - `region = "auto"`
  - `skip_credentials_validation`, `skip_metadata_api_check`, `skip_region_validation`, `skip_requesting_account_id`, `skip_s3_checksum`
  - `use_path_style = true`
  - `endpoints = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }`

  It recommends an R2 token scoped to the state bucket with Object Read & Write. Its snippets are labelled v4 and it doesn't mention locking.

- **Locking.** `use_lockfile = true` uses S3 conditional writes (`If-None-Match`). It went GA in [Terraform 1.11.0](https://github.com/hashicorp/terraform/blob/v1.11/CHANGELOG.md), which also deprecated DynamoDB locking, and is the preferred mechanism in [OpenTofu](https://opentofu.org/docs/language/settings/backends/s3/) (release notes for v1.10.0). R2 PutObject supports `If-None-Match` ([docs: R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)). I did **not** find a Cloudflare doc confirming `use_lockfile` works against R2; test it. throng's `concurrency: deploy` group already serialises applies, which makes locking less important [inference].
- **Alternatives.** Use HCP Terraform, or keep the state file in GitHub Actions artifacts (not recommended: there's no locking and artifacts expire) [inference]. OpenTofu's client-side state encryption is a reason to prefer it if state holds token values [inference; not re-verified for this note].
- **CI wiring [inference].** Add an `infra` job (`setup-opentofu`/`setup-terraform`, `init`, `plan`, `apply`) ahead of `deploy` in `deploy.yml`, with `plan` on PRs. Secrets per environment: the Cloudflare token for the provider, plus an R2 access key id and secret for the backend (an R2 S3 key pair can be limited to one bucket at Object Read & Write, per [docs: R2 tokens](https://developers.cloudflare.com/r2/api/tokens/)). That's two or three new secrets per environment.
- **Bootstrap [inference].** The state bucket and its key pair have to exist before the first `init`, so they're created by hand or by a local first apply. If Terraform manages tokens, its token needs "Account API Tokens Write". That token can mint any token in the account, so it is more privileged than anything throng holds today. Keep it out of the `ci` environment, or create token resources only from a manual run.

## 4. Pulumi and Alchemy (brief)

- **Pulumi.** [`pulumi-cloudflare`](https://github.com/pulumi/pulumi-cloudflare) v6.22.0 is generated with `pulumi-terraform-bridge` v3.140.0, and its release note says "Upgrade terraform-provider-cloudflare to v5.27.0" [source]. So it has the **same coverage and the same v5 bugs as Option 3**, written in TypeScript. State goes in Pulumi Cloud or a DIY backend. The S3 backend takes `endpoint` and `s3ForcePathStyle` query params, so R2 works, with file-based locking on by default ([docs: DIY backend](https://www.pulumi.com/docs/iac/operations/stack-management/using-a-diy-backend/)). DIY backends are "fundamentally limited by the non-transactional protocols of blob storage" ([docs: state](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)). It adds nothing over Terraform for throng except TS syntax [inference].
- **Alchemy.** The npm `latest` tag is **`2.0.0-beta.81`** (2026-10-05). The last non-beta is `0.94.0` (2026-08-01) [npm]. v2 is a rewrite described as "Infrastructure-as-Effects … a single, type-safe [Effect](https://effect.website) program" ([README](https://github.com/alchemy-run/alchemy)).
  - It covers more Cloudflare Workers resources than Terraform. `Cloudflare.R2.Bucket` takes `lifecycleRules` and `cors` directly, but "omit to clear all lifecycle rules" [source: `R2/Bucket.ts`]. It also has D1 `ApplyMigrations`, Containers and Workflows modules, and an `examples/cloudflare-git-artifacts` example.
  - State options: local, Postgres, HTTP, or a Cloudflare Durable Object-backed `StateStore` [source].
  - Adopting it means replacing wrangler deploys and taking on Effect, and the API is still beta and churning (beta.79 to beta.81 in under three weeks). It is not a fit for throng now [inference].

## 5. Tokens and least privilege

- **Today.** One account token with edit on six products deploys both environments. In `e2e.yml` it is also handed to the `throng-ci` Worker as `CF_PREVIEW_TOKEN`, which lets the Worker upload Previews.
- **Option 2** adds no new token and needs only the R2 write permission the README already lists.
- **Option 3's real least-privilege benefit** would be minting narrow tokens as code: a deploy token, a Preview-only token, an R2-only token. But it needs a more privileged bootstrap token to do that (§3) [inference].
- That trade is worth making once there is more than one token to manage. #186's Worker-creating credential, which "never reaches a container", is a likely second one. That's part of the move trigger.

## 6. Runtime-created resources (#186)

#186 has the platform create a `p<projectId>` Worker per project, and delete it, when projects are created or deleted ("idempotent, safe to retry"). The credential stays in the platform Worker's env.

- **Neither option covers this.** Both run at deploy time in CI. Per-project Workers are application data with the same lifecycle as a D1 row, created by the Worker calling the Workers Scripts API [inference].
- **Terraform would be actively wrong for it.** One state entry per project would mean running `apply` from the request path, or reconciling projects in CI, and drift would appear every time a project is created [inference].
- **What IaC _can_ own for #186:** the scoped token the platform uses to create Workers (Option 3, `cloudflare_account_token`), and any account-level limits or settings. For the per-project Workers themselves, the source of truth is throng's D1 plus idempotent API calls [inference].

## What I couldn't verify

- Whether the R2 lifecycle API rejects a duplicate rule `id` (relevant to re-running `lifecycle add`).
- The exact `id` of R2's default multipart-abort rule.
- That Terraform/OpenTofu `use_lockfile` works against R2 in practice. The conditional-write header support is documented, but an end-to-end test isn't.
- Whether any Cloudflare API or Terraform resource creates an Artifacts namespace or a container application on its own.
- How auto-provisioning behaves with `vite build`'s redirected config (`dist/throng/wrangler.json`). The code skips writeback for bindings missing from the user config, but I didn't run a deploy.
