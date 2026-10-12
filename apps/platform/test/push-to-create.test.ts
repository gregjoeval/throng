// Push-to-create through the git proxy, with real `git` against `git http-backend` standing in for
// Artifacts: a branch pushed to the origin becomes (or updates) an attempt's fork, never the origin.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitRoutes } from "../src/git-proxy.ts";
import { projectService } from "../src/projects.ts";
import { forkRepo, originRepo } from "../src/repos.ts";
import type { ProjectContext } from "../src/task-store.ts";
import { mintToken, type Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";
import { git, gitEnv, LocalGitHost, serve, tryGit } from "./support/git-host.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const now = () => new Date("2026-10-10T12:00:00.000Z");

async function setup() {
  const host = await LocalGitHost.start();
  cleanups.push(() => host.close());
  const work = await mkdtemp(join(tmpdir(), "throng-push-create-"));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  const env = gitEnv(work);

  const db = testDatabase();
  const { backend, store, sql } = testTaskBackends(host, now);
  const app = new Hono().route("/git", gitRoutes({ repos: () => host, tasks: () => backend, now }));
  const server = await serve(app, { DB: db, ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "x" });
  cleanups.push(server.close);

  const person = async (email: string) => {
    const user = await userForEmail(db, email);
    const { plaintext } = await mintToken(db, { userId: user.id, agent: null, ttlSeconds: 3600, now: now() });
    const actor: Actor = { user, agent: null };
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

  // t1, by ada, with ada's attempt t1a1.
  const tasks = store(project.id);
  const task = tasks.createTask(project, ada.actor, { title: "Fix login" });
  await tasks.createAttempts(project, ada.actor, { task: task.number });

  const remote = (path: string, token: string) =>
    `${server.origin.replace("://", `://git:${token}@`)}/git/greg/${path}`;
  let clones = 0;
  /** Clones the origin as `token` into a fresh directory. */
  const clone = async (token: string) => {
    const dir = join(work, `clone${++clones}`);
    await git(work, env, "clone", "-q", remote("throng.git", token), dir);
    return dir;
  };
  /** Commits a change in `dir` with `message` and returns its sha. */
  const commit = async (dir: string, message: string) => {
    await writeFile(join(dir, `change${clones}-${Math.random().toString(36).slice(2)}.txt`), `${message}\n`);
    await git(dir, env, "add", "-A");
    await git(dir, env, "commit", "-q", "-m", message);
    return (await git(dir, env, "rev-parse", "HEAD")).trim();
  };
  const push = (dir: string, branch: string) => tryGit(dir, env, "push", "origin", `HEAD:refs/heads/${branch}`);
  const fork = (attempt: string) => forkRepo(project.id, attempt);
  const journal = () =>
    sql(project.id)
      .db.prepare("SELECT kind, user_id, task, attempt, detail FROM journal WHERE task IS NOT NULL ORDER BY id")
      .all() as { kind: string; user_id: string; task: number; attempt: number | null; detail: string }[];
  const pending = () => sql(project.id).db.prepare("SELECT * FROM branch_pushes").all();
  /** The origin's refs, to check nothing but `main` ever lands there. */
  const originRefs = async () => (await git(host.path(origin), env, "for-each-ref", "--format=%(refname)")).trim();

  return {
    host,
    server,
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
    fork,
    journal,
    pending,
    originRefs,
  };
}

describe("push-to-create", () => {
  it("turns a new branch into a task and an opened attempt whose fork's main is the pushed head", async () => {
    const { ada, clone, commit, push, fork, host, tasks, project, journal, originRefs, mainSha, origin } =
      await setup();
    const dir = await clone(ada.token);
    const sha = await commit(dir, "Add search\n\nIndex titles and bodies.\n\nCloses nothing yet.");

    const pushed = await push(dir, "search");
    expect(pushed.stderr).not.toMatch(/rejected|error/);
    expect(pushed.ok).toBe(true);
    expect(pushed.stderr).toMatch(/\* \[new branch\]\s+HEAD -> search/);
    expect(pushed.stderr).toMatch(/remote: Created t2 "Add search" with attempt t2a1, opened, from branch search\./);
    expect(pushed.stderr).toMatch(
      /remote:\s+Task:\s+http:\/\/127\.0\.0\.1:\d+\/api\/projects\/greg\/throng\/tasks\/t2/,
    );
    expect(pushed.stderr).toMatch(/remote:\s+Attempt:\s+http:\/\/127\.0\.0\.1:\d+\/git\/greg\/throng\/t2a1\.git/);

    const task = tasks.getTask(project, ada.actor, { task: 2 });
    expect(task).toMatchObject({
      title: "Add search",
      body: "Index titles and bodies.\n\nCloses nothing yet.",
      creator: ada.user.id,
      state: "open",
      attempt_limit: null,
    });
    expect(tasks.getAttempt(project, ada.actor, { task: 2, number: 1 })).toMatchObject({
      author: ada.user.id,
      state: "open",
      branch: "search",
    });
    expect(await host.head(fork("t2a1"))).toBe(sha);
    expect(await host.head(origin)).toBe(mainSha);
    expect(await originRefs()).toBe("refs/heads/main");

    const events = journal().filter((e) => e.task === 2);
    expect(events.map((e) => [e.kind, e.attempt])).toEqual([
      ["created", null],
      ["created", 1],
      ["opened", 1],
      ["pushed", 1],
      ["scoringQueued", 1],
    ]);
    expect(pushed.stderr).toMatch(new RegExp(`remote: scoring queued for t2a1 \\(${sha}\\)`));
    expect(JSON.parse(events[3]!.detail)).toEqual({
      ref: "t2a1",
      gitRef: "refs/heads/main",
      before: mainSha,
      after: sha,
    });
  });

  it("updates the pusher's own attempt on a later push of the branch, force-pushes included", async () => {
    const { ada, clone, commit, push, fork, host, tasks, project, journal, env } = await setup();
    const dir = await clone(ada.token);
    const first = await commit(dir, "Add search");
    expect((await push(dir, "search")).ok).toBe(true);

    const second = await commit(dir, "Search bodies too");
    const again = await push(dir, "search");
    expect(again.ok).toBe(true);
    expect(again.stderr).toMatch(/remote: Updated t2a1 on t2 from branch search\./);
    expect(await host.head(fork("t2a1"))).toBe(second);
    expect(tasks.listTasks(project, ada.actor, {}).map((t) => t.number)).toEqual([1, 2]);
    expect(tasks.listAttempts(project, ada.actor, { task: 2 })).toHaveLength(1);
    const pushes = journal().filter((e) => e.kind === "pushed" && e.task === 2);
    expect(pushes.map((e) => JSON.parse(e.detail) as { before: string; after: string })).toEqual([
      expect.objectContaining({ after: first }),
      expect.objectContaining({ before: first, after: second }),
    ]);

    await git(dir, env, "reset", "-q", "--hard", "HEAD~2");
    const rewritten = await commit(dir, "Search, take two");
    expect((await push(dir, "search")).ok).toBe(true);
    expect(await host.head(fork("t2a1"))).toBe(rewritten);
  });

  it("rejects another user's push of a branch that maps to someone else's attempt, naming the task", async () => {
    const { ada, bob, clone, commit, push, fork, host, tasks, project } = await setup();
    const mine = await clone(ada.token);
    const sha = await commit(mine, "Add search");
    expect((await push(mine, "search")).ok).toBe(true);

    const theirs = await clone(bob.token);
    await commit(theirs, "Search, my way");
    const rejected = await push(theirs, "search");
    expect(rejected.ok).toBe(false);
    expect(rejected.stderr).toMatch(
      /\[remote rejected\] HEAD -> search \(branch search belongs to t2a1, another user's attempt on t2; push a branch named t2\/<name>/,
    );
    expect(await host.head(fork("t2a1"))).toBe(sha);
    expect(tasks.listTasks(project, bob.actor, {})).toHaveLength(2);
  });

  it("titles a task after its branch when the head commit has no subject", async () => {
    const { ada, clone, commit, push, tasks, project } = await setup();
    const dir = await clone(ada.token);
    await commit(dir, "x");
    await git(dir, gitEnv(dir), "commit", "-q", "--amend", "--allow-empty-message", "-m", "");
    expect((await push(dir, "quiet-change")).ok).toBe(true);
    expect(tasks.getTask(project, ada.actor, { task: 2 })).toMatchObject({ title: "quiet-change", body: "" });
  });

  it("creates only one task when two clients push the same new branch at once", async () => {
    const { ada, bob, clone, commit, push, tasks, project, host, pending } = await setup();
    const one = await clone(ada.token);
    const two = await clone(bob.token);
    await commit(one, "Ada's search");
    await commit(two, "Bob's search");

    const results = await Promise.all([push(one, "search"), push(two, "search")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.stderr).toMatch(
      /\[remote rejected\] HEAD -> search \((another push of branch search|branch search belongs to)/,
    );

    const made = tasks.listTasks(project, ada.actor, {}).filter((t) => t.number !== 1);
    expect(made).toHaveLength(1);
    const attempts = tasks.listAttempts(project, ada.actor, { task: made[0]!.number });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.branch).toBe("search");
    // Every fork left belongs to an attempt.
    expect(await host.list(`${project.id}-t`)).toEqual(
      [`${project.id}-t1a1`, `${project.id}-${attempts[0]!.fork}`].toSorted(),
    );
    expect(pending()).toEqual([]);
  });

  it("leaves no fork, attempt or task behind when a push fails after its fork was made", async () => {
    const { ada, clone, commit, push, tasks, project, host, pending, journal, originRefs } = await setup();
    const dir = await clone(ada.token);
    await commit(dir, "Add search");
    const read = vi.spyOn(host, "listCommits").mockRejectedValueOnce(new Error("Artifacts is down"));

    const failed = await push(dir, "search");
    expect(failed.ok).toBe(false);
    expect(failed.stderr).toMatch(/502|The push of search to t2a1 failed/);
    expect(read).toHaveBeenCalled();
    expect(await host.list(`${project.id}-t2`)).toEqual([]);
    expect(tasks.listTasks(project, ada.actor, {}).map((t) => t.number)).toEqual([1]);
    expect(pending()).toEqual([]);
    expect(journal().filter((e) => e.task !== 1)).toEqual([]);
    expect(await originRefs()).toBe("refs/heads/main");

    // The branch is free again; the failed push's number is never reused.
    const retried = await push(dir, "search");
    expect(retried.ok).toBe(true);
    expect(retried.stderr).toMatch(/Created t3 "Add search" with attempt t3a1/);
  });

  it("leaves nothing behind when the fork refuses the pushed objects", async () => {
    const { ada, clone, commit, push, tasks, project, host, pending } = await setup();
    const dir = await clone(ada.token);
    await commit(dir, "Add search");
    // A fork whose receive-pack rejects every update, as a broken pack or a server-side refusal would.
    const fork = vi.spyOn(host, "fork");
    fork.mockImplementationOnce(async (source, name) => {
      fork.mockRestore();
      await host.fork(source, name);
      await writeFile(join(host.path(name), "hooks", "pre-receive"), "#!/bin/sh\necho refused >&2\nexit 1\n", {
        mode: 0o755,
      });
    });

    const failed = await push(dir, "search");
    expect(failed.ok).toBe(false);
    expect(failed.stderr).toMatch(/\[remote rejected\] HEAD -> search \(pre-receive hook declined\)/);
    expect(await host.list(`${project.id}-t2`)).toEqual([]);
    expect(tasks.listTasks(project, ada.actor, {}).map((t) => t.number)).toEqual([1]);
    expect(pending()).toEqual([]);
  });

  it("rejects deletes, tags and main on the origin", async () => {
    const { ada, clone, commit, env, originRefs } = await setup();
    const dir = await clone(ada.token);
    await commit(dir, "tagged");
    const deleted = await tryGit(dir, env, "push", "origin", ":refs/heads/gone");
    expect(deleted.ok).toBe(false);
    await git(dir, env, "tag", "v1");
    const tagged = await tryGit(dir, env, "push", "origin", "v1");
    expect(tagged.ok).toBe(false);
    expect(tagged.stderr).toMatch(/\[remote rejected\] v1 -> v1 \(the origin keeps no refs but main/);
    expect(await originRefs()).toBe("refs/heads/main");
  });
});

describe("joining a task with a t<n>/ branch", () => {
  it("adds an opened attempt to the task, and a later push updates it", async () => {
    const { bob, clone, commit, push, fork, host, tasks, project, journal } = await setup();
    const dir = await clone(bob.token);
    const first = await commit(dir, "Fix login differently");

    const joined = await push(dir, "t1/bob");
    expect(joined.ok).toBe(true);
    expect(joined.stderr).toMatch(/remote: Added attempt t1a2, opened, to t1 "Fix login" from branch t1\/bob\./);
    expect(joined.stderr).toMatch(/remote:\s+Attempt:\s+\S+\/git\/greg\/throng\/t1a2\.git/);
    expect(tasks.getAttempt(project, bob.actor, { task: 1, number: 2 })).toMatchObject({
      author: bob.user.id,
      state: "open",
      branch: "t1/bob",
    });
    expect(tasks.getTask(project, bob.actor, { task: 1 }).title).toBe("Fix login");
    expect(await host.head(fork("t1a2"))).toBe(first);

    const second = await commit(dir, "And the tests");
    expect((await push(dir, "t1/bob")).ok).toBe(true);
    expect(await host.head(fork("t1a2"))).toBe(second);
    expect(tasks.listAttempts(project, bob.actor, { task: 1 })).toHaveLength(2);
    expect(
      journal()
        .filter((e) => e.task === 1 && e.attempt === 2)
        .map((e) => e.kind),
    ).toEqual(["created", "opened", "pushed", "scoringQueued", "pushed", "scoringCancelled", "scoringQueued"]);
  });

  it("rejects a join for a missing, closed or obsolete task, one at its limit, or one with an open merge request", async () => {
    const { ada, bob, greg, clone, commit, push, tasks, project, host, pending } = await setup();
    const dir = await clone(bob.token);
    await commit(dir, "Join");
    const rejection = async (branch: string) => {
      const result = await push(dir, branch);
      expect(result.ok).toBe(false);
      return /\[remote rejected\] HEAD -> \S+ \((.*)\)/.exec(result.stderr)?.[1];
    };

    expect(await rejection("t9/x")).toBe("branch t9/x is for t9, which doesn't exist");

    tasks.editTask(project, ada.actor, { task: 1, attemptLimit: 1 });
    expect(await rejection("t1/x")).toBe("t1 has 1 of 1 active attempts");
    tasks.editTask(project, ada.actor, { task: 1, attemptLimit: null });

    const mergeRequest = vi.spyOn(tasks, "hasOpenMergeRequest").mockReturnValue(true);
    expect(await rejection("t1/x")).toBe("t1 has an open merge request, so it takes no new attempts");
    mergeRequest.mockRestore();

    await tasks.closeTask(project, ada.actor, { task: 1 });
    expect(await rejection("t1/x")).toBe("can't add attempts to t1: it is closed");

    await tasks.obsoleteTask(project, greg.actor, { task: 1 });
    expect(await rejection("t1/x")).toBe("can't add attempts to t1: it is obsolete");

    // No rejected join left a fork; closing t1 archived and deleted t1a1's.
    expect(await host.list(`${project.id}-t1a`)).toEqual([]);
    expect(await host.list(`${project.id}-t9`)).toEqual([]);
    expect(pending()).toEqual([]);
  });
});
