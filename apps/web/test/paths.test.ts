import { describe, expect, it } from "vitest";
import { buildPath, parsePath, rawApiUrl } from "@/lib/paths";
import type { ProjectLocation } from "@/lib/paths";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const at = { owner: "greg", project: "throng" };

describe("buildPath and parsePath", () => {
  const cases: [ProjectLocation, string][] = [
    [{ ...at, view: "home" }, "/greg/throng"],
    [{ ...at, view: "tasks" }, "/greg/throng/tasks"],
    [{ ...at, view: "settings" }, "/greg/throng/settings"],
    [{ ...at, view: "task", task: "t42" }, "/greg/throng/tasks/t42"],
    [{ ...at, view: "runs" }, "/greg/throng/runs"],
    [
      { ...at, view: "runs", line: "main", status: "waiting", cursor: 40 },
      "/greg/throng/runs?line=main&status=waiting&cursor=40",
    ],
    [{ ...at, view: "runs", line: "t42a3" }, "/greg/throng/runs?line=t42a3"],
    [{ ...at, view: "run", run: 7 }, "/greg/throng/runs/7"],
    [{ ...at, view: "tree", ref: "main", path: "" }, "/greg/throng/tree/main"],
    [{ ...at, view: "tree", ref: "t42a3", path: "src/lib" }, "/greg/throng/tree/t42a3/src/lib"],
    [{ ...at, view: "blob", ref: "main", path: "docs/my notes.md" }, "/greg/throng/blob/main/docs/my%20notes.md"],
    [
      { ...at, view: "blob", ref: "main", path: "naïve/日本語.txt" },
      "/greg/throng/blob/main/na%C3%AFve/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt",
    ],
    [
      { ...at, view: "blob", ref: "main", path: "odd/a#b?c%d+e&f.txt" },
      "/greg/throng/blob/main/odd/a%23b%3Fc%25d%2Be%26f.txt",
    ],
    [
      { ...at, view: "raw", ref: SHA, path: "img/logo 🙂.png", attempt: "t42a3" },
      `/greg/throng/raw/${SHA}/img/logo%20%F0%9F%99%82.png?attempt=t42a3`,
    ],
    [{ ...at, view: "commits", ref: "main" }, "/greg/throng/commits/main"],
    [{ ...at, view: "commits", ref: "main", offset: 50 }, "/greg/throng/commits/main?offset=50"],
    [
      { ...at, view: "commits", ref: SHA, attempt: "t42a3", offset: 100 },
      `/greg/throng/commits/${SHA}?attempt=t42a3&offset=100`,
    ],
    [{ ...at, view: "commit", sha: SHA }, `/greg/throng/commit/${SHA}`],
    [{ ...at, view: "commit", sha: SHA, attempt: "t42a3" }, `/greg/throng/commit/${SHA}?attempt=t42a3`],
  ];

  it.each(cases)("round-trips %o", (location, path) => {
    expect(buildPath(location)).toBe(path);
    expect(parsePath(path)).toEqual(location);
  });

  it("ignores a trailing slash, the hash and other query parameters", () => {
    expect(parsePath("/greg/throng/tree/main/src/?x=1#top")).toEqual({ ...at, view: "tree", ref: "main", path: "src" });
    expect(parsePath("https://throng.example/greg/throng/")).toEqual({ ...at, view: "home" });
  });

  it("is null for anything that isn't a project view", () => {
    for (const path of [
      "/",
      "/greg",
      "/greg/throng/tree",
      "/greg/throng/settings/main",
      "/greg/throng/runs/0",
      "/greg/throng/runs/x",
      "/greg/throng/runs/7/logs",
      "/greg/throng/commits/main/extra",
      "/greg/throng/commit/abc/extra",
      "/greg/throng/blob/main/a//b",
      "/greg/throng/blob/main/%E0%A4%A",
    ]) {
      expect(parsePath(path), path).toBeNull();
    }
  });

  it("drops a commit log offset that isn't a positive integer", () => {
    for (const offset of ["0", "-50", "1.5", "x", ""]) {
      expect(parsePath(`/greg/throng/commits/main?offset=${offset}`), offset).toEqual({
        ...at,
        view: "commits",
        ref: "main",
      });
    }
    expect(buildPath({ ...at, view: "commits", ref: "main", offset: 0 })).toBe("/greg/throng/commits/main");
  });

  it("drops a runs list cursor that isn't a positive integer, and empty filters", () => {
    for (const cursor of ["0", "-5", "1.5", "x", ""]) {
      expect(parsePath(`/greg/throng/runs?cursor=${cursor}&line=&status=`), cursor).toEqual({ ...at, view: "runs" });
    }
    expect(buildPath({ ...at, view: "runs", line: undefined, status: "done" })).toBe("/greg/throng/runs?status=done");
  });

  it("treats a path's stray slashes as separators", () => {
    expect(buildPath({ ...at, view: "tree", ref: "main", path: "/src//lib/" })).toBe("/greg/throng/tree/main/src/lib");
  });
});

describe("rawApiUrl", () => {
  it("maps a raw file URL onto the platform's raw endpoint, keeping the attempt hint", () => {
    const url = new URL(`https://web.example/greg/throng/raw/${SHA}/a%20b/%C3%A9.png?attempt=t42a3&x=1`);
    expect(rawApiUrl(url)?.href).toBe(
      `https://web.example/api/projects/greg/throng/raw/${SHA}/a%20b/%C3%A9.png?attempt=t42a3`,
    );
  });

  it("is null for other URLs, and for a raw URL without a file", () => {
    for (const path of ["/greg/throng/blob/main/a.txt", "/greg/throng/raw/main", "/api/me", "/"]) {
      expect(rawApiUrl(new URL(path, "https://web.example")), path).toBeNull();
    }
  });
});
