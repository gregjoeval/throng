// Vote selection through the API: a task's selection policy override, opening a vote, casting
// ballots, adding a candidate and closing the vote, and the open vote in the task's arena.

import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { CONFIG_PATH } from "../src/config.ts";
import type { FollowParams } from "../src/follows.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { at } from "./support/defined.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

const now = () => new Date("2026-10-10T12:00:00.000Z");

/**
 * greg's project, whose config selects by `selection`, with ada's task t1 and bob's open attempts
 * t1a1 and t1a2, both pushed and passing.
 */
async function setup(selection = "selection: { policy: vote }\n") {
  const repos = new FakeRepos();
  const follows: FollowParams[] = [];
  const { backend, store } = testTaskBackends(
    repos,
    now,
    {
      workflow: { create: async () => ({}), get: async () => ({ terminate: async () => {} }) },
      teardown: async () => {},
    },
    undefined,
    {
      workflow: {
        create: async ({ params }) => {
          follows.push(params);
          return {};
        },
      },
    },
  );
  const api = apiRoutes({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    tasks: () => backend,
    trustForwardedIdentity: true,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  /** Calls as a bearer token, or as a web user by `{ web: email }`. */
  const call = async (method: string, path: string, as: string | { web: string }, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (typeof as === "string") headers["Authorization"] = `Bearer ${as}`;
    else headers[FORWARDED_EMAIL_HEADER] = as.web;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await api.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { [FORWARDED_EMAIL_HEADER]: email, "Content-Type": "application/json" };
    const res = await api.request("/tokens", { method: "POST", headers, body: JSON.stringify({ alias }) }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  const greg = await tokenFor("greg@example.com");
  const ada = await tokenFor("ada@example.com");
  const bob = await tokenFor("bob@example.com");
  const cat = await tokenFor("cat@example.com");
  const catClaude = await tokenFor("cat@example.com", "claude");
  const projectId = (await call("POST", "/projects", greg, { handle: "throng" })).body["id"] as string;
  const origin = `${projectId}-main`;
  repos.commit(origin, { files: { "README.md": "hi\n" } });
  repos.writeFile(origin, "main", CONFIG_PATH, selection);
  const base = "/projects/greg/throng";
  const bobUser = (await call("GET", "/me", bob)).body["user"] as User;
  const tasks = store(projectId);

  await call("POST", `${base}/tasks`, ada, { title: "Fix it" });
  await call("POST", `${base}/tasks/t1/attempts`, bob, { count: 2 });
  const heads: string[] = [];
  for (const number of [1, 2]) {
    const fork = `${projectId}-t1a${number}`;
    const before = repos.ref(fork, "refs/heads/main") ?? "0".repeat(40);
    const after = repos.commit(fork, { files: { "README.md": `attempt ${number}\n` } }).hash;
    tasks.recordPush(
      { id: projectId, owner: "" },
      { user: bobUser, alias: null },
      { task: 1, number, updates: [{ ref: "refs/heads/main", before, after }] },
    );
    heads.push(after);
    await call("POST", `${base}/attempts/t1a${number}/open`, bob);
    await tasks.scoring.drain();
    const run = at(tasks.scoring.listRuns({ task: 1, attempt: number }), -1);
    tasks.scoringFinished(run.id, {
      status: "done",
      result: { base: null, config: { kind: "none" }, gate: "passed", checks: [], metrics: {}, logs: [] },
    });
  }
  /** ada pushes the task branch and t1a1's follow merges it, leaving the merge to be scored. */
  const followT1a1 = async () => {
    const project = { id: projectId, owner: "" };
    const taskHead = repos.commit(origin, { files: { "test.txt": "test\n" }, branch: "tasks-t1" }).hash;
    repos.setRef(origin, "refs/tasks/t1", taskHead);
    const adaUser = (await call("GET", "/me", ada)).body["user"] as User;
    tasks.recordTaskBranchPush(project, { user: adaUser, alias: null }, { task: 1, head: taskHead });
    await tasks.drain(projectId);
    const params = follows.findLast((p) => p.attempt === 1);
    if (params === undefined) throw new Error("no follow of t1a1");
    tasks.claimFollowPush(params.follow);
    const fork = `${projectId}-t1a1`;
    const before = repos.ref(fork, "refs/heads/main") ?? "";
    const merged = repos.commit(fork, { files: { "README.md": "merged\n" }, parents: [before, taskHead] }).hash;
    await tasks.followFinished(params.follow, { kind: "merged", before, head: merged });
  };
  return { call, base, greg, ada, bob, cat, catClaude, heads, followT1a1 };
}

describe("a task's selection policy", () => {
  it("is null until the task overrides the project's, and is set on create or edit", async () => {
    const { call, base, ada, greg } = await setup();
    expect((await call("GET", `${base}/tasks/t1`, ada)).body["selection"]).toBeNull();
    const created = await call("POST", `${base}/tasks`, greg, {
      title: "Pick one",
      selection: { policy: "vote", eligible: "humans" },
    });
    expect(created.body["selection"]).toEqual({ policy: "vote", eligible: "humans" });
    const edited = await call("PATCH", `${base}/tasks/t2`, greg, { selection: { policy: "vote" } });
    expect(edited.body["selection"]).toEqual({ policy: "vote", eligible: "anyone" });
    const cleared = await call("PATCH", `${base}/tasks/t2`, greg, { selection: null });
    expect(cleared.body["selection"]).toBeNull();
    for (const selection of [{ policy: "judge" }, { policy: "creator", eligible: "humans" }, { eligible: "humans" }]) {
      expect((await call("POST", `${base}/tasks`, ada, { title: "x", selection })).status).toBe(400);
    }
  });

  it("shows in the arena as the policy in effect", async () => {
    const { call, base, ada, greg } = await setup("selection: { policy: vote, eligible: aliases }\n");
    const arena = (await call("GET", `${base}/tasks/t1/arena`, ada)).body;
    expect(arena["selection"]).toEqual({ policy: "vote", eligible: "aliases" });
    expect(arena["vote"]).toBeNull();
    await call("PATCH", `${base}/tasks/t1`, greg, { selection: { policy: "creator" } });
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["selection"]).toEqual({ policy: "creator" });
  });

  it("is only the project owner's to set: a task's creator gets 403", async () => {
    const { call, base, ada } = await setup();
    const loose = { policy: "creator" };
    const created = await call("POST", `${base}/tasks`, ada, { title: "Mine", selection: loose });
    expect(created).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect((await call("PATCH", `${base}/tasks/t1`, ada, { selection: loose })).status).toBe(403);
    expect((await call("PATCH", `${base}/tasks/t1`, ada, { title: "Same policy", selection: null })).status).toBe(200);
  });

  it("can't change while the task has an open vote; its title still can", async () => {
    const { call, base, ada, greg } = await setup();
    await call("POST", `${base}/tasks/t1/vote/open`, ada, {});
    const refused = await call("PATCH", `${base}/tasks/t1`, greg, { selection: { policy: "creator" } });
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: "invalidState", message: "t1 has an open vote; close it first" } },
    });
    expect((await call("PATCH", `${base}/tasks/t1`, ada, { title: "Renamed" })).body["title"]).toBe("Renamed");
  });
});

describe("a vote", () => {
  it("opens, takes ballots and closes by selecting its winner", async () => {
    const { call, base, ada, bob, cat, catClaude, heads } = await setup();
    expect((await call("POST", `${base}/tasks/t1/vote/open`, bob, {})).status).toBe(403);
    const opened = await call("POST", `${base}/tasks/t1/vote/open`, ada, { deadline: "2026-10-11T12:00:00.000Z" });
    expect(opened).toEqual({
      status: 200,
      body: {
        task: "t1",
        state: "open",
        eligible: "anyone",
        deadline: "2026-10-11T12:00:00.000Z",
        openedBy: { id: expect.any(String), handle: "ada", alias: null },
        openedAt: "2026-10-10T12:00:00.000Z",
        closedBy: null,
        closedAt: null,
        winner: null,
        candidates: [
          {
            attempt: "t1a1",
            head: heads[0],
            addedAt: "2026-10-10T12:00:00.000Z",
            votes: 0,
            withdrawn: false,
            beingScored: false,
          },
          {
            attempt: "t1a2",
            head: heads[1],
            addedAt: "2026-10-10T12:00:00.000Z",
            votes: 0,
            withdrawn: false,
            beingScored: false,
          },
        ],
        myBallot: null,
      },
    });

    expect((await call("POST", `${base}/tasks/t1/vote`, bob, { attempt: "t1a1" })).status).toBe(403);
    expect((await call("POST", `${base}/tasks/t1/vote`, cat, { attempt: "t2a1" })).status).toBe(400);
    await call("POST", `${base}/tasks/t1/vote`, cat, { attempt: "t1a1" });
    const cast = await call("POST", `${base}/tasks/t1/vote`, catClaude, { attempt: "t1a2" });
    expect(cast.body["candidates"].map((c: Json) => c["votes"])).toEqual([0, 1]);
    expect(cast.body["myBallot"]).toEqual({
      attempt: "t1a2",
      head: heads[1],
      alias: "claude",
      at: "2026-10-10T12:00:00.000Z",
    });
    expect((await call("GET", `${base}/tasks/t1/vote`, { web: "cat@example.com" })).body).toEqual(cast.body);
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["vote"]).toMatchObject({ state: "open" });

    const closed = await call("POST", `${base}/tasks/t1/vote/close`, { web: "ada@example.com" }, {});
    expect(closed.status).toBe(200);
    expect(closed.body["vote"]).toMatchObject({ state: "closed", winner: "t1a2", closedBy: { handle: "ada" } });
    expect(closed.body["mergeRequest"]).toMatchObject({ task: "t1", attempt: "t1a2", approvedHead: heads[1] });
    expect((await call("GET", `${base}/tasks/t1/arena`, ada)).body["vote"]).toBeNull();
  });

  it("takes a candidate the creator adds, and a tie-break when closing", async () => {
    const { call, base, ada, cat } = await setup();
    await call("POST", `${base}/tasks/t1/vote/open`, ada, {});
    const added = await call("POST", `${base}/tasks/t1/vote/candidates`, ada, { attempt: "t1a1" });
    expect(added.body["error"]).toMatchObject({ code: "invalidState" });
    await call("POST", `${base}/tasks/t1/vote`, cat, { attempt: "t1a1" });
    await call("POST", `${base}/tasks/t1/vote`, ada, { attempt: "t1a2" });
    expect((await call("POST", `${base}/tasks/t1/vote/close`, ada, {})).status).toBe(400);
    const closed = await call("POST", `${base}/tasks/t1/vote/close`, ada, { attempt: "t1a1" });
    expect(closed.body["vote"]).toMatchObject({ winner: "t1a1" });
  });

  it("is 409 to close while a candidate a follow moved is being scored", async () => {
    const { call, base, ada, cat, followT1a1 } = await setup();
    await call("POST", `${base}/tasks/t1/vote/open`, ada, {});
    await call("POST", `${base}/tasks/t1/vote`, cat, { attempt: "t1a1" });
    await followT1a1();
    const vote = (await call("GET", `${base}/tasks/t1/vote`, ada)).body;
    expect(vote["candidates"][0]).toMatchObject({ attempt: "t1a1", withdrawn: true, beingScored: true });
    expect(await call("POST", `${base}/tasks/t1/vote/close`, ada, {})).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "invalidState",
          message: "t1's vote has candidates still being scored (t1a1); close it once scoring finishes",
        },
      },
    });
  });

  it("closes by nobody when its task closes", async () => {
    const { call, base, ada } = await setup();
    await call("POST", `${base}/tasks/t1/vote/open`, ada, {});
    await call("POST", `${base}/tasks/t1/close`, ada);
    const vote = (await call("GET", `${base}/tasks/t1/vote`, ada)).body;
    expect(vote).toMatchObject({ state: "closed", closedBy: null, winner: null });
  });

  it("is 404 before the task has one, and 409 to open under the creator's policy", async () => {
    const { call, base, ada } = await setup("");
    expect((await call("GET", `${base}/tasks/t1/vote`, ada)).status).toBe(404);
    expect((await call("POST", `${base}/tasks/t1/vote/open`, ada, {})).status).toBe(409);
  });
});
