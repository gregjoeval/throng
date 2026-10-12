// The git proxy, driven by real `git` through a local `git http-backend` standing in for Artifacts.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { gitRoutes, UPSTREAM_TOKEN_TTL_SECONDS } from "../src/git-proxy.ts";
import { projectService } from "../src/projects.ts";
import { forkRepo, originRepo } from "../src/repos.ts";
import type { ScoringResult } from "../src/results.ts";
import type { ScoringRunner } from "../src/scoring.ts";
import type { ProjectContext } from "../src/task-store.ts";
import { mintToken } from "../src/tokens.ts";
import type { Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { conflictDetails, ERRORED } from "./support/conflicts.ts";
import { testDatabase } from "./support/d1.ts";
import { at } from "./support/defined.ts";
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
  // Runs start but never finish on their own: a test finishes one with `scoringFinished`.
  const scoring: ScoringRunner = {
    workflow: { create: async () => ({}), get: async () => ({ terminate: async () => {} }) },
    teardown: async () => {},
  };
  const { backend, store, sql } = testTaskBackends(host, now, scoring);
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
    expect(pushed.stderr).not.toMatch(/rejected/u);
    expect(pushed.ok).toBeTruthy();
    expect(await host.head(forkRepo(project.id, "t1a1"))).toBe(sha);

    expect(journal()).toHaveLength(1);
    expect(journal()[0]).toMatchObject({ kind: "pushed", user_id: ada.user.id, task: 1, attempt: 1 });
    expect(JSON.parse(at(journal(), 0).detail)).toEqual({ ref: "t1a1", gitRef: "refs/heads/main", before, after: sha });
    // A draft isn't scored on push.
    expect(pushed.stderr).not.toMatch(/scoring/u);
  });

  it("queues scoring of an open attempt's new head on push, and says so", async () => {
    const { ada, clone, commit, env, project, store, attempt } = await setup();
    const ref = { task: attempt.task, number: attempt.number };
    await store(project.id).openAttempt(project, ada.actor, ref);
    const dir = await clone("throng/t1a1.git", ada.token);
    const sha = await commit(dir, "fix");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).toMatch(new RegExp(`remote: scoring queued for t1a1 \\(${sha}\\)`, "u"));
    expect(pushed.stderr).toMatch(/HEAD -> main/u);
    expect(
      store(project.id)
        .scoring.listRuns({ task: 1, attempt: 1 })
        .map((r) => [r.trigger, r.sha, r.status]),
    ).toEqual([
      ["open", expect.any(String), "cancelled"],
      ["push", sha, "queued"],
    ]);

    // Pushing the same head to another ref of the fork queues nothing more.
    const again = await tryGit(dir, env, "push", "origin", "HEAD:refs/heads/copy");
    expect(again.ok).toBeTruthy();
    expect(again.stderr).not.toMatch(/scoring/u);
  });

  it("rejects a push by anyone but the author when git asks to push", async () => {
    const { bob, clone, commit, env, host, project, journal } = await setup();
    const dir = await clone("throng/t1a1.git", bob.token);
    await commit(dir, "intrusion");
    const before = await host.head(forkRepo(project.id, "t1a1"));
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeFalsy();
    expect(pushed.stderr).toMatch(/Push rejected: only the author of t1a1 may/u);
    expect(pushed.stderr).toMatch(/403/u);
    expect(await host.head(forkRepo(project.id, "t1a1"))).toBe(before);
    expect(journal()).toEqual([]);
  });

  it("rejects a push to a closed attempt's fork", async () => {
    const { ada, clone, commit, env, host, project, store } = await setup();
    const dir = await clone("throng/t1a1.git", ada.token);
    await commit(dir, "late");
    await store(project.id).closeAttempt(project, ada.actor, { task: 1, number: 1 });
    const before = await host.head(forkRepo(project.id, "t1a1"));
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeFalsy();
    expect(pushed.stderr).toMatch(/Push rejected: t1a1 is closed/u);
    expect(await host.head(forkRepo(project.id, "t1a1"))).toBe(before);
  });

  it("checks the claim on every push, so a hand-off or close between requests still counts", async () => {
    const { ada, server, project, store, host } = await setup();
    await store(project.id).closeAttempt(project, ada.actor, { task: 1, number: 1 });
    // Closing pushed the archive to the origin itself; only what follows is the proxy's doing.
    const seen = host.requests.length;
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
    expect(await probe.text()).toMatch(/t1a1 is closed/u);

    const command = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main\0report-status\n`;
    const push = await post(`${(command.length + 4).toString(16).padStart(4, "0")}${command}0000PACK`);
    expect(push.status).toBe(200);
    expect(await push.text()).toContain("ng refs/heads/main t1a1 is closed");
    expect(host.requests.slice(seen).filter((r) => r.path.includes("git-receive-pack"))).toEqual([]);
  });

  it("rejects a push to origin main per ref with a readable message", async () => {
    const { greg, clone, commit, env, host, origin } = await setup();
    const dir = await clone("throng.git", greg.token);
    await commit(dir, "direct");
    const before = await host.head(origin);
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeFalsy();
    expect(pushed.stderr).toMatch(/\[remote rejected\] HEAD -> main \(main only advances through the merge queue/u);
    expect(await host.head(origin)).toBe(before);
    // The pack never reached the repo host.
    expect(host.requests.filter((r) => r.method === "POST" && r.path.endsWith("git-receive-pack"))).toEqual([]);
  });

  it("rejects a push of several refs to the origin, since one pack lands in one fork", async () => {
    const { ada, clone, commit, env, host, origin, project } = await setup();
    const dir = await clone("throng.git", ada.token);
    await commit(dir, "feature");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:refs/heads/feature", "HEAD:refs/heads/t1/x");
    expect(pushed.ok).toBeFalsy();
    expect(pushed.stderr).toMatch(/\[remote rejected\] HEAD -> feature \(push one branch at a time to the origin/u);
    expect(pushed.stderr).toMatch(/\[remote rejected\] HEAD -> t1\/x/u);
    expect(await host.head(origin, "refs/heads/feature")).toBeNull();
    expect(await host.list(`${project.id}-t1a2`)).toEqual([]);
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
    expect(await res.text()).toMatch(/main only advances through the merge queue/u);
    expect(host.requests.filter((r) => r.path.endsWith("git-receive-pack"))).toEqual([]);
  });

  it("rejects an expired Throng token", async () => {
    const { advance, ada, clone, work, env, remote } = await setup();
    await clone("throng.git", ada.token);
    advance(2 * 60 * 60 * 1000);
    const cloned = await tryGit(work, env, "clone", "-q", remote("throng.git", ada.token), join(work, "late"));
    expect(cloned.ok).toBeFalsy();
    expect(cloned.stderr).toMatch(/Authentication failed|401/u);
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
        expect(response.body).not.toContain(token);
        expect(JSON.stringify(response.headers)).not.toContain(token);
      }
    }
    expect(
      server.responses.some((r) =>
        r.headers.some(([name]) => name.toLowerCase() === "www-authenticate" && r.status !== 401),
      ),
    ).toBeFalsy();
  });
});

describe("merge request notices on a push to the source attempt", () => {
  const passed: ScoringResult = {
    base: "b".repeat(40),
    config: { kind: "none" },
    gate: "passed",
    checks: [],
    builtin: { filesChanged: 1, additions: 1, deletions: 0, durationMs: 5 },
    preview: { status: "none" },
    logs: [],
  };

  /** t1a1 opened, selected and queued (its head's run passed its gate), and a clone of it to push from. */
  async function queued() {
    const ctx = await setup();
    const { ada, clone, project, store } = ctx;
    const ref = { task: 1, number: 1 };
    await store(project.id).openAttempt(project, ada.actor, ref);
    await store(project.id).selectAttempt(project, ada.actor, ref);
    await store(project.id).scoring.drain();
    const run = at(store(project.id).scoring.listRuns({ task: 1, attempt: 1 }), -1);
    store(project.id).scoringFinished(run.id, { status: "done", result: passed });
    expect(store(project.id).getMergeRequest(project, ada.actor, { task: 1 }).state).toBe("queued");
    const dir = await clone("throng/t1a1.git", ada.token);
    const dequeueUrl = `${ctx.server.origin}/api/projects/greg/throng/tasks/t1/merge-request/dequeue`;
    return { ...ctx, dir, dequeueUrl };
  }

  it("prints nothing for an attempt without a merge request", async () => {
    const { ada, clone, commit, env, project, store } = await setup();
    await store(project.id).openAttempt(project, ada.actor, { task: 1, number: 1 });
    const dir = await clone("throng/t1a1.git", ada.token);
    await commit(dir, "fix");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).not.toMatch(/merge request/u);
  });

  it("prints a conflict dequeue with its file count once, and that the push needs review", async () => {
    const { commit, dir, dequeueUrl, env, project, store } = await queued();
    const details = conflictDetails(["a.ts", "b.ts", "c.ts"]);
    store(project.id).dequeueMergeRequest(project, null, { task: 1, reason: "conflict", details });

    const sha = await commit(dir, "fix");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).toContain(`remote: merge request t1 dequeued (conflict): 3 files — ${dequeueUrl}`);
    expect(pushed.stderr).toContain(`remote: merge request t1 needs review: new head ${sha}`);

    await commit(dir, "more");
    const again = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(again.ok).toBeTruthy();
    expect(again.stderr).not.toMatch(/merge request/u);
  });

  it("prints a dequeue without a file count when there is none, on a push that moves no head", async () => {
    const { dir, dequeueUrl, env, project, store } = await queued();
    store(project.id).dequeueMergeRequest(project, null, { task: 1, reason: "errored", details: ERRORED });

    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:refs/heads/copy");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).toContain(`remote: merge request t1 dequeued (errored) — ${dequeueUrl}`);
    expect(pushed.stderr).not.toMatch(/needs review/u);

    const again = await tryGit(dir, env, "push", "origin", "HEAD:refs/heads/copy2");
    expect(again.ok).toBeTruthy();
    expect(again.stderr).not.toMatch(/merge request/u);
  });

  it("says a push to a queued merge request's source needs review, not that it was dequeued for it", async () => {
    const { commit, dir, env } = await queued();
    const sha = await commit(dir, "fix");
    const pushed = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(pushed.ok).toBeTruthy();
    expect(pushed.stderr).toContain(`remote: merge request t1 needs review: new head ${sha}`);
    expect(pushed.stderr).not.toMatch(/dequeued/u);

    await commit(dir, "more");
    const again = await tryGit(dir, env, "push", "origin", "HEAD:main");
    expect(again.ok).toBeTruthy();
    expect(again.stderr).not.toMatch(/merge request/u);
  });
});
