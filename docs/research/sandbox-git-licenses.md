# Sandbox git against Artifacts, and SDK licenses

Research for [#5](https://github.com/gregjoeval/throng/issues/5) (part of map [#3](https://github.com/gregjoeval/throng/issues/3)). Sources read 2026-10-04.

Each finding is tagged:

- **[docs]**: stated in Cloudflare's official documentation.
- **[example]**: shown in official example code, but not stated as a guarantee.
- **[unverified]**: inferred or not covered by any source. The spike must test it.

## Headline

- Yes, a sandbox can clone, fetch, and push to an Artifacts repo over plain git smart HTTP with a repo-scoped token. Cloudflare publishes an example that does exactly this. Nobody has published a test of `git rebase` or `npm test` against Artifacts, but both are ordinary local git and Node operations once the clone exists.
- **Don't put the token inside the sandbox.** The Artifacts example does, but Cloudflare's own Sandbox security docs advise against it. Instead, register an outbound HTTPS intercept for the Artifacts host so the Worker adds `Authorization: Bearer <token>` to requests on their way out of the sandbox.
- **`@cloudflare/sandbox` 1.0.0 was released on 2026-09-30, and it changes the model.** The package no longer provides `getSandbox()` or a `Sandbox` Durable Object. You write the Durable Object yourself and call `this.ctx.container.start()` / `exec()` directly. `gitCheckout()`, `setEnvVars()`, `keepAlive` and `WarmPool` are gone. The Artifacts example still targets 0.12 (`#v0` template).
- **Images are fixed at deploy time.** With the `durable_object` scheduling policy (the one Sandbox uses), `start({ image })` accepts only `cloudflare/debian-trixie` or a named image from `ctx.container.images`. That map is built from wrangler config at deploy time and holds at most 100 entries. A later `.throng/checks.yml` can only pick from an allowlist we deploy. It cannot name an arbitrary registry image.
- **Licenses:** `@cloudflare/sandbox` is **Apache-2.0** and `agents` is **MIT**. Both can be used by an MIT- or Apache-licensed project. **Note: this repo's `LICENSE` is currently Apache-2.0, not MIT**, so check which license the submission should carry.

## 1. Sandbox ↔ Artifacts git

### Git access to Artifacts

- Every repo has a git smart-HTTP remote at `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. Use the exact `remote` string that the binding or REST API returns. **[docs]** [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- Auth uses repo-scoped tokens, not Cloudflare API tokens. A `read` token allows clone, fetch and pull. A `write` token also allows push. **[docs]** [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
- Token format: `art_v1_<40 hex>?expires=<unix_seconds>`. There are two ways to send it:
  - Send the full string with `git -c http.extraHeader="Authorization: Bearer $TOKEN"`. The docs recommend this form.
  - Put only the secret (the part before `?expires=`) in the password slot of the URL, `https://x:<secret>@…`. The username is ignored. **[docs]** [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- Minting a token from the binding: `repo.createToken(scope = "write", ttlSeconds)` returns `{ plaintext, expiresAt, … }`. `create()` returns a write `token` directly, and `fork()` returns the new repo's `remote`. **[docs]** [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- Protocol support:
  - Clone and fetch support git protocol v1 and v2, including shallow and deepen fetches.
  - Push uses **v1 receive-pack only**.
  - The optional upload-pack capabilities `filter` and `include-tag` are **not supported**, so `--filter=blob:none` partial clones won't work. Sandbox 0.12's `gitCheckout()` used that flag. **[docs]** [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [Replace gitCheckout()](https://developers.cloudflare.com/sandbox/sdk/migrate/outbound-traffic/)
- Limits **[docs]** ([Limits](https://developers.cloudflare.com/artifacts/platform/limits/)):
  - 2,000 git requests per 10 seconds per repo.
  - 1 GB per repo.
  - 32 MB per blob.
- Artifacts entered **open beta on 2026-10-01**. **[docs]** [Changelog](https://developers.cloudflare.com/artifacts/platform/changelog/)

### Official example: Sandbox + Artifacts

[Sandbox SDK + Artifacts](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) ([source, `v0` branch](https://github.com/cloudflare/sandbox-sdk/tree/v0/examples/git-repo-per-sandbox)) **[example]**:

1. The Worker calls `env.ARTIFACTS.create(id)`, or `get(id)` followed by `createToken("write", 3600)`.
2. It builds `https://x:<secret>@<remote>` and calls `sandbox.setEnvVars({ ARTIFACTS_GIT_REMOTE })`.
3. Inside the sandbox, a shell script runs `git clone "$ARTIFACTS_GIT_REMOTE"`, then commit, `git push origin HEAD:<branch>`.
4. The Worker redacts the secret from stdout and stderr.

This example uses `@cloudflare/sandbox@^0.12.10` and the `cloudflare/sandbox:0.12.10` base image, which ships with git. It is the only first-party evidence that clone and push from a sandbox to Artifacts work end to end.

### Passing credentials safely

The Sandbox docs give clear guidance here. **[docs]** [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/):

- Any token placed in a sandbox can be read by all code there. That includes env vars, command arguments, files, and a token-bearing remote URL, which git saves in `.git/config` and which then survives in snapshots. Running `npm test` executes arbitrary dependency code inside the same sandbox.
- Every process has root-equivalent capabilities, so running commands as a separate Linux user protects nothing.
- Recommended pattern: keep the credential in the Worker. Register `ctx.container.interceptOutboundHttps(host, this.ctx.exports.SomeEntrypoint)`. The entrypoint checks each request (method and path) and adds the `Authorization` header before calling `fetch()`.
  - git inside the container must trust `/etc/cloudflare/certs/cloudflare-containers-ca.crt`, for example via `GIT_SSL_CAINFO`.
  - Containers start with `enableInternet: false` by default.
  - **[docs]** [Clone a private repository](https://developers.cloudflare.com/sandbox/network/clone-a-private-repository/), [DO Container API: interceptOutboundHttps](https://developers.cloudflare.com/containers/api/durable-object-container/#interceptoutboundhttps)
- The published gateway example allows only `git-upload-pack` (fetch) for a single GitHub repo. For Throng, the gateway would:
  - also allow `GET …/info/refs?service=git-receive-pack` and `POST …/git-receive-pack` (push), only for the one repo path the job owns;
  - add `Bearer <full token>`.

  **[unverified]** Whether push through an HTTPS intercept to `*.artifacts.cloudflare.net` works. This includes streamed request bodies, receive-pack framing, and a Worker `fetch()` to the Artifacts host.
- Intercepts also accept host globs, for example `*.artifacts.cloudflare.net`. There are 64 hostname targets per container, and an intercept must be registered again for each new container. **[docs]** [Intercept limit](https://developers.cloudflare.com/containers/api/durable-object-container/)
- If `npm ci` needs the public registry, setting `enableInternet: true` also lets test code send anything it can read to any server. The safer pattern intercepts and allowlists `registry.npmjs.org` with Internet left off. **[docs]** [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/#every-opening-is-also-a-way-out). For the spike fixture, the simplest choices are a repo with **no install step** (for example `node --test`) or dependencies baked into the image.

### Rebase and `npm test`

- `exec(argv, { cwd, env })` runs a process without a shell. Use `["sh","-c", "…"]` when you need a shell. `exec()` does not inherit `start({ env })`, except `PATH`. **[docs]** [DO Container API: exec](https://developers.cloudflare.com/containers/api/durable-object-container/#exec)
- **The image must provide git and Node.** `cloudflare/debian-trixie` and `node:24-trixie-slim` include **no git**. The documented Dockerfiles run `apt-get install ca-certificates git`. **[docs]** [Changes in 1.0](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/), [Run tests from a Git repository](https://developers.cloudflare.com/sandbox/commands/run-tests-from-a-git-repository/)
- Cloudflare documents a clone → `npm ci` → `npm test` flow that wraps each step in `timeout --kill-after=5 600`, collects `process.output()`, and calls `destroy()` in `finally`. **[example]** [Run tests from a Git repository](https://developers.cloudflare.com/sandbox/commands/run-tests-from-a-git-repository/)
- `git rebase` against Artifacts: **[unverified]** No source covers it, but it is purely local once the objects are fetched. Spike notes:
  - Don't use `--depth=1` if you need the merge base. Either do a full clone (the fixture is tiny) or fetch with deepen; Artifacts supports deepen.
  - Set `user.name` and `user.email`.
  - A rebased branch pushed to `main` is a fast-forward push. A force-push to a fork branch needs v1 receive-pack, which is supported.
- `exec()` has **no built-in timeout**. Use coreutils `timeout` or an `AbortController`. **[docs]** [DO Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)

### Cold start and warm reuse

- Containers docs say cold starts "can often be in the 1-3 second range", depending on image size and the entrypoint. **[docs]** [Architecture](https://developers.cloudflare.com/containers/concepts/architecture/), [FAQ](https://developers.cloudflare.com/containers/faq/). No sandbox-specific or Artifacts-clone timings are published. **[unverified]** The spike should measure image start, clone, test, and push separately.
- **Warm reuse** **[docs]** ([Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)):
  - The same name reaches the same Durable Object via `getByName()`.
  - The instance keeps running while the Durable Object is active (a request, alarm, stream or WebSocket), and then for `setInactivityTimeout(ms)`, up to **6 hours**.
  - Code running inside the container does **not** count as activity. A long test needs an in-flight request or an alarm to keep the instance alive.
  - The timeout is lost when the Durable Object restarts (including on every deploy). Set it after `start()` **and** again in the constructor.
  - A deploy doesn't replace running instances. New images apply only to new starts.
- 1.0 removed `WarmPool`. **[docs]** [API map](https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/). Possible ways to cut cold-start cost:
  - Keep one sandbox per repo warm by name.
  - Use `snapshotContainer()` (public beta). It saves the root FS but not processes, and expires after 30 days. A snapshot is tied to its image.
  - **[docs]** [Snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

## 2. Images, sizes, timeouts

- **Image set is fixed at deploy time.** With `scheduling_policy: "durable_object"`, `start({ image })` must be either the managed `cloudflare/debian-trixie` or a value from `ctx.container.images`. **[docs]** [DO Container API: start](https://developers.cloudflare.com/containers/api/durable-object-container/#start), [Image management](https://developers.cloudflare.com/containers/guides/image-management/)
  - That map comes from the `containers[].images` map in wrangler config. Each entry is either a `dockerfile` built at deploy, or a **digest-pinned** `registry.cloudflare.com/...@sha256:` reference.
  - The map holds at most **100** named images.
  - There are **no direct external-registry references**. Docker Hub, ECR and GAR images must be pushed to the Cloudflare registry first.
  - Changing an image requires a deploy.
- Implication for `.throng/checks.yml`: an `image:` field can only pick a name from an allowlist that Throng deploys, such as `node`, `python` or `bun`. Per-repo custom toolchains would have to be installed at runtime inside a generic image, optionally cached with a snapshot. This is a product-design question for the backlog.
- **Instance sizes** **[docs]** ([Limits](https://developers.cloudflare.com/containers/platform/limits/)):

  | Type | vCPU | Memory | Disk |
  | --- | --- | --- | --- |
  | lite (**default** for `start()`) | 1/16 | 256 MiB | 2 GB |
  | basic | 1/4 | 1 GiB | 4 GB |
  | standard-1 | 1/2 | 4 GiB | 8 GB |
  | standard-2 | 1 | 6 GiB | 12 GB |
  | standard-3 | 2 | 8 GiB | 16 GB |
  | standard-4 | 4 | 12 GiB | 20 GB |

  - Custom sizes: 1–4 vCPU, at most 12 GiB memory and 20 GB disk, with at least 3 GiB per vCPU.
  - Pass the size via `start({ instance })`.
  - The `start()` reference lists `lite` and `standard-1..4` but omits `basic`. **[unverified]** Whether `basic` is accepted.
  - `lite` (256 MiB) is likely too small for `npm ci`/vitest. **[unverified]** Plan to start with `basic` or `standard-1`.
- **Timeouts:**
  - Inactivity timeout: up to 6 h.
  - `exec()`: no limit.
  - `start()` is not awaited. Under 0.x, `instanceGetTimeoutMS` defaulted to 30 s and `portReadyTimeoutMS` to 90 s. Those are 0.x-only settings.
  - **[docs]** [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/), [Sandbox options (0.x)](https://developers.cloudflare.com/sandbox/sdk/configuration/sandbox-options/)
- **Account limits** **[docs]**:
  - 1,500 concurrent vCPU.
  - 6 TiB concurrent memory.
  - Image size up to the instance's disk size.
  - 50 GB of total image storage.
- **Plan and price** **[docs]** ([Pricing](https://developers.cloudflare.com/containers/platform/pricing/)):
  - Requires the Workers Paid plan.
  - Billed per 10 ms of running time. CPU is billed on active use; memory and disk on provisioned size.
- Wrangler deploys that build a `dockerfile` need Docker running locally. **[docs]** CI with no auto-deploy is unaffected.

## 3. Licenses

| Package | Version (npm `latest`) | License | Source |
| --- | --- | --- | --- |
| `@cloudflare/sandbox` | 1.0.0 (2026-09-30) | **Apache-2.0** | npm `license` field; [`packages/sandbox/LICENSE`](https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/LICENSE); [root `LICENSE`](https://github.com/cloudflare/sandbox-sdk/blob/main/LICENSE) |
| `sandbox-shim` binary (from `cloudflare/sandbox:<ver>` image, crate `sandbox-tools`) | 1.0.0 | Apache-2.0 | [`crates/sandbox-tools/Cargo.toml`](https://github.com/cloudflare/sandbox-sdk/blob/main/crates/sandbox-tools/Cargo.toml) |
| `agents` (Cloudflare Agents SDK) | 0.26.0 | **MIT** (© 2025 Cloudflare, Inc.) | npm; [`LICENSE`](https://github.com/cloudflare/agents/blob/main/LICENSE); [`NOTICE`](https://github.com/cloudflare/agents/blob/main/NOTICE) |
| Runtime deps of `@cloudflare/sandbox` | `zod` 4.5.4, `aws4fetch` 1.0.20 | MIT, MIT | npm |

- GitHub's license detector shows `cloudflare/sandbox-sdk` as `NOASSERTION`. The root `LICENSE` is Apache-2.0 text without the appendix. The npm metadata and the package-level `LICENSE` both say Apache-2.0. No `NOTICE` file exists in sandbox-sdk.
- The `agents` repo has a `NOTICE` listing code it incorporates or adapts:
  - MCP TS SDK (MIT)
  - Coinbase x402 (Apache-2.0)
  - x402-mcp (MIT)
  - Vercel AI SDK (Apache-2.0)
  - Telnyx voice-cloudflare (MIT)
  - PartyServer (ISC, vendored)

  The published npm tarball ships only `LICENSE` (MIT), not the `NOTICE` file.
- **Compatibility (this is my reading, not legal advice):**
  - An MIT- or Apache-2.0-licensed project may depend on both packages. Throng's own code keeps its own license, and the dependencies keep theirs.
  - Apache-2.0 §4 obligations apply only when we **redistribute** Apache code:
    - Keep the license text.
    - Keep any `NOTICE` (sandbox-sdk has none).
    - Mark any modified files.
  - Listing these packages as npm dependencies (not vendored) in a public repo is not redistribution of their source.
  - Deploying a bundled Worker to our own Cloudflare account is not public distribution either.
  - A container image that COPYs `sandbox-shim` and is published to a public registry **would** be redistribution, so ship the Apache-2.0 text with it.
- **Recommended notices:**
  - Add a short `THIRD_PARTY_NOTICES.md` (or a README section) naming `@cloudflare/sandbox` (Apache-2.0) and `agents` (MIT, if used), with links to their license files.
  - If we vendor or copy code from either repo, keep its header and license, and for `agents` its `NOTICE` entries.
  - The spike doesn't use agents or MCP, so `agents` may not be a dependency on this map at all.
- **Repo license mismatch:** the ticket assumes an MIT submission, but [`LICENSE`](../../LICENSE) on `main` is the Apache-2.0 template, with the copyright line still unfilled (`[yyyy] [name of copyright owner]`). Both choices are compatible with these dependencies. Pick one before submission.

## What the spike must test

1. Clone, fetch and push to Artifacts from a container started via `ctx.container` with SDK 1.0 and a git-enabled image. Test both:
   - (a) the token passed into the sandbox (the known-good path from the example);
   - (b) the token added by an `interceptOutboundHttps` gateway on the Artifacts host. This is the preferred path, and push through it is unverified.
2. `git rebase` on a non-shallow clone of the fixture, then a fast-forward push to `main`. Also capture conflict output for the bounce payload.
3. `npm test` (or `node --test`) on the fixture. Check the memory needed (`lite` vs `basic`/`standard-1`) and whether `basic` is accepted by `start()`.
4. Hop timings: cold `start()` → first `exec()`, clone, test, push. Then repeat warm via the same `getByName()` within the inactivity timeout.
5. Keeping the instance alive during a long `exec()` called from a Workflow step, and whether an alarm is needed.
