// The one diff renderer the app uses, `@pierre/diffs` (see "Decide: diff renderer", #115). Every
// diff goes through `<Diff>`, so swapping the renderer touches this file and `./diff-renderer`.
// The renderer is loaded the first time a diff shows, keeping it out of every other route. The
// server never renders a diff (`defaultSsr: false`), so the `import.meta.env.SSR` guard keeps the
// renderer and its worker out of the Worker bundle.

import { lazy, Suspense } from "react";
import type { ComponentType } from "react";

const Renderer = lazy<ComponentType<{ patch: string }>>(() =>
  import.meta.env.SSR ? Promise.resolve({ default: () => null }) : import("./diff-renderer"),
);

/** One file's git-style unified patch, highlighted with the app's Shiki theme pair. */
export function Diff({ patch }: { patch: string }) {
  return (
    <Suspense fallback={<p className="px-4 py-3 text-sm text-muted-foreground">Loading diff…</p>}>
      <Renderer patch={patch} />
    </Suspense>
  );
}
