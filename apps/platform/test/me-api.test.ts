import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { webApp } from "../src/app.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");

async function setup() {
  const repos = new FakeRepos();
  const { backend, store } = testTaskBackends(repos, now);
  const options = {
    verifierFor: () => verify,
    now,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    tasks: () => backend,
  };
  const api = apiRoutes(options);
  const web = webApp(options);
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  const call = async (method: string, path: string, bearer: string, body?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const callAs = async (path: string, email: string) => {
    const res = await web.request(`/api${path}`, { headers: { [FORWARDED_EMAIL_HEADER]: email } }, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const adaClaude = await tokenFor("ada@example.com", "claude");
  const projects: Json[] = [];
  for (const handle of ["throng", "swarm"]) {
    const project = (await call("POST", "/projects", greg, { handle })).body;
    repos.commit(`${String(project["id"])}-main`, { files: { "README.md": "hi\n" } });
    projects.push(project);
  }
  /** What each project's Durable Object does after a transition: publish to the projection. */
  const publish = async () => {
    for (const project of projects) {
      const id = String(project["id"]);
      while ((await store(id).projection.publish(env.DB, id)) !== null);
    }
  };
  return { call, callAs, env, greg, ada, adaClaude, projects, publish };
}

describe("GET /me/tasks and /me/attempts", () => {
  it("list the caller's tasks and attempts across projects, once published", async () => {
    const { call, callAs, greg, ada, adaClaude, publish } = await setup();
    await call("POST", "/projects/greg/throng/tasks", ada, { title: "Fix login" });
    await call("POST", "/projects/greg/swarm/tasks", greg, { title: "Add search" });
    await call("POST", "/projects/greg/swarm/tasks/t1/attempts", adaClaude, { count: 2 });

    expect((await call("GET", "/me/attempts", ada)).body["attempts"]).toEqual([]);
    await publish();

    const tasks = await call("GET", "/me/tasks", adaClaude);
    expect(tasks.status).toBe(200);
    expect(tasks.body["tasks"]).toEqual([
      {
        project: {
          id: expect.any(String),
          handle: "throng",
          owner: { id: expect.any(String), handle: "greg" },
          source: null,
          createdAt: expect.any(String),
        },
        ref: "t1",
        number: 1,
        title: "Fix login",
        state: "open",
        creator: { id: expect.any(String), handle: "ada" },
        createdAt: "2026-10-10T12:00:00.000Z",
        closedAt: null,
      },
    ]);
    const attempts = await call("GET", "/me/attempts", ada);
    expect(
      (attempts.body["attempts"] as Json[]).map((a) => [(a["project"] as Json)["handle"], a["ref"], a["state"]]),
    ).toEqual([
      ["swarm", "t1a2", "draft"],
      ["swarm", "t1a1", "draft"],
    ]);
    expect((attempts.body["attempts"] as Json[])[0]?.["task"]).toEqual({ ref: "t1", number: 1, title: "Add search" });
    expect((await callAs("/me/attempts", "ada@example.com")).body).toEqual(attempts.body);
    expect((await call("GET", "/me/attempts", greg)).body["attempts"]).toEqual([]);
  });

  it("filter by state, leaving obsolete ones out by default", async () => {
    const { call, ada, greg, publish } = await setup();
    await call("POST", "/projects/greg/throng/tasks", ada, { title: "Fix login" });
    await call("POST", "/projects/greg/throng/tasks/t1/attempts", ada, { count: 2 });
    await call("POST", "/projects/greg/throng/attempts/t1a2/obsolete", greg);
    await call("POST", "/projects/greg/throng/attempts/t1a1/close", ada);
    await publish();

    const refs = async (query: string) =>
      ((await call("GET", `/me/attempts${query}`, ada)).body["attempts"] as Json[]).map((a) => a["ref"]);
    expect(await refs("")).toEqual(["t1a1"]);
    expect(await refs("?state=obsolete")).toEqual(["t1a2"]);
    expect(await refs("?state=draft")).toEqual([]);
    expect((await call("GET", "/me/tasks?state=bogus", ada)).status).toBe(400);
  });

  it("are never read for writes: the project's Durable Object decides", async () => {
    const { call, env, ada, publish } = await setup();
    await call("POST", "/projects/greg/throng/tasks", ada, { title: "Fix login" });
    await publish();
    // A projection that has drifted (say, a delivery still on its way) changes nothing a write sees.
    await env.DB.prepare("UPDATE projected_tasks SET state = 'closed', title = 'Stale'").all();

    const created = await call("POST", "/projects/greg/throng/tasks/t1/attempts", ada);
    expect(created.status).toBe(201);
    await publish();
    expect((await call("GET", "/me/tasks", ada)).body["tasks"]).toEqual([
      expect.objectContaining({ title: "Stale", state: "closed" }),
    ]);
    // The next change to the task republishes it from the Durable Object.
    await call("POST", "/projects/greg/throng/tasks/t1/close", ada);
    await publish();
    expect((await call("GET", "/me/tasks?state=closed", ada)).body["tasks"]).toEqual([
      expect.objectContaining({ title: "Fix login", state: "closed" }),
    ]);
  });

  it("are no part of any write or of reading one back: those go to the project's Durable Object", async () => {
    const { call, env, ada, greg, publish } = await setup();
    await call("POST", "/projects/greg/throng/tasks", ada, { title: "Fix login" });
    await call("POST", "/projects/greg/throng/tasks/t1/attempts", ada, { count: 2 });
    await publish();
    // Without the projection's tables, any route that read them would fail.
    await env.DB.prepare("DROP TABLE projected_attempts").all();
    await env.DB.prepare("DROP TABLE projected_tasks").all();

    const ok = async (method: string, path: string, bearer: string, body?: unknown) => {
      const res = await call(method, path, bearer, body);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      return res.body;
    };
    await ok("PATCH", "/projects/greg/throng/tasks/t1", ada, { title: "Fix the login" });
    await ok("POST", "/projects/greg/throng/tasks", ada, { title: "Add search" });
    await ok("POST", "/projects/greg/throng/tasks/t2/attempts", ada);
    await ok("POST", "/projects/greg/throng/attempts/t1a1/open", ada);
    await ok("POST", "/projects/greg/throng/attempts/t1a2/obsolete", greg);
    await ok("POST", "/projects/greg/throng/attempts/t2a1/close", ada);
    await ok("POST", "/projects/greg/throng/tasks/t2/close", ada);

    expect(await ok("GET", "/projects/greg/throng/tasks/t1", ada)).toMatchObject({ title: "Fix the login" });
    expect(
      ((await ok("GET", "/projects/greg/throng/tasks?state=closed", ada))["tasks"] as Json[]).map((t) => t["ref"]),
    ).toEqual(["t2"]);
    expect(
      ((await ok("GET", "/projects/greg/throng/tasks/t1/attempts", ada))["attempts"] as Json[]).map((a) => [
        a["ref"],
        a["state"],
      ]),
    ).toEqual([["t1a1", "open"]]);
    expect(await ok("GET", "/projects/greg/throng/attempts/t2a1", ada)).toMatchObject({ state: "closed" });
    expect((await call("GET", "/me/tasks", ada)).status).toBe(500);
  });

  it("page by offset and limit", async () => {
    const { call, ada, publish } = await setup();
    await call("POST", "/projects/greg/throng/tasks", ada, { title: "Fix login" });
    await call("POST", "/projects/greg/throng/tasks/t1/attempts", ada, { count: 3 });
    await publish();

    const first = await call("GET", "/me/attempts?limit=2", ada);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ offset: 0, limit: 2, next: 2 });
    expect((first.body["attempts"] as Json[]).map((a) => a["ref"])).toEqual(["t1a3", "t1a2"]);
    const last = await call("GET", "/me/attempts?limit=2&offset=2", ada);
    expect(last.body).toMatchObject({ offset: 2, limit: 2, next: null });
    expect((last.body["attempts"] as Json[]).map((a) => a["ref"])).toEqual(["t1a1"]);
    expect((await call("GET", "/me/tasks", ada)).body).toMatchObject({ offset: 0, limit: 50, next: null });
    expect((await call("GET", "/me/tasks?limit=101", ada)).status).toBe(400);
  });

  it("need a token or a signed-in user", async () => {
    const { env } = await setup();
    const res = await apiRoutes({ verifierFor: () => verify, now }).request("/me/tasks", {}, env);
    expect(res.status).toBe(401);
  });
});
