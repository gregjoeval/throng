import { describe, expect, it } from "vitest";
import { parseMergeTree } from "../src/conflicts.ts";

// Recorded from `git merge-tree --write-tree --name-only --messages -z main side` (git 2.47), NULs as \0.
const CONFLICTED =
  "4dfc333587ced8b28e78e0a0dde5bc740fe069d2\0a\0d\0n\0ren\0ren-main\0ren-side\0\0" +
  "1\0a\0Auto-merging\0Auto-merging a\n\0" +
  "1\0a\0CONFLICT (contents)\0CONFLICT (content): Merge conflict in a\n\0" +
  "1\0d\0CONFLICT (modify/delete)\0CONFLICT (modify/delete): d deleted in main and modified in side.  Version side of d left in tree.\n\0" +
  "1\0n\0Auto-merging\0Auto-merging n\n\0" +
  "1\0n\0CONFLICT (contents)\0CONFLICT (add/add): Merge conflict in n\n\0" +
  "3\0ren\0ren-main\0ren-side\0CONFLICT (rename/rename)\0CONFLICT (rename/rename): ren renamed to ren-main in main and to ren-side in side.\n\0";

describe("parseMergeTree", () => {
  it("reads a clean merge's tree, with no conflicts", () => {
    expect(parseMergeTree("728f51c4e821881ff40b466785315f5e38ba3641\0\0")).toEqual({
      tree: "728f51c4e821881ff40b466785315f5e38ba3641",
      files: [],
    });
  });

  it("lists every conflicted path with its type from the messages", () => {
    expect(parseMergeTree(CONFLICTED)).toEqual({
      tree: "4dfc333587ced8b28e78e0a0dde5bc740fe069d2",
      files: [
        { path: "a", type: "content" },
        { path: "d", type: "modify_delete" },
        { path: "n", type: "add_add" },
        { path: "ren", type: "rename" },
        { path: "ren-main", type: "rename" },
        { path: "ren-side", type: "rename" },
      ],
    });
  });

  it("keeps a path with a newline whole", () => {
    const out = ["t".repeat(40), "odd\nname.txt", "", "1", "odd\nname.txt", "CONFLICT (contents)", "x\n", ""].join(
      "\0",
    );
    expect(parseMergeTree(out).files).toEqual([{ path: "odd\nname.txt", type: "content" }]);
  });

  it("calls a conflict with no recognised message a content conflict", () => {
    const out = ["t".repeat(40), "dir", "", "1", "dir", "CONFLICT (file/directory)", "x\n", ""].join("\0");
    expect(parseMergeTree(out).files).toEqual([{ path: "dir", type: "content" }]);
  });
});
