import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { REF_MAX_AGE_SECONDS } from "../src/browse-api.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");
const SOURCE = "https://github.com/octocat/Hello-World";

async function setup() {
  const repos = new FakeRepos();
  const backends = testTaskBackends(repos, now);
  const api = apiRoutes({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    tasks: () => backends.backend,
    fetch: repos.sourceFetch,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const request = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
    api.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const tokenRes = await request(
    "/tokens",
    { "Cf-Access-Jwt-Assertion": "as:greg@example.com", "Content-Type": "application/json" },
    "POST",
    {},
  );
  const auth = { Authorization: `Bearer ${((await tokenRes.json()) as Json)["token"] as string}` };
  const create = async (body: unknown) => {
    const res = await request("/projects", { ...auth, "Content-Type": "application/json" }, "POST", body);
    expect(res.status).toBe(201);
    return ((await res.json()) as Json)["id"] as string;
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await request(path, { ...auth, ...headers });
    const body = res.status === 200 ? ((await res.json()) as Json) : null;
    return { status: res.status, headers: res.headers, body };
  };
  return { repos, create, get, request };
}

describe("GET /projects/{owner}/{project}/stats", () => {
  it("gives main's contributors, languages and description, and where the project came from", async () => {
    const { repos, create, get } = await setup();
    await repos.create("upstream");
    repos.commit("upstream", {
      branch: "master",
      files: { "README.md": "# Hello\n\nSays hello.\n", "hello.ts": "x".repeat(30) },
      author: { name: "Bob", email: "bob@example.com" },
    });
    repos.serveSource(SOURCE, "upstream", "master");
    const id = await create({ handle: "hello", source: { url: SOURCE } });
    const head = repos.commit(`${id}-main`, {
      files: { "README.md": "# Hello\n\nSays hello.\n", "hello.ts": "x".repeat(30), "hello.py": "x".repeat(10) },
    });
    const res = await get("/projects/greg/hello/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ref: "main",
      sha: head.hash,
      source: SOURCE,
      description: "Says hello.",
      contributors: [
        { name: "Ada", email: "ada@example.com", commits: 1 },
        { name: "Bob", email: "bob@example.com", commits: 1 },
      ],
      languages: [
        { name: "TypeScript", bytes: 30, share: 0.75 },
        { name: "Python", bytes: 10, share: 0.25 },
      ],
      truncated: false,
    });
    expect(res.headers.get("ETag")).toBe(`"${head.hash}"`);
    expect(res.headers.get("Cache-Control")).toBe(`private, max-age=${REF_MAX_AGE_SECONDS}`);
  });

  it("answers a project with nothing pushed yet with nothing to count", async () => {
    const { create, get } = await setup();
    await create({ handle: "empty" });
    const res = await get("/projects/greg/empty/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ref: "main",
      sha: null,
      source: null,
      description: null,
      contributors: [],
      languages: [],
      truncated: false,
    });
  });

  it("answers 304 when main hasn't moved, reading no trees or blobs", async () => {
    const { repos, create, get } = await setup();
    const id = await create({ handle: "alpha" });
    const head = repos.commit(`${id}-main`, { files: { "a.ts": "a" } });
    await get("/projects/greg/alpha/stats");
    const reads = repos.calls.length;
    const res = await get("/projects/greg/alpha/stats", { "If-None-Match": `"${head.hash}"` });
    expect(res.status).toBe(304);
    expect(repos.calls.slice(reads).map((c) => c.method)).toEqual(["listCommits"]);
  });

  it("is a 404 for a project that doesn't exist, and a 401 without a token", async () => {
    const { get, request } = await setup();
    expect((await get("/projects/greg/nope/stats")).status).toBe(404);
    expect((await request("/projects/greg/nope/stats")).status).toBe(401);
  });
});
