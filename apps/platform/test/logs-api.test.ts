import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { webApp } from "../src/app.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import type { LogStore } from "../src/logs.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");

/** An R2 bucket in memory; deleting a key stands in for the lifecycle rule expiring it. */
class MemoryLogs implements LogStore {
  readonly objects = new Map<string, string>();
  async get(key: string) {
    const text = this.objects.get(key);
    return text === undefined ? null : { body: new Response(text).body as ReadableStream };
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
}

async function setup() {
  const repos = new FakeRepos();
  const logs = new MemoryLogs();
  const { backend } = testTaskBackends(repos, now);
  const options = {
    verifierFor: () => verify,
    now,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    tasks: () => backend,
    logs: () => logs,
  };
  const api = apiRoutes(options);
  const web = webApp(options);
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const request = (path: string, bearer?: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (bearer !== undefined) headers["Authorization"] = `Bearer ${bearer}`;
    return api.request(path, { ...init, headers }, env);
  };
  const tokenFor = async (email: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: "{}" }, env);
    return ((await res.json()) as Json)["token"] as string;
  };
  const post = async (path: string, bearer: string, body: unknown = {}) => {
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return (await (await request(path, bearer, init)).json()) as Json;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const project = await post("/projects", greg, { handle: "throng" });
  repos.commit(`${project["id"]}-main`, { files: { "README.md": "hi\n" } });
  await post("/projects/greg/throng/tasks", greg, { title: "a" });
  await post("/projects/greg/throng/tasks/t1/attempts", ada);
  const scored = await post("/projects/greg/throng/attempts/t1a1/score", ada);
  const run = scored["run"]["id"] as number;
  const prefix = `logs/${project["id"]}/t1a1/${run}`;
  return { request, web, env, logs, greg, ada, run, prefix, base: "/projects/greg/throng" };
}

describe("GET /projects/{owner}/{project}/runs/{runId}/logs/{name}", () => {
  it("streams a run's stored log as text", async () => {
    const { request, logs, ada, run, prefix, base } = await setup();
    logs.objects.set(`${prefix}/test.log`, "ok\nall 3 passed\n");
    logs.objects.set(`${prefix}/setup.1.log`, "added 12 packages\n");

    const res = await request(`${base}/runs/${run}/logs/test`, ada);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("ok\nall 3 passed\n");
    expect(await (await request(`${base}/runs/${run}/logs/setup.1`, ada)).text()).toBe("added 12 packages\n");
  });

  it("is notFound for a log the run never stored, or one the lifecycle rule expired", async () => {
    const { request, logs, ada, run, prefix, base } = await setup();
    logs.objects.set(`${prefix}/test.log`, "ok\n");
    logs.objects.delete(`${prefix}/test.log`);
    for (const name of ["test", "bundle"]) {
      const res = await request(`${base}/runs/${run}/logs/${name}`, ada);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "notFound", message: expect.any(String) } });
    }
  });

  it("is notFound for a run the project doesn't have, or a name no log can have", async () => {
    const { request, logs, ada, run, prefix, base } = await setup();
    logs.objects.set(`${prefix}/test.log`, "ok\n");
    for (const path of [`${base}/runs/${run + 1}/logs/test`, `${base}/runs/${run}/logs/..%2Ftest`]) {
      const res = await request(path, ada);
      expect(res.status).toBe(404);
      expect(((await res.json()) as Json)["error"]["code"]).toBe("notFound");
    }
    expect((await request(`/projects/greg/other/runs/${run}/logs/test`, ada)).status).toBe(404);
    expect((await request(`${base}/runs/x/logs/test`, ada)).status).toBe(400);
  });

  it("needs a bearer token", async () => {
    const { request, run, base } = await setup();
    expect((await request(`${base}/runs/${run}/logs/test`)).status).toBe(401);
  });

  it("takes throng-web's forwarded identity over the service binding", async () => {
    const { web, env, logs, run, prefix, base } = await setup();
    logs.objects.set(`${prefix}/test.log`, "ok\n");
    const res = await web.request(
      `/api${base}/runs/${run}/logs/test`,
      { headers: { [FORWARDED_EMAIL_HEADER]: "ada@example.com" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });
});
