import { describe, expect, it } from "vitest";
import { conflictFiles, parseMergeTree, parseZdiff3, type ConflictCaps } from "../src/conflicts.ts";

const entry = (mode: string, oid: string, stage: number, path: string) => `${mode} ${oid} ${stage}\t${path}`;
const B = (c: string) => c.repeat(40);

// Recorded from `git merge-tree --write-tree --messages -z main side` (git 2.47), NULs as \0, oids shortened.
const CONFLICTED = [
  "ebe7b509d6cd1d1fab49fabded050df0cc7734a5",
  entry("100644", B("1"), 1, "del.txt"),
  entry("100644", B("3"), 3, "del.txt"),
  entry("100644", B("a"), 1, "g.js"),
  entry("100644", B("b"), 2, "g.js"),
  entry("100755", B("c"), 3, "g.js"),
  entry("100644", B("d"), 2, "new.txt"),
  entry("100644", B("e"), 3, "new.txt"),
  entry("100644", B("f"), 2, "ren-main.txt"),
  entry("100644", B("f"), 3, "ren-side.txt"),
  entry("100644", B("f"), 1, "ren.txt"),
  "",
  "1",
  "del.txt",
  "CONFLICT (modify/delete)",
  "CONFLICT (modify/delete): del.txt deleted in main and modified in side.  Version side of del.txt left in tree.\n",
  "1",
  "g.js",
  "Auto-merging",
  "Auto-merging g.js\n",
  "1",
  "g.js",
  "CONFLICT (contents)",
  "CONFLICT (content): Merge conflict in g.js\n",
  "1",
  "new.txt",
  "Auto-merging",
  "Auto-merging new.txt\n",
  "1",
  "new.txt",
  "CONFLICT (contents)",
  "CONFLICT (add/add): Merge conflict in new.txt\n",
  "3",
  "ren.txt",
  "ren-main.txt",
  "ren-side.txt",
  "CONFLICT (rename/rename)",
  "CONFLICT (rename/rename): ren.txt renamed to ren-main.txt in main and to ren-side.txt in side.\n",
  "",
].join("\0");

const blobs = (base: string | null, main: string | null, attempt: string | null) => ({ base, main, attempt });

describe("parseMergeTree", () => {
  it("reads a clean merge's tree, with no conflicts", () => {
    expect(parseMergeTree("728f51c4e821881ff40b466785315f5e38ba3641\0\0")).toEqual({
      tree: "728f51c4e821881ff40b466785315f5e38ba3641",
      files: [],
    });
  });

  it("lists every conflicted path once, with its type and the blob and mode of each side", () => {
    expect(parseMergeTree(CONFLICTED)).toEqual({
      tree: "ebe7b509d6cd1d1fab49fabded050df0cc7734a5",
      files: [
        {
          path: "del.txt",
          type: "modify_delete",
          blobs: blobs(B("1"), null, B("3")),
          modes: blobs("100644", null, "100644"),
        },
        {
          path: "g.js",
          type: "content",
          blobs: blobs(B("a"), B("b"), B("c")),
          modes: blobs("100644", "100644", "100755"),
        },
        {
          path: "new.txt",
          type: "add_add",
          blobs: blobs(null, B("d"), B("e")),
          modes: blobs(null, "100644", "100644"),
        },
        { path: "ren-main.txt", type: "rename", blobs: blobs(null, B("f"), null), modes: blobs(null, "100644", null) },
        { path: "ren-side.txt", type: "rename", blobs: blobs(null, null, B("f")), modes: blobs(null, null, "100644") },
        { path: "ren.txt", type: "rename", blobs: blobs(B("f"), null, null), modes: blobs("100644", null, null) },
      ],
    });
  });

  it("keeps a path with a tab or a newline whole", () => {
    const path = "odd\tna\nme.txt";
    const out = ["t".repeat(40), entry("100644", B("a"), 2, path), "", "1", path, "CONFLICT (contents)", "x\n", ""];
    expect(parseMergeTree(out.join("\0")).files).toMatchObject([{ path, type: "content" }]);
  });

  it("calls a conflict with no recognised message a content conflict", () => {
    const out = ["t".repeat(40), entry("100644", B("a"), 2, "dir"), "", "1", "dir", "CONFLICT (file/directory)", "x\n"];
    expect(parseMergeTree([...out, ""].join("\0")).files).toMatchObject([{ path: "dir", type: "content" }]);
  });
});

// Recorded from `git merge-file -p --zdiff3 -L main -L base -L attempt` (git 2.47).
const GREETING =
  '<<<<<<< main\nexport const GREETING = "hello from a1";\n||||||| base\nexport const GREETING = "hello";\n' +
  '=======\nexport const GREETING = "hello from a2";\n>>>>>>> attempt\n\nexport function greet(name) {\n' +
  "  return `${GREETING}, ${name}`;\n}\n";
const MULTI =
  "1\n<<<<<<< main\ntwo-m\n||||||| base\n2\n=======\ntwo-a\n>>>>>>> attempt\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n" +
  "<<<<<<< main\nfifteen-m\n||||||| base\n15\n=======\nfifteen-a\n>>>>>>> attempt\n16\n17\n18\n19\n20\n";
const CRLF = "a\r\n<<<<<<< main\r\nB1\r\n||||||| base\r\nb\r\n=======\r\nB2\r\n>>>>>>> attempt\r\nc\r\n";
// Every side lacked a trailing newline; merge-file ends the hunk with one anyway.
const NO_NEWLINE = "x\ny\n<<<<<<< main\nZ1\n||||||| base\nz\n=======\nZ2\n>>>>>>> attempt\n";

describe("parseZdiff3", () => {
  it("reads one hunk with each side's lines", () => {
    expect(parseZdiff3(GREETING)).toEqual([
      {
        startLine: 1,
        base: ['export const GREETING = "hello";'],
        main: ['export const GREETING = "hello from a1";'],
        attempt: ['export const GREETING = "hello from a2";'],
      },
    ]);
  });

  it("numbers several hunks by their line in the base", () => {
    expect(parseZdiff3(MULTI)).toEqual([
      { startLine: 2, base: ["2"], main: ["two-m"], attempt: ["two-a"] },
      { startLine: 15, base: ["15"], main: ["fifteen-m"], attempt: ["fifteen-a"] },
    ]);
  });

  it("drops CRLF line endings", () => {
    expect(parseZdiff3(CRLF)).toEqual([{ startLine: 2, base: ["b"], main: ["B1"], attempt: ["B2"] }]);
  });

  it("reads a hunk at the end of a file with no trailing newline", () => {
    expect(parseZdiff3(NO_NEWLINE)).toEqual([{ startLine: 3, base: ["z"], main: ["Z1"], attempt: ["Z2"] }]);
  });

  it("counts lines blanked out around the hunks", () => {
    expect(parseZdiff3("\n\n<<<<<<< main\n||||||| base\n=======\nnew\n>>>>>>> attempt\n\n")).toEqual([
      { startLine: 3, base: [], main: [], attempt: ["new"] },
    ]);
  });
});

/** A zdiff3 output with one hunk of `n` bytes: a main line of `n - 1` characters. */
const hunk = (n: number) => `<<<<<<< main\n${"m".repeat(n - 1)}\n||||||| base\n=======\n>>>>>>> attempt\n`;

describe("conflictFiles", () => {
  const parsed = parseMergeTree(CONFLICTED).files;
  const caps: ConflictCaps = { fileBytes: 64 * 1024, totalBytes: 512 * 1024 };

  it("adds hunks to content conflicts only, leaving the other types without", () => {
    const files = conflictFiles(parsed, [{ path: "g.js", status: "merged", output: GREETING }], caps);
    expect(files.map((f) => [f.path, f.truncated, f.hunks?.length ?? null])).toEqual([
      ["del.txt", false, null],
      ["g.js", false, 1],
      ["new.txt", false, null],
      ["ren-main.txt", false, null],
      ["ren-side.txt", false, null],
      ["ren.txt", false, null],
    ]);
    expect(files[1]).toEqual({ ...parsed[1], truncated: false, hunks: parseZdiff3(GREETING) });
  });

  it("truncates a file whose hunks are over the per-file cap, keeping its type and blobs", () => {
    const big = `<<<<<<< main\n${"m".repeat(40)}\n||||||| base\n=======\n>>>>>>> attempt\n`;
    const files = conflictFiles(parsed, [{ path: "g.js", status: "merged", output: big }], {
      fileBytes: 40,
      totalBytes: 1000,
    });
    expect(files[1]).toEqual({ ...parsed[1], truncated: true });
  });

  it("truncates the files that would take the hunks past the total cap, and keeps filling after", () => {
    const three = ["a", "b", "c"].map((path) => ({
      path,
      type: "content" as const,
      blobs: blobs(B("1"), B("2"), B("3")),
      modes: blobs("100644", "100644", "100644"),
    }));
    const files = conflictFiles(
      three,
      [
        { path: "a", status: "merged", output: hunk(60) },
        { path: "b", status: "merged", output: hunk(50) },
        { path: "c", status: "merged", output: hunk(40) },
      ],
      { fileBytes: 64, totalBytes: 100 },
    );
    expect(files.map((f) => [f.path, f.truncated, f.hunks?.length ?? null])).toEqual([
      ["a", false, 1],
      ["b", true, null],
      ["c", false, 1],
    ]);
  });

  it("truncates a file the conflict check found too large, and gives none for one it couldn't merge", () => {
    const files = conflictFiles(
      parsed,
      [
        { path: "g.js", status: "too_large" },
        { path: "new.txt", status: "failed" },
      ],
      caps,
    );
    expect(files[1]).toEqual({ ...parsed[1], truncated: true });
    expect(conflictFiles(parsed, [{ path: "g.js", status: "failed" }], caps)[1]).toEqual({
      ...parsed[1],
      truncated: false,
    });
  });
});
