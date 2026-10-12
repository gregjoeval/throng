import { useEffect, useState } from "react";
import { highlight, type LineRange } from "@/lib/highlighter";
import { cn } from "@/lib/utils";

export type CodeProps = {
  code: string;
  /** A Shiki language id or alias. Takes precedence over `path`. */
  lang?: string;
  /** A file path to pick the language from by its name or extension. */
  path?: string;
  /** Number each line and give it an `L<n>` anchor (the file view). */
  lineNumbers?: boolean;
  /** Lines to highlight, e.g. from a `#L10-L20` anchor. */
  highlightLines?: LineRange;
  className?: string;
};

/**
 * Source code highlighted by the shared Shiki highlighter. Shows the plain text
 * until the highlighter and the language have loaded.
 */
export function Code({ code, lang, path, lineNumbers, highlightLines, className }: CodeProps) {
  const start = highlightLines?.start;
  const end = highlightLines?.end;
  // Highlighting belongs to the input it was made from, so a change shows the plain text again.
  const input = JSON.stringify([code, lang, path, lineNumbers, start, end]);
  const [highlighted, setHighlighted] = useState<{ input: string; html: string }>();

  useEffect(() => {
    let current = true;
    const range = start !== undefined && end !== undefined ? { start, end } : undefined;
    const render = async () => {
      // On failure, keep the plain-text fallback.
      const result = await highlight(code, { lang, path, lineNumbers, highlightLines: range }).catch(() => undefined);
      if (current && result !== undefined) setHighlighted({ input, html: result });
    };
    void render();
    return () => {
      current = false;
    };
  }, [input, code, lang, path, lineNumbers, start, end]);

  const html = highlighted?.input === input ? highlighted.html : undefined;
  if (html === undefined) {
    return (
      <div className={cn("code", className)}>
        <pre className="shiki">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  // Shiki escapes the source, so its HTML is safe to inject.
  return <div className={cn("code", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
