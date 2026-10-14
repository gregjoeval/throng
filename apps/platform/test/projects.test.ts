import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import { projectService, resolveProject } from "../src/projects.ts";
import type { Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { FakeBucket } from "./support/object-bucket.ts";

async function setup(newId?: () => string) {
  const db = testDatabase();
  const repos = new FakeRepos();
  const greg: Actor = { user: await userForEmail(db, "greg@example.com"), alias: null };
  const ada: Actor = { user: await userForEmail(db, "ada@example.com"), alias: "claude" };
  const service = projectService({
    db,
    repos,
    fetch: repos.sourceFetch,
    ...(newId === undefined ? {} : { newId }),
  });
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>())?.n;
  return { db, repos, greg, ada, service, count };
}

/** Ids from a fixed list, in order. */
function ids(...list: string[]): () => string {
  return () => {
    const next = list.shift();
    if (next === undefined) throw new Error("out of ids");
    return next;
  };
}

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const err = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

describe("projectService.create", () => {
  it("makes the caller's user the owner and creates the origin with main as default branch", async () => {
    const { repos, ada, service } = await setup();
    const project = await service.create(ada, { handle: "throng" });
    expect(project).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{6}$/u),
      handle: "throng",
      owner: { id: ada.user.id, handle: "ada" },
      source: null,
      createdAt: expect.any(String),
    });
    expect(repos.calls).toEqual([{ method: "create", args: [`${project.id}-main`, { defaultBranch: "main" }] }]);
    expect(await repos.get(`${project.id}-main`)).toMatchObject({ defaultBranch: "main", parent: null });
  });

  it("rejects a handle the owner already uses, without creating a repo", async () => {
    const { repos, greg, service, count } = await setup();
    await service.create(greg, { handle: "throng" });
    const err = await failure(service.create(greg, { handle: "throng" }));
    expect(err.code).toBe("conflict");
    expect(repos.calls.filter((c) => c.method === "create")).toHaveLength(1);
    expect(await count()).toBe(1);
  });

  it("lets different owners use the same handle", async () => {
    const { greg, ada, service } = await setup();
    const a = await service.create(greg, { handle: "throng" });
    const b = await service.create(ada, { handle: "throng" });
    expect(a.id).not.toBe(b.id);
  });

  it("rejects invalid handles", async () => {
    const { greg, service } = await setup();
    for (const handle of ["", "Throng", "a--b", "-a", "a-", "a.git", "a/b", "x".repeat(41)]) {
      expect((await failure(service.create(greg, { handle }))).code, handle).toBe("invalidRequest");
    }
  });

  it("draws another id when one is taken by a project or a repo", async () => {
    const { repos, greg, service } = await setup(ids("aaaaaa", "aaaaaa", "bbbbbb", "cccccc"));
    expect((await service.create(greg, { handle: "one" })).id).toBe("aaaaaa");
    await repos.create("bbbbbb-main");
    expect((await service.create(greg, { handle: "two" })).id).toBe("cccccc");
  });

  it("never draws a deleted project's id again", async () => {
    const { db, repos, greg } = await setup();
    const storage = { logs: new FakeBucket(), caches: new FakeBucket(), destroy: async () => {} };
    const first = projectService({ db, repos, storage, newId: ids("aaaaaa") });
    await first.create(greg, { handle: "throng" });
    await first.delete(greg, { owner: "greg", project: "throng" });

    const again = await projectService({ db, repos, newId: ids("aaaaaa", "bbbbbb") }).create(greg, {
      handle: "throng",
    });

    expect(again.id).toBe("bbbbbb");
  });

  it("leaves no project row when creating the repo fails", async () => {
    const { repos, greg, service, count } = await setup();
    repos.create = async () => {
      throw new Error("artifacts unavailable");
    };
    await expect(service.create(greg, { handle: "throng" })).rejects.toThrow("artifacts unavailable");
    expect(await count()).toBe(0);
  });

  it("deletes the new repo when the row can't be inserted", async () => {
    const { db, repos, greg, service } = await setup(ids("aaaaaa"));
    // Another request takes the handle after the duplicate check, as in a race.
    const create = repos.create.bind(repos);
    repos.create = async (name, opts) => {
      const repo = await create(name, opts);
      await db
        .prepare("INSERT INTO projects (id, owner_id, handle) VALUES (?, ?, ?)")
        .bind("zzzzzz", greg.user.id, "throng")
        .first();
      return repo;
    };
    expect((await failure(service.create(greg, { handle: "throng" }))).code).toBe("conflict");
    expect(await repos.list("aaaaaa")).toEqual([]);
  });
});

const SOURCE = "https://github.com/octocat/Hello-World";

/** A public source at `SOURCE` with two commits on `head`, served by `repos`; returns its head commit. */
function serve(repos: FakeRepos, head: string) {
  repos.commit("upstream", { branch: head, files: { README: "Hello\n" } });
  const tip = repos.commit("upstream", { branch: head, files: { README: "Hello World!\n" } });
  repos.serveSource(SOURCE, "upstream", head);
  return tip;
}

/** Artifacts refusing the import, as it does a source over its memory limit. */
function failImport(repos: FakeRepos): void {
  repos.import = async () => {
    throw Object.assign(new Error("MEMORY_LIMIT"), { name: "ArtifactsError", code: "MEMORY_LIMIT" });
  };
}

/** The copy from the staging repo to the origin's `main` failing. */
function failCopy(repos: FakeRepos): void {
  repos.copyRef = async () => {
    throw new Error("receive-pack refused");
  };
}

async function importSetup(head: string) {
  const context = await setup(ids("aaaaaa"));
  await context.repos.create("upstream");
  const tip = serve(context.repos, head);
  context.repos.calls.length = 0;
  return { ...context, tip };
}

describe("projectService.create with a source", () => {
  it("imports a source whose default branch is main straight into the origin", async () => {
    const { repos, greg, service, tip } = await importSetup("main");
    const project = await service.create(greg, { handle: "hello", source: { url: SOURCE } });
    expect(project).toMatchObject({ id: "aaaaaa", handle: "hello", source: SOURCE });
    expect(repos.calls.map((c) => [c.method, ...c.args])).toEqual([
      ["import", "aaaaaa-main", { url: SOURCE, branch: "main" }],
    ]);
    expect(repos.ref("aaaaaa-main", "refs/heads/main")).toBe(tip.hash);
  });

  it("copies another default branch to main through a staging repo, with its history, and leaves no staging repo", async () => {
    const { repos, greg, service, tip } = await importSetup("master");
    const project = await service.create(greg, { handle: "hello", source: { url: SOURCE } });
    expect(project.source).toBe(SOURCE);
    expect(repos.ref("aaaaaa-main", "refs/heads/main")).toBe(tip.hash);
    expect(await repos.get("aaaaaa-main")).toMatchObject({ defaultBranch: "main" });
    const history = await repos.listCommits("aaaaaa-main", { ref: "main", limit: 10 });
    expect(history.map((c) => c.message)).toHaveLength(2);
    expect(await repos.list("aaaaaa")).toEqual(["aaaaaa-main"]);
    expect(repos.calls.filter((c) => c.method === "import")).toEqual([
      { method: "import", args: ["aaaaaa-import", { url: SOURCE, branch: "master" }] },
    ]);
  });

  it("imports and keeps the source URL normalized, not as typed", async () => {
    const { repos, greg, service } = await importSetup("main");
    const project = await service.create(greg, {
      handle: "hello",
      source: { url: "HTTPS://GitHub.com:443/octocat/Hello-World" },
    });
    expect(project.source).toBe(SOURCE);
    expect(repos.calls.filter((c) => c.method === "import")).toEqual([
      { method: "import", args: ["aaaaaa-main", { url: SOURCE, branch: "main" }] },
    ]);
  });

  it("imports and keeps the URL a same-host redirect ends at", async () => {
    const { db, repos, greg, tip } = await importSetup("main");
    const moved = `${SOURCE}.git`;
    repos.serveSource(moved, "upstream", "main");
    const fetch: typeof globalThis.fetch = async (input, init) =>
      String(input).startsWith("https://github.com/octocat/Old")
        ? new Response(null, { status: 301, headers: { Location: `${moved}/info/refs?service=git-upload-pack` } })
        : repos.sourceFetch(input, init);
    const service = projectService({ db, repos, fetch, newId: ids("aaaaaa") });
    const project = await service.create(greg, { handle: "hello", source: { url: "https://github.com/octocat/Old" } });
    expect(project.source).toBe(moved);
    expect(repos.calls.filter((c) => c.method === "import")).toEqual([
      { method: "import", args: ["aaaaaa-main", { url: moved, branch: "main" }] },
    ]);
    expect(repos.ref("aaaaaa-main", "refs/heads/main")).toBe(tip.hash);
  });

  it("deletes a staging repo left over under the drawn id instead of drawing another", async () => {
    const { repos, greg, service, tip } = await importSetup("master");
    await repos.create("aaaaaa-import");
    const project = await service.create(greg, { handle: "hello", source: { url: SOURCE } });
    expect(project.id).toBe("aaaaaa");
    expect(repos.ref("aaaaaa-main", "refs/heads/main")).toBe(tip.hash);
    expect(await repos.list("aaaaaa")).toEqual(["aaaaaa-main"]);
  });

  it("reads the source back with the project", async () => {
    const { db, greg, ada, service } = await importSetup("main");
    const created = await service.create(greg, { handle: "hello", source: { url: SOURCE } });
    expect(await service.get(ada, { owner: "greg", project: "hello" })).toEqual(created);
    expect(await resolveProject(db, "greg", "hello")).toEqual(created);
    expect(await service.list(greg)).toEqual([created]);
  });

  it("refuses a source URL that isn't one before creating anything", async () => {
    const { repos, greg, service, count } = await importSetup("main");
    const err = await failure(service.create(greg, { handle: "hello", source: { url: "http://github.com/o/r" } }));
    expect(err.code).toBe("invalidRequest");
    expect(repos.calls).toEqual([]);
    expect(await count()).toBe(0);
  });

  it("fails a taken handle before any import starts", async () => {
    const { repos, greg, service } = await importSetup("master");
    await service.create(greg, { handle: "hello" });
    repos.calls.length = 0;
    const err = await failure(service.create(greg, { handle: "hello", source: { url: SOURCE } }));
    expect(err.code).toBe("conflict");
    expect(repos.calls).toEqual([]);
  });

  it("is notFound, with nothing created, when the source is private or missing", async () => {
    const { repos, greg, service, count } = await importSetup("main");
    const url = "https://github.com/octocat/private";
    const err = await failure(service.create(greg, { handle: "hello", source: { url } }));
    expect(err.code).toBe("notFound");
    expect(err.message).toContain("only public repositories can be imported");
    expect(repos.calls).toEqual([]);
    expect(await count()).toBe(0);
  });

  it.each([
    ["the import", "main", failImport],
    ["the import", "master", failImport],
    ["the copy to main", "master", failCopy],
  ])("leaves no project row, origin or staging repo when %s of a %s source fails", async (_step, head, breakIt) => {
    const { repos, greg, service, count } = await importSetup(head);
    breakIt(repos);
    await expect(service.create(greg, { handle: "hello", source: { url: SOURCE } })).rejects.toThrow();
    expect(await count()).toBe(0);
    expect(await repos.list("aaaaaa")).toEqual([]);
  });

  it("draws another id when an import's origin name is taken by a repo", async () => {
    const { repos, greg, service } = await setup(ids("aaaaaa", "bbbbbb"));
    await repos.create("upstream");
    serve(repos, "main");
    await repos.create("aaaaaa-main");
    expect((await service.create(greg, { handle: "hello", source: { url: SOURCE } })).id).toBe("bbbbbb");
  });

  it("says what to fix when Artifacts refuses the import", async () => {
    const { repos, greg, service } = await importSetup("master");
    failImport(repos);
    const err = await failure(service.create(greg, { handle: "hello", source: { url: SOURCE } }));
    expect(err.code).toBe("invalidRequest");
    expect(err.message).toContain("too large to import");
  });

  it("deletes the imported origin when the row can't be inserted", async () => {
    const { db, repos, greg, service, count } = await importSetup("master");
    // Another request takes the handle after the duplicate check, as in a race.
    const copyRef = repos.copyRef.bind(repos);
    repos.copyRef = async (args) => {
      const copied = await copyRef(args);
      await db
        .prepare("INSERT INTO projects (id, owner_id, handle) VALUES (?, ?, ?)")
        .bind("zzzzzz", greg.user.id, "hello")
        .first();
      return copied;
    };
    expect((await failure(service.create(greg, { handle: "hello", source: { url: SOURCE } }))).code).toBe("conflict");
    expect(await count()).toBe(1);
    expect(await repos.list("aaaaaa")).toEqual([]);
  });

  it("still creates the project when deleting the staging repo fails, and logs the orphan", async () => {
    const { repos, greg, service, tip } = await importSetup("master");
    const remove = repos.delete.bind(repos);
    repos.delete = async (name) => {
      if (name === "aaaaaa-import") throw new Error("artifacts unavailable");
      return remove(name);
    };
    const project = await service.create(greg, { handle: "hello", source: { url: SOURCE } });
    expect(project.source).toBe(SOURCE);
    expect(repos.ref("aaaaaa-main", "refs/heads/main")).toBe(tip.hash);
  });
});

describe("projectService.get and resolveProject", () => {
  it("resolves owner and project handles to the project", async () => {
    const { db, greg, ada, service } = await setup();
    const created = await service.create(greg, { handle: "throng" });
    expect(await resolveProject(db, "greg", "throng")).toEqual(created);
    expect(await service.get(ada, { owner: "greg", project: "throng" })).toEqual(created);
  });

  it("is not found for an unknown owner or project", async () => {
    const { db, greg, service } = await setup();
    await service.create(greg, { handle: "throng" });
    for (const [owner, project] of [
      ["nobody", "throng"],
      ["greg", "nothing"],
      ["ada", "throng"],
    ] as const) {
      expect(await resolveProject(db, owner, project)).toBeNull();
      expect((await failure(service.get(greg, { owner, project }))).code).toBe("notFound");
    }
  });
});
