import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown, resolveUrl } from "@/components/markdown";

async function renderMarkdown(source: string, props: { baseUrl?: string; imageBaseUrl?: string } = {}) {
  const { container } = render(<Markdown {...props}>{source}</Markdown>);
  await waitFor(() => expect(container.querySelector(".markdown")?.childElementCount).toBeGreaterThan(0));
  return container;
}

test("strips scripts and iframes", async () => {
  const container = await renderMarkdown(
    [
      "Before",
      "",
      '<script>alert("x")</script>',
      "",
      '<iframe src="https://evil.example"></iframe>',
      "",
      'Inline <img src=x onerror="alert(1)"> html',
      "",
      "[click](javascript:alert(1))",
    ].join("\n"),
  );
  expect(screen.getByText("Before")).toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.innerHTML).not.toContain("alert");
  expect(screen.getByText("click")).not.toHaveAttribute("href", expect.stringContaining("javascript"));
});

test("renders GFM tables and task lists", async () => {
  const container = await renderMarkdown(
    ["| Name | Value |", "| ---- | ----- |", "| a | 1 |", "", "- [x] done", "- [ ] todo"].join("\n"),
  );
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes].map((box) => box.checked)).toEqual([true, false]);
});

test("highlights a fenced code block", async () => {
  const container = await renderMarkdown("```ts\nconst answer: number = 42;\n```");
  await waitFor(() => expect(container.querySelector("pre.shiki")).not.toBeNull());
  const pre = container.querySelector("pre.shiki");
  expect(pre).toHaveTextContent("const answer: number = 42;");
  expect(pre?.querySelector("span[style*='--shiki-dark']")).not.toBeNull();
});

test("a code block in an unknown language falls back to plain text", async () => {
  const container = await renderMarkdown("```no-such-language\n<b>plain</b>\n```");
  await waitFor(() => expect(container.querySelector("pre.shiki")).not.toBeNull());
  expect(container.querySelector("pre.shiki")).toHaveTextContent("<b>plain</b>");
  expect(container.querySelector("pre b")).toBeNull();
});

test("resolves relative links and images against the base", async () => {
  await renderMarkdown(
    [
      "[guide](docs/guide.md) [up](../x.md) [anchor](#usage) [abs](https://example.com/a)",
      "",
      "![logo](img/logo.png)",
    ].join("\n"),
    { baseUrl: "/ada/throng/blob/main/", imageBaseUrl: "/ada/throng/raw/main/" },
  );
  expect(screen.getByText("guide")).toHaveAttribute("href", "/ada/throng/blob/main/docs/guide.md");
  expect(screen.getByText("up")).toHaveAttribute("href", "/ada/throng/blob/x.md");
  expect(screen.getByText("anchor")).toHaveAttribute("href", "#usage");
  expect(screen.getByText("abs")).toHaveAttribute("href", "https://example.com/a");
  expect(screen.getByRole("img", { name: "logo" })).toHaveAttribute("src", "/ada/throng/raw/main/img/logo.png");
});

test("links are rel=noopener noreferrer", async () => {
  await renderMarkdown("[site](https://example.com)");
  expect(screen.getByText("site")).toHaveAttribute("rel", "noopener noreferrer");
});

test("resolveUrl keeps absolute bases absolute", () => {
  expect(resolveUrl("a.md", "https://host.example/x/")).toBe("https://host.example/x/a.md");
  expect(resolveUrl("a.md", undefined)).toBe("a.md");
  expect(resolveUrl("mailto:a@b.c", "/x/")).toBe("mailto:a@b.c");
});
