# Computing commit diffs from Artifacts

Research for [#117](https://github.com/gregjoeval/throng/issues/117), part of map
[#71](https://github.com/gregjoeval/throng/issues/71). Sources were read on 2026-10-09.
Versions checked: `diff` (jsdiff) 9.0.0 plus its unreleased `master` (2026-10-07),
`isomorphic-git@1.43.2`, `wasm-git@0.0.17`, `@pierre/diffs@1.5.2`, crates `imara-diff` 0.2.0
and `similar` 3.2.0, git 2.47.3.

Every claim has a source tag:

- **[docs]**: official documentation (Cloudflare, GitHub, GitLab, the project's README).
- **[source]**: the project's source code, or the generated `worker-configuration.d.ts`.
- **[npm]** / **[crates]** / **[gh]**: registry metadata, or the GitHub API (stars, last push, license).
- **[measured]**: something I ran in a scratch directory. The method is at the end.
- **[inferred]**: my own reasoning, not stated by any source.

## Answer

**For P0, compute diffs in the platform Worker. Walk the two trees with the Artifacts binding,
diff each changed file with jsdiff (`diff` on npm), and write git-style headers ourselves. Cap the
work and cache the result by tree pair. Leave `git diff` in a Sandbox as a later fallback, not the
main path.**

- **The tree walk is cheap.** A commit gives its `treeHash` and `parents`. `readTree` returns each
  entry's `mode` and `hash`, so whole subtrees whose hash didn't change are skipped without being
  read [source]. Over 300 real commits of `honojs/hono` that averaged **7.4 `readTree` + 6.2
  `readBlob` calls per commit**. Even `v4.0.0..HEAD` (716 changed files) took 281 tree reads and
  938 blob reads [measured].
- **jsdiff's output is a valid git patch, and almost always the same one.** 1,461 file diffs from
  450 commits were compared with `git diff --no-renames -U3`:
  - 92% matched hunk for hunk. The only differences were cosmetic: git writes a function name
    after `@@` and writes `-5` where jsdiff writes `-5,1`.
  - Every non-binary commit's patch, applied with `git apply` onto the parent, rebuilt **exactly**
    the commit's tree (449 of 450; the one failure was a binary file) [measured].
- **jsdiff is the right JS library.**
  - It is the standard JS diff library (145 M weekly downloads, BSD-3-Clause, maintained, has types).
  - It is the only candidate that writes unified patches.
  - `@pierre/diffs`, our first-choice renderer, already depends on it (`diff@9.0.0`, pinned
    exactly). Pierre also uses its `createTwoFilesPatch` for its own two-file mode [npm][source].
  - The patch functions add **3.1 KB gzipped** to the Worker [measured].
- **Its weakness is pathological files**, and that is what the caps are for.
  - jsdiff is plain Myers with none of git's heuristics. On a lockfile rewrite (6.1 k → 8.7 k
    lines), jsdiff 9.0.0 took **5.4 s** where `git diff` took 5 ms [measured].
  - jsdiff's `timeout` option **does not work on Workers**. It reads `Date.now()`, and Workers
    freeze the clock until I/O happens [source][docs].
  - Cap with `maxEditLength` instead. At 2,000 it gives up after about 200–250 ms in the worst case
    [measured].

### P0 caps

These are starting values, taken from GitHub's and GitLab's published limits and from my
measurements. They are not tuned [inferred].

| Cap                             | Value                    | On hit                                                            | Basis                                                                                                     |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Changed files listed            | 3,000                    | stop walking, `truncated: true`                                   | GitLab's configurable ceiling is 3,000 files [docs]                                                       |
| Files given a patch             | 300                      | the rest are listed (path, status, blob ids) with no hunks        | GitHub: "limited to 300" files per diff [docs]                                                            |
| Blob size per side              | 1 MB                     | file listed as `tooLarge`, no hunks                               | GitHub: 500 KB of raw diff per file; GitLab: 200 KB per-file patch [docs]. Bounds memory (128 MB isolate) |
| Binary                          | NUL in first 8,000 bytes | emit `Binary files a/x and b/x differ`                            | git's own `buffer_is_binary` rule [source: git `xdiff-interface.c`]                                       |
| jsdiff `maxEditLength` per file | 2,000                    | `structuredPatch` returns `undefined`; mark the file `tooComplex` | ≈200–250 ms worst case on a laptop [measured]                                                             |
| Total patch output              | 1 MB or 20,000 lines     | stop adding hunks, `truncated: true`                              | GitHub: 20,000 lines / 1 MB per PR diff [docs]                                                            |
| Concurrency of binding reads    | 6                        | queue the rest                                                    | Workers allow 6 open connections per invocation [docs]. Whether RPC bindings count is unknown             |

Raise the Worker's `cpu_ms` (default 30 s, max 5 min on Paid) only if real use hits it [docs].

### The tree walk

1. Read the commit with `readCommit(sha)`. Its `parents[0]` is the base. A root commit diffs against
   the empty tree. A merge commit diffs against its first parent, which also keeps us clear of
   combined diffs (see [diff-rendering.md](diff-rendering.md)) [inferred].
2. Walk `oldTree` and `newTree` together.
   - Skip any entry whose `hash` and `mode` are both unchanged.
   - Recurse when either side is a `tree`.
   - When one side is a tree and the other a file, emit a delete plus an add.
3. Sort paths byte-wise to match git's order [inferred].
4. For each changed path:
   - **Gitlink:** no blob read. Emit `Subproject commit <sha>` lines like git does [inferred].
   - **Otherwise:** `readBlob` both sides with bounded concurrency. Apply the size and binary
     rules, then `structuredPatch(a/path, b/path, old, new, , , { context: 3, maxEditLength })`.
5. Write the headers ourselves:
   - `diff --git a/p b/p`
   - `new file mode` / `deleted file mode`, or `old mode` / `new mode`
   - `index <old>..<new> <mode>`
   - then jsdiff's `---`/`+++` and hunks: `formatPatch` with `includeIndex` and `includeUnderline`
     off. Use `/dev/null` for the missing side.

   `@pierre/diffs`' `parsePatchFiles` read this output back correctly for change, new, deleted,
   binary, mode-only and no-newline-at-EOF files [measured].

6. **Renames.**
   - P0 output matches `git diff --no-renames`.
   - Exact renames are free: a deleted path and an added path with the same blob hash. Pair them
     and emit `rename from/to` with no hunks [inferred].
   - Similarity renames ("90% similar") need every added/deleted pair compared. That belongs in the
     Sandbox fallback.
7. **Cache.** A diff between two trees never changes. Key it by `(oldTree, newTree, generator
version, caps)` in the Cache API or R2 [inferred].

### What to serve

The output is two-way unified patches. They render with `@pierre/diffs` or `@git-diff-view` per
[diff-rendering.md](diff-rendering.md), and agents and CLIs can use them as they are. Serve the
patch as one `text/x-diff` body, plus a JSON form: one entry per file with `path`, `status`, modes,
blob ids, `additions`/`deletions`, flags (`binary`, `tooLarge`, `tooComplex`) and that file's patch
text. The renderer also wants the full old file for correct highlighting
([diff-rendering.md](diff-rendering.md)). The blob ids in the JSON let the UI fetch it. The exact
REST shape belongs to the API work in [api-style.md](api-style.md).

## What jsdiff is (for a first look)

- **What it is.**
  - `diff` on npm, repo [kpdecker/jsdiff](https://github.com/kpdecker/jsdiff). License BSD-3-Clause,
    9.2 k stars, 25 open issues, last push 2026-10-07. First published 2011. 145 M weekly downloads.
    No runtime dependencies. Ships its own types since v8 [npm][gh].
- **Algorithm.**
  - Myers' O(ND) diff ("An O(ND) Difference Algorithm and its Variations", 1986). It has two
    performance tweaks that do not change results [docs: README "Deviations"].
  - git also uses Myers by default, but xdiff adds preprocessing and heuristics that jsdiff lacks.
    That is why jsdiff is much slower on big rewrites [inferred].
- **API we need.**
  - `structuredPatch(oldName, newName, oldStr, newStr, oldHeader, newHeader, {context})` returns
    hunk objects.
  - `formatPatch(patch, headerOptions)` serialises them. `createTwoFilesPatch` does both in one call.
  - `parsePatch` reads git's dialect: `isGit`, `isRename`, `isCreate`, `isDelete`, modes,
    `isBinary`.
  - When `formatPatch` is given an `isGit: true` object, it writes `diff --git` and the extended
    headers [docs: README].
  - Every diffing function takes `maxEditLength` and `timeout`. When a call aborts, it returns
    `undefined` [docs].
- **Default header gotcha.** By default `createTwoFilesPatch` starts with
  `===================================================================` and `Index:` lines, not
  `diff --git`. Pass `headerOptions` `{ includeIndex: false, includeUnderline: false,
includeFileHeaders: true }`, or the `FILE_HEADERS_ONLY` constant. Otherwise each file needs a
  git header written ahead of it [docs][measured].
- **Releases.**
  - 9.0.0 (2026-04-13) dropped ES5 and quotes special filenames like git does [docs:
    release-notes.md].
  - The unreleased 10.0.0 on `master` speeds up the core loop by about 4× on non-trivial diffs
    (#712) [docs: release-notes.md]. On my inputs `master` was 3.5–5.6× faster on hard diffs
    [measured].
  - Pin the version. Pierre pins `diff@9.0.0` exactly, so a 10.x in the Worker means two copies
    in any shared bundle [npm][inferred].

## Comparison

|                    | **jsdiff in the Worker** (recommended)                                                     | isomorphic-git                                                                                                                                              | wasm-git (libgit2)                                                                                                 | Rust `imara-diff` / `similar` → WASM                                                                                                                             | `git diff` in a Sandbox                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Reads objects via  | binding `readTree`/`readBlob`, no clone [source]                                           | its own object store: needs `clone`/`fetch` into a memory FS. No partial clone on Artifacts [docs]                                                          | libgit2 on an Emscripten FS: needs a clone [docs: README]                                                          | binding (we write the walk) [inferred]                                                                                                                           | full `git fetch` into the container. No `--filter` on Artifacts [docs]                                 |
| Produces a patch   | yes: `structuredPatch` / `formatPatch`. We write the `diff --git` headers [docs][measured] | **no diff/patch API**. `walk()` only lists changed entries. Open request [#1838](https://github.com/isomorphic-git/isomorphic-git/issues/1838) [source][gh] | yes, libgit2 `git_diff` [inferred]                                                                                 | edit script only. Unified output via `similar`'s `unified_diff` or our own code [docs: crate READMEs][inferred]                                                  | yes, real git output (renames, `--stat`, word diff) [docs]                                             |
| Matches `git diff` | 92% hunk-identical, 100% applies (non-binary) [measured]                                   | n/a                                                                                                                                                         | very close (libgit2 has its own xdiff copy) [inferred]                                                             | `imara-diff` "closely matches the behavior of gnu-diff and git" [docs]                                                                                           | exact                                                                                                  |
| Pathological files | slow: 5.4 s on a lockfile rewrite. Needs `maxEditLength` [measured]                        | n/a                                                                                                                                                         | fast (xdiff heuristics) [inferred]                                                                                 | fast: "very good runtime performance even in pathological cases" [docs]                                                                                          | fast: 5–7 ms on the same file [measured]                                                               |
| Worker fit         | pure JS, 3.1 KB gz for the patch functions [measured]                                      | 53 KB gz for `walk`+`readBlob` [measured], plus clone memory                                                                                                | Emscripten build that clones over sync/async HTTP into an in-memory FS. Repo has to fit in 128 MB [docs][inferred] | must be built and shipped as a `.wasm` module ourselves. Workers can't compile WASM from runtime bytes [docs: Shiki install note in diff-rendering.md][inferred] | runs off-Worker. 1–3 s cold start [docs], plus the fetch                                               |
| License            | BSD-3-Clause [npm]                                                                         | MIT [gh]                                                                                                                                                    | GPL-2.0 with linking exception (libgit2) [source: `COPYING`]                                                       | Apache-2.0 (`imara-diff`), Apache-2.0 (`similar`) [gh]                                                                                                           | git is GPL-2.0, but it runs as a separate program [inferred]                                           |
| Maintenance        | 9.0.0 2026-04-13, push 2026-10-07, 145 M/wk [npm][gh]                                      | 1.43.2 2026-10-08, 1.9 M/wk [npm]                                                                                                                           | 0.0.17 2026-07-17, 1.4 K/wk, one maintainer [npm][gh]                                                              | `imara-diff` 0.2.0 2025-06; `similar` 3.2.0 2026-08. No maintained npm WASM build of either [crates][npm]                                                        | first-party, already in the spike (`apps/platform/src/sandbox.ts`)                                     |
| Per-request cost   | a few binding RPCs + ms of CPU [measured]                                                  | clone per request (or a cache)                                                                                                                              | clone per request                                                                                                  | same RPCs as jsdiff, less CPU                                                                                                                                    | container start + fetch per diff, or precompute                                                        |
| Verdict            | **P0**                                                                                     | no: adds a clone and still has no diff                                                                                                                      | no: clone, GPL-family license, tiny user base                                                                      | **upgrade path** if jsdiff's caps bite often                                                                                                                     | **fallback**: huge files, similarity renames, `--stat`/word diff, or precomputed in the check Workflow |

Other JS libraries are not contenders [npm][docs]:

- `diff-match-patch` and its forks (`@sanity/diff-match-patch`, `diff-match-patch-es`) are
  character-based and output their own patch format.
- `fast-diff` is character-level only.
- `diff-sequences` (Jest) and `fast-myers-diff` return an LCS or edit script with no patch writer.
- `@vscode/diff` is a 0.0.2 prerelease.

## Measurements

Method:

- Node 24.20.0 on a Linux laptop, git 2.47.3. Workers run V8 too, but their CPU speed is not the
  same, so treat times as relative.
- The binding was emulated with `git ls-tree` (for `readTree`) and `git cat-file blob` (for
  `readBlob`). The walk, headers and jsdiff calls are as described above, with `context: 3`.
- Commits: the last 300 first-parent commits of `honojs/hono`, and the last 150 of
  `kpdecker/jsdiff`, each diffed against its first parent.
- Reference: `git diff --no-renames -U3 <parent> <commit>`.

### Fidelity

| Repo   | File diffs | Byte-identical | Identical after hunk-header normalisation¹ | Differ: same +/- counts | Differ: other counts | `git apply` rebuilds exact tree |
| ------ | ---------- | -------------- | ------------------------------------------ | ----------------------- | -------------------- | ------------------------------- |
| hono   | 1,036      | 404 (39%)      | 978 (94.4%)                                | 51                      | 7                    | 299 / 300²                      |
| jsdiff | 425        | 182 (43%)      | 374 (88.0%)                                | 34                      | 17                   | 150 / 150                       |

¹ Two things are dropped from git's `@@` lines before comparing:

- the function-name context git appends, e.g. `@@ -1204,32 +1204,32 @@ __metadata:`
- git's shorthand `-5` for `-5,1`

Neither affects parsing or applying.

² The one failure was a commit that changed `favicon.ico`. A `Binary files … differ` patch can't
be applied. That is equally true of git's own default output, which needs `--binary`.

Most "differ" cases are a different but equally valid alignment of the same edit. Examples: which
blank line a hunk starts on, or a hunk boundary one line earlier. The "other counts" cases are
mostly `yarn.lock`. There jsdiff found a _shorter_ edit than git: +7,423/−4,819 against git's
+8,698/−6,094. git's preprocessing gives up minimality for speed. Turning off git's indent
heuristic changed only 2 files.

### Speed

Per-file jsdiff time over real commits:

| Repo   | Files | p50     | p99    | Max                                  |
| ------ | ----- | ------- | ------ | ------------------------------------ |
| hono   | 1,032 | 0.11 ms | 7.8 ms | 116 ms                               |
| jsdiff | 425   | 0.13 ms | 273 ms | 5,516 ms (`yarn.lock`, 290 → 320 KB) |

Synthetic files (lines of about 55 chars, N lines with D lines replaced at random), full diff, no cap:

| Input                              | jsdiff 9.0.0 | jsdiff `master` |
| ---------------------------------- | ------------ | --------------- |
| 1 k lines, 10 changed              | 2 ms         | 2 ms            |
| 10 k lines, 10 changed             | 7 ms         | 4 ms            |
| 10 k lines, 1 k changed            | 318 ms       | 80 ms           |
| 50 k lines (2.7 MB), 100 changed   | 30 ms        | 36 ms           |
| 50 k lines, 5 k changed            | 8,718 ms     | 2,176 ms        |
| 100 k lines (5.4 MB), 20 k changed | 11,460 ms    | 3,472 ms        |
| 20 k lines, all replaced           | 8,192 ms     | 1,469 ms        |

The real lockfile took jsdiff 9.0.0 5,354 ms and `master` 1,056 ms. `git diff` took 5–7 ms with
every `--diff-algorithm`.

Time until `maxEditLength` aborts (jsdiff 9.0.0). Cost grows about with the square of the cap:

| Input                    | 1,000 | 2,000  | 5,000    | 10,000               |
| ------------------------ | ----- | ------ | -------- | -------------------- |
| `yarn.lock` rewrite      | 60 ms | 203 ms | 1,328 ms | 5,077 ms             |
| 50 k lines, 5 k changed  | 72 ms | 248 ms | 1,626 ms | 6,431 ms (completed) |
| 20 k lines, all replaced | 62 ms | 232 ms | 1,533 ms | 5,436 ms (completed) |

### Size and call counts

Bundle sizes (`esbuild --bundle --minify --format=esm`, `gzip -9`):

- `structuredPatch` + `formatPatch` + `createTwoFilesPatch`: 7.7 KB min / 3.1 KB gz.
- All of `diff`: 22.9 KB / 8.3 KB.
- isomorphic-git `walk` + `TREE` + `readBlob`: 163 KB / 53 KB.

Binding calls for the hono tree walk:

| Range           | Changed files | `readTree` | `readBlob` |
| --------------- | ------------- | ---------- | ---------- |
| `HEAD~1..HEAD`  | 3             | 2          | 4          |
| `HEAD~20..HEAD` | 25            | 33         | 46         |
| `v4.9.0..HEAD`  | 490           | 253        | 757        |
| `v4.0.0..HEAD`  | 716           | 281        | 938        |

`HEAD` has 148 trees in total, so even a large range reads only the changed ones.

## Facts the design leans on

- **Binding.**
  - `readTree(hash)` returns only the immediate children: `{name, mode, hash, type}`, where `type`
    is `tree | blob | symlink | gitlink | exec`. It has **no size field**.
  - `readCommit` returns `treeHash` and `parents` (in git order).
  - `readBlob` returns an untyped `Blob`.
  - `readFile` can throw `MEMORY_LIMIT`.
  - `log` follows first parents only and is capped at 1,000.
  - [source: `worker-configuration.d.ts`; docs: Workers binding, via
    [artifacts-binding.md](artifacts-binding.md)]
- **Artifacts blobs** can be up to 32 MB [docs: Artifacts limits].
- **Workers limits** [docs: Workers limits, updated 2026-10-08]:
  - 128 MB per isolate, JS heap and WASM included.
  - CPU 30 s by default, up to 5 min on Paid. Waiting on network does not count toward CPU time.
  - 10,000 subrequests by default on Paid. KV, R2 and D1 count as subrequests. The page doesn't
    say whether other bindings do.
  - 6 simultaneous open connections.
- **Workers freeze `Date.now()` and `performance.now()`** until I/O, as a Spectre mitigation.
  Local `wrangler dev` does not freeze them [docs: Workers Performance and timers]. jsdiff's
  `timeout` is `Date.now() + timeout` checked in the loop [source: `libesm/diff/base.js`], so in
  production it never fires inside one synchronous call. Tests under `wrangler dev` would hide this.
- **Text decoding.** A JS string costs 2 bytes per character. Two 32 MB blobs, decoded and split
  into lines, would not fit in 128 MB [inferred]. Hence the 1 MB per-side cap.

## Open questions

1. **Can blob size be learned without reading the blob?** `readTree` has no size. Does `readBlob`
   stream, so that `Blob.size` is known before the bytes are buffered? Or is the whole blob copied
   across the RPC? If it is copied, a 32 MB blob costs 32 MB of isolate memory just to discover it
   is too big. The spike should measure `readBlob` on a 30 MB blob.
2. **Binding call cost.** What is the latency of `readTree`/`readBlob`? Do they count as
   subrequests, or toward the 6-connection limit, or the per-repo 2,000 requests / 10 s git limit?
   That decides the concurrency setting and whether wide diffs need batching.
3. **Real Workers CPU.** Re-run the speed table inside a deployed Worker. `maxEditLength = 2000`
   assumes laptop-class V8 speed.
4. **Attempt-vs-base diffs.** "Attempt against the merge target" needs a merge-base. The binding
   can't compute it: `log` follows first parents only, so a walk would mean `readCommit` BFS. Should
   the platform record the base SHA when it creates a fork or attempt? Or should the check Workflow
   (which already runs git in the Sandbox) compute and store it?
5. **Precompute or on demand?** The check Workflow already fetches the attempt in a Sandbox
   (`apps/platform/src/scripts.ts`). It could run `git diff` there and store the result in R2. That
   gives exact git output and similarity renames at no extra container start, but only for diffs
   known at push time. Is that worth it next to on-demand jsdiff plus a cache?
6. **jsdiff 10.0.0.** It is about 4× faster but unreleased. Adopt it when it ships? It needs
   `@pierre/diffs` to move off its exact `diff@9.0.0` pin, or we accept two copies.
7. **When caps bite:** show "too large to display" (GitHub's behaviour), or fall back to a
   whole-file replace hunk (O(n), always valid)? Agents might prefer the latter, and humans the
   former.

## Sources

- jsdiff: https://github.com/kpdecker/jsdiff (README, `release-notes.md`, `src/`),
  https://www.npmjs.com/package/diff
- `@pierre/diffs@1.5.2`: `package.json` dependencies, `dist/utils/parseDiffFromFile.js`,
  `parsePatchFiles`
- isomorphic-git: https://github.com/isomorphic-git/isomorphic-git, issue
  [#1838](https://github.com/isomorphic-git/isomorphic-git/issues/1838)
- wasm-git: https://github.com/petersalomonsen/wasm-git (README, `COPYING`)
- imara-diff: https://github.com/pascalkuthe/imara-diff (README);
  similar: https://github.com/mitsuhiko/similar; crates.io API
- git: `xdiff-interface.c` (`buffer_is_binary`, `FIRST_FEW_BYTES`), `diff.c`
  (https://github.com/git/git)
- Cloudflare: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/),
  [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
  [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/),
  [Artifacts git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- GitHub: [Repository limits: diff limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- GitLab: [Diff limits administration](https://docs.gitlab.com/administration/diff_limits/)
- Related notes: [artifacts-binding.md](artifacts-binding.md),
  [diff-rendering.md](diff-rendering.md),
  [sandbox-git-licenses.md](sandbox-git-licenses.md), [api-style.md](api-style.md)
