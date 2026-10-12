// One Shiki highlighter shared app-wide. Nothing Shiki loads until the first
// highlight: then `./shiki` (core, engine, themes), then each grammar on first
// use. The server build never renders highlighted code (`defaultSsr: false`),
// so the `import.meta.env.SSR` guard drops Shiki and its ~240 grammar chunks
// from the Worker bundle.

/** The light/dark theme pair. The app's `.dark` class picks one via CSS. */
export const themes = { light: "github-light", dark: "github-dark" } as const;

/** The language unknown code falls back to. */
export const plainText = "text";

/** An inclusive, 1-based range of lines. */
export interface LineRange {
  start: number;
  end: number;
}

export interface HighlightOptions {
  /** A Shiki language id or alias. Unknown languages fall back to plain text. */
  lang?: string;
  /** A file path to pick the language from when `lang` is absent. */
  path?: string;
  /** Number each line (`data-line`) and give it an `L<n>` anchor id. */
  lineNumbers?: boolean;
  /** Lines to mark with the `highlighted` class. */
  highlightLines?: LineRange;
}

type Shiki = typeof import("./shiki");

let shiki: Promise<Shiki> | undefined;

/** The lazily loaded Shiki module, imported once. */
export function loadShiki(): Promise<Shiki> {
  if (import.meta.env.SSR) return Promise.reject(new Error("Shiki is client-only"));
  shiki ??= import("./shiki").catch((error: unknown) => {
    shiki = undefined;
    throw error;
  });
  return shiki;
}

/** Highlights `code` to an HTML string. Shiki escapes the source. */
export async function highlight(code: string, options: HighlightOptions): Promise<string> {
  return (await loadShiki()).highlight(code, options);
}

/** The Shiki language for a file path, from its name or extension. Falls back to plain text. */
export async function languageForPath(path: string): Promise<string> {
  return (await loadShiki()).languageForPath(path);
}

/** Loads a language into the shared highlighter. Resolves to the language to use: `lang`, or plain text. */
export async function loadLanguage(lang: string): Promise<string> {
  return (await loadShiki()).loadLanguage(lang);
}
