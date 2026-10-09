# Proxying git smart HTTP to Artifacts through a Worker

Research for [#95](https://github.com/gregjoeval/throng/issues/95) (part of map [#71](https://github.com/gregjoeval/throng/issues/71)). It feeds the "Throng proxies git so Artifacts tokens never leave it" decision from [#73](https://github.com/gregjoeval/throng/issues/73).
Researched 2026-10-08. Sources: the Workers and Artifacts docs (pages dated 2026-04-25 to 2026-10-08), git's protocol docs on git-scm.com, git's `remote-curl.c` and `builtin/receive-pack.c` (master), the spike's code in `apps/platform`, and the spike's results on [#3](https://github.com/gregjoeval/throng/issues/3). No Cloudflare API was called.

Each claim is tagged by evidence level:

- **[docs]**: stated in a developers.cloudflare.com page.
- **[spec]**: stated in git's protocol docs (`gitprotocol-http`, `gitprotocol-pack`, `gitprotocol-v2`, `gitprotocol-capabilities`).
- **[source]**: read from git's C source (`remote-curl.c`, `builtin/receive-pack.c`).
- **[types]**: stated in `apps/platform/worker-configuration.d.ts`.
- **[repo]**: shown by this repo's spike code or its recorded results.
- **[example]**: third-party code or a PR, not first-party docs.
- **[inference]**: follows from the above but is not stated anywhere.
- **[unverified]**: not documented. A spike must test it.

## TL;DR

| #   | Question                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Body-size limits                   | **Responses: none** ("Cloudflare does not enforce response body size limits") **[docs]**, so clones and fetches of any size stream back. **Requests: 100 MB on Free/Pro zones, 200 MB on Business, up to 5 GB on Enterprise**, enforced at the edge with a `413` **[docs]**. Streaming does not avoid this; it caps the size of **one push's pack**. Artifacts' own caps (1 GB repo, 32 MB blob) are larger than or orthogonal to it **[docs]**.                                  |
| 2   | CPU and duration                   | **No hard duration limit** while the client stays connected **[docs]**. CPU defaults to 30 s and can go to 5 min (`limits.cpu_ms`). Network waits don't count **[docs]**. A pass-through proxy spends almost no CPU per byte if bodies are piped natively, not pumped through JS **[inference]**. Memory is 128 MB per isolate, so never buffer a pack **[docs]**.                                                                                                                |
| 3   | Does Artifacts accept it as is?    | **Yes, in the cases the spike exercised.** The spike's `OutboundAuth` already proxies container `git fetch`/`git push` to Artifacts with a Worker `fetch()` and a swapped `Authorization: Bearer` header, and it passed against real Cloudflare **[repo]**. Push is v1 receive-pack only. git itself never asks for v2 on push, so forwarding `Git-Protocol` unchanged is safe **[docs][source]**. Large (chunked) pushes were not exercised **[unverified]**.                    |
| 4   | Check a pushed ref before the pack | **Yes.** The receive-pack request body starts with the ref commands (`old-id new-id refname`) as pkt-lines, ends them with a flush-pkt, and only then sends `PACK…` **[spec][source]**. The Worker can read that prefix, decide, and either forward the prefix plus the rest of the stream, or answer with a synthetic `report-status` (`ng refs/heads/main …`) without forwarding anything. Whole-repo denials happen even earlier, at `GET info/refs?service=git-receive-pack`. |
| 5   | Prior art                          | The spike's `OutboundAuth` is the same pattern without client auth or ref checks **[repo]**. Third-party Workers proxy git smart HTTP to GitHub and to Artifacts (a read-only Kody proxy to Artifacts, gh-proxy, isomorphic-git CORS proxies) **[example]**.                                                                                                                                                                                                                      |

**Verdict:** proxying git through a Worker is viable. The two real constraints are the **zone plan's request-body cap on a single push** (100 MB on Free/Pro) and the **untested large-push path** (chunked request bodies to Artifacts, and how long Artifacts takes to answer after a big pack). Both need a spike before the decision is final, and neither is likely to reverse it for P0's agent-sized pushes.

## 1. Body-size limits

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (updated 2026-10-08) **[docs]**:

- "Request body size limits depend on your Cloudflare account plan, not your Workers plan": Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise up to 5 GB self-serve (zone **Network → Maximum Upload Size**). Over the limit returns `413 Request entity too large`.
- "Cloudflare does not enforce response body size limits." CDN cache caps (512 MB / 5 GB) apply only to cached responses. git responses carry `Cache-Control: no-cache` **[spec]** and the proxy must not cache them, so the cache caps are irrelevant **[inference]**.
- The page says nothing about a body-size limit on **subrequests** (Worker → Artifacts). Artifacts' [Limits](https://developers.cloudflare.com/artifacts/platform/limits/) page lists no push or request-size limit either, only 1 GB per repo and 32 MB per blob **[docs]**.

What this means for git traffic:

- **Clone and fetch (upload-pack).** The client's POST is small (wants/haves). The pack comes back in the response, which has no size limit. Streaming it back is free: returning the subrequest's `Response` unchanged is "already optimal" ([Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)) **[docs]**. **No practical limit** below Artifacts' 1 GB repo cap **[inference]**.
- **Push (receive-pack).** The whole pack is the request body, so **one push is capped at the zone plan's request-body limit** **[docs][inference]**. Streaming keeps memory flat, but it doesn't lift the edge cap, which is applied to the incoming request before the Worker sees it **[inference]**. Whether the cap is enforced on chunked bodies (no `Content-Length`) the same way is **[unverified]**; assume it is.
- Which plan applies to a `*.workers.dev` hostname is not stated. Assume Free (100 MB) until we serve git from a custom domain on a known plan **[unverified]**.

Practical impact: agent and human pushes of a few commits are kilobytes to low megabytes, far below 100 MB. The cap only bites on **seeding a large repo by push**. Seeding should use the Artifacts `import()` / REST import (server-side, no Worker body) instead, or the user pushes history in slices **[inference]**.

## 2. CPU time, duration, memory

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) **[docs]**:

- CPU: Paid plan default 30 s, configurable to 5 min with `"limits": { "cpu_ms": 300000 }`. "Waiting on fetches … does **not** count toward CPU time."
- Duration: "There is no hard limit on duration for HTTP-triggered Workers." While the client stays connected, the Worker "can continue … making subrequests, and streaming a response body". "There is no set time limit on individual subrequests."
- Caveat: "During runtime updates, in-flight requests get a 30-second grace period to finish." A very long clone or push can be cut by a Cloudflare runtime rollout (and presumably by our own deploys) **[docs][inference]**. git surfaces it as a failed RPC; the user retries. A truncated pack is rejected by the server, so no partial ref update results **[inference]**.
- Memory: 128 MB per isolate, shared by concurrent requests. Buffering a pack risks "Memory limit would be exceeded before EOF". The docs' fix is to stream request and response bodies **[docs]**.

CPU cost of the proxy:

- Passing `request.body` straight into `fetch()` and returning the upstream `Response` keeps the bytes in the runtime's native streams. JS code doesn't touch each chunk, so CPU per push is near zero no matter the size **[inference]** (the Streams page says forwarding "verbatim without reading their body text" is optimal **[docs]**).
- The ref check reads only the first few pkt-lines (a few hundred bytes). After that, splice the rest of the stream natively (§4) rather than with a JS `pull()` loop or a JS `TransformStream`, which would bill CPU for every chunk **[inference]**.
- The default 30 s CPU is therefore plenty. Raising `cpu_ms` is a cheap safety margin, not a requirement **[inference]**.

Timeout risk on the upstream side: for a large push, Artifacts must receive and index the pack before it writes `report-status`. Cloudflare's proxy read timeout for origins is 125 s ([Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)) **[docs]**, but whether anything like it applies to a Worker subrequest to `*.artifacts.cloudflare.net`, and how long Artifacts takes per MB of pack, is **[unverified]**.

## 3. Does Artifacts accept proxied requests unchanged?

### What Artifacts documents

From [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) (2026-04-25) and [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/) **[docs]**:

- Remote: `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. Take the host from the `remote` the binding or REST returns.
- Auth: `Authorization: Bearer <full token>` (recommended), or HTTP Basic with any non-empty username and the token **secret** (token minus `?expires=…`) as the password.
- Clone/fetch: `git-upload-pack`, v1 and v2 (`ls-refs`, `fetch`). Push: `git-receive-pack`, **v1 only**: "Artifacts does not support v2 receive-pack." `filter` and `include-tag` are unsupported.
- The page does not mention `info/refs`, the `Git-Protocol` header, content types, or size limits. Standard smart HTTP is implied ("Any regular Git client can … `clone`, `fetch`, `pull` and `push`").

### What the spike already proved

The spike's `OutboundAuth` (`apps/platform/src/sandbox.ts`) **is** a git proxy in all but name: every HTTPS request git makes inside the container lands in a Worker entrypoint, which checks it (`outboundDecision` → `grantFor` in `grants.ts`), copies the request, replaces `Authorization` with `Bearer <token>`, and calls `fetch(request)` to Artifacts **[repo]**. The tokens are Worker-minted `createToken(...).plaintext` values (`workflows.ts#grants`) **[repo]**. The spike's `land` role pushes to canonical `main` through it, and the map closed with "intercept-injected git auth … all work" on real Cloudflare ([#3](https://github.com/gregjoeval/throng/issues/3), [#8](https://github.com/gregjoeval/throng/issues/8)) **[repo]**. So:

- Artifacts accepts a Worker-originated `fetch()` that forwards git's own headers and body with a swapped Bearer header, for `info/refs`, `git-upload-pack` and `git-receive-pack` **[repo]**.
- Worker-minted `createToken()` tokens work from a Worker `fetch()`. That is the path [workers-sdk#15429](https://github.com/cloudflare/workers-sdk/issues/15429) reported as 403 with isomorphic-git; it didn't reproduce with git CLI traffic forwarded by a Worker **[repo]**.
- **Not exercised:** a push larger than git's `http.postBuffer` (1 MiB default), which switches git to a probe request plus a chunked, streamed body (below); upload-pack with a gzipped request body; protocol v2 fetch through the proxy. The fixture repo is tiny **[inference]**.

### What git sends, and what the proxy must preserve

From [gitprotocol-http](https://git-scm.com/docs/gitprotocol-http), [gitprotocol-v2](https://git-scm.com/docs/gitprotocol-v2) and `remote-curl.c`:

| Request                                    | Headers that matter                                                                                   | Notes                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET …/info/refs?service=git-upload-pack`  | `Git-Protocol: version=2` (if v2)                                                                     | Exactly one query parameter **[spec]**. Response must be `Content-Type: application/x-git-upload-pack-advertisement`, or git falls back to dumb HTTP / errors **[spec][source]**.                                                                                                                                                |
| `POST …/git-upload-pack`                   | `Content-Type: application/x-git-upload-pack-request`, `Git-Protocol`, maybe `Content-Encoding: gzip` | git gzips upload-pack bodies over 1 KB (`fetch_git`/`stateless_connect` set `gzip_request`) **[source]**. Pass the body and `Content-Encoding` through untouched.                                                                                                                                                                |
| `GET …/info/refs?service=git-receive-pack` | `Git-Protocol: version=1` at most                                                                     | git downgrades v2 to v0 for any service other than upload-pack (`discover_refs`) **[source]**, so push never asks for v2, and Artifacts' lack of v2 receive-pack never shows **[inference]**.                                                                                                                                    |
| `POST …/git-receive-pack` (probe)          | body is exactly `0000`                                                                                | When the pack exceeds `http.postBuffer`, git first POSTs a 4-byte flush to check auth, because it can't rewind a streamed body (`probe_rpc`) **[source]**. It carries no commands; forward it (or answer it) without treating it as a push.                                                                                      |
| `POST …/git-receive-pack`                  | `Content-Type: application/x-git-receive-pack-request`, no gzip                                       | `push_git` never sets `gzip_request` **[source]**, so the command list is plain pkt-lines the proxy can parse. Large bodies are sent chunked **[source]**; a Worker `fetch()` with a non-fixed-length stream body also goes out chunked ([Request](https://developers.cloudflare.com/workers/runtime-apis/request/)) **[docs]**. |

Proxy rules that follow **[inference]**:

- Forward: method, `Content-Type`, `Content-Encoding`, `Git-Protocol`, `Accept`, `User-Agent`. Replace `Authorization`. Drop `Cookie` (git servers "SHOULD ignore any cookies" **[spec]**) and anything else.
- Return the upstream status, `Content-Type` and `Cache-Control`, with the body streamed. Strip upstream `WWW-Authenticate` so a client is never prompted for an Artifacts credential.
- Use `redirect: "manual"` on the subrequest, so an upstream redirect can't carry our `Authorization` to another host. The docs warn that `follow` forwards `Authorization` **[docs]**.
- On a missing or bad Throng token, answer `401` with `WWW-Authenticate: Basic realm="throng"` so git runs its credential helper. Accept the Throng token as Bearer (`http.extraHeader`) or as the Basic password, mirroring Artifacts' own two forms **[docs][inference]**. On a valid token that lacks access, answer `403` ("access is not currently permitted" → 403 **[spec]**). Error bodies as `text/plain` are printed to the user by git (`show_http_message`) **[source]**.
- Whether the Workers runtime transparently decompresses an incoming `Content-Encoding: gzip` **request** body is not documented **[unverified]**. If it does, forwarding the header unchanged would double-decode. The upload-pack spike step below checks this.

### Minting the Artifacts token

`createToken()` is a control-plane call, limited to 2,000 per 10 s **per namespace** ([Limits](https://developers.cloudflare.com/artifacts/platform/limits/)) **[docs]**. A clone is 2 to 3 git requests and a push 2 to 3 (`info/refs`, optional probe, POST), so minting per request would spend the control-plane budget on data-plane traffic **[inference]**. Cache one short-TTL token per (repo, scope) in the project's Durable Object or the isolate, and re-mint before `expiresAt` **[inference]**. `createToken` takes `ttl` 60 s to 1 y **[types]**.

## 4. Checking refs before the pack is forwarded

### The receive-pack body puts commands first

From [gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack) and [gitprotocol-http](https://git-scm.com/docs/gitprotocol-http) **[spec]**:

```text
update-requests = *shallow ( command-list | push-cert )
command-list    = PKT-LINE(command NUL capability-list) *PKT-LINE(command) flush-pkt
command         = create / delete / update
create          = zero-id SP new-id SP name
delete          = old-id SP zero-id SP name
update          = old-id SP new-id SP name
push-options    = *PKT-LINE(push-option) flush-pkt   ; only if push-options negotiated
packfile        = "PACK" 28*(OCTET)                  ; omitted if every command is a delete
```

`receive-pack` reads the whole command list (`read_head_info`) before it reads any pack data **[source]**. So every ref the push will touch, with its old and new ids, is known after a few hundred bytes, before the pack arrives.

### Proxy flow

1. **`GET info/refs?service=git-receive-pack`.** Authenticate the Throng token and check the coarse claim: may this principal push to this repo at all (e.g. their own open attempt's fork; never a canonical repo, which only the merge queue writes). Deny with 403 here, before the client builds or uploads a pack **[inference]**.
2. **`POST git-receive-pack`.** Read pkt-lines from `request.body` with a reader until the flush-pkt that ends the command list (and the push-options list, if `push-options` was negotiated). Fail closed on anything unexpected: `shallow` lines, `push-cert`, malformed lengths, a body that ends early, or a command list longer than a small cap **[inference]**. The Kody proxy to Artifacts does the same "byte-accurate pkt-line parse; fail closed" for upload-pack **[example]**.
3. **Decide per command.** Examples: refuse any `refs/heads/main` update or delete; allow only the attempt's branch; refuse deletes. The `old-id` is what git saw at ref discovery **[spec]**. Whether an update is a fast-forward can't be checked here, because the new commits are in the pack that hasn't arrived. Detect force-pushes afterwards from the `pushed` event's `before`/`after` **[inference]**.
4. **Allow:** build the upstream body from the bytes already read plus the untouched remainder. For example, write the buffered prefix into an `IdentityTransformStream`'s writable, release the writer, then `request.body.pipeTo(writable)` without awaiting it, and pass the readable to `fetch()`. Native-to-native piping keeps per-byte CPU off the JS thread **[inference]**. That the pipe stays native after a JS reader has consumed part of the body is **[unverified]**; measure CPU on a 50 MB push.
5. **Deny:** don't contact Artifacts. Answer `200` with `Content-Type: application/x-git-receive-pack-result` and a `report-status` built from the parsed commands:

   ```text
   unpack ok
   ng refs/heads/main pushing to main is not allowed; open an attempt instead
   0000
   ```

   - `report-status = unpack-status 1*(command-status) flush-pkt`; `command-fail = "ng" SP refname SP error-msg` **[spec]**. git prints `! [remote rejected] main (…)`.
   - Every command in the request needs a status line. Mark the allowed ones `ng` too ("atomic push rejected"), since nothing was forwarded **[inference]**.
   - If the client asked for `side-band-64k` (modern git always does when advertised **[spec]**), receive-pack sends `report-status` **inside band 1** (`report()` → `send_sideband(1, …)`) **[source]**. The synthetic reply must be wrapped the same way. The capability list on the first command says which **[spec]**.
   - An `unpack <error>` status, or band 3 ("fatal error message"), are cruder alternatives **[spec]**.
   - Whether we must drain the unread pack before responding (or can `cancel()` the body) without git or curl reporting a broken pipe instead of the `ng` lines is **[unverified]**. Small pushes arrive in one buffer, so it only matters for chunked pushes.

6. **Probe POSTs** (`0000` only, no commands) carry no ref update. Forward them so auth and errors behave like a direct remote **[source][inference]**.

Capabilities: Artifacts' advertisement decides what the client may use (`atomic`, `push-options`, `delete-refs`, …). The proxy can pass it through unchanged, and fail closed on a capability it doesn't parse. Whether Artifacts advertises `push-options` or `push-cert` is **[unverified]**: dump one `info/refs?service=git-receive-pack` response in the spike.

### Things the proxy can't see

- Commit contents, authorship and fast-forwardness, before the pack lands. These checks belong after the push: the `cf.artifacts.repo.pushed` Workflow, which already classifies pushes **[inference]**.
- Pushes that don't go through the proxy. Any party that holds an Artifacts write token bypasses every check, so Artifacts tokens must stay inside the platform. That includes the Sandbox, which already gets credentials only through `OutboundAuth` **[repo]**.

## 5. Prior art

- **The spike's `OutboundAuth`** (`apps/platform/src/sandbox.ts`, `network.ts`, `grants.ts`) **[repo]**. Repo-path allowlist, read grants refuse `git-receive-pack` both on `info/refs?service=` and on the POST path (`isReceivePack`), token added by the Worker, `fetch(request)` forwards everything else. The public proxy is the same thing with three additions: Throng-token auth instead of "the container is trusted by construction", a remote-path → Artifacts-repo mapping, and the receive-pack command parse in §4. `grantFor` and `outboundDecision` are a good seam to reuse: the same pure decision can serve both the Sandbox intercept and the public proxy **[inference]**.
- **[kentcdodds/kody PR #2725](https://github.com/kentcdodds/kody/pull/2725)** **[example]**. A Worker serving read-only `.git` smart HTTP for published packages by proxying to Artifacts. It refuses `git-receive-pack` with 403, forces protocol v1, caps request bodies at 256 KiB, and parses pkt-lines byte-accurately and fail-closed. A lesson: Artifacts may refuse a `want` for a SHA that isn't a ref tip ("not our ref").
- **[neyuki778/gh-proxy](https://github.com/neyuki778/gh-proxy)** **[example]**. A Worker reverse proxy for GitHub's smart HTTP: path allowlist (`/info/refs`, `/git-upload-pack`, `/git-receive-pack`), header allowlist, cookies stripped.
- **[aaditagrawal/git-cors-proxy-cf-worker](https://github.com/aaditagrawal/git-cors-proxy-cf-worker)**, [isomorphic-git proxy gist](https://gist.github.com/tomlarkworthy/cf1d4ceabeabdb6d1628575ab3a83acf) **[example]**. CORS proxies for browser git that forward `info/refs` and both service POSTs unchanged.
- **[zllovesuki/git-on-cloudflare](https://github.com/zllovesuki/git-on-cloudflare)** **[example]**. A full smart-HTTP server on Workers + DOs + R2, with streaming push ingest. It shows large streamed request bodies through a Worker are workable, but it's a server, not a proxy.

None of the third-party projects documents large-push behaviour through a Worker to Artifacts.

## Implications

- **The decision holds.** A Worker can front Artifacts for clone, fetch and push, keep Artifacts tokens server-side, and enforce per-ref claims before any pack data reaches Artifacts. The spike already runs the same proxy shape in production **[repo]**.
- **Push size is capped by the zone plan**, not by Workers or Artifacts: 100 MB per push on Free/Pro **[docs]**. Seed large repos with Artifacts import, not a push through the proxy. Serve git from a custom domain on a known plan rather than `workers.dev`.
- **Design the parser as a pure function** `(bytes) → {commands, capabilities, consumed} | malformed`, shared with the Sandbox intercept policy, and test it on recorded git traffic **[inference]**.
- **Cache Artifacts tokens** per repo and scope, so git traffic doesn't consume the per-namespace control-plane quota **[inference]**.

## Risks that would change "proxy git through a Worker"

1. **Chunked or large pushes fail through the Worker** (Artifacts rejects chunked bodies from a Worker, or a subrequest timeout fires while Artifacts indexes a big pack). Fallback: hand the client a short-lived (60 s minimum), repo-scoped Artifacts write token for that push and direct push. That gives up per-ref checks before the pack and leaks a time-boxed token **[inference]**.
2. **The 100 MB per-push cap matters for P0 users.** Fallbacks: Business plan (200 MB), Enterprise (5 GB), or seeding via import **[docs]**.
3. **A synthetic `report-status` can't be delivered cleanly** without draining a large body. Then deny by 403 instead, which loses the friendly per-ref message but keeps the guarantee **[inference]**.

## Open questions and spikes needed

1. **Large push through the Worker:** push 5 MB, 50 MB and 95 MB packs (above `http.postBuffer`) through a proxy route to Artifacts. Confirm the probe, chunked forwarding, `report-status`, CPU time per push (Workers logs), and Artifacts' response latency after the upload.
2. **Over the cap:** push 110 MB on the zone's plan. Confirm the edge `413` and what git prints.
3. **Ref check:** parse the command list, deny `refs/heads/main` with a side-band-wrapped `report-status`, and check git's output for a small and a chunked push. Try both draining and cancelling the remainder.
4. **Native splice:** after reading the prefix with a JS reader, does `pipeTo` of the remainder stay off the JS thread? Compare CPU ms with a plain pass-through.
5. **Gzipped upload-pack:** fetch with enough haves to exceed 1 KB, through the proxy. Confirm the runtime doesn't decompress the request body.
6. **Protocol v2 clone** through the proxy (`git -c protocol.version=2 clone`). Confirm `Git-Protocol` is forwarded and Artifacts answers `version 2`.
7. **Advertisement dump:** record Artifacts' `info/refs?service=git-receive-pack` capabilities (`atomic`, `push-options`, `delete-refs`, `quiet`, `side-band-64k`, `agent`).
8. **Client auth UX:** Throng token as Basic password through a credential helper, and as `http.extraHeader: Authorization: Bearer`. Check git ≥ 2.46 credential-helper bearer support (`authtype`) **[unverified]**.
9. **Which plan's body limit applies to `*.workers.dev`**, if git is served there during P0.

## Sources

- Workers docs: [Limits](https://developers.cloudflare.com/workers/platform/limits/) (2026-10-08), [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) (2026-06-15), [Request](https://developers.cloudflare.com/workers/runtime-apis/request/) (2026-07-02), [Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
- Artifacts docs: [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) (2026-04-25), [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/) (2026-04-25), [Limits](https://developers.cloudflare.com/artifacts/platform/limits/) (2026-10-01)
- git docs: [gitprotocol-http](https://git-scm.com/docs/gitprotocol-http), [gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack), [gitprotocol-v2](https://git-scm.com/docs/gitprotocol-v2), [gitprotocol-capabilities](https://git-scm.com/docs/gitprotocol-capabilities)
- git source (master): [`remote-curl.c`](https://github.com/git/git/blob/master/remote-curl.c) (`discover_refs`, `check_smart_http`, `post_rpc`, `probe_rpc`, `push_git`, `fetch_git`), [`builtin/receive-pack.c`](https://github.com/git/git/blob/master/builtin/receive-pack.c) (`read_head_info`, `report`)
- This repo: `apps/platform/src/sandbox.ts` (`OutboundAuth`), `network.ts` (`outboundDecision`), `grants.ts` (`grantFor`), `workflows.ts` (`#grants`), spike results on [#3](https://github.com/gregjoeval/throng/issues/3) and [#8](https://github.com/gregjoeval/throng/issues/8); [`artifacts-binding.md`](artifacts-binding.md), [`artifacts-limits.md`](artifacts-limits.md), [`sandbox-git-licenses.md`](sandbox-git-licenses.md)
- Prior art: [kentcdodds/kody#2725](https://github.com/kentcdodds/kody/pull/2725), [neyuki778/gh-proxy](https://github.com/neyuki778/gh-proxy), [aaditagrawal/git-cors-proxy-cf-worker](https://github.com/aaditagrawal/git-cors-proxy-cf-worker), [tomlarkworthy isomorphic-git proxy gist](https://gist.github.com/tomlarkworthy/cf1d4ceabeabdb6d1628575ab3a83acf), [zllovesuki/git-on-cloudflare](https://github.com/zllovesuki/git-on-cloudflare), [workers-sdk#15429](https://github.com/cloudflare/workers-sdk/issues/15429)
