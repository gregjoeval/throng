// Verdicts through the API: who may post one, replacing and superseding, the body limit, and the
// per-attempt summaries on the attempt and the arena.

import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "../src/access.ts";
import { apiRoutes } from "../src/api.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import type { User } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { testTaskBackends } from "./support/task-backend.ts";

/** Access sessions are `as:<email>`. */
const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);

let clock = new Date("2026-10-10T12:00:00.000Z");
const now = () => clock;

async function setup() {
  clock = new Date("2026-10-10T12:00:00.000Z");
  const repos = new FakeRepos();
  const { backend, store, sql } = testTaskBackends(repos, now);
  // Trusting throng-web's forwarded identity, as the service binding does.
  const api = apiRoutes({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    tasks: () => backend,
    trustForwardedIdentity: true,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };

  /** Calls as a bearer token, or as a web user by `{ web: email }`. */
  const call = async (method: string, path: string, as?: string | { web: string }, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (typeof as === "string") headers["Authorization"] = `Bearer ${as}`;
    if (typeof as === "object") headers[FORWARDED_EMAIL_HEADER] = as.web;
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
  const adaClaude = await tokenFor("ada@example.com", "claude");
  const bob = await tokenFor("bob@example.com");
  const bobClaude = await tokenFor("bob@example.com", "claude");
  const projectId = (await call("POST", "/projects", greg, { handle: "throng" })).body["id"] as string;
  repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n" } });
  const base = "/projects/greg/throng";
  const adaUser = (await call("GET", "/me", ada)).body["user"] as User;
  const bobUser = (await call("GET", "/me", bob)).body["user"] as User;

  // A task by ada with two draft attempts by ada.
  await call("POST", `${base}/tasks`, ada, { title: "Fix it" });
  await call("POST", `${base}/tasks/t1/attempts`, ada, { count: 2 });

  /** Pushes a new head to one of ada's attempts and records it, as the git proxy does once it lands. */
  const push = async (attempt: number, content: string) => {
    const fork = `${projectId}-t1a${attempt}`;
    const before = repos.ref(fork, "refs/heads/main") ?? "0".repeat(40);
    const after = repos.commit(fork, { files: { "README.md": content } }).hash;
    await store(projectId).recordPush(
      { id: projectId, owner: "" },
      { user: adaUser, alias: null },
      {
        task: 1,
        number: attempt,
        updates: [{ ref: "refs/heads/main", before, after }],
      },
    );
    return after;
  };
  const post = (as: string | { web: string }, body: unknown, attempt = "t1a1") =>
    call("POST", `${base}/attempts/${attempt}/verdicts`, as, body);
  const list = async (attempt = "t1a1") => (await call("GET", `${base}/attempts/${attempt}/verdicts`, ada)).body;
  const journal = () =>
    sql(projectId)
      .db.prepare("SELECT kind, user_id, alias, task, attempt, detail FROM journal WHERE kind = 'verdictPosted'")
      .all();

  /** Merges one of ada's attempts, as a landing would. */
  const merge = (attempt: number) =>
    store(projectId).markMerged({ id: projectId, owner: "" }, null, { task: 1, number: attempt, sha: "m".repeat(40) });

  return { call, base, greg, ada, adaClaude, bob, bobClaude, adaUser, bobUser, push, post, list, journal, merge };
}

describe("posting a verdict", () => {
  it("records another user's verdict on the current head, with the alias they acted under", async () => {
    const { post, list, push, bobClaude, bobUser, journal } = await setup();
    const head = await push(1, "one\n");
    const posted = await post(bobClaude, { recommendation: "revise", body: "Needs a **test**." });
    const verdict = {
      reviewer: { id: bobUser.id, handle: "bob" },
      alias: "claude",
      head,
      recommendation: "revise",
      body: "Needs a **test**.",
      at: "2026-10-10T12:00:00.000Z",
      superseded: false,
    };
    expect(posted).toEqual({ status: 201, body: verdict });
    expect(await list()).toEqual({ verdicts: [verdict] });
    expect(journal()).toEqual([
      {
        kind: "verdictPosted",
        user_id: bobUser.id,
        alias: "claude",
        task: 1,
        attempt: 1,
        detail: JSON.stringify({ ref: "t1a1", head, recommendation: "revise" }),
      },
    ]);
  });

  it("refuses the attempt's author and their aliases, and lets any other user or alias post", async () => {
    const { post, push, ada, adaClaude, bob, bobClaude, greg, list } = await setup();
    await push(1, "one\n");
    for (const author of [ada, adaClaude]) {
      const refused = await post(author, { recommendation: "merge", body: "Mine is great." });
      expect(refused.status).toBe(403);
      expect(refused.body["error"]).toEqual({
        code: "forbidden",
        message: "the author of t1a1 can't post a verdict on it",
      });
    }
    for (const other of [bob, bobClaude, greg]) {
      expect((await post(other, { recommendation: "merge", body: "LGTM" })).status).toBe(201);
    }
    // Bob and Bob's alias are one reviewer: the alias's verdict replaced Bob's.
    expect((await list())["verdicts"].map((v: Json) => [v["reviewer"]["handle"], v["alias"]])).toEqual([
      ["bob", "claude"],
      ["greg", null],
    ]);
  });

  it("replaces the reviewer's verdict on the same head, and journals each post", async () => {
    const { post, push, bob, list, journal } = await setup();
    await push(1, "one\n");
    await post(bob, { recommendation: "revise", body: "Not yet." });
    clock = new Date("2026-10-10T13:00:00.000Z");
    await post(bob, { recommendation: "merge", body: "Now it is." });
    expect((await list())["verdicts"]).toEqual([
      expect.objectContaining({ recommendation: "merge", body: "Now it is.", at: "2026-10-10T13:00:00.000Z" }),
    ]);
    expect(journal()).toHaveLength(2);
  });

  it("keeps a verdict on an older head, superseded, after a push, beside a new one on the new head", async () => {
    const { post, push, bob, list } = await setup();
    const first = await push(1, "one\n");
    await post(bob, { recommendation: "revise", body: "Not yet." });
    const second = await push(1, "two\n");
    expect((await list())["verdicts"].map((v: Json) => [v["head"], v["superseded"]])).toEqual([[first, true]]);
    await post(bob, { recommendation: "merge", body: "Now it is." });
    expect((await list())["verdicts"].map((v: Json) => [v["head"], v["recommendation"], v["superseded"]])).toEqual([
      [first, "revise", true],
      [second, "merge", false],
    ]);
  });

  it("takes a body of up to 64 KB and a known recommendation", async () => {
    const { post, push, bob } = await setup();
    await push(1, "one\n");
    expect((await post(bob, { recommendation: "reject", body: "x".repeat(65_536) })).status).toBe(201);
    const tooLong = await post(bob, { recommendation: "reject", body: "x".repeat(65_537) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body["error"]["code"]).toBe("invalidRequest");
    expect((await post(bob, { recommendation: "approve", body: "ok" })).status).toBe(400);
    expect((await post(bob, { recommendation: "merge" })).status).toBe(400);
  });

  it("needs an active or merged attempt with a head, and a valid reference", async () => {
    const { call, base, post, push, ada, greg, bob } = await setup();
    const noHead = await post(bob, { recommendation: "merge", body: "ok" });
    expect(noHead.status).toBe(409);
    expect(noHead.body["error"]["code"]).toBe("invalidState");

    await push(1, "one\n");
    await call("POST", `${base}/attempts/t1a1/close`, ada);
    expect((await post(bob, { recommendation: "merge", body: "ok" })).status).toBe(409);
    await call("POST", `${base}/attempts/t1a1/obsolete`, greg);
    expect((await post(bob, { recommendation: "merge", body: "ok" })).status).toBe(409);

    expect((await post(bob, { recommendation: "merge", body: "ok" }, "t1a9")).status).toBe(404);
    expect((await post(bob, { recommendation: "merge", body: "ok" }, "t1")).status).toBe(400);
    expect(
      (await call("POST", `${base}/attempts/t1a1/verdicts`, undefined, { recommendation: "merge", body: "ok" })).status,
    ).toBe(401);
  });

  it("takes and lists verdicts from the web as the signed-in user, refusing the author there too", async () => {
    const { call, base, post, push } = await setup();
    await push(1, "one\n");
    const posted = await post({ web: "bob@example.com" }, { recommendation: "merge", body: "LGTM" });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ reviewer: { handle: "bob" }, alias: null });
    expect((await post({ web: "ada@example.com" }, { recommendation: "merge", body: "Mine" })).status).toBe(403);
    const listed = await call("GET", `${base}/attempts/t1a1/verdicts`, { web: "greg@example.com" });
    expect(listed.body["verdicts"]).toEqual([posted.body]);
  });

  it("takes a verdict on an open attempt, and on a merged one for the record", async () => {
    const { call, base, post, push, merge, ada, bob, list } = await setup();
    const head = await push(1, "one\n");
    await call("POST", `${base}/attempts/t1a1/open`, ada);
    expect((await post(bob, { recommendation: "revise", body: "Hmm." })).status).toBe(201);
    await merge(1);
    expect((await post(bob, { recommendation: "merge", body: "Fine in the end." })).status).toBe(201);
    expect((await list())["verdicts"].map((v: Json) => [v["head"], v["recommendation"], v["superseded"]])).toEqual([
      [head, "merge", false],
    ]);
  });
});

describe("verdict summaries", () => {
  it("counts the current head's verdicts by recommendation on the attempt and in the arena", async () => {
    const { call, base, post, push, bob, bobClaude, greg, ada } = await setup();
    await push(1, "one\n");
    await post(bob, { recommendation: "revise", body: "Not yet." });
    const head = await push(1, "two\n");
    await post(bobClaude, { recommendation: "merge", body: "Good now." });
    await post(greg, { recommendation: "merge", body: "Agreed." });

    const summary = { head, merge: 2, revise: 0, reject: 0 };
    expect((await call("GET", `${base}/attempts/t1a1`, ada)).body["verdicts"]).toEqual(summary);
    const arena = (await call("GET", `${base}/tasks/t1/arena`, ada)).body["attempts"] as Json[];
    expect(arena.map((a) => [a["ref"], a["verdicts"]])).toEqual([
      ["t1a1", summary],
      ["t1a2", { head: null, merge: 0, revise: 0, reject: 0 }],
    ]);
  });
});
