# throng (platform)

The platform Worker: the API, the git-facing repos in Artifacts, and checks.

## Entrypoints

- **Default export**: the public hostname. Agents and git use Throng tokens; humans can use an Access JWT on `/api/me` and `/api/tokens`. Any request carrying `X-Throng-Access-Email` is rejected with a 401.
- **`WebEntrypoint`**: throng-web's `PLATFORM` service binding targets it by name. It serves `/api` and trusts `X-Throng-Access-Email`, which throng-web sets only after verifying the Access JWT itself. Named entrypoints can't be reached from the internet, so this is the only path where the header counts. Deploy the platform before throng-web, so the entrypoint exists when the binding is created.

`src/app.ts` builds both, and exports `AppType` for throng-web's typed `hc` client.

## Agents and MCP clients

Agents read `GET /llms.txt` first (`src/llms.ts`): what Throng is, getting a token, the MCP URL, git remotes and auth, the agent loop step by step, and a link to the OpenAPI document at `/api/openapi.json`. It's public and names the host it's served from. The MCP server's `instructions` carry the same loop in short, and `llms.txt` quotes them. A test fails if `llms.txt` doesn't mention every tool `/mcp` lists.

The MCP server is at `/mcp` (`src/mcp.ts`), built on `@modelcontextprotocol/server`: streamable HTTP, stateless, with the Throng token as a bearer header. There is no OAuth discovery, so a client must send the header itself.

**Token.** A human mints one for an alias while signed in, with `POST /api/tokens {"alias": "claude"}`, and keeps it in `THRONG_TOKEN`. The same token works for git, as a bearer header or the HTTP Basic password.

**Git.** Every attempt the API returns carries its `remote`. An agent clones it with:

```sh
git clone -c http.extraHeader="Authorization: Bearer $THRONG_TOKEN" <remote>
```

The `-c` comes after `clone`, so git writes the header into the new repo's config and a plain `git push` sends it too; `git -c … clone` would use it for the clone only.

**Claude Code:**

```sh
claude mcp add --transport http throng https://<host>/mcp --header "Authorization: Bearer $THRONG_TOKEN"
```

**Other clients** that take a JSON config, in the `mcpServers` shape Claude Code's `.mcp.json` uses:

```json
{
  "mcpServers": {
    "throng": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${THRONG_TOKEN}" }
    }
  }
}
```

Clients differ in the details: some omit `type` or call it `streamable-http`, and not all expand `${THRONG_TOKEN}` from the environment, so some need the token written in.

## Runs

Every run on a project, on every line, is in the project Durable Object's `pipeline_runs` table, migrated scoring runs included. At most `SCORING_CAP` runs hold a Sandbox at once across the project: a `main` run first (a landing is one), then follows, then task-branch and attempt runs oldest first; a waiting run holds none. One run per line runs at a time, so landings and the deploys after them happen one after another. A newer head on an attempt or task branch cancels the line's queued or running run; on `main` it replaces only a queued run, and the running one, which may be deploying, runs to its end. A landing is never replaced: only its merge request leaving the queue (a new push or a cancel) cancels it, and only before its `land` step claims the push. A landing is trusted when the owner, as themselves and not under an alias, approved its merge request. A merge request no owner approved whose `main` pipeline names a secret, as `main`'s config is when its head passes, is held before it joins the queue: its landing is a `waiting` `main` run until the owner starts it, which queues the merge request with that run, trusted, as its landing in its turn. One whose secrets only its merged tree's config names is held at its landing's plan: the merge request leaves the queue for `pending`, and the landing waits for the owner the same way. `GET /api/projects/{owner}/{project}/runs` lists them newest first, with each one's line, pipeline, trigger, head, status, gate and who triggered it. `line` filters to one line, `main`, or `tasks` (every line but `main`); `status` to one status (`waiting` lists the runs waiting for the owner). Pages are cursor-paged by run id: a page's `next` is the next page's `cursor`, so a run queued meanwhile never shifts one. `GET …/runs/{runId}` adds the run's outcome: its steps in run order, each with its kind, group, `after`, outcome, duration, notes and log name, and its metrics. `POST …/runs/{runId}/cancel` is the owner's, aliases included, and only while the run is `cancellable`: queued, waiting, or running on any line but `main`, which may be deploying, and never a landing. A waiting run's `waiting` gives the head it would run (a held landing's approved head), the attempt that head is on, the secrets it would hold, and, when a task check someone other than the owner wrote is why a run of the owner's push waits, that check and who wrote it (`taskCheck`), which the web app shows as "Task check lint was written by ada". `POST …/runs/{runId}/start` with that head as `sha` is the owner's acting as themselves, never under an alias: it re-checks each secret the run names, as `main`'s config is now, against the settings (a landing's plan checks again against its merged tree's config), refuses a head the run doesn't wait on or a line (or merge request) that moved on since, and queues the run again, trusted and triggered `start`, with a new Workflow instance. The web app lists waiting runs as "Waiting for you" with Start on the project home and the Runs tab, and a task's as "Waiting for the owner" on its page. The MCP tools `list_runs`, `get_run`, `get_log` (by run and step) and `wait_for_run` read the same; `wait_for_run` holds until the run is done or waiting, with the same per-user cap as `wait_for_attempt`. There is no MCP tool to cancel or start a run.

### Upgrade notes

The project Durable Object doesn't know its owner when it migrates, so what it migrates starts untrusted. A head pushed before the deploy isn't the owner's push: an attempt's run of it waits for the owner if its pipeline names a secret, until the next push. A merge request approved before the deploy isn't the owner's approval: its landing is held for the owner in the same case, until the owner starts it or approves it again.

### How a run runs

Every ref move requests a run on its line: a push to an attempt's fork (`t42a3`) or to a task branch (`t42`) runs `default`. A merge request's landing is the `main` run of what it lands: `merge` (`git merge-tree` in an untrusted container with read grants on the origin and the fork; a conflict ends the run there, the conflict kept in its outcome), the setups and checks on the merged tree under the merged tree's config, `land` (the trusted push, as the approver, with a lease on `main`; a moved `main` ends the run `errored`), then `main`'s post-gate steps on the landed commit. Until `land` the run has no head; then the landed sha is its head and `main`'s, so the ref move it made asks for no other run. A conflict, a failed gate or an error dequeues the merge request with `{ reason, run }`; `GET …/tasks/{t}/merge-request/dequeue` reads the details (the conflict's hunks, the failed steps, or the error) from that run. The pipeline comes from the line, never the tree. `PipelineWorkflow` (`src/pipeline-workflow.ts`) runs it in fixed stages, under the config and `.npmrc` it reads from one commit of the origin's `main`:

```yaml
setup: # in order, in one container; a failed setup stops the run
  - { name: deps, command: npm ci }
checks: # in parallel, each in its own container; every one that runs must pass
  - { name: lint, command: npm run lint, group: verify } # at most one group
  - { name: test, command: npm test, group: verify }
  - { name: build, command: npm run build, after: [lint, test] } # one check or a list
pipelines:
  main:
    groups: [verify] # main runs only these groups' checks; default names none, so it runs every check
    secrets: [CLOUDFLARE_PROD] # added to every step's own; never reaches the setups or checks
    steps: # in order, once the gate passes
      - { name: deploy, command: npm run deploy, secrets: [SENTRY_TOKEN] }
```

1. **Setups.** One container, `<instance>/setup`, fetches the head, records the diff from the attempt's base (`_diff`), and runs the setups in order. When they all pass it is snapshotted (`snapshotContainer`), its logs are stored, and it stops.
2. **Checks.** Each check runs in its own container, `<instance>/check:<name>`, started from that snapshot, all in parallel, except that a check waits until every check it names in `after` has passed. A check whose wait didn't pass is `skipped`, saying which check it waited for. A failed restore is retried once; then the container starts from the image and runs the setups again first, noting it on the check. There are no snapshots under `wrangler dev`, so there every check's container runs the setups itself.

3. **Post-gate steps.** Once the gate passes, `main`'s `steps` run in order, each in its own container, `<instance>/step:<name>`, started from the snapshot the same way, stopping at the first that doesn't pass. Every step after it, or every step when the gate failed, is `skipped`, saying why. The gate is the setups' and checks' alone. A step's container is readied (restored, or the setups re-run) in one Workflow step that retries like any other; its command then runs in the next, which never retries, so a deploy never runs twice by itself: an infrastructure error once the command started ends the run `errored`. A readied container lost before its command started (the command runs only in a running container, never in one started afresh) is readied again, and its command run, in new Workflow steps, up to two more times.

`after` names checks only: naming a setup, an unknown check or the check itself, or making a circle, is a config error. A task's checks take `after` too, and may wait for the project's checks; a project's check can't wait for a task's, which only some attempts have. Setups, checks, post-gate steps and metrics share one set of names.

A check is in at most one `group`. A pipeline that lists `groups` runs only the checks in them, and one that lists none runs every check, so adding a check with no group never changes what `main` runs. A task's checks take no group, and always run on its attempts. Only `default` and `main` exist, and only `main` has steps. A pipeline's `secrets` are added to each of its steps' own, so they reach only its steps; naming them on a pipeline with no steps (`default` always) is a config error. Config errors: `groups` on a check, a group on a setup or step, an empty `groups` or one no check is in, a check a pipeline runs waiting for one it doesn't, an unknown pipeline, and `skip`.

Every container gets one read grant on its line's repo (the attempt's fork, or the origin for a task branch or `main`), fetching its branches and `refs/tasks/*`, and no write grant, reaches only `main`'s `network.allow` and `.npmrc` registries, and gets `THRONG_PROJECT`, `THRONG_PIPELINE`, `THRONG_LINE`, `THRONG_SHA` and `THRONG_RUN`. A landing's setups and checks run before it has landed, so their `THRONG_SHA` is the merge commit their containers make of `main` and the approved head: Throng commits it the same way in each (at the landing's start time), so its sha is the same everywhere, but it's never pushed, and the commit `land` pushes later has another sha. Its post-gate steps get the landed sha. A Workflow step that retries starts its container afresh, never on what a failed try left. Before starting any, the Workflow tells the project Durable Object every container its plan may start. When the run ends, or a newer head cancels it (the Workflow is terminated), every one of them is destroyed and the snapshot released. Containers can't delete a snapshot yet: Cloudflare deletes it 30 days after it was taken or last restored. Each step's outcome, duration, notes and log go to the Durable Object as the run's outcome, from which scoring takes the attempt's score and verdict.

### Caches

A cache keeps paths, such as a dependency store, between runs (`src/caches.ts`). `.throng/config.yml` names each with the paths it keeps (`~/…` or absolute, outside `/workspace`) and the files in the tree that key it (paths or globs, `*`, `?` and `**`); setups, checks and post-gate steps list the ones they use, and a task's checks may list those `main` defines. An unknown name is a config error.

```yaml
caches:
  # pnpm needs its metadata cache too: a store alone fails `pnpm install --offline` with ERR_PNPM_NO_OFFLINE_META.
  pnpm: { path: [~/.local/share/pnpm/store, ~/.cache/pnpm], key: pnpm-lock.yaml }
setup:
  - { name: deps, command: pnpm install --frozen-lockfile --prefer-offline, caches: [pnpm] }
```

- **Key.** Before any container starts, the Workflow reads the head's git tree and hashes, per cache, its name, its paths, each key entry's blob id (a glob's matches in sorted order; `absent` for an entry nothing matches) and the Sandbox image, so a new image never restores an old image's entry.
- **Restore.** By exact key hash only, never a near match. An attempt (`t42a3`) reads `main`'s entries; a task branch (`t42`) reads its own, then `main`'s; `main` reads its own. A container restores what it uses before its command: the setup container the setups' caches; a check's or step's container its own others, as the setups' are already in the snapshot it starts from (or all of them, when it re-runs the setups). The object is streamed straight from R2 into `zstd -d | tar -x` at `/`.
- **Save.** Only a trusted run saves, only on a task branch or `main` (into its own line's scope), only after the command using the cache passed, and only when the scope has no entry for that key: the first save wins, and entries are never written over. The run reserves the key with the project before it uploads, so two runs never write one object; a failed save lets the key go, and a reservation whose run never finished goes after an hour. Attempt runs never save, task checks included. Each cache is saved from one container of a run: the setup container's when a setup uses it, else the first check's in the plan that does, else the first post-gate step's. The container's `tar | zstd -3` is streamed from its stdout into an R2 multipart upload (16 MiB parts, two in flight); one over 2 GB is dropped.
- **Notes.** A cache never fails a run. Each step that uses one notes a hit (with the entry's size and the restore time) or a miss and why, and a save (with size and time) or why it wasn't saved; a failed restore removes what it half-extracted and the step runs without the cache. The setups' notes go on the first setup using each cache.
- **Storage.** Entries are `caches/<projectId>/<scope>/<name>/<keyHash>.tar.zst` in the `CACHES` R2 bucket (`throng-caches`, and `throng-ci-caches` for `ci`), indexed in the project Durable Object's `cache_entries` table (scope, name, key hash, size, created, last used). The deploy and E2E workflows create the bucket when it's missing.
- **Eviction** (`src/cache-index.ts`), after every store call and on the Durable Object's alarm: an entry restored by no run for 7 days is deleted, except `main`'s latest of each cache; while a project's entries are over 10 GB, the least recently used go first, task branches' before `main`'s; and a task branch's entries go when its task closes or goes obsolete.
- **Secrets.** Whatever a trusted run leaves in a cache's paths is restored into later runs, attempts' included. Never keep a token in a cache's path (a `~/.npmrc`, say).

## Scoring logs

Each pipeline run copies the log of every setup and check to the `LOGS` R2 bucket at `logs/<projectId>/<line>/<runId>/<name>.log` (`src/logs.ts`); runs from before runs were keyed on their line keep theirs at `logs/<projectId>/<t42a3>/<sha>/<runId>/<name>.log` until they expire. The nth setup's log is named `setup.<n>` and a check's is its name; check names can't contain a dot, so they never collide. Logs over 5 MB keep their head and tail with a `[throng: truncated …]` marker between them. The run's result lists the logs it stored, and `GET /api/projects/{owner}/{project}/runs/{runId}/logs/{step}` streams one as text, or answers `notFound` once it's missing or expired.

There's one bucket per environment: `throng-logs`, and `throng-ci-logs` for `ci`. Logs are deleted after 30 days by an R2 lifecycle rule. Wrangler's config can't declare lifecycle rules, so they live in `r2-lifecycle.json`, which CI applies before each deploy (see the setup below).

## Sandbox size

Each role of a run gets its own containers (`src/grants.ts`). The ones that run the repository's code, a pipeline run's (a landing's `merge`, setups and checks included), start at the size the project's `.throng/config.yml` sets:

```yaml
sandbox:
  size: standard-1 # lite | standard-1 | standard-2 | standard-3 | standard-4
```

The sizes are Cloudflare's named instance types, which `RunSandbox` passes to `start({ instance })` (`src/sandbox.ts`). `SANDBOX_RESOURCES` in `src/config.ts` gives each one's memory and vCPU, and `/llms.txt` lists them. When `sandbox.size` is absent, or `main`'s config is missing or invalid, it is `standard-1`. A task's checks and metrics never change it: when they clash with `main`'s config, the run's merged config is invalid, but it still starts at the size `main` sets. Any other value is a config error. The trusted `land` and `follow` containers only run git and always start at `lite`.

The size is read from the origin's `main`, like the rest of the config, never from the attempt's head, so an attempt can't raise its own size; a change applies once it lands. A run takes it from the config it loads from `main`; a landing reads `main`'s config before its `merge` starts, never the merged tree's. A container that is already running keeps its size, and the next one to start takes the current config's. Every stored log a step wrote notes its size under `== throng ==` (`sandbox: standard-1`). Logs are read back at `lite`: the container that wrote them is still running and keeps its size, and one that was lost needs no more to find its log missing.

The default is larger than `lite` (see `SANDBOX_RESOURCES`), so each scoring run costs more than it did when every container was `lite`. Wrangler's `containers` entry sets no `instance_type`: under the `durable_object` scheduling policy, the size is chosen at each `start()`, and `max_instances` caps how many containers run at once, whatever their size.

## Previews

Throng deploys nothing. A preview is an ordinary check the project writes, deploying with the owner's own secret into the owner's own account; it writes its URL to a file in `$THRONG_OUTPUT`, and the config declares a `url` metric from it, which the web app shows as a link like any other `url` metric:

```yaml
network:
  allow: [api.cloudflare.com]
checks:
  - name: preview
    command: pnpm deploy:preview # writes {"url": "https://..."} to $THRONG_OUTPUT/out.json
metrics:
  - { name: preview_url, from: preview.out.url, type: string, format: url }
```

A config with the old `preview:` section is invalid. `api.cloudflare.com` is a host like any other: a container reaches it only when `main`'s `network.allow` lists it, and the proxy adds no credentials.

## Network access

A container has no internet (`enableInternet: false`). Only HTTPS on the default port to the hosts its access lists leaves it, through the `OutboundAuth` proxy (`src/network.ts`); the access is fixed when the container starts. Beyond its git grants, the containers that run repository code (a pipeline run's, a landing's setups and checks included) may reach:

- **Registries**, for installs: `registry.npmjs.org` and every `registry=` and `@scope:registry=` host in the `.npmrc` on the origin's `main`, if it's an `https:` URL on the default port with a DNS hostname (no IP literal, trailing dot or single label such as `localhost`). Other lines, auth lines included, are ignored. Registries take `GET` and `HEAD` only, so nothing can publish or log in.
- **`network.allow`** in `.throng/config.yml`: any method.

A registry stays `GET`/`HEAD`-only even when `network.allow` lists its host too: the read-only rule wins, so listing a registry can't open it to publishing. A project that needs to write to such a host has to do it outside Throng. Requests to either kind pass through unchanged: the proxy adds no credentials (private registry credentials are #66). Neither can widen a granted repo's host.

Both are read from the origin's `main`, never from the attempt, so an attempt can't widen its own access. A scoring run or a landing pins `main`'s commit once and reads `.throng/config.yml` and `.npmrc` at it, so the two always agree. A landing reads them from `main` too, so its setups and checks get the registries and `network.allow` `main` has, never the merged tree's. A missing `.npmrc` adds no registries; a read that fails is retried like the config's, and the run or landing ends `errored` if it keeps failing.

## Secrets

A project's secrets (`src/secrets.ts`) are a name, a write-only value and the pipelines each may be used in (`default`, `main`, or both). They live in the project Durable Object's SQLite, in a `secrets` table the D1 projection never reads.

- **Sealing.** Each value is encrypted with AES-256-GCM through Web Crypto, with a random 12-byte IV and `projectId/name/keyId` as additional data, so a row can't be moved to another project, name or key. The keys come from the `SECRETS_KEYRING` Worker secret, imported non-extractable on first use: `{"current": "k1", "keys": {"k1": "<32 bytes, base64>"}}`. New values are sealed under `current`; each row keeps the id of its key.
- **Rotating the key.** Add a new key and make it `current`, keeping the old one listed: old rows still open, and new writes use the new key. Remove the old key only once no row names it (re-sealing old rows by a sweep isn't built yet).
- **Who acts.** `GET /api/projects/{owner}/{project}/secrets` and the MCP tool `list_secrets` give names, pipelines and last change to the project's maintainers, aliases included (for now, the owner). `PUT …/secrets/{name}` (value and/or pipelines) and `DELETE …/secrets/{name}` take the owner acting as themselves, never an alias. Values are 8 characters at least. No route ever returns one.
- **Journal.** Every write is journaled (`secretSet`, `secretDeleted`) with the actor, the name and the pipelines, never the value.
- **Naming them.** A setup, a project check or a post-gate step names the secrets it uses: `secrets: [NPM_TOKEN]`. `pipelines.main.secrets` adds to each of `main`'s post-gate steps' own, and never reaches a setup or check. A task's check can't: tasks aren't reviewed like `main`'s config. The list route and `list_secrets` also give `uses`: where `main`'s config names each secret, whether it has a value, and the pipelines it isn't allowed in (every setup and check runs in every pipeline; a post-gate step only in `main`). The settings page shows them, and flags names with no value.
- **Trust.** A run is trusted when the owner pushed its head, as themselves or under an alias (`pipeline_heads.owners_push`, recorded with each push; a rescore or score-now keeps what the head's push recorded; a follow's merge is no one's push). A landing is trusted when the owner approved it. A run of the owner's push is trusted only if the owner also wrote every task check it runs: a task's checks run from the setups' snapshot, so a check someone else wrote could read what a setup left behind, such as a token in `~/.npmrc`. Each task records who wrote each of its checks (`tasks.check_writers`): whoever created the task or last changed that check in an edit, the owner under an alias counting as the owner, as for a push; a check an edit leaves unchanged keeps its writer, and one saved before writers were is taken as the task creator's. The run's Workflow reads its task's checks from the Durable Object (`runDefinitions`), which, if someone else wrote one, takes the run's trust there and then, recording that check and its writer (`pipeline_runs.task_check`). A run the owner started stays trusted whoever wrote its task's checks: Start is the owner's review. Only a trusted run's containers get secrets, so `main`'s post-gate steps get theirs only from a push or merge by the owner. An untrusted run whose setups, checks and post-gate steps name none runs as normal. Any other untrusted run that names one is `waiting`, holds no slot, and its Workflow ends having started nothing, until the owner starts it as themselves (`POST …/runs/{runId}/start`), which trusts it; a newer push replaces it, and the new run waits again. A merge request no owner approved whose `main` names one is held the same way before it joins the queue; a landing whose secrets only its merged tree names is refused, and so dequeued.
- **Delivery.** Before starting any container, the Workflow's plan step names, by step, the secrets the run's setups, checks and post-gate steps name. The Durable Object refuses the run, naming the step and secret (`check test: secret CLOUDFLARE_PROD isn't allowed in the default pipeline by the project settings`), when one has no value or isn't allowed in the run's pipeline, and hands an untrusted run naming any to the owner. In a trusted run, each step that starts a container loads the sealed values it needs from the Durable Object as the settings are then, opens them with `SECRETS_KEYRING` and puts them straight into the container's env: the setup container holds every setup's secrets, a check's container its own (and the setups' when it re-runs them). A post-gate step's are loaded only as its command starts, in the Workflow step that never retries, and given to that command alone: the step that readies its container (and retries) holds none but the setups' when it re-runs them. One that's gone or no longer allowed by then fails that setup, check or post-gate step, `errored`, naming it (a post-gate step's failure skips the rest); a replaced value applies from the next step. Workflow params and step results carry names only.
- **Masking.** Each value, its base64 (with or without padding) and its URL encoding are replaced with `***` in the logs a step stores, its metric values and the errors it ends with. A check's or post-gate step's step masks the setups' secrets too, as the snapshot its container starts from may hold them, though only a container that re-runs the setups holds them in its env. Masking is a courtesy: trust is what keeps a value from anyone else's code.
- **Snapshots.** Whatever a setup writes to disk, such as a token in `~/.npmrc`, is in the snapshot the run's checks start from, so every check of a trusted run can read it, and Cloudflare keeps the snapshot until 30 days after its last restore. A setup that writes a secret to disk should remove it before it ends.

Make a keyring with `node -e 'console.log(JSON.stringify({current:"k1",keys:{k1:require("crypto").randomBytes(32).toString("base64")}}))'` and set it once for production with `pnpm wrangler secret put SECRETS_KEYRING` before the first deploy that requires it. The E2E workflow makes a fresh one for `throng-ci` on every run. `wrangler.jsonc` lists it under `secrets.required` in both environments, so a deploy without it fails: the Deploy workflow checks for it first and stops, naming it, before it migrates or deploys anything.

Before #257, previews were deployed with Throng's own Cloudflare token, held by the Worker as `CF_PREVIEW_TOKEN` (with `CF_ACCOUNT_ID` beside it). Nothing reads either now, and a deploy never deletes a secret, so each stays on a Worker until someone deletes it. Production's are deleted by hand, as #265's manual step: `pnpm wrangler secret delete CF_PREVIEW_TOKEN` (and `CF_ACCOUNT_ID`, if it's there). `throng-ci`'s are deleted the same way, with `--env ci`.

## E2E job

The **E2E** workflow (`.github/workflows/e2e.yml`) runs `pnpm e2e` against real Artifacts. It deploys the `ci` environment in `wrangler.jsonc`: the `throng-ci` Worker, Artifacts namespace `throng-ci` and D1 database `throng-ci`. It also deploys throng-web's `ci` environment, `throng-web-ci`, bound to `throng-ci`, for the `arena` scenario. It never runs on pull requests or forks, only when started by hand on `gregjoeval/throng`. Runs queue rather than overlap.

Each run:

1. Generates a random `E2E_TOKEN`.
2. Applies D1 migrations to `throng-ci`.
3. Builds with `CLOUDFLARE_ENV=ci` and deploys `throng-ci`, setting `E2E_TOKEN` and a fresh `SECRETS_KEYRING`.
4. Builds and deploys `throng-web-ci` the same way, installs Playwright's Chromium, and waits for `throng-web-ci` to answer.
5. Runs the e2e scenarios. Every project id starts with `e2eci<run id>r<attempt>p`. Each scenario deletes what its projects made, and the suite revokes its Throng tokens when it ends.
6. Always deletes everything under that prefix with `pnpm e2e cleanup`, even when the suite fails or is cancelled: each project's D1 row, its Durable Object's storage, its logs in R2 and its repos.

The suite reaches the Worker through its e2e routes, `/e2e/*`, behind the `E2E_TOKEN` bearer secret. They refuse any project or repo whose id doesn't start with `e2e`, so they can't reach a real project, and `E2E_PROJECT_PREFIX` must start with `e2e` too.

### Running it

Go to **Actions → E2E → Run workflow** on `main` (or a branch, to test it before merging). Leave **scenarios** empty to run them all, or name some, such as `zeroconfig conflict`. From a terminal:

```bash
gh workflow run e2e.yml -f scenarios="zeroconfig"
gh workflow run e2e.yml --ref my-branch     # every scenario, against a branch
```

### Scenarios

- `zeroconfig`, `conflict`, `needsreview`: the merge queue. These make real projects (with task rows) owned by an e2e user, `e2e@throng.invalid`, through `POST /e2e/projects/:project`, then drive them only through `/api` and the git proxy with that user's Throng token (`POST /e2e/token`). The fixture is the one push that goes around the proxy, since the proxy refuses pushes to the origin's `main`.
  - `zeroconfig`: a project with no `.throng/config.yml`. Selecting `t1a1` closes `t1a2`, and the merge request lands as a merge commit whose parents are the old `main` and the approved head, with the `Throng-Task`, `Throng-Attempt`, `Throng-Merge-Request` and `Approved-by` trailers, in `main`'s one run, whose steps are `merge` and `land` and whose head is the landed sha. It also checks custom refs after landing: both attempts are archived under `refs/attempts/` in the origin.
  - `conflict`: two tasks whose attempts edit the same line. `t1`'s merge request lands, and `t2`'s is dequeued with reason `conflict`, naming its landing's run, which ended at `merge` and keeps the expected three-way hunk. Its author merges `main` and pushes, which moves it to `needsReview`. Once approved, it lands.
  - `needsreview`: a slow check keeps the landing in its checks on the merged tree. Its scoring log notes the default Sandbox size, `standard-1`, as the config sets none, and the project's runs list its run on the attempt's line, whose page has the check as a step with that log. A push to the source while it's queued or landing dequeues it with `newPush` to `needsReview`. Once the new head passes, it still doesn't requeue on its own.
- `mcp`: the agent loop through `/mcp` (with the MCP SDK's client) and git only, on a real project with no config (`agentLoop` in `scripts/e2e-mcp.ts`, which `test/mcp.test.ts` also runs in process). Both agents' tokens are minted under an alias (`POST /e2e/token?alias=claude`), so the loop runs as `user (alias)` and checks the attempt and the verdict record it. The e2e user's agent calls `whoami`, `create_task` and `start_attempts count=2`, clones `t1a1`'s `remote` with the recipe above (through `sh`, with the token in `THRONG_TOKEN`), pushes with no auth of its own, `update_attempt state=open`, waits with `wait_for_attempt until=scored` and checks the result with `get_attempt`, then finds the run with `list_runs`, waits on it with `wait_for_run` and reads it with `get_run`. A second e2e user, `e2e-reviewer@throng.invalid` (`POST /e2e/token?as=reviewer&alias=codex`), posts a `merge` verdict. The first selects `t1a1` and waits with `until=mergeRequestChanged` until it merges.
- `arena`: the attempt arena in a browser. Like `zeroconfig`, it makes a real project as the e2e user, with task `t1` and two attempts: `t1a1` edits `src/greeting.js`, and `t1a2` edits it and `src/index.js`. Once both are scored, Playwright's Chromium opens `t1` on `throng-web-ci` (`THRONG_WEB_URL`) and checks that:
  1. the arena shows lanes `t1a1` and `t1a2`, each with its own files, and each compared against its base (`main`, since the task has no branch);
  2. **By file** lists `src/greeting.js` (changed by 2 of 2) and then `src/index.js` (changed by 1 of 2, which `t1a1` left alone);
  3. **Select** on `t1a1`'s lane, confirmed, opens the merge request view, and once it lands the page shows the task closed, with `t1a1` merged in the merge commit the API reports. `t1a2` is closed.

  The e2e user has no Access session, so throng-web can't forward the page's API calls. Instead the browser sends each `/api/*` request to `THRONG_URL` with the e2e user's Throng token (`scripts/e2e-browser.ts`). Everything else is the deployed UI; only throng-web's Access check and forwarding are skipped, and those have unit tests in `apps/web`. For the same reason `throng-web-ci` must not be behind a Cloudflare Access application: the workflow fails at **Wait for throng-web-ci** if it is.

- `caches`: on a real project, through `/api`. An attempt lands; the trusted `main` run of the landing saves a cache its setup fills (`cache stamp: saved for main` in the setup's notes). The next task's attempt, forked from that `main`, restores it (a hit in its setup's notes), saves nothing, and its check prints the stamp `main`'s run wrote.
- `pipeline`: on a real project, through `/api`. Its config has two setups and three checks: `test` waits for `lint` with `after`, both in the `verify` group `main` runs, and `extra` is in a group `main` doesn't run. `main` has a post-gate step, `deploy`, naming a secret the owner sets allowed only in `main`. The owner opens an attempt, which runs every check with `test` after `lint`, then selects and lands it. The landing's `main` run's steps are `merge`, the two setups, `lint` and `test` only, `land`, then `deploy`, whose stored log has the secret's hash and only the mask where its value was; the run's landed sha is `main`'s.
- `waiting`: on a real project, through `/api`. The owner sets a secret allowed in `default` that a check names. A second e2e user (`POST /e2e/token?as=reviewer`) pushes and opens an attempt: its run waits for the owner and holds no slot. Start with a stale sha is refused (409), as are the owner's token under an alias and the second user's (403); the owner's Start at the run's head runs it, and the check prints a hash of the secret. Then the second user creates a task with a check, and the owner pushes and opens an attempt on it: that run waits too, its `waiting.taskCheck` naming the check.
- `metrics`, `failing`, `invalid`, `preview`, `coalesce`, `intrusion`, `deps`: scoring, through the e2e routes' attempts (forks with no task rows); see the header of `scripts/e2e.ts`.
- `taskmetrics`: a task's own metric over a project check, through `/api` on a project with task rows. A clashing name is refused on save; the saved metric is scored with `source: task`; once `main`'s config adds a metric with the task's name, the attempt's next run is `config: invalid`, naming the clash.
- `taskchecks`: a task adds a metric over a project check and a check of its own, through `/api`. Its check runs after the project's with `source: task`, its metrics read both checks, and the gate follows its check: one attempt passes it, the other fails it. Then the task makes its check only report (it exits 0 and writes a metric), and the failing attempt is rescored at the same head with a passing gate.
- `refs`: attempt archives. Closing an attempt pushes its fork's `main` to `refs/attempts/t42a3` in the origin (`ARCHIVE_REF_PREFIX` in `src/archive.ts`), and reopening copies it back. The scenario checks, against real Artifacts, that:
  1. a plain `git push` to a ref under that prefix succeeds and `git ls-remote` lists it;
  2. the Worker's own git client (`src/git-client.ts`, behind `POST /e2e/repos/:name/copy-ref`) copies one origin's `main` into another origin's archive ref, and an archive ref back out again;
  3. both refs are still there after a later push to `main`;
  4. no archive push started a check.

  If step 1 fails because Artifacts rejects or drops custom refs, set `ARCHIVE_REF_PREFIX` to `refs/heads/archive/attempts/` and run the scenario again.

### Setup (once per account)

1. **D1 database.** `throng-ci` exists and its id is in `env.ci.d1_databases` in `wrangler.jsonc`. For a new account, run `pnpm --filter @throng/platform exec wrangler d1 create throng-ci` and replace the id.
2. **API token.** In the Cloudflare dashboard, under **My Profile → API Tokens**, create a token named `Throng CI` for Throng's account with these permissions: Workers Scripts, Containers, D1, Workers R2 Storage and Workers Observability at Edit, plus Account Settings at Read. Both the `ci` and `production` GitHub environments use it. Only the deploy holds it: the deployed Worker gets no Cloudflare credential.
3. **Logs buckets.** Nothing to do by hand. Before each deploy, the deploy and E2E workflows create the environment's bucket (`throng-logs`, `throng-ci-logs`) if it's missing and set its lifecycle rules from `r2-lifecycle.json`: logs under `logs/` expire after 30 days, and R2's default rule aborts incomplete multipart uploads after 7. `lifecycle set` replaces the bucket's whole rule set, so edit the file rather than the dashboard. Check with `pnpm exec wrangler r2 bucket lifecycle list <bucket>`.
4. **GitHub environment.** Under **Settings → Environments**, create an environment named `ci`. Optionally, limit its **Deployment branches** to `main`. Give it two secrets:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id.
5. **Run it once** and check the suite passes and the run's projects and repos are gone afterwards.

To run `arena` from your machine, install Chromium once with `pnpm --filter @throng/platform exec playwright install chromium` and point `THRONG_WEB_URL` at any throng-web, such as `pnpm --filter @throng/web dev` (`http://localhost:5173`). Its own platform binding isn't used, since the browser sends API calls to `THRONG_URL`:

```bash
THRONG_URL=https://throng-ci.<subdomain>.workers.dev E2E_TOKEN=... THRONG_WEB_URL=http://localhost:5173 pnpm e2e arena
```

The first run creates the `throng-ci` Worker, its Workflows (pipeline runs keep the name `throng-ci-scoring`) and its container. `pnpm e2e cleanup` needs `THRONG_URL`, `E2E_TOKEN` and an explicit `E2E_PROJECT_PREFIX`, so it can also clear up after a local run.
