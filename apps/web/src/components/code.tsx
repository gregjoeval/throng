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
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let current = true;
    setHtml(undefined);
    const range = start !== undefined && end !== undefined ? { start, end } : undefined;
    highlight(code, { lang, path, lineNumbers, highlightLines: range })
      .then((result) => {
        if (current) setHtml(result);
      })
      .catch(() => {
        // Keep the plain-text fallback.
      });
    return () => {
      current = false;
    };
  }, [code, lang, path, lineNumbers, start, end]);

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
