// The task branch through the git proxy, with real `git` against `git http-backend` standing in
// for Artifacts: the task creator or project owner pushes `refs/tasks/t<n>` to the origin, and new
// attempts start from its head.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
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
  const { backend, store } = testTaskBackends(host, now);
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

  return { host, env, greg, ada, bob, project, origin, mainSha, tasks, clone, commit, push, taskHead, fork };
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
