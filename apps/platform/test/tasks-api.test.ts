import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { testTaskBackends } from "./support/task-backend.ts";

type Json = Record<string, any>;

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");

async function setup() {
  const repos = new FakeRepos();
  const { backend } = testTaskBackends(repos, now);
  const api = apiRoutes({ verifierFor: () => verify, now, repos: () => repos, tasks: () => backend });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (bearer !== undefined) headers["Authorization"] = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  /** A bearer token for the user with `email`, under `agent` if given. */
  const tokenFor = async (email: string, agent?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ agent }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const adaClaude = await tokenFor("ada@example.com", "claude");
  const bob = await tokenFor("bob@example.com");
  const project = (await call("POST", "/projects", greg, { handle: "throng" })).body;
  const base = "/projects/greg/throng";
  return { call, repos, greg, ada, adaClaude, bob, project, base };
}

describe("task routes", () => {
  it("creates, gets, lists and edits tasks", async () => {
    const { call, ada, bob, greg, base } = await setup();
    const created = await call("POST", `${base}/tasks`, ada, { title: "Fix login", body: "It *fails*." });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ref: "t1",
      number: 1,
      title: "Fix login",
      body: "It *fails*.",
      creator: { id: expect.any(String), handle: "ada" },
      state: "open",
      created_at: "2026-10-10T12:00:00.000Z",
      closed_at: null,
      closed_by: null,
      attempt_limit: null,
    });
    await call("POST", `${base}/tasks`, bob, { title: "Second", attempt_limit: 3 });

    for (const ref of ["t1", "1"]) expect((await call("GET", `${base}/tasks/${ref}`, bob)).body).toEqual(created.body);
    const list = await call("GET", `${base}/tasks`, bob);
    expect(list.status).toBe(200);
    expect(list.body["tasks"].map((t: Json) => t["ref"])).toEqual(["t1", "t2"]);

    const edited = await call("PATCH", `${base}/tasks/t1`, greg, { title: "Fix sign-in", attempt_limit: 4 });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: "Fix sign-in", body: "It *fails*.", attempt_limit: 4 });
    expect((await call("PATCH", `${base}/tasks/t1`, bob, { title: "x" })).status).toBe(403);
  });

  it("runs the task transitions with their permissions", async () => {
    const { call, ada, bob, greg, base } = await setup();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    expect((await call("POST", `${base}/tasks/t1/close`, bob)).status).toBe(403);
    const closed = await call("POST", `${base}/tasks/t1/close`, ada);
    expect(closed.body).toMatchObject({ state: "closed", closed_by: { handle: "ada" } });
    expect((await call("POST", `${base}/tasks/t1/close`, ada)).body).toEqual({
      error: { code: "invalid_state", message: "can't close t1: it is closed" },
    });
    expect((await call("POST", `${base}/tasks/t1/reopen`, greg)).body["state"]).toBe("open");
    expect((await call("POST", `${base}/tasks/t1/obsolete`, ada)).status).toBe(403);
    expect((await call("POST", `${base}/tasks/t1/obsolete`, greg)).body["state"]).toBe("obsolete");
    expect((await call("GET", `${base}/tasks`, ada)).body["tasks"]).toEqual([]);
    expect((await call("GET", `${base}/tasks?state=obsolete`, ada)).body["tasks"]).toHaveLength(1);
    const restore = await call("POST", `${base}/tasks/t1/restore`, greg);
    expect(restore.status).toBe(200);
    expect(restore.body["state"]).toBe("closed");
  });

  it("is 404 for an unknown project or task and 400 for a bad reference or body", async () => {
    const { call, ada, base } = await setup();
    expect((await call("GET", "/projects/greg/nothing/tasks", ada)).status).toBe(404);
    expect((await call("GET", `${base}/tasks/t9`, ada)).body["error"]["code"]).toBe("not_found");
    for (const ref of ["t0", "x", "t1a1"])
      expect((await call("GET", `${base}/tasks/${ref}`, ada)).status, ref).toBe(400);
    for (const body of [{}, { title: "" }, { title: "a", attempt_limit: 0 }]) {
      expect((await call("POST", `${base}/tasks`, ada, body)).status).toBe(400);
    }
  });

  it("needs a bearer token", async () => {
    const { call, base } = await setup();
    expect((await call("GET", `${base}/tasks`)).status).toBe(401);
    expect((await call("POST", `${base}/tasks`, undefined, { title: "a" })).status).toBe(401);
  });
});

describe("attempt routes", () => {
  it("fans a task out to attempts with forks and lists them", async () => {
    const { call, adaClaude, bob, project, repos, base } = await setup();
    await call("POST", `${base}/tasks`, bob, { title: "a" });
    const created = await call("POST", `${base}/tasks/t1/attempts`, adaClaude, { count: 2, note: "go" });
    expect(created.status).toBe(201);
    expect(created.body["attempts"]).toEqual(
      [1, 2].map((n) => ({
        ref: `t1a${n}`,
        task: 1,
        number: n,
        author: { id: expect.any(String), handle: "ada" },
        state: "draft",
        fork: `t1a${n}`,
        branch: null,
        note: "go",
        created_at: "2026-10-10T12:00:00.000Z",
        closed_at: null,
        merged_sha: null,
        archived_sha: null,
      })),
    );
    expect(await repos.list(`${project["id"]}-t`)).toEqual([`${project["id"]}-t1a1`, `${project["id"]}-t1a2`]);

    const one = await call("POST", `${base}/tasks/1/attempts`, bob);
    expect(one.body["attempts"].map((a: Json) => a["ref"])).toEqual(["t1a3"]);
    const list = await call("GET", `${base}/tasks/t1/attempts`, bob);
    expect(list.body["attempts"].map((a: Json) => a["ref"])).toEqual(["t1a1", "t1a2", "t1a3"]);
    expect((await call("GET", `${base}/attempts/t1a2`, bob)).body).toEqual(created.body["attempts"][1]);
    expect((await call("GET", `${base}/attempts/t1a9`, bob)).status).toBe(404);
    expect((await call("GET", `${base}/attempts/t1`, bob)).status).toBe(400);
  });

  it("fails a batch over the cap whole, with attempt_limit", async () => {
    const { call, ada, base } = await setup();
    await call("POST", `${base}/tasks`, ada, { title: "a", attempt_limit: 2 });
    const res = await call("POST", `${base}/tasks/t1/attempts`, ada, { count: 3 });
    expect(res.status).toBe(409);
    expect(res.body["error"]["code"]).toBe("attempt_limit");
    expect((await call("GET", `${base}/tasks/t1/attempts`, ada)).body["attempts"]).toEqual([]);
  });

  it("runs the attempt transitions with their permissions", async () => {
    const { call, ada, adaClaude, bob, greg, base } = await setup();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    await call("POST", `${base}/tasks/t1/attempts`, ada);
    const a = `${base}/attempts/t1a1`;

    expect((await call("POST", `${a}/open`, bob)).status).toBe(403);
    expect((await call("POST", `${a}/open`, greg)).status).toBe(403);
    expect((await call("POST", `${a}/open`, adaClaude)).body["state"]).toBe("open");
    expect((await call("POST", `${a}/open`, ada)).body["error"]["code"]).toBe("invalid_state");
    expect((await call("POST", `${a}/draft`, ada)).body["state"]).toBe("draft");
    expect((await call("PATCH", a, adaClaude, { note: "notes" })).body["note"]).toBe("notes");
    expect((await call("PATCH", a, bob, { note: "x" })).status).toBe(403);
    expect((await call("POST", `${a}/close`, ada)).body).toMatchObject({
      state: "closed",
      closed_at: expect.any(String),
    });
    expect((await call("POST", `${a}/reopen`, ada)).body).toMatchObject({ state: "draft", closed_at: null });
    expect((await call("POST", `${a}/obsolete`, ada)).status).toBe(403);
    expect((await call("POST", `${a}/obsolete`, greg)).body["state"]).toBe("obsolete");
    expect((await call("GET", `${base}/tasks/t1/attempts`, ada)).body["attempts"]).toEqual([]);
    expect((await call("GET", `${base}/tasks/t1/attempts?state=obsolete`, ada)).body["attempts"]).toHaveLength(1);
    expect((await call("POST", `${a}/restore`, greg)).body["state"]).toBe("closed");
  });
});

describe("OpenAPI document", () => {
  it("describes every task and attempt route", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/openapi.json");
    const operations = Object.values(body["paths"]).flatMap((path) => Object.values(path as Json)) as Json[];
    expect(operations.map((op) => op["operationId"])).toEqual(
      expect.arrayContaining([
        "createTask",
        "listTasks",
        "getTask",
        "editTask",
        "closeTask",
        "reopenTask",
        "obsoleteTask",
        "restoreTask",
        "createAttempts",
        "listAttempts",
        "getAttempt",
        "editAttempt",
        "openAttempt",
        "draftAttempt",
        "closeAttempt",
        "reopenAttempt",
        "obsoleteAttempt",
        "restoreAttempt",
      ]),
    );
    expect(body["components"]["schemas"]["Task"]).toBeDefined();
    expect(body["components"]["schemas"]["Attempt"]).toBeDefined();
  });
});
