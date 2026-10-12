import { describe, expect, it } from "vitest";
import { e2eProject, e2eRoutes, e2eToken } from "../src/e2e.ts";
import type { LogBucket } from "../src/e2e.ts";
import { resolveProject } from "../src/projects.ts";
import { forkRepo, originRepo } from "../src/repos.ts";
import { authenticateToken, mintToken } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import type { Database } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const SECRET = "s3cret";

describe("e2eToken", () => {
  it("mints a Throng token for the e2e suite's own user, the same user every time", async () => {
    const db = testDatabase();
    const first = await e2eToken(db, NOW);
    const second = await e2eToken(db, NOW);
    expect(first.user.id).toBe(second.user.id);
    expect(first.token).not.toBe(second.token);
    const found = await authenticateToken(db, first.token, NOW);
    expect(found?.actor).toMatchObject({ user: { id: first.user.id }, alias: null });
  });
});

describe("e2eProject", () => {
  it("makes a real project owned by the e2e user, whose id and handle are both the name asked for", async () => {
    const db = testDatabase();
    const repos = new FakeRepos();
    const { user } = await e2eToken(db, NOW);

    const made = await e2eProject(db, repos, "e2eabc123");

    expect(made.project).toMatchObject({ id: "e2eabc123", handle: "e2eabc123", owner: { id: user.id } });
    expect(await resolveProject(db, user.handle, "e2eabc123")).toMatchObject({ id: "e2eabc123" });
    // The origin exists and the write token lets the suite seed its main directly.
    expect((await repos.get(originRepo("e2eabc123"))).remote).toBe(made.remote);
    expect(made.token).toEqual(expect.any(String));
  });
});

/** An R2 bucket's list and delete, in memory. */
class FakeLogs implements LogBucket {
  readonly keys = new Set<string>();
  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    const all = [...this.keys].filter((k) => k.startsWith(prefix)).toSorted();
    const start = cursor === undefined ? 0 : Number(cursor);
    const page = all.slice(start, start + 2);
    const truncated = start + 2 < all.length;
    return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + 2) } : {}) };
  }
  async delete(keys: string[]) {
    for (const key of keys) this.keys.delete(key);
  }
}

function setup() {
  const db = testDatabase();
  const repos = new FakeRepos();
  const logs = new FakeLogs();
  const destroyed: string[] = [];
  const app = e2eRoutes<{ SPIKE_TOKEN: string }>({
    db: () => db,
    repos: () => repos,
    logs: () => logs,
    project: (_env, id) => ({
      note: async () => {},
      journal: async () => [],
      score: async () => ({}),
      run: async () => null,
      destroy: async () => void destroyed.push(id),
    }),
    secret: (env) => env.SPIKE_TOKEN,
  });
  const call = async (method: string, path: string, auth = SECRET) => {
    const res = await app.request(
      path,
      { method, headers: { Authorization: `Bearer ${auth}` } },
      { SPIKE_TOKEN: SECRET },
    );
    const type = res.headers.get("Content-Type") ?? "";
    return { status: res.status, body: type.startsWith("application/json") ? ((await res.json()) as Json) : null };
  };
  return { db, repos, logs, destroyed, call };
}

async function projectIds(db: Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM projects ORDER BY id").all<{ id: string }>();
  return results.map((r) => r.id);
}

describe("the e2e routes", () => {
  it("need the e2e secret", async () => {
    const { call } = setup();
    expect((await call("POST", "/e2e/token", "wrong")).status).toBe(401);
    expect((await call("POST", "/e2e/token")).status).toBe(200);
  });

  it("refuse to create a project without the e2e prefix", async () => {
    const { db, call } = setup();
    const refused = await call("POST", "/e2e/projects/throng");
    expect(refused.status).toBe(400);
    expect(await projectIds(db)).toEqual([]);

    const made = await call("POST", "/e2e/projects/e2erun1abc");
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ remote: expect.any(String), token: expect.any(String), owner: "e2e" });
    expect(await projectIds(db)).toEqual(["e2erun1abc"]);
  });

  it("refuse to touch repos outside the e2e prefix", async () => {
    const { repos, call } = setup();
    await repos.create("abc123-main");
    expect((await call("GET", "/e2e/repos/abc123-main/head")).status).toBe(400);
    expect((await call("GET", "/e2e/repos?prefix=abc")).status).toBe(400);
    expect((await call("DELETE", "/e2e/projects?prefix=abc")).status).toBe(400);
    expect((await call("DELETE", "/e2e/projects/abc123")).status).toBe(400);
    expect(await repos.list("abc123")).toEqual(["abc123-main"]);
  });

  it("delete everything a project made: its row, its Durable Object's storage, its logs and its repos", async () => {
    const { db, repos, logs, destroyed, call } = setup();
    await call("POST", "/e2e/projects/e2erun1a");
    await call("POST", "/e2e/projects/e2erun1ab");
    await repos.fork(originRepo("e2erun1a"), forkRepo("e2erun1a", "t1a1"));
    for (const key of ["logs/e2erun1a/t1a1/s/1/test.log", "logs/e2erun1a/t1a1/s/2/test.log", "logs/e2erun1a/x.log"])
      logs.keys.add(key);
    logs.keys.add("logs/e2erun1ab/t1a1/s/1/test.log");

    const res = await call("DELETE", "/e2e/projects/e2erun1a");
    expect(res.status).toBe(200);

    expect(await projectIds(db)).toEqual(["e2erun1ab"]);
    expect(destroyed).toEqual(["e2erun1a"]);
    expect([...logs.keys]).toEqual(["logs/e2erun1ab/t1a1/s/1/test.log"]);
    expect(await repos.list("e2erun1a")).toEqual(["e2erun1ab-main"]);
  });

  it("sweep every project under a run's prefix, including one whose repos are already gone", async () => {
    const { db, repos, destroyed, call } = setup();
    await call("POST", "/e2e/projects/e2erun1a");
    await call("POST", "/e2e/projects/e2erun1b");
    await call("POST", "/e2e/projects/e2erun2a");
    await repos.delete(originRepo("e2erun1b"));

    const res = await call("DELETE", "/e2e/projects?prefix=e2erun1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: ["e2erun1a", "e2erun1b"] });
    expect(await projectIds(db)).toEqual(["e2erun2a"]);
    expect(destroyed.toSorted()).toEqual(["e2erun1a", "e2erun1b"]);
    expect(await repos.list("e2erun")).toEqual(["e2erun2a-main"]);
  });

  it("mint a token for a second e2e user, the reviewer, and revoke it", async () => {
    const { db, call } = setup();
    const { body: mine } = await call("POST", "/e2e/token");
    const { status, body: reviewers } = await call("POST", "/e2e/token?as=reviewer");
    expect(status).toBe(200);
    if (mine === null || reviewers === null) throw new Error("minting returned no JSON");
    expect(reviewers["user"]).toMatchObject({ handle: "e2e-reviewer" });
    expect(reviewers["user"]["id"]).not.toBe(mine["user"]["id"]);
    expect((await authenticateToken(db, reviewers["token"], new Date()))?.actor.user.email).toBe(
      "e2e-reviewer@throng.invalid",
    );
    expect((await call("POST", "/e2e/token?as=ada")).status).toBe(400);

    expect((await call("DELETE", `/e2e/tokens/${reviewers["id"]}`)).status).toBe(200);
    expect(await authenticateToken(db, reviewers["token"], new Date())).toBeNull();
  });

  it("mint a token under an alias, for either e2e user", async () => {
    const { db, call } = setup();
    const { body: mine } = await call("POST", "/e2e/token?alias=claude");
    const { body: reviewers } = await call("POST", "/e2e/token?as=reviewer&alias=codex");
    if (mine === null || reviewers === null) throw new Error("minting returned no JSON");
    expect((await authenticateToken(db, mine["token"], new Date()))?.actor).toMatchObject({
      user: { email: "e2e@throng.invalid" },
      alias: "claude",
    });
    expect((await authenticateToken(db, reviewers["token"], new Date()))?.actor).toMatchObject({
      user: { email: "e2e-reviewer@throng.invalid" },
      alias: "codex",
    });
    expect((await call("POST", "/e2e/token?alias=Not%20One")).status).toBe(400);
    expect((await call("DELETE", `/e2e/tokens/${mine["id"]}`)).status).toBe(200);
  });

  it("revoke the run's token, and only the e2e user's", async () => {
    const { db, call } = setup();
    const { body: minted } = await call("POST", "/e2e/token");
    if (minted === null) throw new Error("minting the run's token returned no JSON");
    const other = await userForEmail(db, "ada@example.com");
    const { token: adas } = await mintToken(db, { userId: other.id, alias: null, ttlSeconds: 60, now: new Date() });

    expect((await call("DELETE", `/e2e/tokens/${adas.id}`)).status).toBe(404);
    expect((await call("DELETE", `/e2e/tokens/${minted["id"]}`)).status).toBe(200);
    expect(await authenticateToken(db, minted["token"], new Date())).toBeNull();
  });
});
