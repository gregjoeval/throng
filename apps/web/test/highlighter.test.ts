import { describe, expect, test } from "vitest";
import { highlight, languageForPath, loadLanguage, loadShiki } from "@/lib/highlighter";

describe("languageForPath", () => {
  test.each([
    ["src/index.ts", "typescript"],
    ["app.tsx", "tsx"],
    ["lib/util.mjs", "javascript"],
    ["main.rs", "rust"],
    ["script.py", "python"],
    ["README.md", "markdown"],
    ["config.yml", "yaml"],
    ["Dockerfile", "docker"],
    ["Makefile", "make"],
    [".env", "dotenv"],
    ["notes.txt", "text"],
    ["data.unknownext", "text"],
    ["LICENSE", "text"],
  ])("%s is %s", async (path, lang) => {
    expect(await languageForPath(path)).toBe(lang);
  });
});

test("the highlighter is shared", async () => {
  const shiki = await loadShiki();
  expect(await loadShiki()).toBe(shiki);
  expect(await shiki.getHighlighter()).toBe(await shiki.getHighlighter());
});

test("loads a known language on demand", async () => {
  expect(await loadLanguage("ts")).toBe("ts");
  const highlighter = await (await loadShiki()).getHighlighter();
  expect(highlighter.getLoadedLanguages()).toContain("typescript");
});

test("an unknown language falls back to plain text", async () => {
  expect(await loadLanguage("no-such-language")).toBe("text");
  const html = await highlight("<b>hi</b>", { lang: "no-such-language" });
  expect(html).toContain('class="shiki');
  expect(html).toContain("&#x3C;b>hi&#x3C;/b>");
});

test("highlights with both themes", async () => {
  const html = await highlight("const a = 1;", { path: "a.ts" });
  expect(html).toContain("github-light github-dark");
  expect(html).toContain("--shiki-dark:");
});

test("numbers lines and highlights a range", async () => {
  const container = document.createElement("div");
  container.innerHTML = await highlight("a\nb\nc\nd", {
    lang: "text",
    lineNumbers: true,
    highlightLines: { start: 2, end: 3 },
  });
  expect(container.querySelector("pre")).toHaveClass("line-numbers");
  const lines = [...container.querySelectorAll(".line")];
  expect(lines.map((line) => line.getAttribute("data-line"))).toEqual(["1", "2", "3", "4"]);
  expect(lines.map((line) => line.id)).toEqual(["L1", "L2", "L3", "L4"]);
  expect(lines.map((line) => line.classList.contains("highlighted"))).toEqual([false, true, true, false]);
});
