// Checks the patches against real git: applying a commit's unified patch onto its parent's tree
// with `git apply` must reproduce the commit's tree, sha for sha. Needs `git` on the PATH.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffCommit, unifiedPatch } from "../src/diff.ts";
import { FakeRepos } from "./fake-repos.ts";
import type { FakeFile } from "./fake-repos.ts";

const REPO = "p1-main";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Writes a snapshot into a fresh git work tree. */
function checkout(files: Record<string, FakeFile>): string {
  const dir = mkdtempSync(join(tmpdir(), "throng-diff-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "core.fileMode", "true");
  git(dir, "config", "core.symlinks", "true");
  for (const [path, file] of Object.entries(files)) {
    const { content, type } = typeof file === "object" && "type" in file ? file : { content: file, type: "blob" };
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    if (type === "symlink") {
      symlinkSync(String(content), full);
    } else {
      writeFileSync(full, content);
      chmodSync(full, type === "exec" ? 0o755 : 0o644);
    }
  }
  return dir;
}

describe("unified patches against git apply", () => {
  it("reproduces the commit's tree when applied onto its parent's", async () => {
    const before: Record<string, FakeFile> = {
      "README.md": "# Title\n\nSome text.\n",
      "src/app.ts": Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""),
      "src/old-name.ts": "export const moved = true;\n",
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "docs/gone.md": "delete me\n",
      "no-eol.txt": "first\nlast",
      link: { content: "README.md", type: "symlink" },
      "empty-before.txt": "",
    };
    const after: Record<string, FakeFile> = {
      "README.md": "# Title\n\nSome better text.\nAnd more.\n",
      "src/app.ts": Array.from({ length: 40 }, (_, i) => (i % 13 === 5 ? `changed ${i}\n` : `line ${i}\n`)).join(""),
      "src/new-name.ts": "export const moved = true;\n",
      "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", type: "exec" },
      "no-eol.txt": "first\nlast, changed",
      link: { content: "src/app.ts", type: "symlink" },
      "empty-before.txt": "now has content\n",
      "empty.txt": "",
      "new/dir/file.txt": "brand new\n",
    };
    const repos = new FakeRepos();
    await repos.create(REPO);
    repos.commit(REPO, { files: before });
    const child = repos.commit(REPO, { files: after });
    const diff = (await diffCommit(repos, REPO, child.hash))!;
    expect(diff.files.every((f) => f.flags.length === 0)).toBeTruthy();

    const dir = checkout(before);
    const patchFile = join(dir, "..", `${dir.split("/").pop()}.patch`);
    dirs.push(patchFile);
    writeFileSync(patchFile, unifiedPatch(diff));
    git(dir, "apply", "--whitespace=nowarn", patchFile);
    git(dir, "add", "-A");
    expect(git(dir, "write-tree")).toBe(child.treeHash);
  });
});
