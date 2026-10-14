import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { webApp } from "../src/app.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { at } from "./support/defined.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");

async function setup() {
  const repos = new FakeRepos();
  // Runs start only when a test drains a project's scoring queue.
  const { backend, store } = testTaskBackends(repos, now, {
    workflow: { create: async () => ({}), get: async () => ({ terminate: async () => {} }) },
    teardown: async () => {},
  });
  const options = {
    verifierFor: () => verify,
    now,
    repos: () => repos,
    tasks: () => backend,
  };
  const api = apiRoutes(options);
  // throng-web's binding, over the same database and backend.
  const web = webApp(options);
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (bearer !== undefined) headers["Authorization"] = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  /** A request through throng-web's binding, as the signed-in user with `email`. */
  const callAs = async (method: string, path: string, email: string, body?: unknown) => {
    const headers: Record<string, string> = { [FORWARDED_EMAIL_HEADER]: email };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await web.request(`/api${path}`, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  /** A bearer token for the user with `email`, under `alias` if given. */
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const adaClaude = await tokenFor("ada@example.com", "claude");
  const bob = await tokenFor("bob@example.com");
  const project = (await call("POST", "/projects", greg, { handle: "throng" })).body;
  const base = "/projects/greg/throng";
  return { call, callAs, repos, store, greg, ada, adaClaude, bob, project, base };
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
      createdAt: "2026-10-10T12:00:00.000Z",
      closedAt: null,
      closedBy: null,
      attemptLimit: null,
      checks: [],
      metrics: [],
      taskBranch: null,
      selection: null,
    });
    await call("POST", `${base}/tasks`, bob, { title: "Second", attemptLimit: 3 });

    for (const ref of ["t1", "1"]) expect((await call("GET", `${base}/tasks/${ref}`, bob)).body).toEqual(created.body);
    const list = await call("GET", `${base}/tasks`, bob);
    expect(list.status).toBe(200);
    expect(list.body["tasks"].map((t: Json) => t["ref"])).toEqual(["t1", "t2"]);

    const edited = await call("PATCH", `${base}/tasks/t1`, greg, { title: "Fix sign-in", attemptLimit: 4 });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: "Fix sign-in", body: "It *fails*.", attemptLimit: 4 });
    expect((await call("PATCH", `${base}/tasks/t1`, bob, { title: "x" })).status).toBe(403);
  });

  it("reports a task's task branch head, or null when it has none", async () => {
    const { call, repos, ada, bob, base, project } = await setup();
    const origin = `${project["id"]}-main`;
    repos.commit(origin, { files: { "README.md": "hi\n" } });
    await call("POST", `${base}/tasks`, ada, { title: "Fix login" });
    await call("POST", `${base}/tasks`, ada, { title: "Second" });
    const tests = repos.commit(origin, { branch: "tests", files: { "login.test.ts": "it()\n" } });
    repos.setRef(origin, "refs/tasks/t1", tests.hash);

    expect((await call("GET", `${base}/tasks/t1`, bob)).body["taskBranch"]).toEqual({ sha: tests.hash, commits: 1 });
    expect((await call("GET", `${base}/tasks/t2`, bob)).body["taskBranch"]).toBeNull();
    const list = (await call("GET", `${base}/tasks`, bob)).body["tasks"];
    expect(list.map((t: Json) => t["taskBranch"])).toEqual([{ sha: tests.hash, commits: 1 }, null]);
  });

  it("runs the task transitions with their permissions", async () => {
    const { call, ada, bob, greg, base } = await setup();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    expect((await call("POST", `${base}/tasks/t1/close`, bob)).status).toBe(403);
    const closed = await call("POST", `${base}/tasks/t1/close`, ada);
    expect(closed.body).toMatchObject({ state: "closed", closedBy: { handle: "ada" } });
    expect((await call("POST", `${base}/tasks/t1/close`, ada)).body).toEqual({
      error: { code: "invalidState", message: "can't close t1: it is closed" },
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
    expect((await call("GET", `${base}/tasks/t9`, ada)).body["error"]["code"]).toBe("notFound");
    for (const ref of ["t0", "x", "t1a1"])
      expect((await call("GET", `${base}/tasks/${ref}`, ada)).status, ref).toBe(400);
    for (const body of [{}, { title: "" }, { title: "a", attemptLimit: 0 }]) {
      expect((await call("POST", `${base}/tasks`, ada, body)).status).toBe(400);
    }
  });

  it("needs a bearer token", async () => {
    const { call, base } = await setup();
    expect((await call("GET", `${base}/tasks`)).status).toBe(401);
    expect((await call("POST", `${base}/tasks`, undefined, { title: "a" })).status).toBe(401);
  });
});

describe("task metrics", () => {
  const PROJECT_CONFIG = [
    "checks:",
    "  - name: test",
    "    command: pnpm test",
    "metrics:",
    "  - name: coverage",
    "    from: test.coverage-summary.total.lines.pct",
    "    type: number",
    "",
  ].join("\n");
  const LINES = { name: "lines", from: "test.coverage-summary.total.lines.total", type: "number", unit: "lines" };

  async function withConfig() {
    const env = await setup();
    env.repos.writeFile(`${env.project["id"]}-main`, "main", ".throng/config.yml", PROJECT_CONFIG);
    return env;
  }

  it("are saved on create and edit in the config's shape, and read back with the task", async () => {
    const { call, ada, bob, base } = await withConfig();
    const created = await call("POST", `${base}/tasks`, ada, {
      title: "a",
      metrics: [{ ...LINES, order: "ascending" }],
    });
    expect(created.status).toBe(201);
    const lines = { ...LINES, source: "task", order: "asc" };
    expect(created.body["metrics"]).toEqual([lines]);
    expect((await call("GET", `${base}/tasks/t1`, bob)).body["metrics"]).toEqual([lines]);

    expect((await call("POST", `${base}/tasks`, ada, { title: "b" })).body["metrics"]).toEqual([]);
    const renamed = await call("PATCH", `${base}/tasks/t1`, ada, { title: "A" });
    expect(renamed.body["metrics"]).toEqual([lines]);
    const edited = await call("PATCH", `${base}/tasks/t1`, ada, {
      metrics: [{ name: "branches", from: "test.coverage-summary.total.branches.pct", type: "number" }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body["metrics"]).toEqual([
      {
        name: "branches",
        from: "test.coverage-summary.total.branches.pct",
        type: "number",
        unit: null,
        order: "desc",
        source: "task",
      },
    ]);
    expect((await call("PATCH", `${base}/tasks/t1`, ada, { metrics: [] })).body["metrics"]).toEqual([]);
  });

  it("may be edited only by the task's creator or the project's owner", async () => {
    const { call, ada, bob, greg, base } = await withConfig();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    const edit = (token: string) => call("PATCH", `${base}/tasks/t1`, token, { metrics: [LINES] });
    expect((await edit(bob)).status).toBe(403);
    expect((await edit(greg)).status).toBe(200);
    expect((await edit(ada)).status).toBe(200);
  });

  it("refuses someone else's edit as forbidden, whatever metrics it gives", async () => {
    const { call, ada, bob, base } = await withConfig();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    const edited = await call("PATCH", `${base}/tasks/t1`, bob, { metrics: [{ ...LINES, from: "lint.errors" }] });
    expect(edited.status).toBe(403);
    expect(edited.body["error"]).toMatchObject({ code: "forbidden" });
  });

  it.each([
    ["an invalid shape", { ...LINES, order: "up" }, /^metrics\[0\]\.order: order must be/u],
    [
      "a field its type lacks",
      { ...LINES, type: "boolean" },
      /^metrics\[0\]\.unit: unit is only for a number metric$/u,
    ],
    ["a missing type", { name: "lines", from: LINES.from }, /^metrics\[0\]\.type: type is required/u],
    ["a reserved name", { ...LINES, name: "_lines" }, /^metrics\[0\]\.name: .*reserved/u],
    ["an unknown check", { ...LINES, from: "lint.report.errors" }, /^metrics\[0\]\.from: no check is named lint$/u],
    [
      "a project metric's name",
      { ...LINES, name: "coverage" },
      /^metrics\[0\]\.name: coverage is also a metric's name in \.throng\/config\.yml$/u,
    ],
    [
      "a project check's name",
      { ...LINES, name: "test" },
      /^metrics\[0\]\.name: test is also a check's name in \.throng\/config\.yml$/u,
    ],
  ])("are rejected with what is wrong: %s", async (_label, metric, message) => {
    const { call, ada, base } = await withConfig();
    const created = await call("POST", `${base}/tasks`, ada, { title: "a", metrics: [metric] });
    expect(created.status).toBe(400);
    expect(created.body["error"]).toMatchObject({ code: "invalidRequest", message: expect.stringMatching(message) });
    await call("POST", `${base}/tasks`, ada, { title: "b" });
    const edited = await call("PATCH", `${base}/tasks/t1`, ada, { metrics: [metric] });
    expect(edited.status).toBe(400);
    expect(edited.body["error"]["message"]).toMatch(message);
  });

  it("rejects two task metrics with the same name", async () => {
    const { call, ada, base } = await withConfig();
    const created = await call("POST", `${base}/tasks`, ada, { title: "a", metrics: [LINES, LINES] });
    expect(created.body["error"]["message"]).toBe("metrics[1].name: duplicate metric name lines");
  });
});

describe("task checks", () => {
  const PROJECT_CONFIG = [
    "checks:",
    "  - name: test",
    "    command: pnpm test",
    "metrics:",
    "  - name: coverage",
    "    from: test.coverage-summary.total.lines.pct",
    "    type: number",
    "",
  ].join("\n");
  const SMOKE = { name: "smoke", command: "./smoke.sh", timeout: "2m" };
  const SMOKED = { name: "smoked", from: "smoke.report.ok", type: "boolean" };

  async function withConfig() {
    const env = await setup();
    env.repos.writeFile(`${env.project["id"]}-main`, "main", ".throng/config.yml", PROJECT_CONFIG);
    return env;
  }

  it("are saved with metrics over them, in the config's shape, and read back with the task", async () => {
    const { call, ada, bob, base } = await withConfig();
    const created = await call("POST", `${base}/tasks`, ada, { title: "a", checks: [SMOKE], metrics: [SMOKED] });
    expect(created.status).toBe(201);
    const smoke = { name: "smoke", command: "./smoke.sh", timeoutMs: 120_000, source: "task" };
    expect(created.body["checks"]).toEqual([smoke]);
    expect(created.body["metrics"]).toEqual([{ ...SMOKED, order: "desc", source: "task" }]);
    expect((await call("GET", `${base}/tasks/t1`, bob)).body["checks"]).toEqual([smoke]);

    const edited = await call("PATCH", `${base}/tasks/t1`, ada, { checks: [{ ...SMOKE, timeout: "5m" }] });
    expect(edited.status).toBe(200);
    expect(edited.body["checks"]).toEqual([{ ...smoke, timeoutMs: 300_000 }]);
    expect(edited.body["metrics"]).toHaveLength(1);
    const required = await call("PATCH", `${base}/tasks/t1`, ada, { checks: [{ ...SMOKE, required: false }] });
    expect(required.status).toBe(400);
    expect(JSON.stringify(required.body)).toContain(
      "checks[0].required: required is gone: every check that runs must pass; to report without blocking, exit 0 and write a metric",
    );
    expect((await call("POST", `${base}/tasks`, ada, { title: "b" })).body["checks"]).toEqual([]);
  });

  it("may be edited only by the task's creator or the project's owner", async () => {
    const { call, ada, bob, greg, base } = await withConfig();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    const edit = (token: string) => call("PATCH", `${base}/tasks/t1`, token, { checks: [SMOKE] });
    expect((await edit(bob)).status).toBe(403);
    expect((await edit(greg)).status).toBe(200);
    expect((await edit(ada)).status).toBe(200);
  });

  it.each([
    ["an invalid shape", { checks: [{ ...SMOKE, timeout: "soon" }] }, /^checks\[0\]\.timeout: timeout must be/u],
    ["a missing command", { checks: [{ name: "smoke" }] }, /^checks\[0\]\.command: /u],
    ["a reserved name", { checks: [{ ...SMOKE, name: "_smoke" }] }, /^checks\[0\]\.name: .*reserved/u],
    [
      "a project check's name",
      { checks: [{ ...SMOKE, name: "test" }] },
      /^checks\[0\]\.name: test is also a check's name in \.throng\/config\.yml$/u,
    ],
    [
      "a project metric's name",
      { checks: [{ ...SMOKE, name: "coverage" }] },
      /^checks\[0\]\.name: coverage is also a metric's name in \.throng\/config\.yml$/u,
    ],
    ["a duplicate", { checks: [SMOKE, SMOKE] }, /^checks\[1\]\.name: duplicate check name smoke$/u],
    [
      "a task metric named like it",
      { checks: [SMOKE], metrics: [{ ...SMOKED, name: "smoke" }] },
      /^metrics\[0\]\.name: metric name smoke is also a check's name$/u,
    ],
  ])("are rejected with what is wrong: %s", async (_label, fields, message) => {
    const { call, ada, base } = await withConfig();
    const created = await call("POST", `${base}/tasks`, ada, { title: "a", ...fields });
    expect(created.status).toBe(400);
    expect(created.body["error"]).toMatchObject({ code: "invalidRequest", message: expect.stringMatching(message) });
    await call("POST", `${base}/tasks`, ada, { title: "b" });
    const edited = await call("PATCH", `${base}/tasks/t1`, ada, fields);
    expect(edited.status).toBe(400);
    expect(edited.body["error"]["message"]).toMatch(message);
  });

  it("check a task metric's from against the task's saved checks when an edit gives only one of them", async () => {
    const { call, ada, base } = await withConfig();
    await call("POST", `${base}/tasks`, ada, { title: "a", checks: [SMOKE] });
    expect((await call("PATCH", `${base}/tasks/t1`, ada, { metrics: [SMOKED] })).status).toBe(200);
    const dropped = await call("PATCH", `${base}/tasks/t1`, ada, { checks: [] });
    expect(dropped.status).toBe(400);
    expect(dropped.body["error"]["message"]).toBe("metrics[0].from: no check is named smoke");
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
        alias: "claude",
        state: "draft",
        fork: `t1a${n}`,
        remote: `http://localhost/git/greg/throng/t1a${n}.git`,
        branch: null,
        note: "go",
        createdAt: "2026-10-10T12:00:00.000Z",
        closedAt: null,
        mergedSha: null,
        archivedSha: null,
        needsUpdate: false,
        scoring: { status: "none", sha: null },
        mergeRequest: null,
        verdicts: { head: null, merge: 0, revise: 0, reject: 0 },
      })),
    );
    expect(await repos.list(`${project["id"]}-t`)).toEqual([`${project["id"]}-t1a1`, `${project["id"]}-t1a2`]);

    const one = await call("POST", `${base}/tasks/1/attempts`, bob);
    expect(one.body["attempts"].map((a: Json) => a["ref"])).toEqual(["t1a3"]);
    const list = await call("GET", `${base}/tasks/t1/attempts`, bob);
    expect(list.body["attempts"].map((a: Json) => a["ref"])).toEqual(["t1a1", "t1a2", "t1a3"]);
    expect(created.body["attempts"][1]).toMatchObject((await call("GET", `${base}/attempts/t1a2`, bob)).body);
    expect((await call("GET", `${base}/attempts/t1a9`, bob)).status).toBe(404);
    expect((await call("GET", `${base}/attempts/t1`, bob)).status).toBe(400);
  });

  it("gives each new attempt its git remote, and never the token", async () => {
    const { call, adaClaude, bob, base } = await setup();
    await call("POST", `${base}/tasks`, bob, { title: "a" });
    const created = await call("POST", `${base}/tasks/t1/attempts`, adaClaude, { count: 2 });
    expect(created.body["attempts"].map((a: Json) => a["remote"])).toEqual(
      [1, 2].map((n) => `http://localhost/git/greg/throng/t1a${n}.git`),
    );
    expect(created.body["attempts"][0]).not.toHaveProperty("clone");
    expect(JSON.stringify(created.body)).not.toContain(adaClaude);
  });

  it("forks an attempt of the same task, recording forkedFrom, and refuses one from another task", async () => {
    const { call, ada, bob, repos, project, base } = await setup();
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    await call("POST", `${base}/tasks`, ada, { title: "b" });
    await call("POST", `${base}/tasks/t1/attempts`, ada);
    const head = repos.commit(`${project["id"]}-t1a1`, { files: { "a.txt": "a\n" } }).hash;

    const forked = await call("POST", `${base}/tasks/t1/attempts`, bob, { from: "t1a1" });
    expect(forked.status).toBe(201);
    expect(forked.body["attempts"]).toEqual([expect.objectContaining({ ref: "t1a2", forkedFrom: "t1a1" })]);
    expect(repos.ref(`${project["id"]}-t1a2`, "refs/heads/main")).toBe(head);
    expect((await call("GET", `${base}/attempts/t1a2`, bob)).body["forkedFrom"]).toBe("t1a1");

    const other = await call("POST", `${base}/tasks/t2/attempts`, ada, { from: "t1a1" });
    expect(other.status).toBe(400);
    expect(other.body["error"]["code"]).toBe("invalidRequest");
    expect((await call("POST", `${base}/tasks/t1/attempts`, ada, { from: "t1" })).status).toBe(400);
  });

  it("fails a batch over the cap whole, with attemptLimit", async () => {
    const { call, ada, base } = await setup();
    await call("POST", `${base}/tasks`, ada, { title: "a", attemptLimit: 2 });
    const res = await call("POST", `${base}/tasks/t1/attempts`, ada, { count: 3 });
    expect(res.status).toBe(409);
    expect(res.body["error"]["code"]).toBe("attemptLimit");
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
    expect((await call("POST", `${a}/open`, ada)).body["error"]["code"]).toBe("invalidState");
    expect((await call("POST", `${a}/draft`, ada)).body["state"]).toBe("draft");
    expect((await call("PATCH", a, adaClaude, { note: "notes" })).body["note"]).toBe("notes");
    expect((await call("PATCH", a, bob, { note: "x" })).status).toBe(403);
    expect((await call("POST", `${a}/close`, ada)).body).toMatchObject({
      state: "closed",
      closedAt: expect.any(String),
    });
    expect((await call("POST", `${a}/reopen`, ada)).body).toMatchObject({ state: "draft", closedAt: null });
    expect((await call("POST", `${a}/obsolete`, ada)).status).toBe(403);
    expect((await call("POST", `${a}/obsolete`, greg)).body["state"]).toBe("obsolete");
    expect((await call("GET", `${base}/tasks/t1/attempts`, ada)).body["attempts"]).toEqual([]);
    expect((await call("GET", `${base}/tasks/t1/attempts?state=obsolete`, ada)).body["attempts"]).toHaveLength(1);
    expect((await call("POST", `${a}/restore`, greg)).body["state"]).toBe("closed");
  });

  it("scores a draft now for its author, and rescores an open attempt for the author, creator or owner", async () => {
    const { call, ada, adaClaude, bob, greg, base, repos, project } = await setup();
    const head = repos.commit(`${project["id"]}-main`, { files: { "README.md": "hi\n" } }).hash;
    await call("POST", `${base}/tasks`, bob, { title: "a" });
    await call("POST", `${base}/tasks/t1/attempts`, ada);
    const a = `${base}/attempts/t1a1`;

    expect((await call("POST", `${a}/score`, bob)).status).toBe(403);
    expect((await call("POST", `${a}/rescore`, ada)).body["error"]["code"]).toBe("invalidState");
    const scored = await call("POST", `${a}/score`, adaClaude);
    expect(scored.status).toBe(200);
    expect(scored.body).toEqual({
      queued: true,
      reason: null,
      run: {
        id: 1,
        line: "t1a1",
        pipeline: "default",
        sha: head,
        trigger: "scoreNow",
        status: "queued",
        trusted: false,
        requestedBy: { id: expect.any(String), handle: "ada" },
        alias: "claude",
        createdAt: "2026-10-10T12:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        superseded: false,
        gate: null,
        cancellable: true,
      },
    });
    expect((await call("POST", `${a}/score`, ada)).body).toMatchObject({ queued: false, reason: "already queued" });

    await call("POST", `${a}/open`, ada);
    expect((await call("POST", `${a}/score`, ada)).body["error"]["code"]).toBe("invalidState");
    expect((await call("POST", `${a}/rescore`, greg)).body).toMatchObject({ queued: false, run: { id: 1 } });
    const other = await call("POST", `${base}/tasks`, greg, { title: "b" });
    expect(other.status).toBe(201);
    await call("POST", `${base}/tasks/t2/attempts`, ada);
    await call("POST", `${base}/attempts/t2a1/open`, ada);
    expect((await call("POST", `${base}/attempts/t2a1/rescore`, bob)).status).toBe(403);
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
        "handOffAttempt",
        "scoreAttempt",
        "rescoreAttempt",
      ]),
    );
    expect(body["components"]["schemas"]["Task"]).toBeDefined();
    expect(body["components"]["schemas"]["Attempt"]).toBeDefined();
    expect(body["components"]["schemas"]["ScoringRequest"]).toBeDefined();
  });
});
/** A task by ada with two opened attempts by bob, on an origin with one commit; returns its head. */
async function twoAttempts(env: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const { call, repos, ada, bob, project, base } = env;
  const head = repos.commit(`${project["id"]}-main`, { files: { "README.md": "hi\n" }, message: "init" }).hash;
  await call("POST", `${base}/tasks`, ada, { title: "a" });
  await call("POST", `${base}/tasks/t1/attempts`, bob, { count: 2 });
  for (const a of ["t1a1", "t1a2"]) await call("POST", `${base}/attempts/${a}/open`, bob);
  return head;
}

describe("merge request routes", () => {
  it("selects an attempt, approving its head, and reads the merge request back", async () => {
    const env = await setup();
    const { call, ada, adaClaude, bob, base } = env;
    const head = await twoAttempts(env);

    expect((await call("POST", `${base}/tasks/t1/selection`, bob, { attempt: "t1a1" })).status).toBe(403);
    expect((await call("POST", `${base}/tasks/t1/selection`, ada, { attempt: "t2a1" })).status).toBe(400);
    expect((await call("POST", `${base}/tasks/t1/selection`, ada, {})).status).toBe(400);
    expect((await call("GET", `${base}/tasks/t1/merge-request`, bob)).status).toBe(404);

    const selected = await call("POST", `${base}/tasks/t1/selection`, adaClaude, { attempt: "t1a1" });
    expect(selected.status).toBe(200);
    const ref = { id: expect.any(String), handle: "ada", alias: "claude" };
    expect(selected.body).toEqual({
      task: "t1",
      attempt: "t1a1",
      state: "pending",
      approvedHead: head,
      approvedBy: ref,
      approvedAt: "2026-10-10T12:00:00.000Z",
      queuedAt: null,
      position: null,
      lastDequeue: null,
      mergeSha: null,
      mergedAt: null,
      createdAt: "2026-10-10T12:00:00.000Z",
      createdBy: ref,
    });
    expect((await call("GET", `${base}/tasks/t1/merge-request`, bob)).body).toEqual(selected.body);
    expect((await call("GET", `${base}/attempts/t1a2`, bob)).body["state"]).toBe("closed");
    expect((await call("GET", `${base}/attempts/t1a1`, bob)).body["mergeRequest"]).toEqual({
      state: "pending",
      lastDequeue: null,
    });
    const again = await call("POST", `${base}/tasks/t1/selection`, ada, { attempt: "t1a1" });
    expect(again.body["error"]["code"]).toBe("invalidState");
  });

  it("approves and cancels with their permissions", async () => {
    const env = await setup();
    const { call, ada, bob, greg, base } = env;
    await twoAttempts(env);
    await call("POST", `${base}/tasks/t1/selection`, ada, { attempt: "t1a1" });

    expect((await call("POST", `${base}/tasks/t1/merge-request/approve`, bob)).status).toBe(403);
    expect((await call("POST", `${base}/tasks/t1/merge-request/approve`, greg)).body["state"]).toBe("pending");
    expect((await call("POST", `${base}/tasks/t1/merge-request/cancel`, bob)).status).toBe(403);
    expect((await call("POST", `${base}/tasks/t1/merge-request/cancel`, ada)).body["state"]).toBe("cancelled");
    const after = await call("POST", `${base}/tasks/t1/merge-request/cancel`, ada);
    expect([after.status, after.body["error"]["code"]]).toEqual([409, "invalidState"]);
  });

  it("selects, approves and cancels for the signed-in web user, only if they created the task or own the project", async () => {
    const env = await setup();
    const { callAs, base } = env;
    await twoAttempts(env);
    const select = (email: string) => callAs("POST", `${base}/tasks/t1/selection`, email, { attempt: "t1a1" });
    expect((await select("bob@example.com")).status).toBe(403);
    expect((await select("ada@example.com")).body).toMatchObject({ state: "pending", approvedBy: { handle: "ada" } });
    const act = (verb: string, email: string) => callAs("POST", `${base}/tasks/t1/merge-request/${verb}`, email);
    expect((await act("approve", "bob@example.com")).status).toBe(403);
    expect((await act("approve", "greg@example.com")).body["state"]).toBe("pending");
    expect((await act("cancel", "bob@example.com")).status).toBe(403);
    expect((await act("cancel", "ada@example.com")).body["state"]).toBe("cancelled");
  });

  it("reopens a closed attempt for its author signed in on the web, and no one else", async () => {
    const env = await setup();
    const { call, callAs, ada, base } = env;
    await twoAttempts(env);
    await call("POST", `${base}/tasks/t1/selection`, ada, { attempt: "t1a1" });
    await call("POST", `${base}/tasks/t1/merge-request/cancel`, ada);
    const reopen = (email: string) => callAs("POST", `${base}/attempts/t1a2/reopen`, email);
    expect((await reopen("ada@example.com")).status).toBe(403);
    expect((await reopen("bob@example.com")).body["state"]).toBe("draft");
  });

  it("lists the project's merge queue, front first", async () => {
    const env = await setup();
    const { call, store, ada, bob, project, base } = env;
    await twoAttempts(env);
    expect((await call("GET", `${base}/merge-queue`, bob)).body).toEqual({ queue: [] });

    const tasks = store(project["id"]);
    await tasks.scoring.drain();
    const run = at(tasks.scoring.listRuns("t1a2"), -1);
    tasks.scoringFinished(run.id, {
      status: "done",
      result: {
        base: null,
        config: { kind: "none" },
        gate: "passed",
        checks: [],
        metrics: {},
        logs: [],
      },
    });
    const selected = await call("POST", `${base}/tasks/t1/selection`, ada, { attempt: "t1a2" });
    expect(selected.body).toMatchObject({ state: "queued", position: 1 });
    expect((await call("GET", `${base}/merge-queue`, bob)).body).toEqual({
      queue: [{ position: 1, task: "t1", attempt: "t1a2", state: "queued" }],
    });
  });
});

describe("the task list's summaries", () => {
  type Env = Awaited<ReturnType<typeof setup>>;

  /** Finishes the latest run of t1's attempt `attempt` with `gate`. */
  async function finish(env: Env, attempt: number, gate: "passed" | "failed") {
    const tasks = env.store(env.project["id"]);
    await tasks.scoring.drain();
    const run = at(tasks.scoring.listRuns(`t1a${attempt}`), -1);
    tasks.scoringFinished(run.id, {
      status: "done",
      result: {
        base: null,
        config: { kind: "none" },
        gate,
        checks: [],
        metrics: {},
        logs: [],
      },
    });
  }

  const summary = async ({ call, bob, base }: Env) => {
    const [task] = (await call("GET", `${base}/tasks`, bob)).body["tasks"] as Json[];
    const { attemptCount, bestGate, mergeRequestState } = task as Json;
    return { attemptCount, bestGate, mergeRequestState };
  };

  it("counts attempts and gives the best gate and the merge request's state, so the list is one call", async () => {
    const env = await setup();
    await twoAttempts(env);
    expect(await summary(env)).toEqual({ attemptCount: 2, bestGate: null, mergeRequestState: null });
    await finish(env, 1, "failed");
    expect(await summary(env)).toMatchObject({ bestGate: "failed" });
    await finish(env, 2, "passed");
    expect(await summary(env)).toMatchObject({ bestGate: "passed" });
    await env.call("POST", `${env.base}/tasks/t1/selection`, env.ada, { attempt: "t1a2" });
    expect(await summary(env)).toEqual({ attemptCount: 2, bestGate: "passed", mergeRequestState: "queued" });
  });

  it("leaves obsolete attempts out of the count", async () => {
    const env = await setup();
    await twoAttempts(env);
    await env.call("POST", `${env.base}/attempts/t1a1/obsolete`, env.greg);
    expect(await summary(env)).toMatchObject({ attemptCount: 1 });
  });
});

describe("over throng-web's service binding", () => {
  it("lists, creates, reads, closes and obsoletes tasks, and lists attempts, as the forwarded user", async () => {
    const repos = new FakeRepos();
    const { backend } = testTaskBackends(repos, now);
    const web = webApp({
      verifierFor: () => verify,
      now,
      repos: () => repos,
      tasks: () => backend,
    });
    const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
    const call = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { [FORWARDED_EMAIL_HEADER]: "ada@example.com" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const res = await web.request(`/api${path}`, init, env);
      return { status: res.status, body: (await res.json()) as Json };
    };
    await call("POST", "/projects", { handle: "throng" });
    const base = "/projects/ada/throng";
    expect((await call("POST", `${base}/tasks`, { title: "a" })).status).toBe(201);
    await call("POST", `${base}/tasks`, { title: "b" });
    expect((await call("GET", `${base}/tasks`)).body["tasks"]).toHaveLength(2);
    expect((await call("GET", `${base}/tasks/t1`)).body["title"]).toBe("a");
    expect((await call("GET", `${base}/tasks/t1/attempts`)).body).toEqual({ attempts: [] });
    expect((await call("POST", `${base}/tasks/t1/close`)).body["state"]).toBe("closed");
    expect((await call("POST", `${base}/tasks/t2/obsolete`)).body["state"]).toBe("obsolete");
  });

  it("scores the forwarded user's own draft now", async () => {
    const { call, callAs, ada, base, repos, project } = await setup();
    repos.commit(`${project["id"]}-main`, { files: { "README.md": "hi\n" } });
    await call("POST", `${base}/tasks`, ada, { title: "a" });
    await call("POST", `${base}/tasks/t1/attempts`, ada);
    expect((await callAs("POST", `${base}/attempts/t1a1/score`, "bob@example.com")).status).toBe(403);
    const scored = await callAs("POST", `${base}/attempts/t1a1/score`, "ada@example.com");
    expect(scored.status).toBe(200);
    expect(scored.body).toMatchObject({ queued: true, run: { line: "t1a1", trigger: "scoreNow", alias: null } });
  });
});
