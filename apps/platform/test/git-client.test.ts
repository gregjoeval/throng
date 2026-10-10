// The Worker-side git client, against real `git http-backend` standing in for Artifacts: copying
// refs between repos, and closing and reopening an attempt through it.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveRef } from "../src/archive.ts";
import { copyRef, GitClientError } from "../src/git-client.ts";
import { forkRepo, originRepo } from "../src/repos.ts";
import { TaskStore, type ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { git, gitEnv, LocalGitHost, tryGit } from "./support/git-host.ts";
import { testSql } from "./support/task-backend.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const ada: Actor = { user: { id: "ada00001", handle: "ada", email: "ada@example.com", created_at: "" }, agent: null };
const ORIGIN = originRepo(PROJECT.id);
const FORK = forkRepo(PROJECT.id, "t1a1");
const MAIN = "refs/heads/main";

async function setup() {
  const host = await LocalGitHost.start();
  cleanups.push(() => host.close());
  const work = await mkdtemp(join(tmpdir(), "throng-git-client-"));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  const env = gitEnv(work);
  await host.create(ORIGIN);

  const seed = join(work, "seed");
  await git(work, env, "init", "-q", "-b", "main", seed);
  let commits = 0;
  /** Commits a new file in the seed checkout and pushes HEAD to `ref` in `repo`, straight on disk. */
  const push = async (repo: string, ref = MAIN) => {
    const name = `file${++commits}.txt`;
    await writeFile(join(seed, name), `${"line\n".repeat(200)}${commits}\n`);
    await git(seed, env, "add", "-A");
    await git(seed, env, "commit", "-q", "-m", name);
    await git(seed, env, "push", "-q", "-f", host.path(repo), `HEAD:${ref}`);
    return (await git(seed, env, "rev-parse", "HEAD")).trim();
  };
  const remote = async (name: string, scope: "read" | "write") => ({
    url: (await host.get(name)).remote,
    token: (await host.mintToken(name, scope, 600)).token,
  });
  /** Checks a repo has every object `sha` reaches, so a copy left nothing behind. */
  const complete = async (repo: string, sha: string) => {
    const listed = await tryGit(host.path(repo), env, "rev-list", "--objects", "--missing=print", sha);
    return listed.ok && listed.stdout.includes(sha) && !/^\?/m.test(listed.stdout);
  };
  return { host, env, seed, push, remote, complete };
}

describe("copyRef", () => {
  it("copies a fork's head, and the objects it needs, to a new ref in the origin", async () => {
    const { host, push, remote, complete } = await setup();
    const base = await push(ORIGIN);
    await host.fork(ORIGIN, FORK);
    await push(FORK);
    const head = await push(FORK);

    const sha = await copyRef(fetch, {
      from: await remote(FORK, "read"),
      fromRef: MAIN,
      to: await remote(ORIGIN, "write"),
      toRef: "refs/attempts/t1a1",
    });
    expect(sha).toBe(head);
    expect(await host.head(ORIGIN, "refs/attempts/t1a1")).toBe(head);
    expect(await host.head(ORIGIN)).toBe(base);
    expect(await complete(ORIGIN, head)).toBe(true);
  });

  it("force-updates a ref to a commit that doesn't descend from it", async () => {
    const { host, push, remote, complete } = await setup();
    await push(ORIGIN);
    await host.fork(ORIGIN, FORK);
    await push(ORIGIN, "refs/attempts/t1a1");
    const rewound = await push(FORK);
    const sha = await copyRef(fetch, {
      from: await remote(FORK, "read"),
      fromRef: MAIN,
      to: await remote(ORIGIN, "write"),
      toRef: "refs/attempts/t1a1",
    });
    expect(sha).toBe(rewound);
    expect(await host.head(ORIGIN, "refs/attempts/t1a1")).toBe(rewound);
    expect(await complete(ORIGIN, rewound)).toBe(true);
  });

  it("returns null for a missing ref, and pushes nothing when the target is already there", async () => {
    const { host, push, remote } = await setup();
    const base = await push(ORIGIN);
    await host.fork(ORIGIN, FORK);
    const args = { from: await remote(FORK, "read"), to: await remote(ORIGIN, "write") };
    expect(await copyRef(fetch, { ...args, fromRef: "refs/heads/nope", toRef: "refs/x" })).toBeNull();
    const pushes = () => host.requests.filter((r) => r.path.endsWith("/git-receive-pack")).length;
    const before = pushes();
    expect(await copyRef(fetch, { ...args, fromRef: MAIN, toRef: MAIN })).toBe(base);
    expect(pushes()).toBe(before);
  });

  it("creates a ref at a commit the target already has, sending an empty pack", async () => {
    const { host, push, remote } = await setup();
    const base = await push(ORIGIN);
    await host.fork(ORIGIN, FORK);
    const sha = await copyRef(fetch, {
      from: await remote(FORK, "read"),
      fromRef: MAIN,
      to: await remote(ORIGIN, "write"),
      toRef: "refs/attempts/t1a1",
    });
    expect(sha).toBe(base);
    expect(await host.head(ORIGIN, "refs/attempts/t1a1")).toBe(base);
  });

  it("refuses a source that has moved from the expected sha", async () => {
    const { host, push, remote } = await setup();
    await push(ORIGIN);
    await host.fork(ORIGIN, FORK);
    const copy = copyRef(fetch, {
      from: await remote(FORK, "read"),
      fromRef: MAIN,
      to: await remote(ORIGIN, "write"),
      toRef: "refs/attempts/t1a1",
      expect: "f".repeat(40),
    });
    await expect(copy).rejects.toBeInstanceOf(GitClientError);
  });

  it("fails without a write token on the target, and never leaks a token in the error", async () => {
    const { host, push, remote } = await setup();
    await push(ORIGIN);
    await host.fork(ORIGIN, FORK);
    await push(FORK);
    const target = await remote(ORIGIN, "read");
    const err = await copyRef(fetch, {
      from: await remote(FORK, "read"),
      fromRef: MAIN,
      to: target,
      toRef: "refs/attempts/t1a1",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitClientError);
    expect((err as Error).message).not.toContain(target.token);
    expect(await host.head(ORIGIN, "refs/attempts/t1a1")).toBeNull();
  });
});

describe("archive through real git", () => {
  it("closing archives the head into the origin and deletes the fork; reopening restores it", async () => {
    const { host, push, complete } = await setup();
    await push(ORIGIN);
    const store = new TaskStore({ sql: testSql(), repos: host });
    store.createTask(PROJECT, ada, { title: "a" });
    await store.createAttempts(PROJECT, ada, { task: 1 });
    const head = await push(FORK);
    const ref = { task: 1, number: 1 };

    expect((await store.closeAttempt(PROJECT, ada, ref)).archived_sha).toBe(head);
    expect(await host.head(ORIGIN, archiveRef("t1a1"))).toBe(head);
    expect(await host.list(FORK)).toEqual([]);

    // The archive survives the origin moving on.
    const advanced = await push(ORIGIN);
    expect(await host.head(ORIGIN, archiveRef("t1a1"))).toBe(head);

    expect((await store.reopenAttempt(PROJECT, ada, ref)).state).toBe("draft");
    expect(await host.head(FORK)).toBe(head);
    expect(await complete(FORK, head)).toBe(true);
    expect(await host.head(ORIGIN)).toBe(advanced);
  });
});
