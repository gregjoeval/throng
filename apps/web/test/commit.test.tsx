import { act, screen, waitFor, within } from "@testing-library/react";
import type { InferResponseType } from "hono/client";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { client, CommitDiff, FileDiff } from "@/lib/api";
import { renderApp } from "./app";
import { server } from "./server";

type Commit = InferResponseType<(typeof client.api.projects)[":owner"][":project"]["commit"][":sha"]["$get"], 200>;

const SHA = "c".repeat(40);
const PARENT = "d".repeat(40);
const OTHER_PARENT = "e".repeat(40);

const COMMIT: Commit = {
  sha: SHA,
  tree: "f".repeat(40),
  parents: [PARENT],
  message:
    "Teach the parser <b>tags</b>\n\nIt now reads <b> as text.\n\nCo-authored-by: ada (claude) <u1+claude@users.noreply.throng>\n",
  author: { name: "ada (claude)", email: "u1+claude@users.noreply.throng", date: "2026-10-10T12:00:00.000Z" },
  committer: { name: "Throng", email: "noreply@users.noreply.throng", date: "2026-10-11T12:00:00.000Z" },
};

/** A file whose one-line change has `before` and `after` as the changed line. */
function modified(path: string, before = "const b = 2;", after = "const b = 3;"): FileDiff {
  return {
    path,
    status: "modified",
    oldMode: "100644",
    newMode: "100644",
    oldHash: "1".repeat(40),
    newHash: "2".repeat(40),
    additions: 1,
    deletions: 1,
    flags: [],
    patch: [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      `-${before}`,
      `+${after}`,
      "",
    ].join("\n"),
  };
}

function added(path: string, line: string): FileDiff {
  return {
    path,
    status: "added",
    oldMode: null,
    newMode: "100644",
    oldHash: null,
    newHash: "3".repeat(40),
    additions: 1,
    deletions: 0,
    flags: [],
    patch: [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      `+++ b/${path}`,
      "@@ -0,0 +1 @@",
      `+${line}`,
      "",
    ].join("\n"),
  };
}

/** A file listed without a patch because of `flag`. */
function flagged(path: string, flag: FileDiff["flags"][number]): FileDiff {
  return { ...modified(path), additions: 0, deletions: 0, flags: [flag], patch: undefined };
}

function diffOf(files: FileDiff[], overrides: Partial<CommitDiff> = {}): CommitDiff {
  return {
    sha: SHA,
    parent: PARENT,
    oldTree: "a".repeat(40),
    newTree: "f".repeat(40),
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    },
    truncated: false,
    ...overrides,
  };
}

/** Serves one commit and its diff; returns the attempt hints the platform was asked with. */
function serveCommit(commit: Commit, diff: CommitDiff) {
  const hints: (string | null)[] = [];
  server.use(
    http.get("*/api/projects/:owner/:project/commit/:sha", ({ request }) => {
      hints.push(new URL(request.url).searchParams.get("attempt"));
      return HttpResponse.json(commit);
    }),
    http.get("*/api/projects/:owner/:project/commit/:sha/diff", () => HttpResponse.json(diff)),
  );
  return hints;
}

const section = (path: string) => screen.getByRole("region", { name: path });
const fileList = () => screen.getByRole("list", { name: "Files changed" });

/** The text a file's rendered diff shows, once the renderer has drawn it. */
function diffText(path: string): string | undefined {
  return section(path).querySelector("diffs-container")?.shadowRoot?.textContent ?? undefined;
}

describe("the commit view", () => {
  it("shows the full message as plain text, the author and committer, and a parent link", async () => {
    serveCommit(COMMIT, diffOf([modified("src/a.ts")]));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    expect(await screen.findByRole("heading", { name: "Teach the parser <b>tags</b>" })).toBeInTheDocument();
    const message = screen.getByTestId("commit-message");
    expect(message).toHaveTextContent("It now reads <b> as text.");
    expect(message.querySelector("b")).toBeNull();
    const people = screen.getByRole("list", { name: "People" });
    expect(within(people).getByText("Authored by").parentElement).toHaveTextContent("ada");
    expect(within(people).getByText("claude")).toHaveAttribute("title", "Alias");
    expect(within(people).getByText("Committed by").parentElement).toHaveTextContent("Throng");
    expect(screen.getByRole("link", { name: PARENT.slice(0, 7) })).toHaveAttribute(
      "href",
      `/ada/alpha/commit/${PARENT}`,
    );
  });

  it("links every parent of a merge commit, keeping the attempt hint", async () => {
    const hints = serveCommit({ ...COMMIT, parents: [PARENT, OTHER_PARENT] }, diffOf([modified("src/a.ts")]));
    await renderApp(`/ada/alpha/commit/${SHA}?attempt=t42a3`);
    expect(await screen.findByRole("link", { name: OTHER_PARENT.slice(0, 7) })).toHaveAttribute(
      "href",
      `/ada/alpha/commit/${OTHER_PARENT}?attempt=t42a3`,
    );
    expect(screen.getByText(/against its first parent/u)).toBeInTheDocument();
    expect(hints).toEqual(["t42a3"]);
  });

  it("lists the files with their status and +/- counts, and renders a diff for each", async () => {
    serveCommit(COMMIT, diffOf([modified("src/a.ts"), added("src/new.ts", "export const fresh = true;")]));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    const first = await within(await screen.findByRole("list", { name: "Files changed" })).findByRole("listitem", {
      name: "src/a.ts",
    });
    expect(first).toHaveTextContent("modified");
    expect(first).toHaveTextContent("+1");
    expect(first).toHaveTextContent("−1");
    expect(within(fileList()).getByRole("listitem", { name: "src/new.ts" })).toHaveTextContent("added");
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
    await waitFor(() => expect(diffText("src/a.ts")).toContain("const b = 3;"));
    await waitFor(() => expect(diffText("src/new.ts")).toContain("export const fresh = true;"));
  });

  it("shows a root commit with no parent", async () => {
    serveCommit({ ...COMMIT, parents: [] }, diffOf([added("README.md", "# alpha")], { parent: null, oldTree: null }));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    expect(await screen.findByText("Root commit")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: PARENT.slice(0, 7) })).toBeNull();
    await waitFor(() => expect(diffText("README.md")).toContain("# alpha"));
  });

  it.each([
    ["tooLarge", "too large to diff"],
    ["binary", "Binary file"],
    ["tooComplex", "too complex to diff"],
    ["truncated", "left out"],
  ] as const)("shows a %s file as a notice in place of its diff", async (flag, notice) => {
    serveCommit(COMMIT, diffOf([flagged("data/blob.bin", flag), modified("src/a.ts")]));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    await screen.findByRole("list", { name: "Files changed" });
    expect(within(section("data/blob.bin")).getByRole("note")).toHaveTextContent(notice);
    expect(section("data/blob.bin").querySelector("diffs-container")).toBeNull();
    await waitFor(() => expect(diffText("src/a.ts")).toContain("const b = 3;"));
  });

  it("shows a file cut short by the patch cap with a notice above what was kept", async () => {
    const cut = { ...modified("src/big.ts"), flags: ["truncated" as const] };
    serveCommit(COMMIT, diffOf([cut]));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    await screen.findByRole("list", { name: "Files changed" });
    expect(within(section("src/big.ts")).getByRole("note")).toHaveTextContent("cut short");
    await waitFor(() => expect(diffText("src/big.ts")).toContain("const b = 3;"));
  });

  it("says so when more files changed than are listed", async () => {
    serveCommit(
      COMMIT,
      diffOf([modified("src/a.ts")], { truncated: true, totals: { files: 3001, additions: 1, deletions: 1 } }),
    );
    await renderApp(`/ada/alpha/commit/${SHA}`);
    expect(await screen.findByRole("note", { name: "Files left out" })).toHaveTextContent(
      "Only the first 1 of 3001 changed files are listed.",
    );
  });

  it("shows renames from their old path, and a rename without changes as a note", async () => {
    const moved: FileDiff = {
      path: "src/new-name.ts",
      oldPath: "src/old-name.ts",
      status: "renamed",
      oldMode: "100644",
      newMode: "100644",
      oldHash: "4".repeat(40),
      newHash: "4".repeat(40),
      additions: 0,
      deletions: 0,
      flags: [],
      patch:
        "diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\nrename from src/old-name.ts\nrename to src/new-name.ts\n",
    };
    serveCommit(COMMIT, diffOf([moved]));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    const row = await within(await screen.findByRole("list", { name: "Files changed" })).findByRole("listitem", {
      name: "src/new-name.ts",
    });
    expect(row).toHaveTextContent("src/old-name.ts → src/new-name.ts");
    expect(row).toHaveTextContent("renamed");
    expect(within(section("src/new-name.ts")).getByRole("note")).toHaveTextContent("Renamed without changes.");
  });

  it("shows notFound for an unknown commit", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project/commit/:sha", () =>
        HttpResponse.json({ error: { code: "notFound", message: `no commit ${SHA}` } }, { status: 404 }),
      ),
      http.get("*/api/projects/:owner/:project/commit/:sha/diff", () =>
        HttpResponse.json({ error: { code: "notFound", message: `no commit ${SHA}` } }, { status: 404 }),
      ),
    );
    await renderApp(`/ada/alpha/commit/${SHA}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(`no commit ${SHA}`);
  });
});

describe("lazy rendering", () => {
  /** An IntersectionObserver the test drives: `show(path)` scrolls that file's section into view. */
  class FakeObserver {
    static all: FakeObserver[] = [];
    targets: Element[] = [];
    constructor(private readonly callback: IntersectionObserverCallback) {
      FakeObserver.all.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve(target: Element) {
      this.targets = this.targets.filter((t) => t !== target);
    }
    disconnect() {
      this.targets = [];
    }
    static show(target: Element) {
      for (const observer of FakeObserver.all) {
        if (!observer.targets.includes(target)) continue;
        const entry = { target, isIntersecting: true } as IntersectionObserverEntry;
        observer.callback([entry], observer as unknown as IntersectionObserver);
      }
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeObserver.all = [];
  });

  it("renders a file's diff only once it scrolls into view", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    serveCommit(COMMIT, diffOf([modified("src/a.ts"), modified("src/b.ts", "old b", "new b")]));
    await renderApp(`/ada/alpha/commit/${SHA}`);
    await screen.findByRole("list", { name: "Files changed" });
    expect(section("src/a.ts").querySelector("diffs-container")).toBeNull();
    expect(section("src/b.ts").querySelector("diffs-container")).toBeNull();

    act(() => FakeObserver.show(section("src/b.ts")));
    await waitFor(() => expect(diffText("src/b.ts")).toContain("new b"));
    expect(section("src/a.ts").querySelector("diffs-container")).toBeNull();
  });
});
