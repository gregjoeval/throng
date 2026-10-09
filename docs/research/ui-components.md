# UI component library: shadcn/ui and alternatives

Research for [#114](https://github.com/gregjoeval/throng/issues/114), part of
map [#71](https://github.com/gregjoeval/throng/issues/71). Sources were read
on 2026-10-09. Versions checked: `shadcn@4.21.4`, `@base-ui/react@1.9.0`,
`radix-ui@1.7.0`, `@radix-ui/themes@3.3.0`, `react-aria-components@1.22.0`,
`@ark-ui/react@5.39.3`, `@heroui/react@3.2.6`, `@mantine/core@9.7.1`,
`@cloudflare/kumo@2.14.0`, `daisyui@5.7.47`.

Source tags:

- **[docs]**: official docs site, changelog or `llms.txt`.
- **[source]**: published package contents or shadcn registry JSON
  (`ui.shadcn.com/r/styles/<base>-nova/<item>.json`).
- **[npm]**: npm registry (versions, dates, licenses, weekly downloads).
- **[gh]**: GitHub API (stars, open issues, last push).
- **[measured]**: something I ran in a scratch directory (bundle sizes,
  export lists).
- **[inferred]**: my own reading, not stated anywhere.

The UI is not built yet: `apps/platform` on `main` has Hono and Vite only, no
React or Tailwind [source]. Starting position from #71: React Router v7 on
Workers, Vite, Shiki, TanStack Query.

## TL;DR

- **Use shadcn/ui on Base UI** (the default since July 2026), with Tailwind
  v4. Components are copied into our repo, so the arena, the file browser and
  the diff surroundings can be reshaped freely. It has the best agent
  tooling of any option (skill, MCP server, `shadcn info --json`).
- **Fill the gaps with the libraries shadcn itself uses.** TanStack Table for
  data tables, `react-resizable-panels` for split panes, the Base UI `Toast`
  for toasts and `cmdk` (via shadcn `Command`) for the command palette.
- **shadcn now has three bases: Base UI (default), Radix and React Aria**
  [docs]. Radix is "not being deprecated", but new work lands on Base UI
  first, and some components exist only there [docs]. React Aria is the
  choice if accessibility beats everything else. Its Toast is still
  `UNSTABLE_` [source].
- **Watch Cloudflare Kumo.** It is a packaged library on Base UI and
  Tailwind v4 that ships a Command Palette, Table, Toast and a Shiki code
  block [docs][npm]. It is Cloudflare's product look, though, and it is
  packaged rather than owned.
- **daisyUI works only as a skin, not as the component library.** It is a
  Tailwind v4 plugin of CSS classes, with no JS and no React components.
  Its interactive pieces rely on native `<dialog>`, the popover API, `<details>`
  and radio inputs, so there is no roving focus, typeahead, combobox or
  command palette [docs]. Pairing it with a headless library (Base UI or React
  Aria) means writing the same wrappers shadcn already gives us, with
  daisyUI's look instead of ours [inferred].
- **Don't pick** Radix Themes (stalled), Mantine (its own CSS system, not
  Tailwind), Park UI (Panda-first and quiet since February 2026) or HeroUI
  (good, but a packaged, opinionated visual style on React Aria; shadcn's Aria
  base gives the same primitives with our own code).

## Candidates at a glance

|                  | shadcn/ui                                                             | Radix Themes                                    | Ark UI / Park UI                                           | React Aria Components                          | HeroUI v3                                               | Mantine                                                             | Kumo                                               | daisyUI                                                                |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Ownership        | copied in via CLI; primitives from npm [docs]                         | package [docs]                                  | Ark: headless package; Park: CLI-copied recipes [docs][gh] | headless package [docs]                        | package, "a living library" [docs]                      | package [docs]                                                      | package for components, copy-in "blocks" [docs]    | Tailwind plugin (npm), classes only [docs]                             |
| Primitives       | Base UI (default), Radix or React Aria [docs]                         | Radix [docs]                                    | Zag.js state machines [docs]                               | own hooks (`react-aria`) [docs]                | React Aria Components [docs]                            | own [source]                                                        | Base UI [docs]                                     | none; native `<dialog>`, popover API, `<details>`, radio inputs [docs] |
| Styling          | Tailwind v4 + CSS variables (OKLCH) [docs]                            | own CSS, specificity capped for Tailwind [docs] | Ark: any; Park: Panda CSS [gh]                             | any; Tailwind plugin for state variants [docs] | Tailwind v4 required (peer `tailwindcss >=4`) [source]  | CSS modules + PostCSS preset; Tailwind only via `classNames` [docs] | Tailwind v4 (recommended) or standalone CSS [docs] | Tailwind v4 required; `@plugin "daisyui"` [docs]                       |
| Latest release   | 4.21.4, 2026-10-07 [npm]                                              | 3.3.0, 2026-01-31 [npm]                         | Ark 5.39.3, 2026-10-05; Park CLI 1.0.1, 2025-11-20 [npm]   | 1.22.0, 2026-10-08 [npm]                       | 3.2.6, 2026-09-17 [npm]                                 | 9.7.1, 2026-10-06 [npm]                                             | 2.14.0, 2026-09-17 [npm]                           | 5.7.47, 2026-09-30 [npm]                                               |
| Weekly downloads | 11.6 M CLI; `@base-ui/react` 16.3 M; `radix-ui` 16.2 M [npm]          | 0.97 M [npm]                                    | Ark 0.81 M [npm]                                           | 4.8 M [npm]                                    | 0.65 M [npm]                                            | 2.7 M [npm]                                                         | 0.39 M [npm]                                       | 1.04 M [npm]                                                           |
| Repo health      | 125 K stars, 1,773 open issues; Base UI 11 K stars, pushed today [gh] | last push 2026-04-11 [gh]                       | Ark pushed 2026-10-08; Park last commit 2026-02-21 [gh]    | pushed 2026-10-08, 621 open [gh]               | pushed today, 26 open [gh]                              | pushed 2026-10-08, 29 open [gh]                                     | pushed 2026-10-08 [gh]                             | 42.6 K stars, 48 open, pushed 2026-10-08 [gh]                          |
| License          | MIT                                                                   | MIT                                             | MIT                                                        | Apache-2.0                                     | MIT on npm, Apache-2.0 in repo and docs [npm][gh][docs] | MIT                                                                 | MIT                                                | MIT                                                                    |
| `llms.txt`       | yes [docs]                                                            | no (404) [docs]                                 | Ark yes; Park no [docs]                                    | yes, plus MCP and agent skills [docs]          | yes [docs]                                              | yes [docs]                                                          | yes, plus CLI docs and a "Design skill" [docs]     | yes, written as an `alwaysApply` agent skill [docs]                    |

## shadcn/ui: current state

- **Base UI is the default** as of the July 2026 changelog: "Base UI is the
  default component library in shadcn/ui", and `shadcn init` picks it unless
  you pass `-b radix` [docs]. The reasons given are that Base UI is stable,
  the team builds new work on it, and users of shadcn/create were already
  choosing it over Radix about two to one [docs].
- **Radix stays supported.** "Radix is not being deprecated." Updates ship to
  both, "except components that exist only in Base UI" [docs]. An agent skill
  can migrate one component at a time [docs].
- **React Aria is a third base** (July 2026): `shadcn init --base aria`
  works across all eight styles. Existing projects keep their base [docs].
- **Base UI itself** went 1.0 stable on 2025-12-11 and has shipped a minor
  release every month since. 1.9.0 came out on 2026-10-09 [docs][npm]. Its
  exports include Autocomplete, Combobox, Menu, Toast, Drawer and OTPField
  [measured]. The old `@base-ui-components/react` is deprecated ("renamed to
  @base-ui/react") [npm].
- **Radix Primitives** is active again. It had a major release on
  2026-06-06 and fixes through July 2026 (React 19 and RSC fixes, per-primitive
  subpaths) [docs]. `radix-ui@1.7.0` was published on 2026-10-05 [npm].
- **Base-specific differences** in the registry [source]:
  - Toast: Base UI has a native `toast` built on `@base-ui/react`. On Radix
    the toast page says it "has been deprecated. Use sonner" [docs].
  - Combobox: the _Radix_ registry item imports `@base-ui/react`, so a Radix
    project pulls in Base UI anyway [source].
  - Command: Base UI and Radix both use `cmdk`. The Aria item has no external
    dependency and uses React Aria's Autocomplete [source].
  - Resizable: `react-resizable-panels` on every base [source].
  - Data Table is a docs recipe on TanStack Table, not a registry item (404)
    [source][docs].
- **Recent additions** include a native Toast (July 2026), chat components
  (June 2026), Questionnaire (August 2026), and `cn` as its own package,
  replacing `clsx` + `tailwind-merge` (September 2026) [docs].
- **Tailwind v4** has been supported since February 2025. Theming uses CSS
  variables in OKLCH, and dark mode is a class/variable switch [docs].

## Coverage of what Throng needs

| Need                                | shadcn (Base UI)                                                         | React Aria Components                                                     | Kumo                                                  | Mantine                             |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| Data tables (task lists, scores)    | `Table` + TanStack Table recipe [docs]                                   | `Table` with keyboard grid nav, column resizing, multi-select, DnD [docs] | `Table` [docs]                                        | `Table` [measured]                  |
| Tabs                                | yes [docs]                                                               | yes [docs]                                                                | yes [docs]                                            | yes [docs]                          |
| Split panes (side-by-side attempts) | `Resizable` = `react-resizable-panels` (4.14.3, 33.5 M/wk) [source][npm] | none; bring `react-resizable-panels` [inferred]                           | none found [docs]                                     | `Splitter` export [measured]        |
| Command palette                     | `Command` = `cmdk` [source]                                              | `Autocomplete` + `Menu`/`ListBox` [docs]                                  | `CommandPalette` [docs]                               | `@mantine/spotlight` [inferred]     |
| Dialogs                             | yes [docs]                                                               | `Modal` + `Dialog` [docs]                                                 | yes [docs]                                            | yes [docs]                          |
| Toasts                              | Base UI `Toast` [docs]                                                   | `UNSTABLE_Toast*` only [source]                                           | yes [docs]                                            | `@mantine/notifications` [inferred] |
| File tree (file browser)            | none in shadcn; Base UI has no Tree [measured]                           | `Tree` with DnD [docs]                                                    | none found [docs]                                     | `Tree` [measured]                   |
| Code / diff surroundings            | none; pair with `@pierre/diffs` [inferred]                               | none [inferred]                                                           | `CodeHighlighted` on Shiki ^4 (a dependency) [source] | none in core [inferred]             |

daisyUI covers dialogs (`modal`), tabs, toasts (a positioning wrapper
only, with no queue or timers), `table`, `menu`, `dropdown`, `drawer` and
`kbd`. It has no split pane, command palette, combobox or tree [docs]. Its
`diff` component is an image before/after slider, not a code diff [docs]. Its
"Code mockup" is a decorative terminal frame [docs].

Ark UI also exports `Splitter`, `Toast`/`Toaster`, `Combobox` and `TreeView`
[measured][docs].

The file tree is the gap common to shadcn/Base UI. Options are React Aria's
`Tree` (usable inside a Base UI project, since it is headless), Ark's
`TreeView`, or a hand-rolled tree. A tree is only one `role="tree"` widget
[inferred].

The diff renderer from
[diff-rendering.md](diff-rendering.md) (`@pierre/diffs`, Shiki-native) doesn't
care about the component library. Only the chrome around it (file headers,
tabs, split panes, comment popovers) comes from the library [inferred].
Kumo's dependency on Shiki ^4 would match the Shiki we already plan to load
[source][inferred].

## Accessibility

- **React Aria** has the strongest claims. It follows the W3C ARIA
  Authoring Practices, is "extensively tested using many popular screen
  readers and devices", has touch-screen-reader behaviour, and ships
  translations for 30+ languages and RTL [docs].
- **Base UI and Radix** both handle focus management, keyboard navigation and
  ARIA wiring for their primitives [docs]. Radix's recent releases are
  largely ARIA and React 19 fixes [docs]. I found no published screen-reader
  test matrix for either [inferred].
- **daisyUI** adds no behaviour. A11y comes from the HTML it styles. Native
  `<dialog>.showModal()` gives focus trapping and Escape. Popover-API
  dropdowns give light dismiss, but no arrow-key menu navigation. Its tabs are
  `role="tablist"` markup on buttons or radio inputs, with no roving
  tabindex [docs][inferred]. Anything richer needs a headless library
  underneath [inferred].
- **HeroUI** inherits React Aria's behaviour [docs]. **Kumo** inherits Base
  UI's [docs]. **Mantine** builds its own [source].
- With shadcn the a11y logic stays in the npm primitive, so copied-in markup
  doesn't fork it. What we _do_ own is styling, such as focus rings and
  contrast [inferred].

## Bundle size [measured]

Each bundle imports Dialog, Tabs, Menu/DropdownMenu, Popover, Tooltip, Select
and Toast (or the closest equivalent), with React external and CSS dropped:

| Bundle                          | min    | gzip   |
| ------------------------------- | ------ | ------ |
| `radix-ui`                      | 197 KB | 54 KB  |
| `radix-ui` + `cmdk` + `sonner`  | 231 KB | 64 KB  |
| `@base-ui/react`                | 309 KB | 103 KB |
| `@base-ui/react` + Autocomplete | 351 KB | 116 KB |
| `react-aria-components`         | 203 KB | 64 KB  |
| `@ark-ui/react`                 | 227 KB | 65 KB  |
| `@heroui/react`                 | 320 KB | 102 KB |
| `@mantine/core` (+ provider)    | 240 KB | 74 KB  |
| `@radix-ui/themes`              | 233 KB | 62 KB  |

daisyUI ships no JS. Compiling Tailwind v4 with the daisyUI plugin over a
page using `modal`, `dropdown`, `tabs`, `toast`, `table`, `btn`, `input`,
`select` and `menu` gives 64 KB min / 9.2 KB gzip of CSS, including the
default light and dark themes. Tailwind alone is 1.4 KB gzip for the same
page [measured]. Paired with a headless library, the JS cost is that
library's row above [inferred].

Per primitive, gzip, Base UI vs Radix: Dialog 27 vs 15 KB, Tabs 14 vs 10,
Select 49 vs 35, Toast 29 vs 13. Base UI costs roughly 40 KB gzip more for
the same set. It is a real but modest cost next to Shiki (the web bundle is
695 KB gzip per Shiki's docs) and `@pierre/diffs` (152 KB gzip measured in
diff-rendering.md) [measured][docs]. Routes that lazy-load the arena keep
it off the task list pages [inferred]. Subpath imports
(`@base-ui/react/dialog`) gave the same total as the root import, so
tree-shaking already works [measured].

## Theming and dark mode

- **shadcn:** semantic CSS variables (OKLCH) in our own CSS, presets and
  eight styles, and dark mode via a `.dark` class [docs]. The `sonner` item
  depends on `next-themes`, but the Base UI `toast` does not [source].
- **Kumo:** semantic tokens use CSS `light-dark()` and are switched by
  `data-mode`. "Never use Tailwind's `dark:` variant" [docs]. It also
  requires a `@source` line for `node_modules` under Tailwind v4 [docs].
- **daisyUI:** themes are CSS variables (`--color-base-100`,
  `--color-primary`, …, `--radius-field`, `--size-selector`) defined with
  `@plugin "daisyui/theme" { … }`. They are selected with `data-theme` on any
  element, can nest, and are registered as Tailwind v4 colour tokens
  (`bg-primary`, `text-base-content`) [docs]. The defaults are `light` and
  `dark --prefersdark`, with about 35 built-in themes [docs]. It tells you not to
  use `dark:` with its colours. To make `dark:` follow a theme, define
  `@custom-variant dark (&:where([data-theme=night], …))` [docs]. Its
  palette (`primary`/`secondary`/`accent`/`neutral`/`base-*` with `-content`
  pairs) differs from shadcn's (`background`/`foreground`/`card`/`muted`/…).
  Mixing the two needs a token mapping [inferred].
- **Mantine:** a theme object plus CSS variables, with a colour-scheme
  manager [docs].
- **Radix Themes:** `<Theme>` wrapper with its own tokens [docs].

## How well AI coding agents use it

- **shadcn** has the most agent tooling:
  - an agent skill (`pnpm dlx skills add shadcn/ui`) that reads
    `shadcn info --json` (base, Tailwind version, aliases, installed
    components) so generated code fits the project;
  - an MCP server for registry search and install;
  - an `llms.txt` [docs].

  The code is ordinary files in the repo, so agents can read and edit it
  like any other code [inferred]. shadcn's popularity (11.6 M weekly CLI
  downloads) also means models have seen a lot of it [npm][inferred].
  Caveat: much of that training data is Radix-flavoured shadcn
  (`asChild`), while Base UI uses a `render` prop. The skill exists partly to
  close that gap [docs][inferred].

- **React Aria** offers `llms.txt`, per-page markdown, MCP servers and Agent
  Skills (v1.14/v1.15 release notes) [docs].
- **Kumo** has an `llms.txt`, a CLI that prints component docs
  (`npx @cloudflare/kumo doc Button`) and a "Design skill" page [docs].
- **daisyUI:** its `llms.txt` is an agent skill with front matter
  `alwaysApply: true` that tells the agent to use daisyUI "even if the user
  does not request it" [docs]. Class-only markup is easy for agents to
  generate. But nothing stops an agent writing an inaccessible `<div>` menu
  [inferred].
- **HeroUI:** `llms.txt`. MCP is "coming soon" [docs].
- **Mantine, Ark:** `llms.txt` [docs].

## Recommendation

1. **shadcn/ui, Base UI base, Tailwind v4.** Run `shadcn init` with the
   default base and install the shadcn skill for agents. Use `Resizable`
   (react-resizable-panels) for the arena's side-by-side columns, `Command`
   for the palette, `Toast` for toasts, and TanStack Table under `Table` for
   task lists and score tables.
2. **File tree:** start with a hand-rolled tree or Ark's `TreeView`. Use React
   Aria's `Tree` if keyboard and screen-reader quality matters more than one
   extra dependency [inferred].
3. **If accessibility is the deciding criterion**, choose `--base aria`
   instead. Same ownership model and agent tooling, Table and Tree
   included, but Toast is unstable and the community examples are fewer
   [docs][source][inferred].
4. **Not daisyUI.** It would give a cheap look with zero JS, but Throng's
   hard parts are behavioural: the command palette, menus, comboboxes,
   keyboard navigation in the arena and the file tree. daisyUI provides none
   of them. With Base UI or React Aria underneath, we would write the
   wrappers shadcn already gives us, against a second token system
   [docs][inferred]. If its themes are wanted, port a daisyUI theme's OKLCH
   values into shadcn's CSS variables instead [inferred].
5. **Revisit Kumo** if we want a ready-made Cloudflare-dashboard look with
   less code to own. It sits on the same Base UI primitives, so moving
   between them later is feasible [inferred].

## Open questions

- Does a Base UI `Toast` + `Command` (cmdk) + `Resizable` arena prototype
  stay under an acceptable JS budget next to `@pierre/diffs` and Shiki? Fold
  this into the diff prototype ([#80](https://github.com/gregjoeval/throng/issues/80)).
- `cmdk` was last published 2025-03-14 and its repo (`dip/cmdk`) was last
  pushed 2025-10-29 [npm][gh]. Is that stable or neglected? Would Base UI's
  `Autocomplete` serve as a palette instead?
- Base UI's Combobox and the React Aria `Tree` in one tree: any focus-
  management clashes between two primitive libraries? Untested.
- SSR on Workers with React Router v7: all candidates claim SSR support, but
  none was rendered in `workerd` for this note.
- Kumo's styles target Cloudflare's design language. Is a non-Cloudflare
  product allowed to look that way, and does Kumo intend outside use? The
  docs don't say.
- If we ever want daisyUI's themes, is a one-off mapping of daisyUI
  variables onto shadcn's variables enough, or would both class vocabularies
  end up in the codebase?
- Which shadcn style (Vega, Nova, Maia, Lyra, Mira, Luma, Rhea, Sera) suits
  a dense code-review UI? It's a design call, not a research one.

## Sources

- shadcn: https://ui.shadcn.com/docs/changelog (entries "Base UI as the
  Default", "React Aria", "Toast", "cn"), https://ui.shadcn.com/docs/components,
  https://ui.shadcn.com/docs/components/radix/toast,
  https://ui.shadcn.com/docs/skills, https://ui.shadcn.com/llms.txt, registry
  JSON at `https://ui.shadcn.com/r/styles/{base,radix,aria}-nova/<item>.json`
- Base UI: https://base-ui.com/react/overview/releases, https://github.com/mui/base-ui
- Radix: https://www.radix-ui.com/primitives/docs/overview/releases,
  https://www.radix-ui.com/themes/docs/overview/releases,
  https://github.com/radix-ui/primitives, https://github.com/radix-ui/themes
- React Aria: https://react-aria.adobe.com/, https://react-aria.adobe.com/llms.txt
- Ark / Park: https://ark-ui.com/llms.txt, https://github.com/chakra-ui/ark,
  https://github.com/chakra-ui/park-ui
- HeroUI: https://heroui.com/docs/react/getting-started, https://github.com/heroui-inc/heroui
- Mantine: https://mantine.dev/llms.txt, https://mantine.dev/llms/q-third-party-styles.md
- daisyUI: https://daisyui.com/llms.txt (config, colours, themes,
  modal/dropdown/tab/toast/diff syntax), https://github.com/saadeghi/daisyui
- Kumo: https://github.com/cloudflare/kumo, https://kumo-ui.com/llms.txt,
  https://kumo-ui.com/installation.md, https://kumo-ui.com/components-vs-blocks.md,
  https://kumo-ui.com/colors.md, https://kumo-ui.com/changelog.md
- npm registry metadata and downloads: `https://registry.npmjs.org/<pkg>`,
  `https://api.npmjs.org/downloads/point/last-week/<pkg>`; GitHub API
  `repos/<owner>/<repo>`

Method for [measured] numbers: `npm i --ignore-scripts` in a scratch
directory. One entry per library imported the listed components, bundled
with `esbuild --bundle --minify --format=esm`, with `react`, `react-dom` and
`react/jsx-runtime` external and CSS dropped. Sizes are `gzip -9`. Export
lists come from `Object.keys(require(pkg))` in Node. The daisyUI CSS size
comes from `@tailwindcss/cli --minify` over a one-file HTML fixture, with
`@import "tailwindcss" source(none)` and `@plugin "daisyui"`.
