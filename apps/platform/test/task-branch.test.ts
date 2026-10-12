// The task branch through the git proxy, with real `git` against `git http-backend` standing in
// for Artifacts: the task creator or project owner pushes `refs/tasks/t<n>` to the origin, and new
// attempts start from its head.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { FollowParams } from "../src/follows.ts";
import { gitRoutes } from "../src/git-proxy.ts";
import { projectService } from "../src/projects.ts";
import { forkRepo, originRepo } from "../src/repos.ts";
import type { ProjectContext } from "../src/task-store.ts";
import { mintToken } from "../src/tokens.ts";
import type { Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";
import { git, gitEnv, LocalGitHost, serve, tryGit } from "./support/git-host.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const now = () => new Date("2026-10-10T12:00:00.000Z");

async function setup() {
  const host = await LocalGitHost.start();
  cleanups.push(() => host.close());
  const work = await mkdtemp(join(tmpdir(), "throng-task-branch-"));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  const env = gitEnv(work);

  const db = testDatabase();
  const followed: FollowParams[] = [];
  const follow = { workflow: { create: async ({ params }: { params: FollowParams }) => followed.push(params) } };
  const { backend, store } = testTaskBackends(host, now, undefined, undefined, follow);
  const app = new Hono().route("/git", gitRoutes({ repos: () => host, tasks: () => backend, now }));
  const server = await serve(app, { DB: db, ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "x" });
  cleanups.push(server.close);

  const person = async (email: string) => {
    const user = await userForEmail(db, email);
    const { plaintext } = await mintToken(db, { userId: user.id, alias: null, ttlSeconds: 3600, now: now() });
    const actor: Actor = { user, alias: null };
    return { user, actor, token: plaintext };
  };
  const greg = await person("greg@example.com");
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");

  const created = await projectService({ db, repos: host }).create(greg.actor, { handle: "throng" });
  const project: ProjectContext = { id: created.id, owner: greg.user.id };
  const origin = originRepo(project.id);

  const seed = join(work, "seed");
  await git(work, env, "init", "-q", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(seed, env, "add", "-A");
  await git(seed, env, "commit", "-q", "-m", "seed");
  await git(seed, env, "push", "-q", host.path(origin), "main");
  const mainSha = await host.head(origin);

  // t1, created by ada.
  const tasks = store(project.id);
  tasks.createTask(project, ada.actor, { title: "Fix login" });

  const remote = (token: string) => `${server.origin.replace("://", `://git:${token}@`)}/git/greg/throng.git`;
  let clones = 0;
  /** Clones the origin as `token` into a fresh directory. */
  const clone = async (token: string) => {
    const dir = join(work, `clone${++clones}`);
    await git(work, env, "clone", "-q", remote(token), dir);
    return dir;
  };
  /** Commits a new file in `dir` with `message` and returns its sha. */
  const commit = async (dir: string, message: string) => {
    await writeFile(join(dir, `file-${Math.random().toString(36).slice(2)}.txt`), `${message}\n`);
    await git(dir, env, "add", "-A");
    await git(dir, env, "commit", "-q", "-m", message);
    return (await git(dir, env, "rev-parse", "HEAD")).trim();
  };
  const push = (dir: string, ref: string) => tryGit(dir, env, "push", "origin", `HEAD:${ref}`);
  const taskHead = () => host.head(origin, "refs/tasks/t1");
  const fork = (attempt: string) => forkRepo(project.id, attempt);

  const attemptRemote = (token: string, attempt: string) =>
    `${server.origin.replace("://", `://git:${token}@`)}/git/greg/throng/${attempt}.git`;
  return {
    host,
    work,
    env,
    greg,
    ada,
    bob,
    project,
    origin,
    mainSha,
    tasks,
    clone,
    commit,
    push,
    taskHead,
    fork,
    followed,
    attemptRemote,
    settled: server.settled,
  };
}

describe("pushing a task branch", () => {
  it("lets the task's creator and the project owner push refs/tasks/t<n>, at any time", async () => {
    const { ada, greg, clone, commit, push, taskHead, host, origin, mainSha } = await setup();
    const dir = await clone(ada.token);
    const tests = await commit(dir, "Add login tests");
    const pushed = await push(dir, "refs/tasks/t1");
    expect(pushed.stderr).not.toMatch(/rejected|error/u);
    expect(pushed.ok).toBeTruthy();
    expect(await taskHead()).toBe(tests);
    expect(await host.head(origin)).toBe(mainSha);

    const owner = await clone(greg.token);
    await git(owner, gitEnv(owner), "fetch", "-q", "origin", "refs/tasks/t1");
    await git(owner, gitEnv(owner), "reset", "-q", "--hard", "FETCH_HEAD");
    const fixtures = await commit(owner, "Add fixtures");
    expect((await push(owner, "refs/tasks/t1")).ok).toBeTruthy();
    expect(await taskHead()).toBe(fixtures);
  });

  it("refuses anyone else, and a task that doesn't exist, with a remote: reason", async () => {
    const { bob, ada, clone, commit, push, taskHead } = await setup();
    const dir = await clone(bob.token);
    await commit(dir, "My tests");
    const refused = await push(dir, "refs/tasks/t1");
    expect(refused.ok).toBeFalsy();
    expect(refused.stderr).toMatch(
      /\[remote rejected\] HEAD -> refs\/tasks\/t1 \(only t1's creator or the project owner may push its task branch\)/u,
    );
    expect(await taskHead()).toBeNull();

    const mine = await clone(ada.token);
    await commit(mine, "Tests for nothing");
    const missing = await push(mine, "refs/tasks/t9");
    expect(missing.ok).toBeFalsy();
    expect(missing.stderr).toMatch(/\[remote rejected\] HEAD -> refs\/tasks\/t9 \(no task t9\)/u);
  });
});

describe("starting attempts on a task with a task branch", () => {
  it("starts new attempts' forks from the task head, and from main when there is none", async () => {
    const { ada, bob, clone, commit, push, host, fork, tasks, project, mainSha } = await setup();
    await tasks.createAttempts(project, bob.actor, { task: 1 });
    expect(await host.head(fork("t1a1"))).toBe(mainSha);

    const dir = await clone(ada.token);
    const tests = await commit(dir, "Add login tests");
    expect((await push(dir, "refs/tasks/t1")).ok).toBeTruthy();
    await tasks.createAttempts(project, bob.actor, { task: 1, count: 2 });
    expect(await host.head(fork("t1a2"))).toBe(tests);
    expect(await host.head(fork("t1a3"))).toBe(tests);
    expect(await host.head(fork("t1a1"))).toBe(mainSha);
  });

  it("seeds an attempt forked from another with that attempt's head, not the task head", async () => {
    const { ada, bob, clone, commit, push, host, fork, tasks, project, mainSha } = await setup();
    await tasks.createAttempts(project, bob.actor, { task: 1 });
    const dir = await clone(ada.token);
    const tests = await commit(dir, "Add login tests");
    expect((await push(dir, "refs/tasks/t1")).ok).toBeTruthy();

    await tasks.createAttempts(project, bob.actor, { task: 1, from: { task: 1, number: 1 } });
    expect(await host.head(fork("t1a2"))).toBe(mainSha);
    await tasks.createAttempts(project, bob.actor, { task: 1 });
    expect(await host.head(fork("t1a3"))).toBe(tests);
  });

  it("starts a push-to-create attempt from the task head, and names the task branch in the notice", async () => {
    const { ada, bob, env, clone, commit, push, host, fork, tasks, project, followed } = await setup();
    const dir = await clone(ada.token);
    const tests = await commit(dir, "Add login tests");
    expect((await push(dir, "refs/tasks/t1")).ok).toBeTruthy();

    const mine = await clone(bob.token);
    await git(mine, env, "fetch", "-q", "origin", "refs/tasks/t1");
    await git(mine, env, "reset", "-q", "--hard", "FETCH_HEAD");
    const fix = await commit(mine, "Fix login");
    const pushed = await push(mine, "refs/heads/t1/bob");
    expect(pushed.stderr).not.toMatch(/rejected|error/u);
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).toMatch(
      new RegExp(`remote: t1 has a task branch at ${tests}; fetch refs/tasks/t1 first and build on it\\.`, "u"),
    );
    expect(await host.head(fork("t1a1"))).toBe(fix);
    expect(tasks.getAttempt(project, bob.actor, { task: 1, number: 1 })).toMatchObject({ state: "open" });
    // Its author may not have built on the task branch: a follow checks, and merges it in if not.
    await tasks.drain(project.id);
    expect(followed.map((f) => [f.attempt, f.taskHead])).toEqual([[1, tests]]);

    // A new task made by push-to-create has no task branch to name.
    const other = await clone(bob.token);
    await commit(other, "Add search");
    expect((await push(other, "refs/heads/search")).stderr).not.toMatch(/task branch/u);
  });
});

describe("following the task branch", () => {
  it("queues a follow of the pushed task head for each active attempt, and names them in the push's reply", async () => {
    const { ada, bob, clone, commit, push, tasks, project, followed } = await setup();
    await tasks.createAttempts(project, bob.actor, { task: 1, count: 2 });
    await tasks.closeAttempt(project, bob.actor, { task: 1, number: 2 });

    const dir = await clone(ada.token);
    const tests = await commit(dir, "Add login tests");
    const pushed = await push(dir, "refs/tasks/t1");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).toMatch(new RegExp(`remote: t1's task branch is at ${tests}; merging it into t1a1\\.`, "u"));
    await tasks.drain(project.id);
    expect(followed.map((f) => [f.attempt, f.taskHead])).toEqual([[1, tests]]);
  });

  it("says nothing more when the task has no active attempts", async () => {
    const { ada, clone, commit, push } = await setup();
    const dir = await clone(ada.token);
    await commit(dir, "Add login tests");
    const pushed = await push(dir, "refs/tasks/t1");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).not.toMatch(/merging/u);
  });

  it("tells an author whose push the fork rejected as non-fast-forward after a follow to pull first", async () => {
    const { ada, bob, env, host, clone, commit, push, tasks, project, fork, followed, attemptRemote } = await setup();
    await tasks.createAttempts(project, bob.actor, { task: 1 });
    // bob works on his attempt.
    const mine = await clone(bob.token);
    await git(mine, env, "remote", "add", "attempt", attemptRemote(bob.token, "t1a1"));
    await commit(mine, "Fix login");
    expect((await tryGit(mine, env, "push", "attempt", "HEAD:main")).ok).toBeTruthy();

    // ada moves the task branch; the follow merges it into t1a1, as its Workflow would.
    const dir = await clone(ada.token);
    const tests = await commit(dir, "Add login tests");
    expect((await push(dir, "refs/tasks/t1")).ok).toBeTruthy();
    await tasks.drain(project.id);
    const follow = followed.find((f) => f.attempt === 1);
    if (follow === undefined) throw new Error("no follow of t1a1");
    const before = (await host.head(fork("t1a1"))) ?? "";
    await git(mine, env, "fetch", "-q", "origin", "refs/tasks/t1");
    await git(mine, env, "merge", "-q", "--no-edit", "FETCH_HEAD");
    const merged = (await git(mine, env, "rev-parse", "HEAD")).trim();
    await git(mine, env, "push", "-q", host.path(fork("t1a1")), "HEAD:main");
    await git(mine, env, "reset", "-q", "--hard", "HEAD~1");
    expect(tasks.claimFollowPush(follow.follow)).toBeTruthy();
    await tasks.followFinished(follow.follow, { kind: "merged", before, head: merged });
    expect(tests).not.toBe(merged);

    // bob, not having pulled, forces his next commit; a host that refuses non-fast-forwards rejects it.
    await git(host.path(fork("t1a1")), env, "config", "receive.denyNonFastForwards", "true");
    await commit(mine, "More of the fix");
    const forced = await tryGit(mine, env, "push", "--force", "attempt", "HEAD:main");
    expect(forced.ok).toBeFalsy();
    expect(forced.stderr).toMatch(/remote: t1's task branch moved; pull first/u);
    expect(await host.head(fork("t1a1"))).toBe(merged);

    // Once bob pulls, his push lands and the notice is gone.
    await git(mine, env, "pull", "-q", "--no-rebase", "--no-edit", "attempt", "main");
    const pulled = await tryGit(mine, env, "push", "attempt", "HEAD:main");
    expect(pulled.ok).toBeTruthy();
    expect(pulled.stderr).not.toMatch(/pull first/u);
  });
});

/**
 * `setup` and what a task branch's follows need: `pushTaskBranch`, as ada, and `runFollow`, which
 * does what the latest Follow Workflow of an attempt does: merges the task head into the fork's
 * `main` and reports it.
 */
async function following() {
  const s = await setup();
  const { ada, env, host, work, clone, commit, push, tasks, project, fork, origin, followed } = s;
  const pushTaskBranch = async () => {
    const dir = await clone(ada.token);
    const head = await commit(dir, "Add login tests");
    expect((await push(dir, "refs/tasks/t1")).ok).toBeTruthy();
    return head;
  };
  let runs = 0;
  /** Runs the latest follow of attempt `t1a<attempt>`, as its Workflow would, and returns its merge. */
  const runFollow = async (attempt: number) => {
    await s.settled();
    await tasks.drain(project.id);
    const follow = followed.findLast((f) => f.attempt === attempt);
    if (follow === undefined) throw new Error(`no follow of t1a${attempt}`);
    const dir = join(work, `follow${++runs}`);
    await git(work, env, "clone", "-q", host.path(fork(`t1a${attempt}`)), dir);
    const before = (await git(dir, env, "rev-parse", "HEAD")).trim();
    await git(dir, env, "fetch", "-q", host.path(origin), "refs/tasks/t1");
    await git(dir, env, "merge", "-q", "--no-edit", "FETCH_HEAD");
    const head = (await git(dir, env, "rev-parse", "HEAD")).trim();
    await git(dir, env, "push", "-q", "origin", "HEAD:main");
    expect(tasks.claimFollowPush(follow.follow)).toBeTruthy();
    await tasks.followFinished(follow.follow, { kind: "merged", before, head });
    await tasks.drain(project.id);
    return head;
  };
  /** How many follows of `t1a<attempt>` have started, once the pushes so far are checked. */
  const follows = async (attempt: number) => {
    await s.settled();
    await tasks.drain(project.id);
    return followed.filter((f) => f.attempt === attempt).length;
  };
  return { ...s, pushTaskBranch, runFollow, follows };
}

/**
 * `following` with bob's attempt t1a1 and his clone `mine` (remote `attempt` is the fork), and a
 * task branch a follow merged into t1a1. `mine` doesn't have the merge: bob never pulled it.
 */
async function followedAttempt() {
  const s = await following();
  const mine = await bobsAttempt(s);
  const tests = await s.pushTaskBranch();
  const merged = await s.runFollow(1);
  return { ...s, mine, tests, merged };
}

/** Starts bob's attempt t1a1 and pushes a first commit to it from his clone, which it returns. */
async function bobsAttempt({
  bob,
  env,
  clone,
  commit,
  tasks,
  project,
  attemptRemote,
}: Awaited<ReturnType<typeof setup>>) {
  await tasks.createAttempts(project, bob.actor, { task: 1 });
  const mine = await clone(bob.token);
  await git(mine, env, "remote", "add", "attempt", attemptRemote(bob.token, "t1a1"));
  await commit(mine, "Fix login");
  expect((await tryGit(mine, env, "push", "attempt", "HEAD:main")).ok).toBeTruthy();
  return mine;
}

describe("an author's push that drops the task branch", () => {
  it("follows again after a forced push, which the host accepts, drops the follow's merge", async () => {
    const { env, host, commit, fork, mine, merged, follows, runFollow } = await followedAttempt();
    const count = await follows(1);

    const fix = await commit(mine, "More of the fix");
    const forced = await tryGit(mine, env, "push", "--force", "attempt", "HEAD:main");
    expect(forced.ok).toBeTruthy();
    expect(await host.head(fork("t1a1"))).toBe(fix);
    expect(fix).not.toBe(merged);

    const again = await runFollow(1);
    expect(await follows(1)).toBe(count + 1);
    expect(await host.head(fork("t1a1"))).toBe(again);
  });

  it("marks the attempt needs update when following again conflicts", async () => {
    const { env, commit, tasks, project, bob, followed, mine, tests, settled } = await followedAttempt();
    const fix = await commit(mine, "More of the fix");
    expect((await tryGit(mine, env, "push", "--force", "attempt", "HEAD:main")).ok).toBeTruthy();
    await settled();
    await tasks.drain(project.id);
    const follow = followed.findLast((f) => f.attempt === 1);
    if (follow === undefined) throw new Error("no follow of t1a1");
    expect(follow.taskHead).toBe(tests);
    expect(tasks.claimFollowPush(follow.follow)).toBeTruthy();
    await tasks.followFinished(follow.follow, { kind: "conflict", head: fix });
    expect(tasks.getAttempt(project, bob.actor, { task: 1, number: 1 })).toMatchObject({ needs_update: true });
  });

  it("queues nothing when the push contains the task head", async () => {
    const { env, commit, mine, follows } = await followedAttempt();
    const count = await follows(1);
    await git(mine, env, "pull", "-q", "--no-rebase", "--no-edit", "attempt", "main");
    await commit(mine, "More of the fix");
    const pushed = await tryGit(mine, env, "push", "attempt", "HEAD:main");
    expect(pushed.ok).toBeTruthy();
    expect(await follows(1)).toBe(count);
  });

  it("answers the push before checking it", async () => {
    const { env, host, commit, mine, follows } = await followedAttempt();
    const count = await follows(1);
    // The fork's history can't be read until the push has its reply.
    const { promise: readable, resolve: release } = Promise.withResolvers<void>();
    const readCommit = host.readCommit.bind(host);
    host.readCommit = async (name, hash) => {
      await readable;
      return readCommit(name, hash);
    };

    await commit(mine, "More of the fix");
    expect((await tryGit(mine, env, "push", "--force", "attempt", "HEAD:main")).ok).toBeTruthy();
    release();
    expect(await follows(1)).toBe(count + 1);
  });

  it("checks a push-to-create push into an existing attempt the same way", async () => {
    const { bob, host, clone, commit, push, fork, follows, pushTaskBranch, runFollow } = await following();
    await pushTaskBranch();
    const mine = await clone(bob.token);
    await commit(mine, "Fix login");
    expect((await push(mine, "refs/heads/t1/bob")).ok).toBeTruthy();
    await runFollow(1);
    const count = await follows(1);

    // bob pushes his branch again without the follow's merge; it replaces the fork's main.
    const fix = await commit(mine, "More of the fix");
    expect((await push(mine, "refs/heads/t1/bob")).ok).toBeTruthy();
    expect(await host.head(fork("t1a1"))).toBe(fix);
    await runFollow(1);
    expect(await follows(1)).toBe(count + 1);
  });

  it("leaves an attempt on a task with no task branch alone", async () => {
    const s = await setup();
    const { env, commit, tasks, project, followed, settled } = s;
    const mine = await bobsAttempt(s);
    await commit(mine, "More of the fix");
    expect((await tryGit(mine, env, "push", "--force", "attempt", "HEAD:main")).ok).toBeTruthy();
    await settled();
    await tasks.drain(project.id);
    expect(followed).toHaveLength(0);
  });
});
