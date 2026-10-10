// The git proxy, driven by real `git` through a local `git http-backend` standing in for Artifacts.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { gitRoutes, UPSTREAM_TOKEN_TTL_SECONDS } from "../src/git-proxy.ts";
import { projectService } from "../src/projects.ts";
import { originRepo, forkRepo } from "../src/repos.ts";
import type { ProjectContext } from "../src/task-store.ts";
import { mintToken, type Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";
import { git, gitEnv, LocalGitHost, serve, tryGit } from "./support/git-host.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup() {
  let clock = new Date("2026-10-10T12:00:00.000Z").getTime();
  const now = () => new Date(clock);
  const host = await LocalGitHost.start();
  host.now = () => clock;
  cleanups.push(() => host.close());
  const work = await mkdtemp(join(tmpdir(), "throng-git-work-"));
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

  // Seed origin `main` straight onto disk, as an import would.
  const seed = join(work, "seed");
  await git(work, env, "init", "-q", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(seed, env, "add", "-A");
  await git(seed, env, "commit", "-q", "-m", "seed");
  await git(seed, env, "push", "-q", host.path(origin), "main");

  const task = store(project.id).createTask(project, ada.actor, { title: "Fix login" });
  const [attempt] = await store(project.id).createAttempts(project, ada.actor, { task: task.number });
  if (attempt === undefined) throw new Error("no attempt");

  /** The remote URL for `path` (e.g. `throng.git`), with `token` as the Basic password. */
  const remote = (path: string, token: string) =>
    `${server.origin.replace("://", `://git:${token}@`)}/git/greg/${path}`;

  let clones = 0;
  /** Clones `path` as `token` into a fresh directory and returns it. */
  const clone = async (path: string, token: string) => {
    const dir = join(work, `clone${++clones}`);
    await git(work, env, "clone", "-q", remote(path, token), dir);
    return dir;
  };
  /** Commits a change in `dir` and returns its sha. */
  const commit = async (dir: string, message: string) => {
    await writeFile(join(dir, `${message}.txt`), `${message}\n`);
    await git(dir, env, "add", "-A");
    await git(dir, env, "commit", "-q", "-m", message);
    return (await git(dir, env, "rev-parse", "HEAD")).trim();
  };
  const journal = () =>
    sql(project.id)
      .db.prepare("SELECT kind, user_id, task, attempt, detail FROM journal WHERE kind = 'pushed' ORDER BY id")
      .all() as { kind: string; user_id: string; task: number; attempt: number; detail: string }[];
  const advance = (ms: number) => {
    clock += ms;
  };

  return {
    host,
    server,
    env,
    work,
    greg,
    ada,
    bob,
    project,
    origin,
    attempt,
    store,
    remote,
    clone,
    commit,
    journal,
    advance,
  };
}

describe("git proxy", () => {
  it("lets any valid token clone and fetch the origin and an attempt's fork", async () => {
    const { bob, clone, env, host, origin } = await setup();
    const fromOrigin = await clone("throng.git", bob.token);
    expect((await git(fromOrigin, env, "rev-parse", "HEAD")).trim()).toBe(await host.head(origin));
    await git(fromOrigin, env, "fetch", "-q", "origin");

    const fromFork = await clone("throng/t1a1.git", bob.token);
    expect((await git(fromFork, env, "log", "--format=%s")).trim()).toBe("seed");
  });

  it("lets the author push to their active attempt's fork, and journals the push", async () => {
    const { ada, clone, commit, env, host, project, journal } = await setup();
    const dir = await clone("throng/t1a1.git", ada.token);
    const before = (await git(dir, env, "rev-parse", "HEAD")).trim();
    const sha = await commit(dir, "fix");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.stderr).not.toMatch(/rejected/);
    expect(pushed.ok).toBe(true);
    expect(await host.head(forkRepo(project.id, "t1a1"))).toBe(sha);

    await expect.poll(journal).toHaveLength(1);
    expect(journal()[0]).toMatchObject({ kind: "pushed", user_id: ada.user.id, task: 1, attempt: 1 });
    expect(JSON.parse(journal()[0]!.detail)).toEqual({ ref: "t1a1", git_ref: "refs/heads/main", before, after: sha });
  });

  it("rejects a push by anyone but the author when git asks to push", async () => {
    const { bob, clone, commit, env, host, project, journal } = await setup();
    const dir = await clone("throng/t1a1.git", bob.token);
    await commit(dir, "intrusion");
    const before = await host.head(forkRepo(project.id, "t1a1"));
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBe(false);
    expect(pushed.stderr).toMatch(/Push rejected: only the author of t1a1 may/);
    expect(pushed.stderr).toMatch(/403/);
    expect(await host.head(forkRepo(project.id, "t1a1"))).toBe(before);
    expect(journal()).toEqual([]);
  });

  it("rejects a push to a closed attempt's fork", async () => {
    const { ada, clone, commit, env, host, project, store } = await setup();
    const dir = await clone("throng/t1a1.git", ada.token);
    await commit(dir, "late");
    store(project.id).closeAttempt(project, ada.actor, { task: 1, number: 1 });
    const before = await host.head(forkRepo(project.id, "t1a1"));
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBe(false);
    expect(pushed.stderr).toMatch(/Push rejected: t1a1 is closed/);
    expect(await host.head(forkRepo(project.id, "t1a1"))).toBe(before);
  });

  it("checks the claim on every push, so a hand-off or close between requests still counts", async () => {
    const { ada, server, project, store, host } = await setup();
    store(project.id).closeAttempt(project, ada.actor, { task: 1, number: 1 });
    // Receive-pack POSTs without the `info/refs` before them: a probe, then a push.
    const post = (body: string) =>
      fetch(`${server.origin}/git/greg/throng/t1a1.git/git-receive-pack`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`git:${ada.token}`)}`,
          "Content-Type": "application/x-git-receive-pack-request",
        },
        body,
      });
    const probe = await post("0000");
    expect(probe.status).toBe(403);
    expect(await probe.text()).toMatch(/t1a1 is closed/);

    const command = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main\0report-status\n`;
    const push = await post(`${(command.length + 4).toString(16).padStart(4, "0")}${command}0000PACK`);
    expect(push.status).toBe(200);
    expect(await push.text()).toContain("ng refs/heads/main t1a1 is closed");
    expect(host.requests.filter((r) => r.path.includes("git-receive-pack"))).toEqual([]);
  });

  it("rejects a push to origin main per ref with a readable message", async () => {
    const { greg, clone, commit, env, host, origin } = await setup();
    const dir = await clone("throng.git", greg.token);
    await commit(dir, "direct");
    const before = await host.head(origin);
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBe(false);
    expect(pushed.stderr).toMatch(/\[remote rejected\] HEAD -> main \(main only advances through the merge queue/);
    expect(await host.head(origin)).toBe(before);
    // The pack never reached the repo host.
    expect(host.requests.filter((r) => r.method === "POST" && r.path.endsWith("git-receive-pack"))).toEqual([]);
  });

  it("rejects other branches pushed to the origin until push-to-create lands", async () => {
    const { ada, clone, commit, env, host, origin } = await setup();
    const dir = await clone("throng.git", ada.token);
    await commit(dir, "feature");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:refs/heads/feature", "HEAD:refs/heads/t1/x");
    expect(pushed.ok).toBe(false);
    expect(pushed.stderr).toMatch(
      /\[remote rejected\] HEAD -> feature \(pushing a branch to the origin isn't supported yet/,
    );
    expect(pushed.stderr).toMatch(/\[remote rejected\] HEAD -> t1\/x/);
    expect(await host.head(origin, "refs/heads/feature")).toBeNull();
  });

  it("rejects a push with a plain 403 when the client asked for no report", async () => {
    const { greg, host, server } = await setup();
    const command = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main\n`;
    const res = await fetch(`${server.origin}/git/greg/throng.git/git-receive-pack`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`git:${greg.token}`)}`,
        "Content-Type": "application/x-git-receive-pack-request",
      },
      body: `${(command.length + 4).toString(16).padStart(4, "0")}${command}0000PACK`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/main only advances through the merge queue/);
    expect(host.requests.filter((r) => r.path.endsWith("git-receive-pack"))).toEqual([]);
  });

  it("rejects an expired Throng token", async () => {
    const { advance, ada, clone, work, env, remote } = await setup();
    await clone("throng.git", ada.token);
    advance(2 * 60 * 60 * 1000);
    const cloned = await tryGit(work, env, "clone", "-q", remote("throng.git", ada.token), join(work, "late"));
    expect(cloned.ok).toBe(false);
    expect(cloned.stderr).toMatch(/Authentication failed|401/);
  });

  it("rejects unknown projects and attempts, and dumb HTTP", async () => {
    const { ada, server } = await setup();
    const get = (path: string) =>
      fetch(`${server.origin}${path}`, { headers: { Authorization: `Basic ${btoa(`git:${ada.token}`)}` } });
    expect((await get("/git/greg/nope.git/info/refs?service=git-upload-pack")).status).toBe(404);
    expect((await get("/git/greg/throng/t9a9.git/info/refs?service=git-upload-pack")).status).toBe(404);
    expect((await get("/git/greg/throng/9a9.git/info/refs?service=git-upload-pack")).status).toBe(404);
    expect((await get("/git/greg/throng.git/info/refs")).status).toBe(403);
    expect((await get("/git/greg/throng.git/HEAD")).status).toBe(404);
    expect((await get("/git/greg/throng/t9a9.git/info/refs?service=git-receive-pack")).status).toBe(404);
  });

  it("caches the Artifacts token per repo and scope and never shows it to the client", async () => {
    const { ada, advance, clone, commit, env, host, server, origin, project } = await setup();
    const mintsBefore = host.mints.length;
    const dir = await clone("throng/t1a1.git", ada.token);
    await git(dir, env, "fetch", "-q", "origin");
    await commit(dir, "one");
    await git(dir, env, "push", "-q", "origin", "HEAD:main");
    await commit(dir, "two");
    await git(dir, env, "push", "-q", "origin", "HEAD:main");
    await clone("throng.git", ada.token);
    const fork = forkRepo(project.id, "t1a1");
    expect(host.mints.slice(mintsBefore)).toEqual([
      { name: fork, scope: "read" },
      { name: fork, scope: "write" },
      { name: origin, scope: "read" },
    ]);

    // Shortly before the token expires, a new one is minted.
    advance((UPSTREAM_TOKEN_TTL_SECONDS - 60) * 1000);
    await clone("throng.git", ada.token);
    expect(host.mints.slice(mintsBefore).filter((m) => m.name === origin && m.scope === "read")).toHaveLength(2);

    for (const token of host.tokens()) {
      for (const response of server.responses) {
        expect(response.body.includes(token)).toBe(false);
        expect(JSON.stringify(response.headers)).not.toContain(token);
      }
    }
    expect(
      server.responses.some((r) =>
        r.headers.some(([name]) => name.toLowerCase() === "www-authenticate" && r.status !== 401),
      ),
    ).toBe(false);
  });
});
