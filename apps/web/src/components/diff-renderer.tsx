// `<Diff>`'s lazily loaded half: `@pierre/diffs` itself. It highlights with Shiki using the app's
// theme pair, in a pool of workers off the main thread where the browser has them.

import { PatchDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { useSyncExternalStore } from "react";
import type { Layout } from "@/lib/arena-view";
import { themes } from "@/lib/highlighter";
import { currentTheme, subscribeTheme } from "@/lib/theme";

const POOL = {
  poolOptions: {
    workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" }),
  },
  highlighterOptions: { theme: themes },
};

export default function DiffRenderer({ patch, layout }: { patch: string; layout: Layout }) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "light" as const);
  const diff = (
    <PatchDiff patch={patch} options={{ theme: themes, themeType: theme, lineDiffType: "word", diffStyle: layout }} />
  );
  // jsdom, for one, has no workers; the renderer then highlights on the main thread.
  if (typeof Worker === "undefined") return diff;
  return <WorkerPoolContextProvider {...POOL}>{diff}</WorkerPoolContextProvider>;
}
