import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import { projectService, resolveProject } from "../src/projects.ts";
import type { Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";

async function setup(newId?: () => string) {
  const db = testDatabase();
  const repos = new FakeRepos();
  const greg: Actor = { user: await userForEmail(db, "greg@example.com"), alias: null };
  const ada: Actor = { user: await userForEmail(db, "ada@example.com"), alias: "claude" };
  const service = projectService({ db, repos, ...(newId === undefined ? {} : { newId }) });
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
