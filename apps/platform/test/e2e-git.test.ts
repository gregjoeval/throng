import { describe, expect, it } from "vitest";
import { basicAuthHeader, parseCommit } from "../scripts/e2e-git.ts";

describe("parseCommit", () => {
  it("reads a merge commit's parents and Throng trailers from `git cat-file -p`", () => {
    const raw = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
parent 1111111111111111111111111111111111111111
parent 2222222222222222222222222222222222222222
author ada <ada00001+ada@users.noreply.throng> 1760097600 +0000
committer Throng <noreply@users.noreply.throng> 1760097600 +0000

Merge t1a1: Greet from a1

Throng-Task: t1
Throng-Attempt: t1a1
Throng-Merge-Request: t1
Approved-by: ada <ada00001+ada@users.noreply.throng>
`;
    expect(parseCommit(raw)).toEqual({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"],
      author: "ada <ada00001+ada@users.noreply.throng>",
      committer: "Throng <noreply@users.noreply.throng>",
      subject: "Merge t1a1: Greet from a1",
      trailers: {
        "Throng-Task": ["t1"],
        "Throng-Attempt": ["t1a1"],
        "Throng-Merge-Request": ["t1"],
        "Approved-by": ["ada <ada00001+ada@users.noreply.throng>"],
      },
    });
  });

  it("has no trailers when the message is only a subject, and no parents for a root commit", () => {
    const raw = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
author e2e <e2e@localhost> 1760097600 +0000
committer e2e <e2e@localhost> 1760097600 +0000

fixture
`;
    expect(parseCommit(raw)).toMatchObject({ parents: [], subject: "fixture", trailers: {} });
  });
});

describe("basicAuthHeader", () => {
  it("sends a Throng token as the Basic password, which is how the git proxy reads it", () => {
    expect(basicAuthHeader("thr_abc")).toBe(`Authorization: Basic ${btoa("e2e:thr_abc")}`);
  });
});
