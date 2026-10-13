// The MCP server at `/mcp`, driven by the SDK's own client in process: the tool list, auth, each
// tool reaching its service as the token's actor (alias included), errors as tool errors, and caps.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { agentLoop, toolCaller } from "../scripts/e2e-mcp.ts";
import type { AccessVerifier } from "../src/access.ts";
import { publicApp } from "../src/app.ts";
import { CONFIG_PATH } from "../src/config.ts";
import { DIFF_CAPS } from "../src/diff.ts";
import { FORWARDED_EMAIL_HEADER } from "../src/forwarded.ts";
import type { LogStore } from "../src/logs.ts";
import { MAX_FILE_BYTES, MAX_LOG_SLICE_BYTES } from "../src/mcp.ts";
import type { ScoringResult } from "../src/results.ts";
import type { TaskBackend } from "../src/tasks.ts";
import type { Actor } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../src/waiters.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";
import { FakePreviewWorkers } from "./support/preview-workers.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const verify: AccessVerifier = async (token) => (token.startsWith("as:") ? { email: token.slice(3) } : null);
const now = () => new Date("2026-10-10T12:00:00.000Z");
const ORIGIN = "https://throng.test";

/** The spec's tool table, in its order. */
const TOOLS = [
  "whoami",
  "list_tasks",
  "get_task",
  "create_task",
  "start_attempts",
  "update_attempt",
  "hand_off",
  "list_files",
  "read_file",
  "list_commits",
  "get_commit_diff",
  "get_attempt",
  "wait_for_attempt",
  "score_now",
  "rescore",
  "get_log",
  "post_verdict",
  "list_verdicts",
  "select_attempt",
  "approve_merge_request",
  "cancel_merge_request",
  "get_dequeue",
  "open_vote",
  "cast_vote",
  "add_vote_candidate",
  "close_vote",
  "get_vote",
];

/** An R2 bucket in memory. */
class MemoryLogs implements LogStore {
  readonly objects = new Map<string, string>();
  async get(key: string) {
    const text = this.objects.get(key);
    return text === undefined ? null : { body: new Response(text).body as ReadableStream };
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
}

/** Calls a tool: its summary line, its data, and whether it is an error. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const texts = (result.content as { type: string; text: string }[]).map((c) => c.text);
  return { isError: result.isError === true, summary: texts[0] ?? "", data: result.structuredContent as Json };
}

const PASSED: ScoringResult = {
  base: null,
  config: { kind: "none" },
  gate: "passed",
  checks: [],
  metrics: {},
  logs: [],
};

/** Workflows that start and do nothing: `runPlatform` reports for them. */
const runner = {
  workflow: { create: async () => ({}), get: async () => ({ terminate: async () => {} }) },
  teardown: async () => {},
};

async function setup() {
  const repos = new FakeRepos();
  const logs = new MemoryLogs();
  const { backend, store, sql } = testTaskBackends(repos, now, runner, runner);
  // Every store call a tool makes, with the actor it passed: a store method takes `(project, actor, …)`.
  const storeCalls: { method: string; actor: Actor }[] = [];
  const recording = (projectId: string): TaskBackend => ({
    call: async (method, args) => {
      storeCalls.push({ method, actor: args[1] as Actor });
      return backend(projectId).call(method, args);
    },
  });
  const app = publicApp({
    verifierFor: () => verify,
    now,
    repos: () => repos,
    previewWorkers: () => new FakePreviewWorkers(),
    tasks: () => recording,
    logs: () => logs,
  });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const fetchApp = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.request(input instanceof Request ? input : new Request(input, init), undefined, env));

  /** Mints a token for `email`, under `alias` if given, as a human would in the UI. */
  const tokenFor = async (email: string, alias?: string) => {
    const headers = { "Cf-Access-Jwt-Assertion": `as:${email}`, "Content-Type": "application/json" };
    const body = JSON.stringify(alias === undefined ? {} : { alias });
    const res = await app.request("/api/tokens", { method: "POST", headers, body }, env);
    return ((await res.json()) as Json)["token"] as string;
  };

  /** An MCP client connected to `/mcp` with `token` as its bearer. */
  const connect = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: fetchApp,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  };

  /**
   * Plays the project's Durable Object and Workflows until stopped: drains after each tick, every
   * scoring run passes, and every landing lands as a new commit on `main`.
   */
  const runPlatform = (projectId: string) => {
    const stopped = new AbortController();
    const ticking = (async () => {
      while (!stopped.signal.aborted) {
        const tasks = store(projectId);
        await tasks.drain(projectId);
        const runs = sql(projectId).exec<{ id: number }>("SELECT id FROM scoring_runs WHERE status = 'running'");
        for (const { id } of runs) tasks.scoringFinished(id, { status: "done", result: PASSED });
        const landing = tasks.landings.active();
        if (landing !== null) {
          const merge = repos.commit(`${projectId}-main`, { files: { "README.md": "merged\n" } }).hash;
          await tasks.landingFinished(landing.id, { kind: "landed", sha: merge });
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    return async () => {
      stopped.abort();
      await ticking;
    };
  };

  return { repos, logs, store, storeCalls, env, app, fetchApp, tokenFor, connect, runPlatform };
}

/** greg's project with one commit on `main` and a task t1, and clients for greg, ada, and ada as `claude`. */
async function withProject() {
  const context = await setup();
  const { tokenFor, connect, app, env, repos } = context;
  const gregToken = await tokenFor("greg@example.com");
  const headers = { Authorization: `Bearer ${gregToken}`, "Content-Type": "application/json" };
  const body = JSON.stringify({ handle: "throng" });
  const res = await app.request("/api/projects", { method: "POST", headers, body }, env);
  const projectId = ((await res.json()) as Json)["id"] as string;
  const main = repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n" } }).hash;
  const greg = await connect(gregToken);
  const ada = await connect(await tokenFor("ada@example.com"));
  const claude = await connect(await tokenFor("ada@example.com", "claude"));
  await call(greg, "create_task", { project: "greg/throng", title: "Fix it" });
  /** Pushes a new head to attempt `t1a<number>` as `email`, and records it as the git proxy does. */
  const pushTo = async (number: number, email: string) => {
    const fork = `${projectId}-t1a${number}`;
    const before = repos.ref(fork, "refs/heads/main") ?? "0".repeat(40);
    const after = repos.commit(fork, { files: { "README.md": `try ${number}\n` } }).hash;
    const user = await userForEmail(env.DB, email);
    const updates = [{ ref: "refs/heads/main", before, after }];
    context
      .store(projectId)
      .recordPush({ id: projectId, owner: "" }, { user, alias: null }, { task: 1, number, updates });
    return after;
  };
  return { ...context, projectId, main, greg, ada, claude, pushTo, project: "greg/throng" };
}

describe("/mcp", () => {
  it("lists the spec's tools", async () => {
    const { tokenFor, connect } = await setup();
    const client = await connect(await tokenFor("greg@example.com"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    for (const tool of tools) expect(tool.description).toEqual(expect.any(String));
  });

  it("names its tools in snake_case, their parameters in camelCase, and itself in kebab-case (ADR 0002)", async () => {
    const { tokenFor, connect } = await setup();
    const client = await connect(await tokenFor("greg@example.com"));
    expect(client.getServerVersion()?.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).filter((name) => !/^[a-z]+(?:_[a-z]+)*$/u.test(name))).toEqual([]);
    const params = tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {}).map((p) => `${t.name}.${p}`));
    expect(params.filter((p) => !/\.[a-z][a-zA-Z0-9]*$/u.test(p))).toEqual([]);
  });

  it("describes the agent loop in its instructions", async () => {
    const { tokenFor, connect } = await setup();
    const client = await connect(await tokenFor("greg@example.com"));
    expect(client.getInstructions()).toContain("wait_for_attempt");
  });

  it("is 401 without a valid bearer token", async () => {
    const { fetchApp } = await setup();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const refused: Record<string, string>[] = [
      {},
      { Authorization: "Bearer thr_nope" },
      { [FORWARDED_EMAIL_HEADER]: "a@example.com" },
    ];
    for (const auth of refused) {
      const res = await fetchApp(`${ORIGIN}/mcp`, { method: "POST", headers: { ...headers, ...auth }, body });
      expect(res.status).toBe(401);
    }
  });

  it("acts as the token's user and alias", async () => {
    const { claude } = await withProject();
    const me = await call(claude, "whoami");
    expect(me.isError).toBeFalsy();
    expect(me.summary).toBe("ada as claude");
    expect(me.data).toMatchObject({
      user: { handle: "ada" },
      alias: "claude",
      token: { expiresAt: expect.any(String) },
    });
  });

  it("calls each tool family's services as the token's user and alias", async () => {
    const { claude, greg, project, pushTo, storeCalls } = await withProject();
    await call(greg, "start_attempts", { project, task: "t1" });
    await pushTo(1, "greg@example.com");
    /** The store methods `name` reached and who each was called as. */
    const actingAs = async (name: string, args: Record<string, unknown>) => {
      storeCalls.length = 0;
      const result = await call(claude, name, { project, ...args });
      expect(result.isError, `${name}: ${result.summary}`).toBeFalsy();
      return storeCalls.map(({ method, actor }) => `${method}: ${actor.user.handle} (${actor.alias})`);
    };
    // Tasks.
    expect(await actingAs("create_task", { title: "Mine" })).toEqual(["createTask: ada (claude)"]);
    expect(await actingAs("list_tasks", {})).toEqual(["listTasks: ada (claude)"]);
    // Attempts.
    expect(await actingAs("start_attempts", { task: "t2" })).toEqual(["createAttempts: ada (claude)"]);
    expect(await actingAs("update_attempt", { attempt: "t2a1", state: "open" })).toEqual(["openAttempt: ada (claude)"]);
    expect(await actingAs("rescore", { attempt: "t2a1" })).toEqual(["rescore: ada (claude)"]);
    // Verdicts, on greg's attempt.
    expect(await actingAs("post_verdict", { attempt: "t1a1", recommendation: "merge", body: "ok" })).toEqual([
      "postVerdict: ada (claude)",
    ]);
    expect(await actingAs("list_verdicts", { attempt: "t1a1" })).toEqual(["listVerdicts: ada (claude)"]);
    // Merge requests, on the task ada created as claude.
    expect(await actingAs("select_attempt", { task: "t2", attempt: "t2a1" })).toEqual(["selectAttempt: ada (claude)"]);
    expect(await actingAs("cancel_merge_request", { task: "t2" })).toEqual(["cancelMergeRequest: ada (claude)"]);
    // Browsing an attempt's fork resolves the attempt as the caller.
    expect(await actingAs("list_files", { ref: "t1a1" })).toEqual(["getAttempt: ada (claude)"]);
  });

  it("drives the agent loop through the services: start, open, read", async () => {
    const { claude, greg, project } = await withProject();
    const started = await call(claude, "start_attempts", { project, task: "t1", count: 2, note: "two tries" });
    expect(started.isError).toBeFalsy();
    expect(started.summary).toBe(
      'started t1a1, t1a2; clone each remote with git clone -c http.extraHeader="Authorization: Bearer $THRONG_TOKEN" <remote>',
    );
    const remote = `${ORIGIN}/git/greg/throng/t1a1.git`;
    expect(started.data["attempts"][0]).toMatchObject({
      ref: "t1a1",
      author: { handle: "ada" },
      alias: "claude",
      note: "two tries",
      remote,
    });
    expect(started.data["attempts"][0]).not.toHaveProperty("clone");

    const opened = await call(claude, "update_attempt", { project, attempt: "t1a1", note: "ready", state: "open" });
    expect(opened.data["attempt"]).toMatchObject({ ref: "t1a1", state: "open", note: "ready" });

    const got = await call(claude, "get_attempt", { project, attempt: "t1a1" });
    expect(got.data["attempt"]).toMatchObject({ state: "open", scoring: { status: expect.any(String) } });

    const task = await call(greg, "get_task", { project, task: "1" });
    expect(task.data).toMatchObject({ task: { ref: "t1", title: "Fix it" }, mergeRequest: null });
    expect(task.data["attempts"].map((a: Json) => a["ref"])).toEqual(["t1a1", "t1a2"]);
    expect((await call(greg, "list_tasks", { project })).data["tasks"]).toHaveLength(1);
  });

  it("runs the e2e suite's agent loop: start, push, open, wait for scoring, review, select, wait for the merge", async () => {
    const { connect, tokenFor, runPlatform, repos, env, store, projectId, project, claude } = await withProject();
    const codex = await connect(await tokenFor("greg@example.com", "codex"));
    const stop = runPlatform(projectId);
    const pushed: string[] = [];
    try {
      const result = await agentLoop({
        creator: toolCaller(codex),
        reviewer: toolCaller(claude),
        project,
        // What `git push` to the attempt's remote does, through the git proxy.
        push: async ({ ref, remote }) => {
          expect(remote).toBe(`${ORIGIN}/git/greg/throng/${ref}.git`);
          const [, task = "", number = ""] = /^t(\d+)a(\d+)$/u.exec(ref) ?? [];
          const fork = `${projectId}-${ref}`;
          const before = repos.ref(fork, "refs/heads/main") ?? "0".repeat(40);
          const after = repos.commit(fork, { files: { "README.md": "hello\n" } }).hash;
          const user = await userForEmail(env.DB, "greg@example.com");
          const updates = [{ ref: "refs/heads/main", before, after }];
          store(projectId).recordPush(
            { id: projectId, owner: "" },
            { user, alias: "codex" },
            { task: Number(task), number: Number(number), updates },
          );
          pushed.push(ref);
          return after;
        },
        wait: 1,
        timeoutMs: 10_000,
      });
      expect(pushed).toEqual(["t2a1"]);
      expect(result).toMatchObject({
        creator: "greg (codex)",
        reviewer: "ada (claude)",
        task: "t2",
        attempt: "t2a1",
        mergeSha: repos.ref(`${projectId}-main`, "refs/heads/main"),
      });
    } finally {
      await stop();
    }
  });

  it("records a verdict under the reviewer's alias", async () => {
    const { claude, greg, project, pushTo } = await withProject();
    await call(greg, "start_attempts", { project, task: "t1" });
    const head = await pushTo(1, "greg@example.com");
    const posted = await call(claude, "post_verdict", {
      project,
      attempt: "t1a1",
      recommendation: "revise",
      body: "no",
    });
    expect(posted.summary).toBe(`revise on ${head}`);
    const listed = await call(greg, "list_verdicts", { project, attempt: "t1a1" });
    expect(listed.data["verdicts"]).toMatchObject([
      { reviewer: { handle: "ada" }, alias: "claude", head, recommendation: "revise", superseded: false },
    ]);
    // The author's own alias can't review it.
    const own = await call(claude, "start_attempts", { project, task: "t1" });
    await pushTo(2, "ada@example.com");
    const refused = await call(claude, "post_verdict", {
      project,
      attempt: own.data["attempts"][0]["ref"],
      recommendation: "merge",
      body: "",
    });
    expect(refused.summary).toMatch(/^forbidden: /u);
  });

  it("turns a service's refusal into a tool error", async () => {
    const { claude, greg, project } = await withProject();
    await call(claude, "start_attempts", { project, task: "t1" });
    const refused = await call(greg, "update_attempt", { project, attempt: "t1a1", state: "open" });
    expect(refused.isError).toBeTruthy();
    expect(refused.summary).toMatch(/^forbidden: /u);
    const missing = await call(greg, "get_dequeue", { project, task: "t1" });
    expect(missing.summary).toMatch(/^notFound: /u);
    expect((await call(greg, "list_tasks", { project: "throng" })).isError).toBeTruthy();
  });

  it("creates a task with its own checks and metrics, as REST does", async () => {
    const { ada, project } = await withProject();
    const smoke = { name: "smoke", command: "./smoke.sh" };
    const smoked = { name: "smoked", from: "smoke.report.ok", type: "boolean" };
    const created = await call(ada, "create_task", { project, title: "Smoke", checks: [smoke], metrics: [smoked] });
    expect(created.isError).toBeFalsy();
    expect(created.data["task"]).toMatchObject({
      checks: [{ ...smoke, source: "task" }],
      metrics: [{ ...smoked, source: "task" }],
    });
  });

  it("waits on an attempt, answering changed: false when nothing changed", async () => {
    const { ada, project } = await withProject();
    await call(ada, "start_attempts", { project, task: "t1" });
    const waited = await call(ada, "wait_for_attempt", { project, attempt: "t1a1", wait: 1, until: "stateChanged" });
    expect(waited.data["attempt"]).toMatchObject({ ref: "t1a1", state: "draft", changed: false });
    const invalid = await call(ada, "wait_for_attempt", { project, attempt: "t1a1", wait: 31 });
    expect(invalid.isError).toBeTruthy();
  });

  it("takes the same wait limits as `?wait=`, defaulting to the documented length", async () => {
    const { tokenFor, connect, app, env } = await setup();
    const client = await connect(await tokenFor("greg@example.com"));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "wait_for_attempt");
    const mcpWait = tool?.inputSchema.properties?.["wait"] as Json;
    const doc = (await (await app.request(`${ORIGIN}/api/openapi.json`, {}, env)).json()) as Json;
    const params = doc["paths"]["/projects/{owner}/{project}/attempts/{a}"]["get"]["parameters"] as Json[];
    const restWait = params.find((p) => p["name"] === "wait")?.["schema"] as Json;
    expect({ min: mcpWait["minimum"], max: mcpWait["maximum"] }).toEqual({ min: 1, max: MAX_WAIT_SECONDS });
    expect({ min: restWait["minimum"], max: restWait["maximum"] }).toEqual({ min: 1, max: MAX_WAIT_SECONDS });
    expect(mcpWait["default"]).toBe(DEFAULT_WAIT_SECONDS);
    expect(restWait["example"]).toBe(DEFAULT_WAIT_SECONDS);
  });

  it("selects an attempt, and cancels its merge request", async () => {
    const { ada, greg, project, pushTo } = await withProject();
    await call(ada, "start_attempts", { project, task: "t1", count: 2 });
    await pushTo(1, "ada@example.com");
    await call(ada, "update_attempt", { project, attempt: "t1a1", state: "open" });
    const refused = await call(ada, "select_attempt", { project, task: "t1", attempt: "t1a1" });
    expect(refused.summary).toMatch(/^forbidden: /u);
    const selected = await call(greg, "select_attempt", { project, task: "t1", attempt: "t1a1" });
    expect(selected.data["mergeRequest"]).toMatchObject({ attempt: "t1a1", state: "pending" });
    const task = await call(greg, "get_task", { project, task: "t1" });
    expect(task.data["mergeRequest"]).toMatchObject({ state: "pending" });
    const cancelled = await call(greg, "cancel_merge_request", { project, task: "t1" });
    expect(cancelled.data["mergeRequest"]).toMatchObject({ state: "cancelled" });
    expect((await call(greg, "approve_merge_request", { project, task: "t1" })).isError).toBeTruthy();
  });

  it("runs a vote: open, cast, add a candidate that passes later, read and close", async () => {
    const { ada, greg, project, projectId, repos, store, pushTo, connect, tokenFor } = await withProject();
    const bob = await connect(await tokenFor("bob@example.com"));
    repos.writeFile(`${projectId}-main`, "main", CONFIG_PATH, "selection: { policy: vote }\n");
    await call(ada, "start_attempts", { project, task: "t1", count: 2 });
    for (const number of [1, 2]) {
      await pushTo(number, "ada@example.com");
      await call(ada, "update_attempt", { project, attempt: `t1a${number}`, state: "open" });
    }
    const tasks = store(projectId);
    await tasks.scoring.drain();
    /** Finishes the attempt's latest run with `gate`. */
    const finish = (number: number, gate: "passed" | "failed") => {
      const run = tasks.scoring.listRuns({ task: 1, attempt: number }).at(-1)?.id ?? 0;
      tasks.scoringFinished(run, { status: "done", result: { ...PASSED, gate } });
    };
    finish(1, "passed");
    finish(2, "failed");

    const opened = await call(greg, "open_vote", { project, task: "t1" });
    expect(opened.summary).toBe("t1's vote is open: t1a1 0");
    expect(opened.data["vote"]).toMatchObject({ state: "open", eligible: "anyone" });
    expect((await call(ada, "cast_vote", { project, task: "t1", attempt: "t1a1" })).summary).toMatch(/^forbidden: /u);

    await pushTo(2, "ada@example.com");
    await tasks.scoring.drain();
    finish(2, "passed");
    const added = await call(greg, "add_vote_candidate", { project, task: "t1", attempt: "t1a2" });
    expect(added.summary).toBe("t1's vote is open: t1a1 0, t1a2 0");
    const cast = await call(bob, "cast_vote", { project, task: "t1", attempt: "t1a2" });
    expect(cast.summary).toBe("t1's vote is open: t1a1 0, t1a2 1");
    expect((await call(bob, "get_vote", { project, task: "t1" })).data["vote"]).toMatchObject({
      myBallot: { attempt: "t1a2" },
    });

    const closed = await call(greg, "close_vote", { project, task: "t1" });
    expect(closed.summary).toBe("t1's vote selected t1a2; merge request is queued");
    expect(closed.data).toMatchObject({ vote: { winner: "t1a2" }, mergeRequest: { attempt: "t1a2" } });
  });

  it("hands an attempt to another user", async () => {
    const { claude, project } = await withProject();
    await call(claude, "start_attempts", { project, task: "t1" });
    const handed = await call(claude, "hand_off", { project, attempt: "t1a1", to: "greg" });
    expect(handed.data["attempt"]).toMatchObject({ author: { handle: "greg" } });
  });

  it("caps read_file, with a hint", async () => {
    const { greg, repos, projectId, project } = await withProject();
    repos.commit(`${projectId}-main`, { files: { "README.md": "hi\n", "big.txt": "x".repeat(MAX_FILE_BYTES + 10) } });
    const small = await call(greg, "read_file", { project, ref: "main", path: "README.md" });
    expect(small.data).toMatchObject({ content: "hi\n", truncated: false, hint: null });
    const read = await call(greg, "read_file", { project, ref: "main", path: "big.txt" });
    expect(read.data).toMatchObject({ size: MAX_FILE_BYTES + 10, truncated: true, hint: expect.any(String) });
    expect(read.data["content"]).toHaveLength(MAX_FILE_BYTES);
    const listed = await call(greg, "list_files", { project, ref: "main" });
    expect(listed.data["entries"].map((e: Json) => e["name"])).toEqual(["README.md", "big.txt"]);
  });

  it("gives a commit's diff as unified text", async () => {
    const { greg, repos, projectId, project } = await withProject();
    const sha = repos.commit(`${projectId}-main`, { files: { "README.md": "hello\n" } }).hash;
    const diff = await call(greg, "get_commit_diff", { project, sha });
    expect(diff.data).toMatchObject({ sha, totals: { files: 1, additions: 1, deletions: 1 }, hint: null });
    expect(diff.data["patch"]).toContain("-hi\n+hello\n");
    const commits = await call(greg, "list_commits", { project, ref: "main", limit: 1 });
    expect(commits.data).toMatchObject({ commits: [{ sha }], next: 1 });
  });

  it("caps a large commit diff at the diff caps, listing what it cut with a hint", async () => {
    const { greg, repos, projectId, project } = await withProject();
    // One file too large to diff, then more small ones than get a patch: the last by path goes without.
    const small = Object.fromEntries(
      Array.from({ length: DIFF_CAPS.maxPatchedFiles }, (_, i) => [`f/${String(i).padStart(3, "0")}.txt`, "a\n"]),
    );
    const files = { "README.md": "hi\n", "a-huge.txt": "x".repeat(DIFF_CAPS.maxBlobBytes + 1), ...small };
    const sha = repos.commit(`${projectId}-main`, { files }).hash;
    const diff = await call(greg, "get_commit_diff", { project, sha });
    expect(diff.isError).toBeFalsy();
    expect(diff.data).toMatchObject({
      sha,
      totals: { files: DIFF_CAPS.maxPatchedFiles + 1 },
      truncated: false,
      hint: "Some files have no patch or a cut-short one (see `capped`); diff them in a clone.",
    });
    const last = `f/${String(DIFF_CAPS.maxPatchedFiles - 1).padStart(3, "0")}.txt`;
    expect(diff.data["capped"]).toEqual([
      { path: "a-huge.txt", flags: ["tooLarge"] },
      { path: last, flags: ["truncated"] },
    ]);
    // Lines are counted for patched files only.
    expect(diff.summary).toBe(
      `${DIFF_CAPS.maxPatchedFiles + 1} files, +${DIFF_CAPS.maxPatchedFiles - 1} -0. ${diff.data["hint"]}`,
    );
    expect(diff.data["patch"]).toContain("+++ b/f/000.txt");
    expect(diff.data["patch"]).not.toContain(`+++ b/${last}`);
    expect(diff.data["patch"]).not.toContain("xxxx");
  });

  it("returns a log's last 64 KB by default, and another part from `offset`", async () => {
    const { ada, logs, projectId, main, project } = await withProject();
    await call(ada, "start_attempts", { project, task: "t1" });
    const scored = await call(ada, "score_now", { project, attempt: "t1a1" });
    const run = scored.data["run"]["id"] as number;
    const log = `${"a".repeat(MAX_LOG_SLICE_BYTES)}${"b".repeat(100)}`;
    logs.objects.set(`logs/${projectId}/t1a1/${main}/${run}/test.log`, log);

    const tail = await call(ada, "get_log", { project, run, name: "test" });
    expect(tail.data).toMatchObject({ size: log.length, offset: 100, hint: expect.any(String) });
    expect(tail.data["text"]).toBe(log.slice(100));
    const head = await call(ada, "get_log", { project, run, name: "test", offset: 0 });
    expect(head.data["text"]).toBe(log.slice(0, MAX_LOG_SLICE_BYTES));
    expect((await call(ada, "get_log", { project, run, name: "lint" })).summary).toMatch(/^notFound: /u);
  });
});
