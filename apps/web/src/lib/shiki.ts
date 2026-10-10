import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import type { HighlighterGeneric, ShikiTransformer } from "shiki/core";
import { createBundledHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { type HighlightOptions, plainText, themes } from "./highlighter";

// The Shiki side of `./highlighter`, which imports this module lazily. Each
// grammar is its own chunk, imported the first time it is used. The
// JavaScript regex engine avoids shipping Oniguruma's WASM.

type Highlighter = HighlighterGeneric<string, string>;

const createHighlighter = createBundledHighlighter<string, string>({
  langs: bundledLanguages,
  themes: {
    "github-light": () => import("shiki/themes/github-light.mjs"),
    "github-dark": () => import("shiki/themes/github-dark.mjs"),
  },
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
});

let highlighter: Promise<Highlighter> | undefined;

/** The shared highlighter, created on first call. */
export function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: [themes.light, themes.dark], langs: [] }).catch((error: unknown) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}

const specialLanguages = new Set(["text", "txt", "plain", "plaintext", "ansi"]);

export async function loadLanguage(lang: string): Promise<string> {
  const name = lang.toLowerCase();
  if (specialLanguages.has(name)) return name;
  if (!Object.hasOwn(bundledLanguages, name)) return plainText;
  const hl = await getHighlighter();
  try {
    await hl.loadLanguage(name);
    return name;
  } catch {
    return plainText;
  }
}

// Extensions Shiki's language ids and aliases don't already cover.
const extraExtensions: Record<string, string> = {
  cjs: "javascript",
  mjs: "javascript",
  cts: "typescript",
  mts: "typescript",
  h: "c",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  htm: "html",
  xhtml: "html",
  mdown: "markdown",
  pyi: "python",
  svg: "xml",
  zsh: "shellscript",
  bash: "shellscript",
  conf: "ini",
  cfg: "ini",
  txt: plainText,
  lock: plainText,
};

const fileNames: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  justfile: "just",
  "cmakelists.txt": "cmake",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
  ".env": "dotenv",
};

const extensions = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  for (const key of [info.id, ...(info.aliases ?? [])]) {
    if (!extensions.has(key)) extensions.set(key, info.id);
  }
}
for (const [ext, lang] of Object.entries(extraExtensions)) extensions.set(ext, lang);

function known(lang: string | undefined): lang is string {
  return lang !== undefined && (lang === plainText || Object.hasOwn(bundledLanguages, lang));
}

export function languageForPath(path: string): string {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const byName = fileNames[name];
  if (known(byName)) return byName;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return plainText;
  const byExtension = extensions.get(name.slice(dot + 1));
  return known(byExtension) ? byExtension : plainText;
}

function lineTransformer({ lineNumbers, highlightLines }: HighlightOptions): ShikiTransformer {
  return {
    name: "throng:lines",
    pre(node) {
      if (lineNumbers) this.addClassToHast(node, "line-numbers");
    },
    line(node, line) {
      if (lineNumbers) {
        node.properties["data-line"] = line;
        node.properties["id"] = `L${line}`;
      }
      if (highlightLines && line >= highlightLines.start && line <= highlightLines.end) {
        this.addClassToHast(node, "highlighted");
      }
    },
  };
}

export async function highlight(code: string, options: HighlightOptions): Promise<string> {
  const requested = options.lang ?? (options.path ? languageForPath(options.path) : plainText);
  const [hl, lang] = await Promise.all([getHighlighter(), loadLanguage(requested)]);
  return hl.codeToHtml(code, {
    lang,
    themes,
    defaultColor: "light",
    transformers: [lineTransformer(options)],
  });
}

type RehypeTransformer = ReturnType<typeof rehypeShikiFromHighlighter>;

/** Highlights the code blocks in a hast tree, loading their languages on demand. */
export async function highlightTree(...args: Parameters<RehypeTransformer>): Promise<void> {
  const hl = await getHighlighter();
  await rehypeShikiFromHighlighter(hl, {
    themes,
    defaultColor: "light",
    lazy: true,
    fallbackLanguage: plainText,
    defaultLanguage: plainText,
  })(...args);
}
