// The project's caches through the task store, as a run's Workflow and the Durable Object use them:
// where each line's runs restore from and save to, which runs may save, and that eviction deletes
// entries' objects, including every entry of a task branch once its task ends.

import { describe, expect, it } from "vitest";
import type { CacheKey } from "../src/caches.ts";
import type { PipelineParams } from "../src/scoring.ts";
import { TaskStore } from "../src/task-store.ts";
import type { ProjectContext } from "../src/task-store.ts";
import type { Actor } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testSql } from "./support/task-backend.ts";

const PROJECT: ProjectContext = { id: "abc123", owner: "owner001" };
const owner: Actor = { user: { id: "owner001", handle: "owner", email: "o@example.com", created_at: "" }, alias: null };
const PNPM: CacheKey = { name: "pnpm", keyHash: "k1" };
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const repos = new FakeRepos();
  void repos.create("abc123-main", { defaultBranch: "main" });
  let now = Date.parse("2026-10-14T00:00:00.000Z");
  const deleted: string[] = [];
  const created: PipelineParams[] = [];
  const store = new TaskStore({
    sql: testSql(),
    repos,
    now: () => new Date(now),
    scoring: {
      workflow: {
        create: async ({ params }) => void created.push(params),
        get: async () => ({ terminate: async () => {} }),
      },
      teardown: async () => {},
    },
    cacheObjects: { delete: async (keys) => void deleted.push(...keys) },
  });
  let sha = 0;
  /** A running run on `line`, trusted or not. */
  const running = async (line: string, trusted = true): Promise<number> => {
    const request = store.scoring.request({
      project: PROJECT.id,
      line,
      sha: String(++sha).padStart(40, "0"),
      trigger: "push",
      actor: null,
      ownersPush: trusted,
    });
    await store.scoring.drain();
    return request.run.id;
  };
  /** A trusted run on `line` saves `key`'s entry, as its Workflow does. */
  const saved = async (line: string, key: CacheKey = PNPM) => {
    const run = await running(line);
    const [lookup] = store.pipelineCaches(run, [key]);
    if (lookup?.save === null || lookup === undefined) throw new Error(`${line} may not save`);
    const entry = { scope: lookup.save, ...key };
    expect(store.pipelineCacheSaving(run, entry)).toBeTruthy();
    expect(store.pipelineCacheSaved(run, { ...entry, size: 100 })).toBeTruthy();
    store.pipelineFinished(run, { status: "errored", error: "done with it" });
  };
  const later = (ms: number) => {
    now += ms;
  };
  return { store, running, saved, deleted, later };
}

describe("a run's caches", () => {
  it("on main: restores main's entry by exact key, and saves only on a miss", async () => {
    const t = setup();
    const run = await t.running("main");
    expect(t.store.pipelineCaches(run, [PNPM])).toEqual([{ ...PNPM, restore: null, save: "main" }]);
    t.store.pipelineFinished(run, { status: "errored", error: "x" });
    await t.saved("main");
    const next = await t.running("main");
    expect(t.store.pipelineCaches(next, [PNPM, { name: "pnpm", keyHash: "k2" }])).toEqual([
      { ...PNPM, restore: "main", save: null },
      { name: "pnpm", keyHash: "k2", restore: null, save: "main" },
    ]);
  });

  it("on an attempt: restores main's entry, never a task branch's, and never saves, trusted or not", async () => {
    const t = setup();
    await t.saved("t1");
    const attempt = await t.running("t1a1");
    expect(t.store.pipelineCaches(attempt, [PNPM])).toEqual([{ ...PNPM, restore: null, save: null }]);
    await t.saved("main");
    const next = await t.running("t1a2");
    expect(t.store.pipelineCaches(next, [PNPM])).toEqual([{ ...PNPM, restore: "main", save: null }]);
    expect(t.store.pipelineCacheSaving(next, { scope: "main", ...PNPM })).toBeFalsy();
    expect(t.store.pipelineCacheSaved(next, { scope: "main", ...PNPM, size: 1 })).toBeFalsy();
  });

  it("on a task branch: restores its own entry, then main's, and saves its own on a miss", async () => {
    const t = setup();
    await t.saved("main");
    const branch = await t.running("t1");
    expect(t.store.pipelineCaches(branch, [PNPM])).toEqual([{ ...PNPM, restore: "main", save: null }]);
    const other = { name: "pip", keyHash: "p1" };
    expect(t.store.pipelineCaches(branch, [other])).toEqual([{ ...other, restore: null, save: "t1" }]);
    t.store.pipelineFinished(branch, { status: "errored", error: "x" });
    await t.saved("t1", other);
    expect(t.store.pipelineCaches(await t.running("t1"), [other])).toEqual([{ ...other, restore: "t1", save: null }]);
    // main never reads a task branch's entry.
    expect(t.store.pipelineCaches(await t.running("main"), [other])).toEqual([
      { ...other, restore: null, save: "main" },
    ]);
  });

  it("saves only from a trusted running run, into its own line's scope, and never over an entry", async () => {
    const t = setup();
    const untrusted = await t.running("t1", false);
    expect(t.store.pipelineCaches(untrusted, [PNPM])).toEqual([
      { ...PNPM, restore: null, save: null, unsaved: "this run isn't trusted" },
    ]);
    expect(t.store.pipelineCacheSaving(untrusted, { scope: "t1", ...PNPM })).toBeFalsy();
    t.store.pipelineFinished(untrusted, { status: "errored", error: "x" });

    const trusted = await t.running("t1");
    expect(t.store.pipelineCacheSaving(trusted, { scope: "main", ...PNPM })).toBeFalsy();
    expect(t.store.pipelineCacheSaved(trusted, { scope: "t1", ...PNPM, size: 5 })).toBeTruthy();
    expect(t.store.pipelineCacheSaving(trusted, { scope: "t1", ...PNPM })).toBeFalsy();
    expect(t.store.pipelineCacheSaved(trusted, { scope: "t1", ...PNPM, size: 6 })).toBeFalsy();
    t.store.pipelineFinished(trusted, { status: "errored", error: "x" });
    // A run that ended saves nothing.
    expect(t.store.pipelineCacheSaving(trusted, { scope: "t1", name: "pip", keyHash: "p" })).toBeFalsy();
  });
});

describe("cache eviction", () => {
  it("deletes a task branch's entries when its task closes", async () => {
    const t = setup();
    const task = t.store.createTask(PROJECT, owner, { title: "Fix it" });
    await t.saved(`t${task.number}`);
    await t.saved("main");
    await t.store.closeTask(PROJECT, owner, { task: task.number });
    await t.store.drain(PROJECT.id);
    expect(t.deleted).toEqual([`caches/abc123/t${task.number}/pnpm/k1.tar.zst`]);
    expect(t.store.caches.list().map((e) => e.scope)).toEqual(["main"]);
  });

  it("deletes entries unused for 7 days, keeping main's latest", async () => {
    const t = setup();
    await t.saved("t1");
    await t.saved("main");
    t.later(1000);
    await t.saved("main", { name: "pnpm", keyHash: "k2" });
    t.later(7 * DAY);
    await t.store.evictCaches(PROJECT.id);
    expect(t.deleted.toSorted()).toEqual(["caches/abc123/main/pnpm/k1.tar.zst", "caches/abc123/t1/pnpm/k1.tar.zst"]);
    expect(t.store.caches.list().map((e) => [e.scope, e.keyHash])).toEqual([["main", "k2"]]);
  });
});
