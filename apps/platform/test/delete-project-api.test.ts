// Deleting a project through the API: only its owner, acting as themselves, may, and everything the
// project holds goes with it, its D1 row last, so a delete that fails partway can be called again.

import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { FakeBucket } from "./support/object-bucket.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async () => null;
const PROJECT = "/projects/greg/throng";

async function setup() {
  const repos = new FakeRepos();
  const { backend } = testTaskBackends(repos);
  const logs = new FakeBucket();
  const caches = new FakeBucket();
  const destroyed: string[] = [];
  /** Makes the next Durable Object `destroy` throw, as an unreachable one would. */
  let failDestroy = false;
  const api = apiRoutes({
    verifierFor: () => verify,
    repos: () => repos,
    tasks: () => backend,
    storage: () => ({
      logs,
      caches,
      destroy: async (projectId) => {
        if (failDestroy) {
          failDestroy = false;
          throw new Error("Durable Object unreachable");
        }
        destroyed.push(projectId);
      },
    }),
    trustForwardedIdentity: true,
  });
  const db = testDatabase();
  const env = { DB: db, ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    const text = await res.text();
    return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as Json };
  };
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { [FORWARDED_EMAIL_HEADER]: email, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const gregAgent = await tokenFor("greg@example.com", "agent");
  const ada = await tokenFor("ada@example.com");
  const projectId = (await call("POST", "/projects", greg, { handle: "throng" })).body["id"] as string;
  const otherId = (await call("POST", "/projects", greg, { handle: "other" })).body["id"] as string;
  await repos.fork(`${projectId}-main`, `${projectId}-t1a1`);
  for (const id of [projectId, otherId]) {
    logs.keys.add(`logs/${id}/1/check.log`).add(`logs/${id}/2/check.log`).add(`logs/${id}/3/check.log`);
    caches.keys.add(`caches/${id}/abc`);
  }
  await db
    .prepare(
      `INSERT INTO projected_tasks (project_id, number, title, creator_id, state, created_at, epoch, version)
       VALUES (?, 1, 'Fix', 'u', 'open', '2026-10-10T12:00:00.000Z', 1, 1)`,
    )
    .bind(projectId)
    .first();

  const remaining = async () => ({
    repos: await repos.list(`${projectId}-`),
    logs: [...logs.keys].filter((key) => key.includes(projectId)),
    caches: [...caches.keys].filter((key) => key.includes(projectId)),
    projected: (
      await db
        .prepare("SELECT COUNT(*) AS n FROM projected_tasks WHERE project_id = ?")
        .bind(projectId)
        .first<{ n: number }>()
    )?.n,
  });
  return {
    call,
    greg,
    gregAgent,
    ada,
    projectId,
    otherId,
    repos,
    logs,
    caches,
    destroyed,
    remaining,
    failNextDestroy: () => {
      failDestroy = true;
    },
  };
}

describe("DELETE /projects/{owner}/{project}", () => {
  it("deletes the project and everything it holds for its owner acting as themselves", async () => {
    const { call, greg, projectId, otherId, destroyed, remaining, repos, logs } = await setup();

    expect(await call("DELETE", PROJECT, greg)).toEqual({ status: 204, body: null });

    expect((await call("GET", PROJECT, greg)).status).toBe(404);
    expect(destroyed).toEqual([projectId]);
    expect(await remaining()).toEqual({ repos: [], logs: [], caches: [], projected: 0 });
    // The owner's other project keeps everything.
    expect((await call("GET", "/projects/greg/other", greg)).status).toBe(200);
    expect(await repos.list(`${otherId}-`)).toEqual([`${otherId}-main`]);
    expect([...logs.keys].filter((key) => key.includes(otherId))).toHaveLength(3);
  });

  it("answers 404 when called again, the project being gone", async () => {
    const { call, greg } = await setup();
    await call("DELETE", PROJECT, greg);

    expect(await call("DELETE", PROJECT, greg)).toMatchObject({ status: 404, body: { error: { code: "notFound" } } });
  });

  it("refuses the owner under an alias, and anyone else, deleting nothing", async () => {
    const { call, gregAgent, ada, greg, destroyed, remaining } = await setup();

    for (const token of [gregAgent, ada]) {
      expect(await call("DELETE", PROJECT, token)).toMatchObject({
        status: 403,
        body: { error: { code: "forbidden" } },
      });
    }

    expect(destroyed).toEqual([]);
    expect((await remaining()).repos).toHaveLength(2);
    expect((await call("GET", PROJECT, greg)).status).toBe(200);
  });

  it("keeps the project when a step fails, so calling again finishes the delete", async () => {
    const { call, greg, projectId, destroyed, remaining, failNextDestroy } = await setup();
    failNextDestroy();

    expect((await call("DELETE", PROJECT, greg)).status).toBe(500);
    expect((await call("GET", PROJECT, greg)).status).toBe(200);

    expect((await call("DELETE", PROJECT, greg)).status).toBe(204);
    expect(destroyed).toEqual([projectId]);
    expect(await remaining()).toEqual({ repos: [], logs: [], caches: [], projected: 0 });
  });

  it("keeps the project when deleting its repos fails, so calling again deletes what's left", async () => {
    const { call, greg, repos, remaining } = await setup();
    const deleteRepo = repos.delete.bind(repos);
    let failing = true;
    repos.delete = async (name) => {
      if (failing && name.endsWith("-t1a1")) {
        failing = false;
        throw new Error("Artifacts unavailable");
      }
      return deleteRepo(name);
    };

    expect((await call("DELETE", PROJECT, greg)).status).toBe(500);
    expect((await call("GET", PROJECT, greg)).status).toBe(200);

    expect((await call("DELETE", PROJECT, greg)).status).toBe(204);
    expect(await remaining()).toEqual({ repos: [], logs: [], caches: [], projected: 0 });
  });

  it("frees the handle at once for a new project, under a new id", async () => {
    const { call, greg, projectId } = await setup();
    await call("DELETE", PROJECT, greg);

    const again = await call("POST", "/projects", greg, { handle: "throng" });

    expect(again.status).toBe(201);
    expect(again.body["id"]).not.toBe(projectId);
  });
});
