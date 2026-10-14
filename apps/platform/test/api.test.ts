import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { mintToken } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";

const verify: AccessVerifier = async (token) => (token === "valid" ? { email: "greg@example.com" } : null);

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

interface As {
  access?: string;
  bearer?: string;
}

const NOW = new Date("2026-10-10T12:00:00.000Z");

function setup() {
  let clock = NOW;
  const repos = new FakeRepos();
  const api = apiRoutes({
    verifierFor: () => verify,
    now: () => clock,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    fetch: repos.sourceFetch,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  /** Sends as an Access session (`{access}`) or a bearer token (`{bearer}`), or anonymously. */
  const call = async (method: string, path: string, as: As = {}, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (as.access !== undefined) headers["Cf-Access-Jwt-Assertion"] = as.access;
    if (as.bearer !== undefined) headers["Authorization"] = `Bearer ${as.bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const human = { access: "valid" };
  const mint = async (body: unknown = {}, as: As = human) => {
    const res = await call("POST", "/tokens", as, body);
    expect(res.status).toBe(201);
    return res.body;
  };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  return { api, call, mint, human, advance, env, repos };
}

describe("GET /api/me", () => {
  it("is 401 with the shared error shape without a session or token", async () => {
    const { call } = setup();
    for (const as of [{}, { access: "forged" }, { bearer: "thr_nope" }, { bearer: "not-a-throng-token" }]) {
      const res = await call("GET", "/me", as);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    }
  });

  it("returns the signed-in user, created on first sight, with no alias or token", async () => {
    const { call, human } = setup();
    const first = await call("GET", "/me", human);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ user: { handle: "greg", email: "greg@example.com" }, alias: null, token: null });
    expect((await call("GET", "/me", human)).body).toEqual(first.body);
  });

  it("returns the alias and token expiry for a bearer token", async () => {
    const { call, mint, human } = setup();
    const user = (await call("GET", "/me", human)).body["user"];
    const minted = await mint({ alias: "claude" });
    const res = await call("GET", "/me", { bearer: minted["token"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user, alias: "claude", token: { id: minted["id"], expiresAt: minted["expiresAt"] } });
  });
});

describe("POST /api/tokens", () => {
  it("mints a thr_ token that expires in 24 h by default and stores only its hash", async () => {
    const { mint, env } = setup();
    const minted = await mint();
    expect(minted).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{12}$/u),
      alias: null,
      token: expect.stringMatching(/^thr_[A-Za-z0-9_-]{43}$/u),
      createdAt: "2026-10-10T12:00:00.000Z",
      expiresAt: "2026-10-11T12:00:00.000Z",
      revokedAt: null,
    });
    const row = await env.DB.prepare("SELECT * FROM tokens WHERE id = ?").bind(minted["id"]).first<Json>();
    expect(row?.["hash"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.values(row ?? {})).not.toContain(minted["token"]);
  });

  it("accepts an alias and an expiry of up to 7 days", async () => {
    const { mint } = setup();
    expect(await mint({ alias: "claude", expiresIn: 7 * DAY })).toMatchObject({
      alias: "claude",
      expiresAt: "2026-10-17T12:00:00.000Z",
    });
  });

  it("rejects an expiry above 7 days, and malformed requests", async () => {
    const { call, human } = setup();
    const bodies = [{ expiresIn: 7 * DAY + 1 }, { expiresIn: 0 }, { expiresIn: 1.5 }, { alias: "" }, { alias: "a(b)" }];
    for (const body of bodies) {
      const res = await call("POST", "/tokens", human, body);
      expect(res.status).toBe(400);
      expect(res.body["error"]["code"]).toBe("invalidRequest");
    }
  });

  it("is 401 without a session or token", async () => {
    const { call } = setup();
    expect((await call("POST", "/tokens", {}, {})).status).toBe(401);
  });

  it("lets a token mint another, no longer-lived than itself", async () => {
    const { call, mint } = setup();
    const parent = await mint({ expiresIn: 2 * HOUR });
    const bearer = { bearer: parent["token"] };
    expect((await mint({}, bearer))["expiresAt"]).toBe(parent["expiresAt"]);
    expect((await mint({ expiresIn: HOUR, alias: "claude" }, bearer))["alias"]).toBe("claude");
    expect((await call("POST", "/tokens", bearer, { expiresIn: 3 * HOUR })).status).toBe(400);
  });

  it("takes a null alias as the caller acting as themselves", async () => {
    const { mint } = setup();
    expect((await mint({ alias: null }))["alias"]).toBeNull();
  });

  it("only lets an alias's token mint for that alias", async () => {
    const { call, mint } = setup();
    const alias = { bearer: (await mint({ alias: "claude" }))["token"] };
    expect((await mint({}, alias))["alias"]).toBe("claude");
    expect((await call("POST", "/tokens", alias, { alias: "codex" })).body["error"]["code"]).toBe("forbidden");
  });
});

describe("GET /api/tokens", () => {
  it("lists the caller's tokens newest first without secrets", async () => {
    const { call, mint, human, advance } = setup();
    const first = await mint();
    advance(60);
    const second = await mint({ alias: "claude" });
    const res = await call("GET", "/tokens", human);
    expect(res.status).toBe(200);
    expect(res.body["tokens"].map((t: Json) => t["id"])).toEqual([second["id"], first["id"]]);
    for (const token of res.body["tokens"]) {
      expect(Object.keys(token).toSorted()).toEqual(["alias", "createdAt", "expiresAt", "id", "revokedAt"]);
    }
  });

  it("shows an alias only its own tokens", async () => {
    const { call, mint } = setup();
    await mint();
    const claude = await mint({ alias: "claude" });
    await mint({ alias: "codex" });
    const res = await call("GET", "/tokens", { bearer: claude["token"] });
    expect(res.body["tokens"].map((t: Json) => t["id"])).toEqual([claude["id"]]);
  });
});

describe("DELETE /api/tokens/{id}", () => {
  it("revokes a token, which is rejected on its next request", async () => {
    const { call, mint, human, advance } = setup();
    const minted = await mint();
    const bearer = { bearer: minted["token"] };
    expect((await call("GET", "/me", bearer)).status).toBe(200);

    const revoked = await call("DELETE", `/tokens/${minted["id"]}`, human);
    expect(revoked.status).toBe(200);
    expect(revoked.body["revokedAt"]).toBe("2026-10-10T12:00:00.000Z");
    expect((await call("GET", "/me", bearer)).status).toBe(401);

    advance(60);
    const again = await call("DELETE", `/tokens/${minted["id"]}`, human);
    expect(again.body["revokedAt"]).toBe("2026-10-10T12:00:00.000Z");
  });

  it("lets a token revoke itself", async () => {
    const { call, mint } = setup();
    const minted = await mint();
    const bearer = { bearer: minted["token"] };
    expect((await call("DELETE", `/tokens/${minted["id"]}`, bearer)).status).toBe(200);
    expect((await call("GET", "/me", bearer)).status).toBe(401);
  });

  it("is 404 for unknown ids and other callers' tokens", async () => {
    const { call, mint, human } = setup();
    expect((await call("DELETE", "/tokens/nope", human)).body).toEqual({
      error: { code: "notFound", message: "no such token" },
    });
    const humanToken = await mint();
    const alias = { bearer: (await mint({ alias: "claude" }))["token"] };
    expect((await call("DELETE", `/tokens/${humanToken["id"]}`, alias)).status).toBe(404);
  });
});

describe("token expiry", () => {
  it("accepts a token until the instant it expires, then rejects it", async () => {
    const { call, mint, advance } = setup();
    const bearer = { bearer: (await mint({ expiresIn: HOUR }))["token"] };
    advance(HOUR - 1);
    expect((await call("GET", "/me", bearer)).status).toBe(200);
    advance(1);
    expect((await call("GET", "/me", bearer)).status).toBe(401);
  });
});

describe("POST /api/projects", () => {
  it("creates a project owned by the token's user, with its origin repo", async () => {
    const { call, mint, repos } = setup();
    const bearer = { bearer: (await mint({ alias: "claude" }))["token"] };
    const res = await call("POST", "/projects", bearer, { handle: "throng" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{6}$/u),
      handle: "throng",
      owner: { id: expect.any(String), handle: "greg" },
      source: null,
      createdAt: expect.any(String),
    });
    expect(await repos.list(res.body["id"])).toEqual([`${res.body["id"]}-main`]);
  });

  it("imports a public git source as the project's main, and shows where it came from", async () => {
    const { call, mint, repos } = setup();
    await repos.create("upstream");
    const head = repos.commit("upstream", { branch: "master", files: { README: "Hello\n" } });
    const url = "https://github.com/octocat/Hello-World";
    repos.serveSource(url, "upstream", "master");
    const bearer = { bearer: (await mint())["token"] };
    const res = await call("POST", "/projects", bearer, { handle: "hello", source: { url } });
    expect(res.status).toBe(201);
    expect(res.body["source"]).toBe(url);
    expect(repos.ref(`${res.body["id"]}-main`, "refs/heads/main")).toBe(head.hash);
    expect((await call("GET", "/projects/greg/hello", bearer)).body["source"]).toBe(url);
  });

  it("says why a source can't be imported", async () => {
    const { call, mint, repos } = setup();
    const bearer = { bearer: (await mint())["token"] };
    const cases: [unknown, number, string][] = [
      [{ url: "http://github.com/o/r" }, 400, "invalidRequest"],
      [{ url: "https://token@github.com/o/r" }, 400, "invalidRequest"],
      [{ url: 42 }, 400, "invalidRequest"],
      [{}, 400, "invalidRequest"],
      [{ url: "https://github.com/octocat/private" }, 404, "notFound"],
    ];
    for (const [source, status, code] of cases) {
      const res = await call("POST", "/projects", bearer, { handle: "hello", source });
      expect(res.status, JSON.stringify(source)).toBe(status);
      expect(res.body["error"]["code"]).toBe(code);
    }
    expect(repos.calls.filter((c) => c.method === "import" || c.method === "create")).toEqual([]);
  });

  it("is 409 for a handle the caller already uses", async () => {
    const { call, mint } = setup();
    const bearer = { bearer: (await mint())["token"] };
    expect((await call("POST", "/projects", bearer, { handle: "throng" })).status).toBe(201);
    const res = await call("POST", "/projects", bearer, { handle: "throng" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "conflict", message: "project greg/throng already exists" } });
  });

  it("is 400 for an invalid handle", async () => {
    const { call, mint } = setup();
    const bearer = { bearer: (await mint())["token"] };
    for (const body of [{}, { handle: "Throng" }, { handle: "a/b" }, { handle: 1 }]) {
      const res = await call("POST", "/projects", bearer, body);
      expect(res.status).toBe(400);
      expect(res.body["error"]["code"]).toBe("invalidRequest");
    }
  });

  it("needs a bearer token; an Access session is not enough", async () => {
    const { call, human } = setup();
    for (const as of [{}, human]) {
      expect((await call("POST", "/projects", as, { handle: "throng" })).status).toBe(401);
    }
  });
});

describe("GET /api/projects", () => {
  it("lists the projects the caller's user owns, by handle", async () => {
    const { call, mint, env } = setup();
    const greg = { bearer: (await mint())["token"] };
    const claude = { bearer: (await mint({ alias: "claude" }))["token"] };
    for (const handle of ["zeta", "alpha"]) {
      expect((await call("POST", "/projects", greg, { handle })).status).toBe(201);
    }
    const ada = await userForEmail(env.DB, "ada@example.com");
    const { plaintext } = await mintToken(env.DB, { userId: ada.id, alias: null, ttlSeconds: HOUR, now: NOW });
    expect((await call("POST", "/projects", { bearer: plaintext }, { handle: "other" })).status).toBe(201);

    for (const as of [greg, claude]) {
      const res = await call("GET", "/projects", as);
      expect(res.status).toBe(200);
      expect(res.body["projects"].map((p: Json) => `${p["owner"]["handle"]}/${p["handle"]}`)).toEqual([
        "greg/alpha",
        "greg/zeta",
      ]);
    }
    expect((await call("GET", "/projects", { bearer: plaintext })).body["projects"]).toHaveLength(1);
  });

  it("is an empty list for a caller with no projects", async () => {
    const { call, mint } = setup();
    const res = await call("GET", "/projects", { bearer: (await mint())["token"] });
    expect(res).toEqual({ status: 200, body: { projects: [] } });
  });

  it("needs a bearer token; an Access session is not enough", async () => {
    const { call, human } = setup();
    for (const as of [{}, human]) expect((await call("GET", "/projects", as)).status).toBe(401);
  });
});

describe("GET /api/projects/{owner}/{project}", () => {
  it("resolves handles to the project", async () => {
    const { call, mint } = setup();
    const bearer = { bearer: (await mint())["token"] };
    const created = (await call("POST", "/projects", bearer, { handle: "throng" })).body;
    const res = await call("GET", "/projects/greg/throng", bearer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
  });

  it("is 404 for an unknown owner or project", async () => {
    const { call, mint } = setup();
    const bearer = { bearer: (await mint())["token"] };
    await call("POST", "/projects", bearer, { handle: "throng" });
    for (const path of ["/projects/nobody/throng", "/projects/greg/nothing"]) {
      const res = await call("GET", path, bearer);
      expect(res.status).toBe(404);
      expect(res.body["error"]["code"]).toBe("notFound");
    }
  });

  it("is 401 without a token", async () => {
    const { call } = setup();
    expect((await call("GET", "/projects/greg/throng")).status).toBe(401);
  });
});

describe("errors", () => {
  it("turns unexpected failures into the shared error shape, also when mounted", async () => {
    const { api } = setup();
    api.get("/boom", () => {
      throw new Error("boom");
    });
    const app = new Hono().route("/api", api);
    const res = await app.request("/api/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
  });
});

describe("GET /api/openapi.json", () => {
  it("describes the token routes and the error shape", async () => {
    const { call } = setup();
    const { status, body } = await call("GET", "/openapi.json");
    expect(status).toBe(200);
    expect(Object.keys(body["paths"])).toEqual(
      expect.arrayContaining(["/me", "/tokens", "/tokens/{id}", "/projects", "/projects/{owner}/{project}"]),
    );
    expect(body["components"]["schemas"]["Error"]).toBeDefined();
    expect(body["components"]["schemas"]["Project"]).toBeDefined();
  });

  it("gives every operation an id, a summary and tags", async () => {
    const { call } = setup();
    const { body } = await call("GET", "/openapi.json");
    const operations = Object.values(body["paths"]).flatMap((path) => Object.values(path as Json)) as Json[];
    const operationIds = operations.map((op) => op["operationId"]);
    expect(operationIds).toEqual(
      expect.arrayContaining([
        "getMe",
        "mintToken",
        "listTokens",
        "revokeToken",
        "listProjects",
        "createProject",
        "getProject",
      ]),
    );
    expect(new Set(operationIds).size).toBe(operations.length);
    for (const op of operations) {
      expect(op["summary"]).toEqual(expect.any(String));
      expect(op["tags"]).toEqual([expect.any(String)]);
    }
  });
});
