import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { webApp } from "../src/app.ts";
import { ARCHIVE_REF_PREFIX } from "../src/archive.ts";
import { IMMUTABLE, REF_MAX_AGE_SECONDS } from "../src/browse-api.ts";
import { MAX_TEXT_BYTES } from "../src/browse.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");
const REF_CACHE = `private, max-age=${REF_MAX_AGE_SECONDS}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

async function setup(extra: Partial<Parameters<typeof apiRoutes>[0]> = {}) {
  const repos = new FakeRepos();
  const backends = testTaskBackends(repos, now);
  const options = { verifierFor: () => verify, now, repos: () => repos, tasks: () => backends.backend, ...extra };
  const api = apiRoutes(options);
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  const request = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
    api.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const tokenRes = await request(
    "/tokens",
    { "Cf-Access-Jwt-Assertion": "as:greg@example.com", "Content-Type": "application/json" },
    "POST",
    {},
  );
  const greg = ((await tokenRes.json()) as Json)["token"] as string;
  const auth = { Authorization: `Bearer ${greg}` };
  const post = async (path: string, body: unknown = {}) => {
    const res = await request(path, { ...auth, "Content-Type": "application/json" }, "POST", body);
    expect(res.status).toBeLessThan(300);
    return (await res.json()) as Json;
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await request(path, { ...auth, ...headers });
    const type = res.headers.get("Content-Type") ?? "";
    const body = type.startsWith("application/json") ? ((await res.json()) as Json) : null;
    return { status: res.status, headers: res.headers, body, res };
  };

  const project = await post("/projects", { handle: "throng" });
  const id = project["id"] as string;
  const origin = `${id}-main`;
  const base = "/projects/greg/throng";
  return { repos, backends, options, env, request, get, post, id, origin, base };
}

describe("ref resolution", () => {
  it("resolves main, an active attempt, an archived attempt and a sha", async () => {
    const { repos, backends, get, post, id, origin, base } = await setup();
    const first = repos.commit(origin, { files: { "README.md": "v1\n" } });
    await post(`${base}/tasks`, { title: "Work" });
    await post(`${base}/tasks/t1/attempts`, { count: 3 });

    const active = repos.commit(`${id}-t1a1`, { files: { "README.md": "attempt 1\n" } });
    const archived = repos.commit(`${id}-t1a2`, { files: { "README.md": "attempt 2\n" } });
    const recorded = repos.commit(`${id}-t1a3`, { files: { "README.md": "attempt 3\n" } });

    // Closing archives each head to its archive ref, records the sha and deletes the fork.
    await post(`${base}/attempts/t1a2/close`);
    await post(`${base}/attempts/t1a3/close`);
    expect(await repos.list(`${id}-t1a`)).toEqual([`${id}-t1a1`]);
    // The recorded sha wins over the archive ref: move t1a3's ref and clear t1a2's record.
    repos.setRef(origin, `${ARCHIVE_REF_PREFIX}t1a3`, first.hash);
    backends.sql(id).exec("UPDATE attempts SET archived_sha = NULL WHERE task = 1 AND number = 2");

    const readme = async (ref: string) => (await get(`${base}/blob/${ref}/README.md`)).body!;
    expect(await readme("main")).toMatchObject({ ref: "main", sha: first.hash, content: "v1\n" });
    expect(await readme("t1a1")).toMatchObject({ ref: "t1a1", sha: active.hash, content: "attempt 1\n" });
    expect(await readme("t1a2")).toMatchObject({ ref: "t1a2", sha: archived.hash, content: "attempt 2\n" });
    expect(await readme("t1a3")).toMatchObject({ ref: "t1a3", sha: recorded.hash, content: "attempt 3\n" });
    expect(await readme(first.hash)).toMatchObject({ ref: first.hash, sha: first.hash, content: "v1\n" });
    expect(await readme(first.hash.toUpperCase())).toMatchObject({ sha: first.hash });
  });

  it("finds a fork-only sha only through ?attempt=", async () => {
    const { repos, get, post, id, origin, base } = await setup();
    repos.commit(origin, { files: { a: "1" } });
    await post(`${base}/tasks`, { title: "Work" });
    await post(`${base}/tasks/t1/attempts`);
    const work = repos.commit(`${id}-t1a1`, { files: { a: "2" } });

    expect((await get(`${base}/commit/${work.hash}`)).status).toBe(404);
    const found = await get(`${base}/commit/${work.hash}?attempt=t1a1`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ sha: work.hash, message: work.message });
    expect((await get(`${base}/tree/${work.hash}?attempt=t1a1`)).body).toMatchObject({ sha: work.hash });
    expect((await get(`${base}/commit/${work.hash}?attempt=nope`)).status).toBe(400);
  });

  it("returns notFound for unknown refs, projects and empty repos", async () => {
    const { repos, get, post, origin, base } = await setup();
    const notFound = { error: { code: "notFound", message: expect.any(String) } };
    expect((await get(`${base}/tree/main`)).body).toEqual(notFound);
    expect((await get(`/projects/greg/nope/tree/main`)).status).toBe(404);
    expect((await get(`/projects/greg/nope/refs`)).status).toBe(404);

    repos.commit(origin, { files: { a: "1" } });
    await post(`${base}/tasks`, { title: "Work" });
    for (const ref of ["feature", "HEAD", "t1a9", "t9a1", "t1", "0".repeat(40)]) {
      const res = await get(`${base}/tree/${ref}`);
      expect(res.status, ref).toBe(404);
      expect(res.body).toEqual(notFound);
    }
  });

  it("reads a closed attempt's fork until it is archived", async () => {
    const { repos, get, post, id, origin, base } = await setup();
    repos.commit(origin, { files: { a: "1" } });
    await post(`${base}/tasks`, { title: "Work" });
    await post(`${base}/tasks/t1/attempts`);
    const work = repos.commit(`${id}-t1a1`, { files: { a: "2" } });
    // A failed archive keeps the fork and records nothing.
    repos.copyRef = async () => {
      throw new Error("archive failed");
    };
    await post(`${base}/attempts/t1a1/close`);
    expect((await get(`${base}/tree/t1a1`)).body).toMatchObject({ sha: work.hash });
    await repos.delete(`${id}-t1a1`);
    expect((await get(`${base}/tree/t1a1`)).status).toBe(404);
  });
});

describe("GET /refs", () => {
  it("lists main, active attempts and archived attempts with their heads", async () => {
    const { repos, backends, get, post, id, origin, base } = await setup();
    expect((await get(`${base}/refs`)).body).toEqual({ main: { ref: "main", sha: null }, active: [], archived: [] });

    const main = repos.commit(origin, { files: { a: "1" } });
    await post(`${base}/tasks`, { title: "One" });
    await post(`${base}/tasks/t1/attempts`, { count: 2 });
    await post(`${base}/tasks`, { title: "Two" });
    await post(`${base}/tasks/t2/attempts`, { count: 2 });
    const a1 = repos.commit(`${id}-t1a1`, { files: { a: "t1a1" } });
    const a2 = repos.commit(`${id}-t1a2`, { files: { a: "t1a2" } });
    await post(`${base}/attempts/t1a2/close`);
    backends.sql(id).exec("UPDATE attempts SET archived_sha = ? WHERE task = 1 AND number = 2", a2.hash);
    await post(`${base}/attempts/t2a1/open`);
    await post(`${base}/attempts/t2a2/obsolete`);

    const res = await get(`${base}/refs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(REF_CACHE);
    expect(res.body).toEqual({
      main: { ref: "main", sha: main.hash },
      active: [
        { ref: "t1a1", state: "draft", sha: a1.hash },
        { ref: "t2a1", state: "open", sha: main.hash },
      ],
      archived: [{ ref: "t1a2", state: "closed", sha: a2.hash }],
    });
  });
});

describe("GET /tree", () => {
  it("lists a directory, folders first, at the root and below", async () => {
    const { repos, get, origin, base } = await setup();
    const head = repos.commit(origin, {
      files: {
        "zeta.md": "z",
        "Alpha.md": "a",
        "src/index.ts": "x",
        "docs/guide.md": "g",
        "run.sh": { content: "#!/bin/sh\n", type: "exec" },
        link: { content: "zeta.md", type: "symlink" },
      },
    });

    const root = await get(`${base}/tree/main`);
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ ref: "main", sha: head.hash, path: "" });
    expect(root.body!["entries"].map((e: Json) => [e.name, e.type])).toEqual([
      ["docs", "tree"],
      ["src", "tree"],
      ["Alpha.md", "blob"],
      ["link", "symlink"],
      ["run.sh", "exec"],
      ["zeta.md", "blob"],
    ]);
    expect(root.body!["entries"][0]).toEqual({
      name: "docs",
      path: "docs",
      type: "tree",
      mode: "40000",
      hash: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });

    const src = await get(`${base}/tree/main/src`);
    expect(src.body).toMatchObject({
      path: "src",
      entries: [{ name: "index.ts", path: "src/index.ts", mode: "100644" }],
    });
    expect((await get(`${base}/tree/main/src/`)).body).toMatchObject({ path: "src" });
  });

  it("handles paths with spaces and unicode", async () => {
    const { repos, get, origin, base } = await setup();
    repos.commit(origin, { files: { "my docs/héllo wörld/日本.md": "こんにちは\n" } });
    const dir = await get(`${base}/tree/main/${encodeURI("my docs/héllo wörld")}`);
    expect(dir.status).toBe(200);
    expect(dir.body!["entries"]).toEqual([
      expect.objectContaining({ name: "日本.md", path: "my docs/héllo wörld/日本.md" }),
    ]);
    const file = await get(`${base}/blob/main/${encodeURIComponent("my docs/héllo wörld/日本.md")}`);
    expect(file.body).toMatchObject({ path: "my docs/héllo wörld/日本.md", content: "こんにちは\n" });
  });

  it("is a 404 for a missing path or a file", async () => {
    const { repos, get, origin, base } = await setup();
    repos.commit(origin, { files: { "src/a.ts": "a" } });
    for (const path of ["nope", "src/nope", "src/a.ts", "src/a.ts/deeper"]) {
      expect((await get(`${base}/tree/main/${path}`)).status, path).toBe(404);
    }
  });
});

describe("GET /blob and /raw", () => {
  it("returns text with its metadata", async () => {
    const { repos, get, origin, base } = await setup();
    const head = repos.commit(origin, { files: { "src/a.ts": "export const a = 1;\n" } });
    const res = await get(`${base}/blob/main/src/a.ts`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ref: "main",
      sha: head.hash,
      name: "a.ts",
      path: "src/a.ts",
      type: "blob",
      mode: "100644",
      hash: expect.stringMatching(/^[0-9a-f]{40}$/u),
      size: 20,
      binary: false,
      tooLarge: false,
      content: "export const a = 1;\n",
    });
  });

  it("flags binary and too-large files without content", async () => {
    const { repos, get, origin, base } = await setup();
    const lateNul = new Uint8Array(9000).fill(0x61);
    lateNul[8500] = 0;
    repos.commit(origin, {
      files: {
        "logo.png": PNG,
        "late-nul.txt": lateNul,
        "big.txt": "x".repeat(MAX_TEXT_BYTES + 1),
        "edge.txt": "y".repeat(MAX_TEXT_BYTES),
      },
    });
    expect((await get(`${base}/blob/main/logo.png`)).body).toMatchObject({
      size: PNG.length,
      binary: true,
      tooLarge: false,
      content: null,
    });
    expect((await get(`${base}/blob/main/late-nul.txt`)).body).toMatchObject({ binary: false, size: 9000 });
    expect((await get(`${base}/blob/main/big.txt`)).body).toMatchObject({
      size: MAX_TEXT_BYTES + 1,
      binary: false,
      tooLarge: true,
      content: null,
    });
    expect((await get(`${base}/blob/main/edge.txt`)).body).toMatchObject({ tooLarge: false, size: MAX_TEXT_BYTES });
  });

  it("is a 404 for a directory or a missing file", async () => {
    const { repos, get, origin, base } = await setup();
    repos.commit(origin, { files: { "src/a.ts": "a" } });
    for (const path of ["src", "src/b.ts", "nope/a.ts"]) {
      expect((await get(`${base}/blob/main/${path}`)).status, path).toBe(404);
      expect((await get(`${base}/raw/main/${path}`)).status, path).toBe(404);
    }
  });

  it("serves raw bytes typed by extension, never as a page", async () => {
    const { repos, get, origin, base } = await setup();
    const head = repos.commit(origin, {
      files: { "img/logo.png": PNG, "index.html": "<script>alert(1)</script>", "data.bin": PNG, "a b.txt": "hi" },
    });
    const png = await get(`${base}/raw/main/img/logo.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await png.res.arrayBuffer())).toEqual(PNG);
    expect(png.headers.get("ETag")).toBe(`"${head.hash}"`);
    expect(png.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(png.headers.get("Content-Security-Policy")).toContain("sandbox");

    const html = await get(`${base}/raw/main/index.html`);
    expect(html.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await html.res.text()).toBe("<script>alert(1)</script>");
    expect((await get(`${base}/raw/main/data.bin`)).headers.get("Content-Type")).toBe("application/octet-stream");
    const spaced = await get(`${base}/raw/main/a%20b.txt`);
    expect(await spaced.res.text()).toBe("hi");
    expect(spaced.headers.get("Content-Disposition")).toBe("inline; filename*=UTF-8''a%20b.txt");
  });
});

describe("GET /commits and /commit", () => {
  it("pages first-parent history, 50 by default and at most 100", async () => {
    const { repos, get, origin, base } = await setup();
    const shas: string[] = [];
    for (let i = 0; i < 120; i++) shas.unshift(repos.commit(origin, { files: { n: String(i) } }).hash);

    const first = await get(`${base}/commits/main`);
    expect(first.body).toMatchObject({ ref: "main", sha: shas[0], offset: 0, limit: 50, next: 50 });
    expect(first.body!["commits"].map((c: Json) => c.sha)).toEqual(shas.slice(0, 50));

    const last = await get(`${base}/commits/main?offset=100&limit=100`);
    expect(last.body).toMatchObject({ offset: 100, limit: 100, next: null });
    expect(last.body!["commits"].map((c: Json) => c.sha)).toEqual(shas.slice(100));

    const exact = await get(`${base}/commits/main?offset=20&limit=100`);
    expect(exact.body).toMatchObject({ next: null });
    expect(exact.body!["commits"]).toHaveLength(100);

    for (const query of ["limit=101", "limit=0", "offset=-1", "limit=abc"]) {
      expect((await get(`${base}/commits/main?${query}`)).status, query).toBe(400);
    }
  });

  it("follows first parents only", async () => {
    const { repos, get, origin, base } = await setup();
    const root = repos.commit(origin, { files: { a: "1" } });
    const side = repos.commit(origin, { files: { a: "side" }, branch: "side", parents: [root.hash] });
    const merge = repos.commit(origin, { files: { a: "merged" }, parents: [root.hash, side.hash] });
    const res = await get(`${base}/commits/main`);
    expect(res.body!["commits"].map((c: Json) => c.sha)).toEqual([merge.hash, root.hash]);
  });

  it("returns a commit's message, people, dates, parents and tree", async () => {
    const { repos, get, origin, base } = await setup();
    const root = repos.commit(origin, { files: { a: "1" } });
    const head = repos.commit(origin, {
      files: { a: "2" },
      message: "Fix it\n\nLonger body.",
      author: { name: "Bob", email: "bob@example.com" },
    });
    const res = await get(`${base}/commit/${head.hash}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sha: head.hash,
      tree: head.treeHash,
      parents: [root.hash],
      message: "Fix it\n\nLonger body.",
      author: { name: "Bob", email: "bob@example.com", date: new Date(head.authoredAt * 1000).toISOString() },
      committer: { name: "Bob", email: "bob@example.com", date: new Date(head.committedAt * 1000).toISOString() },
    });
    expect((await get(`${base}/commit/${root.hash}`)).body).toMatchObject({ parents: [] });
    expect((await get(`${base}/commit/abc123`)).status).toBe(400);
    expect((await get(`${base}/commit/${head.treeHash}`)).status).toBe(404);
  });
});

describe("GET /commit/{sha}/diff", () => {
  it("answers the commit's diff as JSON, with totals", async () => {
    const { repos, get, origin, base } = await setup();
    const root = repos.commit(origin, { files: { "a.txt": "1\n", "b.txt": "b\n" } });
    const head = repos.commit(origin, { files: { "a.txt": "2\n", "c.txt": "c\n" } });
    const res = await get(`${base}/commit/${head.hash}/diff`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sha: head.hash,
      parent: root.hash,
      truncated: false,
      totals: { files: 3, additions: 2, deletions: 2 },
    });
    const files = res.body!["files"] as Json[];
    expect(files.map((f) => [f["path"], f["status"]])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "deleted"],
      ["c.txt", "added"],
    ]);
    expect(files[0]!["patch"]).toContain("@@ -1 +1 @@\n-1\n+2\n");
  });

  it("answers the concatenated unified patch for Accept: text/x-diff", async () => {
    const { repos, get, origin, base } = await setup();
    repos.commit(origin, { files: { "a.txt": "1\n" } });
    const head = repos.commit(origin, { files: { "a.txt": "2\n", "c.txt": "c\n" } });
    const res = await get(`${base}/commit/${head.hash}/diff`, { Accept: "text/x-diff" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/x-diff; charset=utf-8");
    const text = await res.res.text();
    expect(text.startsWith("diff --git a/a.txt b/a.txt\n")).toBeTruthy();
    expect(text).toContain("diff --git a/c.txt b/c.txt\nnew file mode 100644\n");
  });

  it("is immutable, finds attempt commits by ?attempt=, and 404s an unknown sha", async () => {
    const { repos, get, post, id, origin, base } = await setup();
    const head = repos.commit(origin, { files: { "a.txt": "a" } });
    const res = await get(`${base}/commit/${head.hash}/diff`);
    expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(res.headers.get("ETag")).toBe(`"${head.hash}"`);

    await post(`${base}/tasks`, { title: "Work" });
    await post(`${base}/tasks/t1/attempts`, { count: 1 });
    const work = repos.commit(`${id}-t1a1`, { files: { "a.txt": "b" } });
    expect((await get(`${base}/commit/${work.hash}/diff`)).status).toBe(404);
    const found = await get(`${base}/commit/${work.hash}/diff?attempt=t1a1`);
    expect(found.body).toMatchObject({ sha: work.hash, parent: head.hash, totals: { files: 1 } });
    expect((await get(`${base}/commit/${head.treeHash}/diff`)).status).toBe(404);
  });

  it("serves a repeated diff from the diff cache", async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (key: Request) => store.get(key.url)?.clone(),
      put: async (key: Request, res: Response) => void store.set(key.url, res.clone()),
    };
    const { repos, get, origin, base } = await setup({ diffCache: () => cache });
    repos.commit(origin, { files: { "a.txt": "1\n" } });
    const head = repos.commit(origin, { files: { "a.txt": "2\n" } });
    const first = await get(`${base}/commit/${head.hash}/diff`);
    expect(first.status).toBe(200);
    const reads = repos.calls.length;
    expect((await get(`${base}/commit/${head.hash}/diff`)).body).toEqual(first.body);
    expect(repos.calls.slice(reads).map((c) => c.method)).not.toContain("readBlob");
    expect(store.size).toBe(1);
  });
});

describe("caching", () => {
  it("marks sha-addressed responses immutable", async () => {
    const { repos, get, origin, base } = await setup();
    const head = repos.commit(origin, { files: { "a.txt": "a" } });
    for (const path of [
      `/commit/${head.hash}`,
      `/commit/${head.hash}/diff`,
      `/tree/${head.hash}`,
      `/blob/${head.hash}/a.txt`,
      `/raw/${head.hash}/a.txt`,
      `/commits/${head.hash}`,
    ]) {
      const res = await get(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toBe(IMMUTABLE);
      expect(res.headers.get("ETag"), path).toBe(`"${head.hash}"`);
    }
  });

  it("gives ref-addressed responses a short max-age and the sha as ETag, and honours If-None-Match", async () => {
    const { repos, get, origin, base } = await setup();
    const first = repos.commit(origin, { files: { "a.txt": "a" } });
    const res = await get(`${base}/blob/main/a.txt`);
    expect(res.headers.get("Cache-Control")).toBe(REF_CACHE);
    expect(res.headers.get("ETag")).toBe(`"${first.hash}"`);

    const reads = repos.calls.length;
    const cached = await get(`${base}/blob/main/a.txt`, { "If-None-Match": `"${first.hash}"` });
    expect(cached.status).toBe(304);
    expect(await cached.res.text()).toBe("");
    expect(repos.calls.slice(reads).map((c) => c.method)).toEqual(["listCommits"]);

    const second = repos.commit(origin, { files: { "a.txt": "b" } });
    const changed = await get(`${base}/blob/main/a.txt`, { "If-None-Match": `"${first.hash}"` });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).toBe(`"${second.hash}"`);
    expect(changed.body).toMatchObject({ content: "b" });
  });

  it("never caches errors as immutable", async () => {
    const { repos, get, origin, base } = await setup();
    const head = repos.commit(origin, { files: { "a.txt": "a" } });
    const res = await get(`${base}/blob/${head.hash}/missing.txt`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toContain("immutable");
  });
});

describe("auth", () => {
  it("requires a bearer token; an Access session alone isn't enough", async () => {
    const { repos, request, origin, base } = await setup();
    repos.commit(origin, { files: { a: "1" } });
    expect((await request(`${base}/refs`)).status).toBe(401);
    expect((await request(`${base}/tree/main`, { "Cf-Access-Jwt-Assertion": "as:ada@example.com" })).status).toBe(401);
  });

  it("takes throng-web's forwarded identity over the service binding", async () => {
    const { repos, options, env, origin, base } = await setup();
    repos.commit(origin, { files: { a: "1" } });
    const web = webApp(options);
    const res = await web.request(
      `/api${base}/tree/main`,
      { headers: { [FORWARDED_EMAIL_HEADER]: "ada@example.com" } },
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("the OpenAPI document", () => {
  it("documents the read routes with plain path parameters", async () => {
    const { request } = await setup();
    const doc = (await (await request("/openapi.json")).json()) as Json;
    const paths = doc["paths"] as Json;
    const browse = Object.keys(paths).filter((p) => /\/(refs|tree|blob|raw|commits?)(\/|$)/u.test(p));
    expect(browse.toSorted()).toEqual([
      "/projects/{owner}/{project}/blob/{ref}/{path}",
      "/projects/{owner}/{project}/commit/{sha}",
      "/projects/{owner}/{project}/commit/{sha}/diff",
      "/projects/{owner}/{project}/commits/{ref}",
      "/projects/{owner}/{project}/raw/{ref}/{path}",
      "/projects/{owner}/{project}/refs",
      "/projects/{owner}/{project}/tree/{ref}",
      "/projects/{owner}/{project}/tree/{ref}/{path}",
    ]);
    const blob = paths["/projects/{owner}/{project}/blob/{ref}/{path}"]["get"];
    expect(blob).toMatchObject({ operationId: "getBlob", tags: ["Browse"] });
    expect(blob["parameters"].map((p: Json) => p["name"])).toEqual(
      expect.arrayContaining(["owner", "project", "ref", "path", "attempt"]),
    );
  });
});
