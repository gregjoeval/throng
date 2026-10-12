import { useMemo } from "react";
import { defaultUrlTransform, MarkdownHooks } from "react-markdown";
import type { Components, UrlTransform } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { loadShiki } from "@/lib/highlighter";
import type { highlightTree } from "@/lib/shiki";
import { cn } from "@/lib/utils";

/**
 * Highlights fenced code blocks through `@shikijs/rehype` with the shared
 * highlighter. Unknown languages fall back to plain text.
 */
function rehypeShiki() {
  return async (...args: Parameters<typeof highlightTree>) => {
    let shiki;
    try {
      shiki = await loadShiki();
    } catch {
      return; // Leave the code blocks plain.
    }
    await shiki.highlightTree(...args);
  };
}

// Sanitize before highlighting: Shiki's output carries inline styles the
// sanitizer would strip. Raw HTML is never rendered (no `rehype-raw`).
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize, rehypeShiki];

const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/u;

/** Resolves a relative URL against `base`. Absolute URLs and fragments are left alone. */
export function resolveUrl(url: string, base: string | undefined): string {
  if (!base || url === "" || scheme.test(url) || url.startsWith("#") || url.startsWith("//")) {
    return url;
  }
  const resolved = new URL(url, new URL(base, "https://base.invalid"));
  return scheme.test(base) ? resolved.href : resolved.pathname + resolved.search + resolved.hash;
}

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} rel="noopener noreferrer" />,
};

export interface MarkdownProps {
  children: string;
  /** The URL relative links resolve against, e.g. the README's directory in the file browser. End it with `/`. */
  baseUrl?: string;
  /** The URL relative images resolve against, e.g. the `/raw` directory. Defaults to `baseUrl`. */
  imageBaseUrl?: string;
  className?: string;
}

/** GitHub-flavoured Markdown, sanitized, with code blocks highlighted by Shiki. */
export function Markdown({ children, baseUrl, imageBaseUrl, className }: MarkdownProps) {
  const urlTransform = useMemo<UrlTransform>(
    () => (url, key) => {
      const safe = defaultUrlTransform(url);
      return resolveUrl(safe, key === "src" ? (imageBaseUrl ?? baseUrl) : baseUrl);
    },
    [baseUrl, imageBaseUrl],
  );
  return (
    <div className={cn("markdown", className)}>
      <MarkdownHooks
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
        skipHtml
      >
        {children}
      </MarkdownHooks>
    </div>
  );
}
