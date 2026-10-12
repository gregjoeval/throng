import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app";
import { serveRepo } from "./repo";
import { server } from "./server";

const FILES = {
  "README.md": "# Alpha\n\nSee the [guide](docs/guide.md).\n\n![logo](docs/logo.png)\n",
  "package.json": '{ "name": "alpha" }\n',
  "src/index.ts": "export const a = 1;\n",
  "src/lib/util.ts": "export const b = 2;\n",
  "docs/guide.md": "# Guide\n\nRead **this**.\n",
  "docs/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]),
  "big.txt": "x".repeat(1024 * 1024 + 1),
};

const entriesList = () => screen.findByRole("table", { name: "Files" });
const rowNames = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );

describe("project home", () => {
  it("lists the root directory at main, with the README rendered below", async () => {
    const asked = serveRepo({ main: FILES });
    await renderApp("/ada/alpha");
    const table = await entriesList();
    expect(rowNames(table).map(([name]) => name)).toEqual(["docs", "src", "README.md", "big.txt", "package.json"]);
    expect(within(table).getByRole("link", { name: "docs" })).toHaveAttribute("href", "/ada/alpha/tree/main/docs");
    const readme = await screen.findByRole("region", { name: "README.md" });
    expect(await within(readme).findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(asked).toContain("tree main  +sizes");
    expect(asked).toContain("blob main README.md");
  });

  it("resolves the README's relative links and images against the repo", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha");
    const readme = await screen.findByRole("region", { name: "README.md" });
    expect(await within(readme).findByRole("link", { name: "guide" })).toHaveAttribute(
      "href",
      "/ada/alpha/blob/main/docs/guide.md",
    );
    expect(within(readme).getByRole("img", { name: "logo" })).toHaveAttribute(
      "src",
      "/ada/alpha/raw/main/docs/logo.png",
    );
  });

  it("finds a README by any case, with or without .md", async () => {
    serveRepo({ main: { "src/a.ts": "a\n", readme: "Plain words.\n" } });
    await renderApp("/ada/alpha");
    const readme = await screen.findByRole("region", { name: "readme" });
    expect(await within(readme).findByText("Plain words.")).toBeInTheDocument();
  });

  it("shows no README when there's none", async () => {
    const asked = serveRepo({ main: { "src/a.ts": "a\n" } });
    await renderApp("/ada/alpha");
    await entriesList();
    expect(screen.queryByRole("region")).toBeNull();
    expect(asked.filter((url) => url.startsWith("blob"))).toEqual([]);
  });

  it("says so when main has no commits yet", async () => {
    serveRepo({}, { main: { ref: "main", sha: null }, active: [], archived: [] });
    await renderApp("/ada/alpha");
    expect(await screen.findByText("Nothing pushed yet")).toBeInTheDocument();
  });
});

describe("the directory view", () => {
  it("lists a directory's entries, folders first, with each file's size", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha/tree/main/src");
    const table = await entriesList();
    expect(rowNames(table)).toEqual([
      ["lib", ""],
      ["index.ts", "20 B"],
    ]);
    expect(within(table).getByRole("link", { name: "lib" })).toHaveAttribute("href", "/ada/alpha/tree/main/src/lib");
    expect(within(table).getByRole("link", { name: "index.ts" })).toHaveAttribute(
      "href",
      "/ada/alpha/blob/main/src/index.ts",
    );
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByText("src")).toHaveAttribute("aria-current", "page");
  });

  it("opens a folder, then a file, keeping the attempt hint", async () => {
    const sha = "b".repeat(40);
    serveRepo({ [sha]: FILES }, { main: { ref: "main", sha: null }, active: [], archived: [] });
    const { user, path } = await renderApp(`/ada/alpha/tree/${sha}?attempt=t42a3`);
    await user.click(within(await entriesList()).getByRole("link", { name: "src" }));
    await waitFor(() => expect(path()).toBe(`/ada/alpha/tree/${sha}/src?attempt=t42a3`));
    await user.click(within(await entriesList()).getByRole("link", { name: "index.ts" }));
    await waitFor(() => expect(path()).toBe(`/ada/alpha/blob/${sha}/src/index.ts?attempt=t42a3`));
  });

  it("shows notFound for a missing directory", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha/tree/main/nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("no directory nope at main");
  });
});

const switcher = () => screen.findByRole("button", { name: /^Ref: /u });
/** The items of the switcher's menu group named `name`. */
const items = async (name: string) =>
  within(await screen.findByRole("group", { name }))
    .getAllByRole("menuitem")
    .map((item) => item.textContent);

describe("the ref switcher", () => {
  it("lists main, then the active attempts and the archived ones, grouped", async () => {
    serveRepo({ main: FILES });
    const { user } = await renderApp("/ada/alpha/tree/main/src");
    await user.click(await switcher());
    expect(await items("Main")).toEqual(["main"]);
    expect(await items("Active attempts")).toEqual(["t42a3"]);
    expect(await items("Archived attempts")).toEqual(["t41a1"]);
  });

  it("keeps the path when it exists at the ref switched to", async () => {
    const asked = serveRepo({ main: FILES, t42a3: FILES });
    const { user, path } = await renderApp("/ada/alpha/blob/main/src/index.ts");
    await user.click(await switcher());
    await user.click(await screen.findByRole("menuitem", { name: "t42a3" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/blob/t42a3/src/index.ts"));
    expect(await switcher()).toHaveAccessibleName("Ref: t42a3");
    expect(asked).toContain("blob t42a3 src/index.ts");
  });

  it("opens the root of the ref switched to when the path isn't there", async () => {
    serveRepo({ main: FILES, t41a1: { "other.md": "o\n" } });
    const { user, path } = await renderApp("/ada/alpha/tree/main/src/lib");
    await user.click(await switcher());
    await user.click(await screen.findByRole("menuitem", { name: "t41a1" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tree/t41a1"));
    expect(await screen.findByRole("link", { name: "other.md" })).toBeInTheDocument();
  });

  it("keeps the path when it can't tell whether the path is there", async () => {
    serveRepo({ main: FILES, t42a3: FILES });
    server.use(http.get("*/api/projects/:owner/:project/blob/t42a3/*", () => new HttpResponse(null, { status: 502 })));
    const { user, path } = await renderApp("/ada/alpha/blob/main/src/index.ts");
    await user.click(await switcher());
    await user.click(await screen.findByRole("menuitem", { name: "t42a3" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/blob/t42a3/src/index.ts"));
  });

  it("drops the attempt hint, which only a sha needs", async () => {
    const sha = "b".repeat(40);
    serveRepo({ [sha]: FILES, main: FILES });
    const { user, path } = await renderApp(`/ada/alpha/tree/${sha}/src?attempt=t42a3`);
    expect(await switcher()).toHaveAccessibleName(`Ref: ${sha.slice(0, 7)}`);
    await user.click(await switcher());
    await user.click(await screen.findByRole("menuitem", { name: "main" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tree/main/src"));
  });

  it("switches project home to the root of another ref", async () => {
    serveRepo({ main: FILES, t42a3: FILES });
    const { user, path } = await renderApp("/ada/alpha");
    await user.click(await switcher());
    await user.click(await screen.findByRole("menuitem", { name: "t42a3" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tree/t42a3"));
  });
});

const CODE = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n";
const gutter = () => screen.findByRole("navigation", { name: "Line numbers" });
/** The numbers of the lines marked highlighted, once Shiki has rendered them. */
async function highlighted() {
  await waitFor(() => expect(document.querySelector("pre span[style*='--shiki-dark']")).not.toBeNull());
  return [...document.querySelectorAll(".line")].flatMap((line, i) =>
    line.classList.contains("highlighted") ? [i + 1] : [],
  );
}

describe("the file view", () => {
  it("shows a text file highlighted, with a numbered link to each line", async () => {
    serveRepo({ main: { "src/a.ts": CODE } });
    await renderApp("/ada/alpha/blob/main/src/a.ts");
    const lines = within(await gutter()).getAllByRole("link");
    expect(lines.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["1", "#L1"],
      ["2", "#L2"],
      ["3", "#L3"],
      ["4", "#L4"],
      ["5", "#L5"],
    ]);
    expect(await highlighted()).toEqual([]);
    expect(screen.getByRole("region", { name: "a.ts" })).toHaveTextContent("const c = 3;");
  });

  it("selects a line on click, then a range on shift-click", async () => {
    serveRepo({ main: { "src/a.ts": CODE } });
    const { user, router } = await renderApp("/ada/alpha/blob/main/src/a.ts");
    await user.click(within(await gutter()).getByRole("link", { name: "2" }));
    await waitFor(() => expect(router.state.location.hash).toBe("L2"));
    await waitFor(async () => expect(await highlighted()).toEqual([2]));
    await user.keyboard("{Shift>}");
    await user.click(within(await gutter()).getByRole("link", { name: "4" }));
    await user.keyboard("{/Shift}");
    await waitFor(() => expect(router.state.location.hash).toBe("L2-L4"));
    await waitFor(async () => expect(await highlighted()).toEqual([2, 3, 4]));
    expect(router.state.location.pathname).toBe("/ada/alpha/blob/main/src/a.ts");
  });

  it("orders a range picked upwards, and highlights the lines a URL's anchor names", async () => {
    serveRepo({ main: { "src/a.ts": CODE } });
    const { user, router } = await renderApp("/ada/alpha/blob/main/src/a.ts#L4");
    await waitFor(async () => expect(await highlighted()).toEqual([4]));
    await user.keyboard("{Shift>}");
    await user.click(within(await gutter()).getByRole("link", { name: "1" }));
    await user.keyboard("{/Shift}");
    await waitFor(() => expect(router.state.location.hash).toBe("L1-L4"));
  });

  it("renders Markdown by default, with a toggle to its source", async () => {
    serveRepo({ main: FILES });
    const { user } = await renderApp("/ada/alpha/blob/main/docs/guide.md");
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Guide" })).toBeNull();
    expect(await gutter()).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "guide.md" })).toHaveTextContent("Read **this**.");
  });

  it("keeps the attempt hint on a Markdown file's relative links and images at a sha", async () => {
    const sha = "b".repeat(40);
    serveRepo({ [sha]: FILES }, { main: { ref: "main", sha: null }, active: [], archived: [] });
    await renderApp(`/ada/alpha/blob/${sha}/README.md?attempt=t42a3`);
    const file = await screen.findByRole("region", { name: "README.md" });
    expect(await within(file).findByRole("link", { name: "guide" })).toHaveAttribute(
      "href",
      `/ada/alpha/blob/${sha}/docs/guide.md?attempt=t42a3`,
    );
    expect(within(file).getByRole("img", { name: "logo" })).toHaveAttribute(
      "src",
      `/ada/alpha/raw/${sha}/docs/logo.png?attempt=t42a3`,
    );
  });

  it("opens Markdown at its source when the URL names a line", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha/blob/main/docs/guide.md#L3");
    expect(await gutter()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an image inline from /raw", async () => {
    serveRepo({ [`${"b".repeat(40)}`]: FILES }, { main: { ref: "main", sha: null }, active: [], archived: [] });
    await renderApp(`/ada/alpha/blob/${"b".repeat(40)}/docs/logo.png?attempt=t42a3`);
    expect(await screen.findByRole("img", { name: "logo.png" })).toHaveAttribute(
      "src",
      `/ada/alpha/raw/${"b".repeat(40)}/docs/logo.png?attempt=t42a3`,
    );
  });

  it("shows any image type the platform serves as one inline", async () => {
    serveRepo({ main: { "art/photo.avif": new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]) } });
    await renderApp("/ada/alpha/blob/main/art/photo.avif");
    expect(await screen.findByRole("img", { name: "photo.avif" })).toHaveAttribute(
      "src",
      "/ada/alpha/raw/main/art/photo.avif",
    );
  });

  it("shows a binary file's size and a raw link instead of its content", async () => {
    serveRepo({ main: { "bin/tool": new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]) } });
    await renderApp("/ada/alpha/blob/main/bin/tool");
    expect(await screen.findByText("Binary file, 8 B")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View raw" })).toHaveAttribute("href", "/ada/alpha/raw/main/bin/tool");
  });

  it("shows a too-large file's size and a raw link instead of its content", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha/blob/main/big.txt");
    expect(await screen.findByText("Too large to show, 1.0 MB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View raw" })).toHaveAttribute("href", "/ada/alpha/raw/main/big.txt");
  });

  it("offers every file's raw bytes", async () => {
    serveRepo({ main: { "src/a.ts": CODE } });
    await renderApp("/ada/alpha/blob/main/src/a.ts");
    expect(await screen.findByRole("link", { name: "Raw" })).toHaveAttribute("href", "/ada/alpha/raw/main/src/a.ts");
    expect(screen.getByText("5 lines · 65 B")).toBeInTheDocument();
  });

  it("shows notFound for a missing file", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha/blob/main/nope.ts");
    expect(await screen.findByRole("alert")).toHaveTextContent("no file nope.ts at main");
  });
});

const sidebar = () => screen.findByRole("treegrid", { name: "File tree" });
/**
 * Each row of the sidebar's tree as its name indented two spaces a level, after `+` or `-` for a
 * folder shut or open, and with ` *` when it's selected.
 */
const outline = (tree: HTMLElement) =>
  within(tree)
    .getAllByRole("row")
    .map((row) => {
      const level = Number(row.getAttribute("aria-level"));
      const expanded = row.getAttribute("aria-expanded");
      const marks: Record<string, string> = { true: "- ", false: "+ " };
      const mark = expanded === null ? "" : (marks[expanded] ?? "");
      const selected = row.getAttribute("aria-selected") === "true" ? " *" : "";
      return `${"  ".repeat(level - 1)}${mark}${row.textContent}${selected}`;
    });

describe("the file tree sidebar", () => {
  it("opens at the current path, its folders expanded and the current one selected", async () => {
    serveRepo({ main: FILES });
    await renderApp("/ada/alpha/blob/main/src/lib/util.ts");
    const tree = await sidebar();
    await waitFor(() =>
      expect(outline(tree)).toEqual([
        "+ docs",
        "- src",
        "  - lib",
        "    util.ts *",
        "  index.ts",
        "README.md",
        "big.txt",
        "package.json",
      ]),
    );
  });

  it("loads a folder's contents only when it's expanded", async () => {
    const asked = serveRepo({ main: FILES });
    const { user } = await renderApp("/ada/alpha/tree/main/src");
    const tree = await sidebar();
    await waitFor(() => expect(outline(tree)).toContain("  index.ts"));
    expect(asked).not.toContain("tree main docs");
    const docs = within(tree).getByRole("row", { name: /docs/u });
    await user.click(within(docs).getByRole("button", { name: /expand/iu }));
    await waitFor(() => expect(outline(tree)).toContain("  guide.md"));
    // The sidebar shows no sizes, so it never asks for them.
    expect(asked).toContain("tree main docs");
    expect(asked).toContain("tree main src");
  });

  it("says so when a folder can't be read, instead of loading forever", async () => {
    serveRepo({ main: FILES });
    server.use(
      http.get("*/api/projects/:owner/:project/tree/main/docs", () => new HttpResponse(null, { status: 502 })),
    );
    await renderApp("/ada/alpha/tree/main/docs");
    const tree = await sidebar();
    await waitFor(() => expect(outline(tree)).toContain("  Couldn't load this folder"));
  });

  it("opens a file picked in the tree, keeping the ref and attempt hint", async () => {
    const sha = "b".repeat(40);
    serveRepo({ [sha]: FILES }, { main: { ref: "main", sha: null }, active: [], archived: [] });
    const { user, path } = await renderApp(`/ada/alpha/tree/${sha}/src?attempt=t42a3`);
    await user.click(await within(await sidebar()).findByRole("row", { name: "index.ts" }));
    await waitFor(() => expect(path()).toBe(`/ada/alpha/blob/${sha}/src/index.ts?attempt=t42a3`));
    await waitFor(async () => expect(outline(await sidebar())).toContain("  index.ts *"));
  });
});
