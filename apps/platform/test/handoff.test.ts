// Handing off an attempt: the store's rules, then end to end through the API and the git proxy,
// where the next push checks the new author with nothing revoked.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { apiRoutes } from "../src/api.ts";
import { ServiceError } from "../src/errors.ts";
import { gitRoutes } from "../src/git-proxy.ts";
import { projectService } from "../src/projects.ts";
import { forkRepo, originRepo } from "../src/repos.ts";
import { TaskStore } from "../src/task-store.ts";
import type { AttemptState, ProjectContext } from "../src/task-store.ts";
import { mintToken } from "../src/tokens.ts";
import type { Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { git, gitEnv, LocalGitHost, serve, tryGit } from "./support/git-host.ts";
import type { Json } from "./support/json.ts";
import { testSql, testTaskBackends } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };

function actor(id: string, alias: string | null = null): Actor {
  return { user: { id, handle: id, email: `${id}@example.com`, created_at: "" }, alias };
}

const owner = actor("owner001");
const adaUser = actor("ada00001");
const claudeOfAda = actor("ada00001", "claude");
const bobUser = actor("bob00001");

function storeSetup() {
  const repos = new FakeRepos();
  void repos.create("abc123-main", { defaultBranch: "main" });
  const sql = testSql();
  const store = new TaskStore({ sql, repos, now: () => new Date("2026-10-10T12:00:00.000Z") });
  const journal = () =>
    sql.db.prepare("SELECT kind, user_id, alias, task, attempt, detail FROM journal WHERE kind = 'handedOff'").all();
  return { store, journal };
}

/** A task with one attempt by ada, in `state`. */
async function attemptIn(store: TaskStore, state: AttemptState) {
  const task = store.createTask(PROJECT, adaUser, { title: "Fix it" });
  const [a] = await store.createAttempts(PROJECT, adaUser, { task: task.number });
  if (a === undefined) throw new Error("no attempt");
  const ref = { task: a.task, number: a.number };
  if (state === "open" || state === "merged") await store.openAttempt(PROJECT, adaUser, ref);
  if (state === "merged") store.markMerged(PROJECT, owner, { ...ref, sha: "abc" });
  if (state === "closed") store.closeAttempt(PROJECT, adaUser, ref);
  if (state === "obsolete") store.obsoleteAttempt(PROJECT, owner, ref);
  return ref;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  throw new Error("expected a ServiceError");
}

describe("handOffAttempt", () => {
  it("drops the alias the old author started the attempt under", async () => {
    const { store } = storeSetup();
    const task = store.createTask(PROJECT, adaUser, { title: "Fix it" });
    const [a] = await store.createAttempts(PROJECT, claudeOfAda, { task: task.number });
    if (a === undefined) throw new Error("no attempt");
    expect(a.alias).toBe("claude");
    const ref = { task: a.task, number: a.number };
    expect(store.handOffAttempt(PROJECT, claudeOfAda, { ...ref, to: bobUser.user.id }).alias).toBeNull();
  });

  it("makes the new user the author at once and journals both users", async () => {
    const { store, journal } = storeSetup();
    const ref = await attemptIn(store, "open");
    const handed = store.handOffAttempt(PROJECT, claudeOfAda, { ...ref, to: bobUser.user.id });
    expect(handed).toMatchObject({ author: bobUser.user.id, state: "open" });
    expect(store.getAttempt(PROJECT, bobUser, ref).author).toBe(bobUser.user.id);
    expect(journal()).toEqual([
      {
        kind: "handedOff",
        user_id: adaUser.user.id,
        alias: "claude",
        task: 1,
        attempt: 1,
        detail: JSON.stringify({ ref: "t1a1", from: adaUser.user.id, to: bobUser.user.id }),
      },
    ]);

    // The claim moved: the old author can no longer act as author, the new one can.
    expect(code(() => store.authorizePush(PROJECT, adaUser, ref))).toBe("forbidden");
    expect(store.authorizePush(PROJECT, bobUser, ref).author).toBe(bobUser.user.id);
    expect(code(() => store.handOffAttempt(PROJECT, adaUser, { ...ref, to: adaUser.user.id }))).toBe("forbidden");
    expect(store.handOffAttempt(PROJECT, bobUser, { ...ref, to: adaUser.user.id }).author).toBe(adaUser.user.id);
  });

  it("hands off a draft too", async () => {
    const { store } = storeSetup();
    const ref = await attemptIn(store, "draft");
    expect(store.handOffAttempt(PROJECT, adaUser, { ...ref, to: bobUser.user.id })).toMatchObject({
      author: bobUser.user.id,
      state: "draft",
    });
  });

  it("refuses a non-author, even the project owner", async () => {
    const { store, journal } = storeSetup();
    const ref = await attemptIn(store, "open");
    for (const who of [bobUser, owner]) {
      expect(code(() => store.handOffAttempt(PROJECT, who, { ...ref, to: bobUser.user.id }))).toBe("forbidden");
    }
    expect(journal()).toEqual([]);
  });

  it.each(["closed", "merged", "obsolete"] as const)("refuses a %s attempt", async (state) => {
    const { store, journal } = storeSetup();
    const ref = await attemptIn(store, state);
    expect(code(() => store.handOffAttempt(PROJECT, adaUser, { ...ref, to: bobUser.user.id }))).toBe("invalidState");
    expect(journal()).toEqual([]);
  });

  it("refuses handing an attempt to its own author", async () => {
    const { store } = storeSetup();
    const ref = await attemptIn(store, "open");
    expect(code(() => store.handOffAttempt(PROJECT, claudeOfAda, { ...ref, to: adaUser.user.id }))).toBe(
      "invalidRequest",
    );
  });
});

const now = () => new Date("2026-10-10T12:00:00.000Z");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The API and the git proxy over one local git host, with greg's project and ada's attempt t1a1. */
async function e2eSetup() {
  const host = await LocalGitHost.start();
  cleanups.push(() => host.close());
  const work = await mkdtemp(join(tmpdir(), "throng-handoff-"));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  const env = gitEnv(work);

  const db = testDatabase();
  const bindings = { DB: db, ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "x" };
  const { backend, store } = testTaskBackends(host, now);
  const api = apiRoutes({
    verifierFor: () => async () => null,
    now,
    repos: () => host,
    tasks: () => backend,
  });
  const app = new Hono().route("/git", gitRoutes({ repos: () => host, tasks: () => backend, now }));
  const server = await serve(app, bindings);
  cleanups.push(server.close);

  const person = async (email: string, alias: string | null = null) => {
    const user = await userForEmail(db, email);
    const { plaintext } = await mintToken(db, { userId: user.id, alias, ttlSeconds: 3600, now: now() });
    return { user, actor: { user, alias } as Actor, token: plaintext };
  };
  const greg = await person("greg@example.com");
  const ada = await person("ada@example.com");
  const adaClaude = await person("ada@example.com", "claude");
  const bob = await person("bob@example.com");

  const created = await projectService({ db, repos: host }).create(greg.actor, { handle: "throng" });
  const project: ProjectContext = { id: created.id, owner: greg.user.id };
  const seed = join(work, "seed");
  await git(work, env, "init", "-q", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(seed, env, "add", "-A");
  await git(seed, env, "commit", "-q", "-m", "seed");
  await git(seed, env, "push", "-q", host.path(originRepo(project.id)), "main");

  const task = store(project.id).createTask(project, ada.actor, { title: "Fix login" });
  await store(project.id).createAttempts(project, ada.actor, { task: task.number });

  const handOff = async (token: string, to: string, attempt = "t1a1") => {
    const res = await api.request(
      `/projects/greg/throng/attempts/${attempt}/handoff`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      },
      bindings,
    );
    return { status: res.status, body: (await res.json()) as Json };
  };

  let clones = 0;
  const clone = async (token: string) => {
    const dir = join(work, `clone${++clones}`);
    const remote = `${server.origin.replace("://", `://git:${token}@`)}/git/greg/throng/t1a1.git`;
    await git(work, env, "clone", "-q", remote, dir);
    return dir;
  };
  const commit = async (dir: string, message: string) => {
    await writeFile(join(dir, `${message}.txt`), `${message}\n`);
    await git(dir, env, "add", "-A");
    await git(dir, env, "commit", "-q", "-m", message);
    return (await git(dir, env, "rev-parse", "HEAD")).trim();
  };
  const fork = forkRepo(project.id, "t1a1");

  return { host, env, greg, ada, adaClaude, bob, store, project, handOff, clone, commit, fork };
}

describe("hand-off through the API and the git proxy", () => {
  it("moves the claim: the old author's next push is refused and the new author's lands", async () => {
    const { host, env, adaClaude, ada, bob, handOff, clone, commit, fork } = await e2eSetup();
    const adaDir = await clone(ada.token);
    await commit(adaDir, "first");
    expect((await tryGit(adaDir, env, "push", "origin", "HEAD:main")).ok).toBeTruthy();

    const handed = await handOff(adaClaude.token, "bob");
    expect(handed.status).toBe(200);
    expect(handed.body).toMatchObject({ ref: "t1a1", state: "draft", author: { id: bob.user.id, handle: "bob" } });

    // Ada's next push, from the same clone with the same token, is refused.
    const before = await host.head(fork);
    await commit(adaDir, "second");
    const refused = await tryGit(adaDir, env, "push", "origin", "HEAD:main");
    expect(refused.ok).toBeFalsy();
    expect(refused.stderr).toMatch(/only the author of t1a1 may/u);
    expect(await host.head(fork)).toBe(before);

    const bobDir = await clone(bob.token);
    const sha = await commit(bobDir, "bob");
    expect((await tryGit(bobDir, env, "push", "origin", "HEAD:main")).ok).toBeTruthy();
    expect(await host.head(fork)).toBe(sha);
  });

  it("refuses a non-author, an unknown user, the author themselves and a closed attempt", async () => {
    const { ada, bob, greg, store, project, handOff } = await e2eSetup();
    expect((await handOff(bob.token, "bob")).body).toEqual({
      error: { code: "forbidden", message: "only the author of t1a1 may" },
    });
    expect((await handOff(greg.token, "bob")).status).toBe(403);

    const unknown = await handOff(ada.token, "nobody");
    expect(unknown.status).toBe(404);
    expect(unknown.body["error"]).toEqual({ code: "notFound", message: "no user nobody" });

    const self = await handOff(ada.token, "ada");
    expect(self.status).toBe(400);
    expect(self.body["error"]["code"]).toBe("invalidRequest");

    expect((await handOff(ada.token, "")).status).toBe(400);
    expect((await handOff(ada.token, "bob", "t1")).status).toBe(400);
    expect((await handOff(ada.token, "bob", "t1a9")).status).toBe(404);

    store(project.id).closeAttempt(project, ada.actor, { task: 1, number: 1 });
    const closed = await handOff(ada.token, "bob");
    expect(closed.status).toBe(409);
    expect(closed.body["error"]).toEqual({ code: "invalidState", message: "can't hand off t1a1: it is closed" });
  });
});
