# Diff rendering options with Shiki

Research for [#79](https://github.com/gregjoeval/throng/issues/79), of map
[#71](https://github.com/gregjoeval/throng/issues/71). Sources were read on
2026-10-07. Versions checked: `@pierre/diffs@1.5.2`, `@git-diff-view/*@0.1.7`,
`react-diff-view@3.3.3`, `diff2html@3.4.56`, `@codemirror/merge@6.12.2`,
`monaco-editor@0.57.0`, `shiki@4.5.0`.

Every claim has a source tag:

- **[docs]**: the project's README or docs site.
- **[source]**: the project's source code at the default branch.
- **[npm]**: the npm registry (versions, dates, licenses, dependencies,
  weekly downloads).
- **[gh]**: the GitHub API (stars, open issues, last push, archived flag).
- **[measured]**: something I ran in a scratch directory (esbuild bundle size,
  or feeding a combined diff to each parser).
- **[inferred]**: my own reading, not stated anywhere.

## Answer

**Prototype `@pierre/diffs` first, with `@git-diff-view/react` +
`@git-diff-view/shiki` as the fallback.**

- `@pierre/diffs` is the only candidate _built on_ Shiki. Highlighting,
  themes and token spans all come from Shiki. Shiki is a dependency with a
  wide range (`^3 || ^4`), so it dedupes with our copy and we can share
  one highlighter. It is
  also the only patch-based renderer that virtualises large diffs in the
  browser. It has a line-annotation API for comments, a worker pool for
  highlighting off the main thread, and server-side HTML pre-rendering. It
  ships vanilla JS (a shadow-DOM custom element) plus React bindings, so
  SvelteKit is not ruled out. The risks: it is young (first npm publish
  2025-12-10), it releases often, and it is Apache-2.0 rather than MIT.
- `@git-diff-view` has the widest framework spread (React, Vue, Solid,
  Svelte, CLI) and an official Shiki adapter. But it always bundles
  highlight.js, it does not virtualise on the web, it is pre-1.0, and it has
  one maintainer.
- **No candidate renders `diff --cc` properly.** Only diff2html parses
  combined diffs at all, and it reduces them to plain insert and delete
  lines. Do not make the renderer carry this. Turn a bounce into ordinary
  two-way diffs before it reaches the UI (see
  [Combined diffs](#combined-diffs-for-bounces)).
- Monaco's diff editor and CodeMirror's merge view are _editors_. They take
  two full documents, not a patch. They are heavy (Monaco) or need a
  third-party Shiki bridge (CodeMirror). Keep them in mind for a future
  "edit in place" file browser, not for the arena's diff lists.

## Comparison

|                                              | `@pierre/diffs`                                                                          | `@git-diff-view` (+ `/shiki`)                                                                     | `react-diff-view`                                                                                                                                            | `diff2html`                                                                                               | Monaco diff editor                                                           | `@codemirror/merge`                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Input                                        | patch text or two files [source]                                                         | patch hunks + optional full old/new content [docs]                                                | patch text [docs]                                                                                                                                            | patch text [docs]                                                                                         | two full models [docs]                                                       | two full docs [docs]                                                                                    |
| Shiki pairing                                | native: built on Shiki, JS regex engine by default [docs][source]                        | official adapter `@git-diff-view/shiki` (`registerHighlighter`) [docs]                            | none. Hard-wired to a refractor@3 object. Shiki would need a duck-typed `{highlight(text, lang)}` adapter returning refractor-shaped HAST [source][inferred] | none. Expects a highlight.js instance [docs]                                                              | official `@shikijs/monaco` (`shikiToMonaco`) [docs]                          | none official. Third-party `codemirror-shiki@0.3.0` [npm]                                               |
| Virtualisation                               | yes: `Virtualizer`, `VirtualizedFileDiff` [source]                                       | no on web (only the Lynx build virtualises). Offers worker + "template mode" [source][docs]       | no. README advises lazy rendering for large diffs [docs]                                                                                                     | no [docs][inferred]                                                                                       | yes (editor viewport) [inferred]                                             | yes (CodeMirror viewport) [inferred]                                                                    |
| Split + unified                              | yes (split / stacked) [docs]                                                             | yes [docs]                                                                                        | yes [docs]                                                                                                                                                   | yes (`side-by-side` / `line-by-line`) [docs]                                                              | yes (`renderSideBySide`) [source: d.ts]                                      | yes (`MergeView` / `unifiedMergeView`) [docs]                                                           |
| Word / char changes                          | yes: `lineDiffType` `word-alt`, `word`, `char`, ... [source]                             | yes, via `fast-diff` [source]                                                                     | yes: `markEdits` (diff-match-patch) [docs]                                                                                                                   | yes: `diffStyle: word / char` [docs]                                                                      | yes [inferred]                                                               | yes: `highlightChanges` [source]                                                                        |
| Inline comments later                        | line annotations framework [docs][source]                                                | widgets + `extendData` per line [docs]                                                            | `widgets` prop, one per change [docs]                                                                                                                        | none. You would post-process HTML [inferred]                                                              | view zones (`addZone`) [source: d.ts]                                        | CM decorations / widgets [inferred]                                                                     |
| Combined diff (`diff --cc`)                  | no. Parses to an empty file [measured]                                                   | no. Throws `Invalid hunk header format` [measured]                                                | no. Throws [measured]                                                                                                                                        | partial. Parses `@@@` two-parent hunks into insert/delete lines; README says unsupported [measured][docs] | no [inferred]                                                                | no [inferred]                                                                                           |
| Framework                                    | vanilla (custom element) + React [docs][source]                                          | React, Vue, Solid, Svelte, Lynx, CLI [docs]                                                       | React only [npm]                                                                                                                                             | none (HTML string + DOM helper) [docs]                                                                    | none (React via `@monaco-editor/react`) [npm]                                | none (CodeMirror 6) [npm]                                                                               |
| SSR                                          | `ssr` export: `preloadDiffs`, `renderHTML` [source]                                      | SSR + RSC examples [docs]                                                                         | React SSR [inferred]                                                                                                                                         | HTML string [docs]                                                                                        | client only [inferred]                                                       | client only [inferred]                                                                                  |
| Bundle, min / gzip, Shiki and React excluded | 784 KB / 152 KB [measured]                                                               | 1235 KB / 345 KB for `/react` (includes highlight.js through lowlight); `/shiki` +2 KB [measured] | 72 KB / 24 KB (+ refractor) [measured]                                                                                                                       | 92 KB / 25 KB (UI base, no hljs) [measured]                                                               | 2721 KB / 701 KB for `editor.api` + 95 KB gz worker, no languages [measured] | 275 KB / 89 KB incl. CM core [measured]                                                                 |
| License                                      | Apache-2.0 [npm][gh]                                                                     | MIT [npm]                                                                                         | MIT [npm]                                                                                                                                                    | MIT [npm]                                                                                                 | MIT [npm]                                                                    | MIT [npm]                                                                                               |
| Weekly downloads                             | 4.06 M [npm]                                                                             | 127 K (`/react`) [npm]                                                                            | 335 K [npm]                                                                                                                                                  | 569 K [npm]                                                                                               | 11.3 M [npm]                                                                 | 2.26 M [npm]                                                                                            |
| Maintenance                                  | last publish 2026-10-05; 6.2 K stars, 77 open issues; first publish 2025-12-10 [npm][gh] | last publish 2026-07-13; 0.x; one maintainer; 743 stars [npm][gh]                                 | last publish 2026-03-30; 1 K stars [npm][gh]                                                                                                                 | last publish 2026-01-31; 3.4 K stars [npm][gh]                                                            | last publish 2026-09-24; Microsoft [npm][gh]                                 | last publish 2026-06-09. GitHub mirror is archived; development is on `code.haverbeke.berlin` [npm][gh] |

For scale, Shiki itself through the fine-grained `shiki/core` + JS regex
engine, with one theme and the TypeScript grammar, was 357 KB min / 72 KB gz
[measured]. Shiki's own docs list `shiki/bundle/web` at 695 KB gz and the full
bundle at 1.2 MB gz [docs: shiki.style/guide/bundles].

## Pairing with Shiki, in detail

Shiki facts that hold for every option:

- A highlighter should be a "long-lived singleton". Do not create it in hot
  paths [docs: shiki.style/guide/install].
- On Cloudflare Workers the default Oniguruma WASM build "won't work",
  because Workers cannot initialise WebAssembly from binary data. You must
  import `shiki/onig.wasm` as an asset, or use the JavaScript regex engine
  [docs: shiki.style/guide/install]. Since Shiki 3.9.1 the JS engine supports
  all built-in languages [docs: shiki.style/guide/regex-engines].
- Highlighting a hunk alone gets multi-line constructs wrong (template
  strings, block comments). Each library that cares works around this by
  taking the full old file: react-diff-view's `oldSource` [docs],
  git-diff-view's "syntax highlighting with full context" [docs], and
  pierre's `parseDiffFromFile` [source]. Throng keeps attempts in git
  repos, so full file content is available. The prototype should feed it in
  [inferred].

Per candidate:

- **`@pierre/diffs`.** Depends on `shiki` and `@shikijs/transformers` at
  `^3.0.0 || ^4.0.0`, so it uses the app's copy [npm]. Its shared highlighter
  defaults to `preferredHighlighter = 'shiki-js'`, which is
  `createJavaScriptRegexEngine()`. `'shiki-wasm'` opts into Oniguruma
  [source: `src/highlighter/shared_highlighter.ts`]. So it should run under
  Workers SSR without the WASM asset dance [inferred]. It "automatically
  adapts to Shiki themes" [docs]. It ships a worker pool (`./worker` export)
  for off-main-thread highlighting [npm][source].
- **`@git-diff-view/shiki`.** `getDiffViewHighlighter(shikiOptions)` returns
  a highlighter you pass to `diffFile.initSyntax({ registerHighlighter })`
  [docs]. But `@git-diff-view/core` lists `highlight.js`, `lowlight` and
  `@git-diff-view/lowlight` as hard dependencies [npm]. The measured React
  bundle carries them even when Shiki is used [measured].
- **`react-diff-view`.** `tokenize()` calls
  `options.refractor.highlight(text, language)` and expects refractor-shaped
  nodes. The README pins refractor@3 [source: `src/tokenize/toTokenTrees.ts`;
  docs]. You could pass an object whose `highlight` wraps Shiki's
  `codeToHast`, but that is our adapter to maintain, and Shiki emits inline
  styles where refractor emits classes [inferred].
- **`diff2html`.** `Diff2HtmlUI` takes a highlight.js instance [docs]. Shiki
  would mean walking the generated DOM and re-highlighting each line, which
  loses cross-line context [inferred].
- **Monaco.** `@shikijs/monaco` exists because "Monaco's built-in highlighter
  does not use the full TextMate grammar". Languages must be registered
  first. Shiki also recommends `modern-monaco` (built-in Shiki) [docs:
  shiki.style/packages/monaco].
- **CodeMirror merge.** No Shiki package exists from either project. The
  only bridge is `codemirror-shiki@0.3.0`, last published 2025-07-19 [npm].

## Combined diffs for bounces

`git diff` and `git show` print a merge as a combined diff by default. `--cc`
also drops hunks where the result just picks one parent [docs: git-diff(1)
"COMBINED DIFF FORMAT", git-diff-tree(1)]. I fed the two-parent `--cc`
example from git's docs to each parser [measured]:

- `diff2html.parse` returns one file with `isCombined: true`. Its lines come
  back as `context`, `delete` and `insert` only, so you lose which parent a
  line came from. Its README still says input is unified or git diff "(not
  combined or word diff)" [docs]. Parsing is two-parent only (`@@@` regex)
  [source: `src/diff-parser.ts`].
- `@pierre/diffs` `parsePatchFiles` returns a file with no hunks. Its parser
  splits on `diff --git` [source: `src/utils/parsePatchFiles.ts`].
- `@git-diff-view/core` throws `Invalid hunk header format`.
- `react-diff-view` `parseDiff` (gitdiff-parser) throws.

Recommendation [inferred]: keep the raw `--cc` text on the bounce for
fidelity. For display, derive ordinary diffs when the bounce is made, using
one of:

1. One diff per parent: `git diff <merge>^1 <merge>` and
   `git diff <merge>^2 <merge>`.
2. `git log --remerge-diff`. It re-merges the two parents into a temporary
   tree, conflict markers included, and diffs that against the real merge
   [docs: git-log(1)]. This shows exactly what conflict resolution changed.
   Git marks its output format "subject to change".

`@pierre/diffs` also has `UnresolvedFile` / `parseMergeConflictDiffFromFile`.
These render a file _containing_ conflict markers as a diff with
accept/reject actions [source]. That suits a bounce that carries the
conflicted file instead of a `--cc` patch.

## Fit with the arena

- **Two diffs per attempt** (against the merge target and against its own
  base) are two independent patch renders of the same files. Every
  patch-based option handles this. With pierre or git-diff-view, one shared
  Shiki highlighter and the worker pool keep the second render cheap
  [inferred].
- **Grouping attempts by base** is UI around the renderer. Nothing above
  constrains it [inferred].
- **"Must not limit us later"**: the choice that limits least is the one
  with a vanilla core and thin framework bindings. That is pierre (vanilla +
  React) or git-diff-view (core + many bindings). react-diff-view ties us to
  React. Monaco and CodeMirror lock the arena into an editor model
  [inferred].

## For the prototype (#80)

1. `@pierre/diffs`: a React Router v7 route that SSRs a two-file patch with
   `preloadDiffs`/`renderHTML` on Workers, then hydrates `VirtualizedFileDiff`.
   Check:
   - whether the JS regex engine is enough for our languages;
   - scroll performance on a roughly 10k-line diff;
   - adding a comment annotation;
   - client bundle cost next to our Shiki.
2. `@git-diff-view/react` + `@git-diff-view/shiki`, on the same patch, to
   compare the bundle (highlight.js is always included) and large-diff
   behaviour without virtualisation.

## Sources

- npm registry metadata and downloads:
  `https://registry.npmjs.org/<pkg>`,
  `https://api.npmjs.org/downloads/point/last-week/<pkg>`
- `@pierre/diffs`: https://github.com/pierrecomputer/pierre/tree/main/packages/diffs,
  https://diffs.com
- `@git-diff-view`: https://github.com/MrWangJustToDo/git-diff-view
- `react-diff-view`: https://github.com/otakustay/react-diff-view
- `diff2html`: https://github.com/rtfpessoa/diff2html
- `@codemirror/merge`: https://code.haverbeke.berlin/codemirror/merge
  (mirror: https://github.com/codemirror/merge)
- Monaco: https://github.com/microsoft/monaco-editor,
  `monaco-editor@0.57.0/esm/vs/editor/editor.api.d.ts`
- Shiki: https://shiki.style/guide/install, https://shiki.style/guide/bundles,
  https://shiki.style/guide/regex-engines, https://shiki.style/packages/monaco
- Git: git-diff(1) "COMBINED DIFF FORMAT", git-diff-tree(1) `--cc`,
  git-log(1) `--remerge-diff`

Method for [measured] numbers: `npm i --ignore-scripts` in a scratch
directory. Each library's public entry was bundled with
`esbuild --bundle --minify --format=esm`, with `react`, `react-dom`,
`shiki/*` and `@shikijs/*` external and CSS/fonts dropped. Sizes are
`gzip -9`. The combined-diff test fed the `diff --cc describe.c` example
from git-diff(1) to each library's patch parser in Node.
