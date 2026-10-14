// A project's secrets through the API: the owner sets, replaces, allows and deletes them acting as
// themselves; maintainers, aliases included, read their names; no answer ever holds a value.

import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import { openSecret } from "../src/secrets.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";
import { TEST_KEYRING, testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const START = Date.parse("2026-10-10T12:00:00.000Z");
let clock = START;
const now = () => new Date(clock);

const VALUE = "cf-preview-token-0123456789";
const SECRETS = "/projects/greg/throng/secrets";

/** A base64 column read back as bytes. */
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function setup() {
  clock = START;
  const repos = new FakeRepos();
  const { backend, store, sql } = testTaskBackends(repos, now);
  const api = apiRoutes({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    tasks: () => backend,
    trustForwardedIdentity: true,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  /** Every response's raw text, to check no answer ever held a value. */
  const answers: string[] = [];

  /** Calls as a bearer token, or as a web user by `{ web: email }`. */
  const call = async (method: string, path: string, as: string | { web: string }, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (typeof as === "string") headers["Authorization"] = `Bearer ${as}`;
    else headers[FORWARDED_EMAIL_HEADER] = as.web;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    const text = await res.text();
    answers.push(text);
    return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as Json };
  };
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { [FORWARDED_EMAIL_HEADER]: email, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const gregClaude = await tokenFor("greg@example.com", "claude");
  const ada = await tokenFor("ada@example.com");
  const projectId = (await call("POST", "/projects", greg, { handle: "throng" })).body["id"] as string;
  const gregId = ((await call("GET", "/me", greg)).body["user"] as Json)["id"] as string;
  const journal = () =>
    sql(projectId)
      .exec<{ kind: string; detail: string; user_id: string; alias: string | null }>(
        "SELECT kind, detail, user_id, alias FROM journal WHERE kind LIKE 'secret%' ORDER BY id",
      )
      .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Json }));
  return { call, greg, gregClaude, ada, gregId, projectId, store, sql, answers, journal };
}

describe("setting a secret", () => {
  it("stores it for the owner, and lists its name, pipelines and last change, never its value", async () => {
    const { call, greg, answers } = await setup();
    const put = await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main", "default"] });
    expect(put).toEqual({
      status: 200,
      body: { name: "DEPLOY_TOKEN", pipelines: ["default", "main"], changedAt: "2026-10-10T12:00:00.000Z" },
    });
    const listed = await call("GET", SECRETS, greg);
    expect(listed).toEqual({
      status: 200,
      body: {
        secrets: [{ name: "DEPLOY_TOKEN", pipelines: ["default", "main"], changedAt: "2026-10-10T12:00:00.000Z" }],
      },
    });
    expect(answers.join("\n")).not.toContain(VALUE);
  });

  it("works for the owner signed in to throng-web", async () => {
    const { call } = await setup();
    const put = await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, { web: "greg@example.com" }, { value: VALUE });
    expect(put.status).toBe(200);
    expect(put.body["pipelines"]).toEqual([]);
  });

  it("keeps the value encrypted in the project's Durable Object, and out of the D1 projection", async () => {
    const { call, greg, projectId, sql, store } = await setup();
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main"] });
    const rows = sql(projectId).exec<{ ciphertext: string; iv: string; key_id: string }>(
      "SELECT ciphertext, iv, key_id FROM secrets WHERE name = 'DEPLOY_TOKEN'",
    );
    const [row] = rows;
    if (row === undefined) throw new Error("no secrets row");
    expect(JSON.stringify(sql(projectId).db.prepare("SELECT * FROM secrets").all())).not.toContain(VALUE);
    const sealed = { ciphertext: bytes(row.ciphertext), iv: bytes(row.iv), keyId: row.key_id };
    expect(await openSecret(TEST_KEYRING, projectId, "DEPLOY_TOKEN", sealed)).toBe(VALUE);
    expect(store(projectId).projection.hasChanges()).toBeFalsy();
  });

  it("replaces the value and keeps its pipelines, or changes its pipelines and keeps the value", async () => {
    const { call, greg, projectId, sql } = await setup();
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main"] });
    const sealed = () => sql(projectId).exec<{ ciphertext: string }>("SELECT ciphertext FROM secrets")[0]?.ciphertext;
    const first = sealed();

    clock += 60_000;
    const replaced = await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: `${VALUE}-2` });
    expect(replaced.body).toEqual({ name: "DEPLOY_TOKEN", pipelines: ["main"], changedAt: now().toISOString() });
    const second = sealed();
    expect(second).not.toBe(first);

    clock += 60_000;
    const allowed = await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { pipelines: ["default"] });
    expect(allowed.body).toEqual({ name: "DEPLOY_TOKEN", pipelines: ["default"], changedAt: now().toISOString() });
    expect(sealed()).toBe(second);
  });

  it.each([
    ["a value shorter than 8 characters", "DEPLOY_TOKEN", { value: "short12" }],
    ["neither a value nor pipelines", "DEPLOY_TOKEN", {}],
    ["an unknown pipeline", "DEPLOY_TOKEN", { value: VALUE, pipelines: ["preview"] }],
    ["a lowercase name", "deploy_token", { value: VALUE }],
    ["a name starting with a digit", "1TOKEN", { value: VALUE }],
    ["a name Throng reserves", "THRONG_SHA", { value: VALUE }],
  ])("refuses %s", async (_, name, body) => {
    const { call, greg } = await setup();
    const refused = await call("PUT", `${SECRETS}/${name}`, greg, body);
    expect(refused.status).toBe(400);
    expect(refused.body["error"]["code"]).toBe("invalidRequest");
    expect((await call("GET", SECRETS, greg)).body["secrets"]).toEqual([]);
  });

  it("refuses to allow a secret that has no value yet", async () => {
    const { call, greg } = await setup();
    const refused = await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { pipelines: ["main"] });
    expect(refused.status).toBe(404);
    expect(refused.body["error"]["message"]).toContain("DEPLOY_TOKEN");
  });
});

describe("deleting a secret", () => {
  it("removes it", async () => {
    const { call, greg } = await setup();
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main"] });
    expect((await call("DELETE", `${SECRETS}/DEPLOY_TOKEN`, greg)).status).toBe(204);
    expect((await call("GET", SECRETS, greg)).body["secrets"]).toEqual([]);
    expect((await call("DELETE", `${SECRETS}/DEPLOY_TOKEN`, greg)).status).toBe(404);
  });
});

describe("who may", () => {
  it("lets the owner's aliases read secrets' names, but not set, allow or delete them", async () => {
    const { call, greg, gregClaude } = await setup();
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main"] });
    expect((await call("GET", SECRETS, gregClaude)).body["secrets"]).toHaveLength(1);
    for (const [method, body] of [
      ["PUT", { value: `${VALUE}-2` }],
      ["PUT", { pipelines: ["default", "main"] }],
      ["DELETE", undefined],
    ] as const) {
      const refused = await call(method, `${SECRETS}/DEPLOY_TOKEN`, gregClaude, body);
      expect(refused.status).toBe(403);
    }
    expect((await call("PUT", `${SECRETS}/NEW_TOKEN`, gregClaude, { value: VALUE })).status).toBe(403);
    expect((await call("GET", SECRETS, greg)).body["secrets"]).toEqual([
      { name: "DEPLOY_TOKEN", pipelines: ["main"], changedAt: "2026-10-10T12:00:00.000Z" },
    ]);
  });

  it("lets no one else read or change them", async () => {
    const { call, greg, ada } = await setup();
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main"] });
    expect((await call("GET", SECRETS, ada)).status).toBe(403);
    expect((await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, ada, { value: `${VALUE}-2` })).status).toBe(403);
    expect((await call("DELETE", `${SECRETS}/DEPLOY_TOKEN`, ada)).status).toBe(403);
  });

  it("is 404 for a project that doesn't exist", async () => {
    const { call, greg } = await setup();
    expect((await call("GET", "/projects/greg/nope/secrets", greg)).status).toBe(404);
  });
});

describe("the journal", () => {
  it("records every write with its actor, name and pipelines, never the value", async () => {
    const { call, greg, gregId, journal } = await setup();
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { value: VALUE, pipelines: ["main"] });
    await call("PUT", `${SECRETS}/DEPLOY_TOKEN`, greg, { pipelines: ["default", "main"] });
    await call("DELETE", `${SECRETS}/DEPLOY_TOKEN`, greg);
    const entries = journal();
    expect(entries).toEqual([
      { kind: "secretSet", user_id: gregId, alias: null, detail: { name: "DEPLOY_TOKEN", pipelines: ["main"] } },
      {
        kind: "secretSet",
        user_id: gregId,
        alias: null,
        detail: { name: "DEPLOY_TOKEN", pipelines: ["default", "main"] },
      },
      {
        kind: "secretDeleted",
        user_id: gregId,
        alias: null,
        detail: { name: "DEPLOY_TOKEN", pipelines: ["default", "main"] },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(VALUE);
  });
});
