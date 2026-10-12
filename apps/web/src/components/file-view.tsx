// One file at a ref: highlighted text with line anchors, rendered Markdown, an inline image, or
// for binary and too-large files, their size and a raw link.

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Code } from "@/components/code";
import { Markdown } from "@/components/markdown";
import { isMarkdown, markdownBases } from "@/components/readme";
import type { Blob } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { lineAnchor, parseLineAnchor, selectLine } from "@/lib/lines";
import { buildPath } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";
import { cn } from "@/lib/utils";

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/iu;

/** The text's lines, a final newline ending the last line rather than starting another. */
function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function FileView({ at, blob }: { at: BrowseLocation; blob: Blob }) {
  const raw = buildPath({ ...at, view: "raw" });
  const hash = useRouterState({ select: (state) => state.location.hash });
  const selected = parseLineAnchor(hash);
  const markdown = blob.content !== null && isMarkdown(blob.path);
  // A line anchor is in the source, so a link to one opens Markdown there.
  const [source, setSource] = useState(selected !== undefined);
  const showSource = !markdown || source;

  const summary =
    blob.content === null ? formatBytes(blob.size) : `${lineCount(blob.content)} lines · ${formatBytes(blob.size)}`;

  return (
    <section aria-label={blob.name} className="flex flex-col rounded-xl border">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm">
        <span className="text-muted-foreground tabular-nums">{summary}</span>
        <span className="flex-1" />
        {markdown && (
          <span className="flex gap-1">
            <Toggle pressed={!source} onPress={() => setSource(false)}>
              Preview
            </Toggle>
            <Toggle pressed={source} onPress={() => setSource(true)}>
              Source
            </Toggle>
          </span>
        )}
        <a href={raw} className="rounded-md border px-2 py-0.5 hover:bg-muted">
          Raw
        </a>
      </header>
      <div className="p-4">
        <FileBody at={at} blob={blob} raw={raw} showSource={showSource} />
      </div>
    </section>
  );
}

function FileBody({ at, blob, raw, showSource }: { at: BrowseLocation; blob: Blob; raw: string; showSource: boolean }) {
  if (IMAGE.test(blob.path) && !blob.tooLarge) {
    return <img src={raw} alt={blob.name} className="mx-auto max-w-full" />;
  }
  if (blob.content === null) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
        <p>{blob.binary ? `Binary file, ${formatBytes(blob.size)}` : `Too large to show, ${formatBytes(blob.size)}`}</p>
        <a href={raw} className="text-primary underline underline-offset-4">
          View raw
        </a>
      </div>
    );
  }
  if (!showSource) return <Markdown {...markdownBases(at)}>{blob.content}</Markdown>;
  return <NumberedCode path={blob.path} code={blob.content} />;
}

/** Code with a gutter of line links: click one to select it, shift-click another to select the range. */
function NumberedCode({ path, code }: { path: string; code: string }) {
  const navigate = useNavigate();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const selected = parseLineAnchor(hash);
  const lines = Array.from({ length: Math.max(1, lineCount(code)) }, (_, i) => i + 1);
  const first = selected?.start;

  // The file loads after the page, too late for the browser's own jump to the anchor: jump once it's here.
  useEffect(() => {
    if (first !== undefined) document.getElementById(`L${first}`)?.scrollIntoView?.({ block: "center" });
    // Only on arrival: picking lines afterwards shouldn't move the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (line: number) => (event: MouseEvent) => {
    event.preventDefault();
    const range = selectLine(selected, line, event.shiftKey);
    void navigate({ to: ".", search: true, hash: lineAnchor(range), replace: true, resetScroll: false });
  };

  return (
    <div className="flex font-mono text-sm leading-relaxed">
      <nav aria-label="Line numbers" className="flex flex-col py-3 pr-2 text-right select-none">
        {lines.map((line) => (
          <a
            key={line}
            id={`L${line}`}
            href={`#L${line}`}
            onClick={pick(line)}
            className={cn(
              "px-1 text-muted-foreground hover:text-foreground",
              selected !== undefined && line >= selected.start && line <= selected.end && "text-foreground",
            )}
          >
            {line}
          </a>
        ))}
      </nav>
      <Code code={code} path={path} highlightLines={selected} className="min-w-0 flex-1" />
    </div>
  );
}

function Toggle({ pressed, onPress, children }: { pressed: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onPress}
      className={cn("rounded-md px-2 py-0.5 hover:bg-muted", pressed && "bg-muted font-medium")}
    >
      {children}
    </button>
  );
}
