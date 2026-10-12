import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app";
import { serveRepo } from "./repo";

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
