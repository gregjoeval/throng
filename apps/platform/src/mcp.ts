// The MCP server at `/mcp`: the agent API as curated tools, for MCP clients such as Claude Code.
// Stateless: each POST builds a fresh server for the bearer token's actor, serves the one JSON-RPC
// request, and is done, so there are no sessions to keep. Tools call the same service functions the
// REST routes call, with the same input schemas, so permissions and validation are the API's own.
// Large payloads (files, diffs, logs) are capped, with a hint on how to read the rest.

import { z } from "@hono/zod-openapi";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, ToolCallback } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { AccessBindings } from "./access.ts";
import {
  AttemptQuerySchema,
  BallotSchema,
  CloseVoteSchema,
  CreateAttemptsSchema,
  CreateTaskSchema,
  EditAttemptSchema,
  HandOffSchema,
  OpenVoteSchema,
  PageQuerySchema,
  PostVerdictSchema,
  SelectionSchema,
  VoteCandidateSchema,
  WaitQuerySchema,
  WaitSecondsSchema,
  workersCache,
} from "./api-shared.ts";
import type { ApiOptions } from "./api.ts";
import { bearerAuth } from "./auth.ts";
import type { AuthEnv } from "./auth.ts";
import { browseService } from "./browse.ts";
import { DIFF_CAPS, diffCommit, unifiedPatch } from "./diff.ts";
import { ServiceError } from "./errors.ts";
import { missingLog } from "./logs.ts";
import { ATTEMPT_STATES, TASK_STATES } from "./task-store.ts";
import { taskService } from "./tasks.ts";
import type { MergeRequest, ScoringAnswer, Vote } from "./tasks.ts";
import type { Actor } from "./tokens.ts";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./waiters.ts";

/** `read_file` returns at most this much of a file's text. */
export const MAX_FILE_BYTES = 256 * 1024;
/** `get_log` returns at most this much of a log: by default its last this many bytes. */
export const MAX_LOG_SLICE_BYTES = 64 * 1024;

/** How an agent clones an attempt's remote: `-c` after `clone` is saved in the clone's config, so a plain push works. */
export const CLONE_RECIPE = 'git clone -c http.extraHeader="Authorization: Bearer $THRONG_TOKEN" <remote>';

/** What the server tells a client it is for: the agent loop, in short. `llms.txt` has the long form. */
export const MCP_INSTRUCTIONS = [
  "Throng runs many attempts at a task in parallel, scores each, and merges the best one.",
  "Every tool but `whoami` takes `project` as `owner/project`. Tasks are `t42`, attempts `t42a3`.",
  "The loop: `start_attempts` gives each attempt a git `remote`. Clone it with " +
    `\`${CLONE_RECIPE}\`, ` +
    "which keeps the header for later pushes. Commit, push to `main`, then `update_attempt` with `state: open`. " +
    "`wait_for_attempt` with `until: scored` holds until the head is scored; read the result with " +
    "`get_attempt` (and failing checks' logs with `get_log`), fix, push, and wait again.",
  "If a merge request is dequeued, `get_dequeue` says why (with conflict hunks): merge `main` into the attempt " +
    "and push; its head then needs approving again.",
].join("\n");

type Deps = Required<Pick<ApiOptions, "repos" | "tasks" | "logs" | "diffCache">>;

/** A dependency this server was built without; using it is a bug. */
function missing(what: string): () => never {
  return () => {
    throw new Error(`the MCP server was built without ${what}`);
  };
}

/** `/mcp`, behind the API's bearer middleware: no token, or a bad one, is a 401. */
export function mcpRoutes(options: ApiOptions = {}) {
  const deps: Deps = {
    repos: options.repos ?? missing("repos"),
    tasks: options.tasks ?? missing("a task backend"),
    logs: options.logs ?? missing("a logs bucket"),
    diffCache: options.diffCache ?? workersCache,
  };
  return new Hono<AuthEnv>()
    .use(bearerAuth(options.now === undefined ? {} : { now: options.now }))
    .all("/", async (c) => {
      const context: ToolContext = {
        actor: c.var.actor,
        token: c.var.token,
        env: c.env,
        origin: new URL(c.req.url).origin,
      };
      const handler = createMcpHandler(() => mcpServer(deps, context));
      return handler.fetch(c.req.raw);
    });
}

interface ToolContext {
  actor: Actor;
  token: AuthEnv["Variables"]["token"];
  env: AccessBindings;
  origin: string;
}

const ProjectRefSchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/u, "project must be `owner/project`")
  .describe("The project, as `owner/project`, e.g. `greg/throng`.");
const TaskRefSchema = z.string().describe("A task reference: `t42` or `42`.");
const AttemptRefSchema = z.string().describe("An attempt reference, e.g. `t42a3`.");
const RefSchema = z.string().describe("`main`, an attempt reference (`t42a3`), or a full 40-character commit sha.");

/** The states `update_attempt` moves an attempt to; `merged` and `obsolete` aren't its author's to choose. */
const UPDATE_STATES = z.enum(ATTEMPT_STATES).exclude(["merged", "obsolete"]);

const onProject = z.object({ project: ProjectRefSchema });
const onTask = onProject.extend({ task: TaskRefSchema });
const onAttempt = onProject.extend({ attempt: AttemptRefSchema });

function projectPath(ref: string): { owner: string; project: string } {
  const [owner = "", project = ""] = ref.split("/");
  return { owner, project };
}

/** A tool's answer: a one-line summary, then the data as JSON. */
function answer(summary: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

/** A summary line with its hint, if any, as one more sentence. */
function withHint(summary: string, hint: string | null): string {
  return hint === null ? summary : `${summary}. ${hint}`;
}

/** The answer to a scoring request: the run it queued, or why it queued none. */
function scoringAnswer(scored: ScoringAnswer): CallToolResult {
  return answer(scored.queued ? `queued run ${scored.run.id}` : `not queued: ${scored.reason}`, { ...scored });
}

/** The answer to a call that moves the task's merge request: its new state. */
function mergeRequestAnswer(mergeRequest: MergeRequest): CallToolResult {
  return answer(`merge request is ${mergeRequest.state}`, { mergeRequest });
}

/** A vote candidate's tally, or why it doesn't count now. */
function tally(c: Vote["candidates"][number]): string | number {
  if (c.beingScored) return "being scored";
  return c.withdrawn ? "withdrawn" : c.votes;
}

/** The answer to a call that reads or changes the task's vote: its state and each candidate's tally. */
function voteAnswer(vote: Vote): CallToolResult {
  const tallies = vote.candidates.map((c) => `${c.attempt} ${tally(c)}`).join(", ");
  return answer(`${vote.task}'s vote is ${vote.state}: ${tallies}`, { vote });
}

/** Runs a tool, turning a service's refusal into a tool error the model can read and act on. */
async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) {
      return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}` }] };
    }
    console.error({ event: "mcp.error", error: String(error) });
    return { isError: true, content: [{ type: "text", text: "internal: internal error" }] };
  }
}

/** Decodes at most `max` of `bytes` from byte `start` as UTF-8, dropping any character cut in half. */
function sliceBytes(bytes: Uint8Array, start: number, max: number): string {
  return new TextDecoder().decode(bytes.subarray(start, start + max)).replace(/^�+|�+$/gu, "");
}

function mcpServer({ repos, tasks, logs, diffCache }: Deps, { actor, token, env, origin }: ToolContext): McpServer {
  const service = taskService({ db: env.DB, repos: repos(env), backend: tasks(env), origin });
  const browse = browseService({ db: env.DB, repos: repos(env), backend: tasks(env) });
  const server = new McpServer({ name: "throng", version: "0.0.0" }, { instructions: MCP_INSTRUCTIONS });

  const tool = <S extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: S,
    run: (input: z.infer<S>) => Promise<CallToolResult>,
  ) => {
    // The SDK parses each call's arguments with `inputSchema` before this runs; TypeScript can't
    // resolve its callback type's conditional over a generic schema, so it is asserted here.
    const callback = (async (input: z.infer<S>) => guarded(() => run(input))) as ToolCallback<S>;
    server.registerTool<z.ZodObject, S>(name, { description, inputSchema }, callback);
  };

  tool("whoami", "Who the token acts as: the user, the alias, and when the token expires.", z.object({}), async () => {
    const { user, alias } = actor;
    const data = {
      user: { id: user.id, handle: user.handle, email: user.email },
      alias,
      token: token === null ? null : { id: token.id, expiresAt: token.expires_at },
    };
    return answer(`${user.handle}${alias === null ? "" : ` as ${alias}`}`, data);
  });

  tool(
    "list_tasks",
    "List the project's tasks, with each one's attempt count, best gate and merge request state. " +
      "Obsolete tasks only with `state: obsolete`.",
    onProject.extend({ state: z.enum(TASK_STATES).optional() }),
    async ({ project, state }) => {
      const list = await service.listTasks(actor, { ...projectPath(project), state });
      return answer(`${list.length} tasks`, { tasks: list });
    },
  );

  tool(
    "get_task",
    "A task in one call: the task, every attempt with its scoring and current result, the metrics, and its " +
      "latest merge request (null when it has none).",
    onTask,
    async ({ project, task }) => {
      const path = { ...projectPath(project), task };
      const [found, arena, mergeRequest] = await Promise.all([
        service.getTask(actor, path),
        service.taskArena(actor, path),
        service.getMergeRequest(actor, path).catch((error: unknown) => {
          if (error instanceof ServiceError && error.code === "notFound") return null;
          throw error;
        }),
      ]);
      const summary = `${found.ref} (${found.state}): ${found.title}; ${arena.attempts.length} attempts`;
      return answer(summary, { task: found, metrics: arena.metrics, attempts: arena.attempts, mergeRequest });
    },
  );

  tool(
    "create_task",
    "Create an open task; the caller is its creator. Only the project owner may set its `selection` policy.",
    CreateTaskSchema.extend(onProject.shape),
    async ({ project, ...input }) => {
      const created = await service.createTask(actor, { ...projectPath(project), ...input });
      return answer(`created ${created.ref}`, { task: created });
    },
  );

  tool(
    "start_attempts",
    `Start \`count\` draft attempts at a task. Each comes with its git \`remote\`: \`${CLONE_RECIPE}\`.`,
    CreateAttemptsSchema.extend(onTask.shape),
    async ({ project, task, ...input }) => {
      const attempts = await service.createAttempts(actor, { ...projectPath(project), task, ...input });
      const refs = attempts.map((a) => a.ref).join(", ");
      return answer(`started ${refs}; clone each remote with ${CLONE_RECIPE}`, { attempts });
    },
  );

  tool(
    "update_attempt",
    "Edit an attempt's note, and move it with `state`: `open` (ready to be scored and selected), `draft` or " +
      "`closed`. Only its author may.",
    onAttempt.extend({
      note: EditAttemptSchema.shape.note.optional(),
      state: UPDATE_STATES.optional(),
    }),
    async ({ project, attempt, note, state }) => {
      const path = { ...projectPath(project), attempt };
      if (note === undefined && state === undefined) {
        throw new ServiceError("invalidRequest", "give a `note`, a `state`, or both");
      }
      const moves = { open: service.openAttempt, draft: service.draftAttempt, closed: service.closeAttempt };
      let updated = note === undefined ? null : await service.editAttempt(actor, { ...path, note });
      if (state !== undefined) updated = await moves[state](actor, path);
      if (updated === null) throw new Error("unreachable: an update with nothing to do");
      return answer(`${updated.ref} is ${updated.state}`, { attempt: updated });
    },
  );

  tool(
    "hand_off",
    "Hand an active attempt to another user, by handle, who becomes its author.",
    HandOffSchema.extend(onAttempt.shape),
    async ({ project, attempt, to }) => {
      const updated = await service.handOffAttempt(actor, { ...projectPath(project), attempt, to });
      return answer(`${updated.ref} is now ${updated.author.handle}'s`, { attempt: updated });
    },
  );

  tool(
    "list_files",
    "List one directory (the root by default) at a ref.",
    onProject.extend({
      ref: RefSchema,
      path: z.string().default("").describe("The directory; empty for the root."),
      ...AttemptQuerySchema.shape,
    }),
    async ({ project, ref, path, attempt }) => {
      const at = await browse.resolve(actor, { ...projectPath(project), ref, attempt });
      const entries = await browse.tree(at, path);
      return answer(`${entries.length} entries in ${path || "/"} at ${at.sha}`, { ref, sha: at.sha, path, entries });
    },
  );

  tool(
    "read_file",
    `Read a text file at a ref. Text past ${MAX_FILE_BYTES / 1024} KB is cut off, with a hint; read large ` +
      "or binary files from a clone.",
    onProject.extend({ ref: RefSchema, path: z.string().min(1), ...AttemptQuerySchema.shape }),
    async ({ project, ref, path, attempt }) => {
      const at = await browse.resolve(actor, { ...projectPath(project), ref, attempt });
      const file = await browse.blob(at, path);
      const bytes = file.content === null ? null : new TextEncoder().encode(file.content);
      const truncated = bytes !== null && bytes.length > MAX_FILE_BYTES;
      const content = truncated ? sliceBytes(bytes, 0, MAX_FILE_BYTES) : file.content;
      let hint: string | null = null;
      if (truncated) hint = `Only the first ${MAX_FILE_BYTES} of ${file.size} bytes; read the rest from a clone.`;
      else if (file.content === null) {
        hint = `${file.binary ? "Binary" : "Too large"}: no content; read it from a clone.`;
      }
      const data = {
        ref,
        sha: at.sha,
        path: file.path,
        size: file.size,
        binary: file.binary,
        truncated,
        content,
        hint,
      };
      return answer(withHint(`${file.path} at ${at.sha}: ${file.size} bytes`, hint), data);
    },
  );

  tool(
    "list_commits",
    "List the first-parent history from a ref, newest first, a page at a time.",
    onProject.extend({ ref: RefSchema, ...AttemptQuerySchema.shape, ...PageQuerySchema.shape }),
    async ({ project, ref, attempt, offset, limit }) => {
      const at = await browse.resolve(actor, { ...projectPath(project), ref, attempt });
      const page = await browse.commits(at, { offset, limit });
      return answer(`${page.commits.length} commits from ${at.sha}`, { ref, sha: at.sha, offset, limit, ...page });
    },
  );

  tool(
    "get_commit_diff",
    "A commit's diff against its first parent, as unified text ready for `git apply`. The API's diff caps " +
      `apply: at most ${DIFF_CAPS.maxPatchedFiles} files patched and ${DIFF_CAPS.maxPatchBytes} bytes in all; ` +
      "past them, diff in a clone.",
    onProject.extend({
      sha: z.string().regex(/^[0-9a-fA-F]{40}$/u, "sha must be 40 hex characters"),
      ...AttemptQuerySchema.shape,
    }),
    async ({ project, sha, attempt }) => {
      const at = await browse.resolve(actor, { ...projectPath(project), ref: sha, attempt });
      const diff = await diffCommit(repos(env), at.repo, at.sha, { cache: diffCache(env) });
      if (diff === null) throw new ServiceError("notFound", `no commit ${at.sha}`);
      const capped = diff.files.filter((f) => f.flags.length > 0).map((f) => ({ path: f.path, flags: f.flags }));
      const hint =
        diff.truncated || capped.length > 0
          ? "Some files have no patch or a cut-short one (see `capped`); diff them in a clone."
          : null;
      const { totals } = diff;
      const summary = withHint(`${totals.files} files, +${totals.additions} -${totals.deletions}`, hint);
      return answer(summary, {
        sha: diff.sha,
        parent: diff.parent,
        totals,
        truncated: diff.truncated,
        capped,
        hint,
        patch: unifiedPatch(diff),
      });
    },
  );

  tool(
    "get_attempt",
    "An attempt: its state, scoring status and current result, merge request, and verdict summary.",
    onAttempt,
    async ({ project, attempt }) => {
      const path = { ...projectPath(project), attempt };
      const [found, scoring] = await Promise.all([service.getAttempt(actor, path), service.getScoring(actor, path)]);
      const gate = scoring.result?.gate ?? "none";
      return answer(`${found.ref} is ${found.state}; scoring ${scoring.status}, gate ${gate}`, {
        attempt: { ...found, scoring },
      });
    },
  );

  tool(
    "wait_for_attempt",
    `Hold until what \`until\` watches on the attempt changes, or \`wait\` seconds (default ${DEFAULT_WAIT_SECONDS}, ` +
      `at most ${MAX_WAIT_SECONDS}) pass, then return the attempt and whether it changed. \`until: scored\` waits ` +
      "for the current head to have a `done` or `errored` run, and answers at once if it already has one. " +
      "Call again while `changed` is false. A deploy drops waits in flight: they answer `changed: false`.",
    onAttempt.extend({
      wait: WaitSecondsSchema.default(DEFAULT_WAIT_SECONDS).describe(`Seconds to hold, 1 to ${MAX_WAIT_SECONDS}.`),
      until: WaitQuerySchema.shape.until,
    }),
    async ({ project, attempt, wait, until }) => {
      const found = await service.waitForAttempt(actor, { ...projectPath(project), attempt, wait, until });
      return answer(`${found.ref} ${found.changed ? "changed" : "did not change"} (${until})`, { attempt: found });
    },
  );

  tool(
    "score_now",
    "Score a draft attempt's head now. Only its author may.",
    onAttempt,
    async ({ project, attempt }) => {
      return scoringAnswer(await service.scoreNow(actor, { ...projectPath(project), attempt }));
    },
  );

  tool("rescore", "Score an open attempt's head again.", onAttempt, async ({ project, attempt }) => {
    return scoringAnswer(await service.rescore(actor, { ...projectPath(project), attempt }));
  });

  tool(
    "get_log",
    `Read a scoring run's log: a check's name, \`setup.<n>\`, or \`preview.deploy\`. Returns the last ` +
      `${MAX_LOG_SLICE_BYTES / 1024} KB by default; pass \`offset\` (bytes) to read ${MAX_LOG_SLICE_BYTES / 1024} ` +
      "KB from there instead.",
    onProject.extend({
      run: z.number().int().min(1).describe("The run's id."),
      name: z.string().min(1).describe("The log's name, e.g. `test`."),
      offset: z.number().int().min(0).optional().describe("The byte to start at; omit for the log's tail."),
    }),
    async ({ project, run, name, offset }) => {
      const key = await service.runLogKey(actor, { ...projectPath(project), run, name });
      const log = await logs(env).get(key);
      if (log === null) throw missingLog(run, name);
      const bytes = new Uint8Array(await new Response(log.body).arrayBuffer());
      const start = offset ?? Math.max(0, bytes.length - MAX_LOG_SLICE_BYTES);
      const end = Math.min(bytes.length, start + MAX_LOG_SLICE_BYTES);
      const capped = start > 0 || end < bytes.length;
      const hint = capped ? `Bytes ${start}-${end} of ${bytes.length}; pass \`offset\` to read another part.` : null;
      const data = { run, name, size: bytes.length, offset: start, text: sliceBytes(bytes, start, end - start), hint };
      return answer(withHint(`${name} of run ${run}: ${bytes.length} bytes`, hint), data);
    },
  );

  tool(
    "post_verdict",
    "Post your verdict on an attempt's current head: `merge`, `revise` or `reject`, with a markdown body. " +
      "Posting again on the same head replaces it. Not on your own attempts. Advisory only.",
    PostVerdictSchema.extend(onAttempt.shape),
    async ({ project, attempt, ...input }) => {
      const verdict = await service.postVerdict(actor, { ...projectPath(project), attempt, ...input });
      return answer(`${verdict.recommendation} on ${verdict.head}`, { verdict });
    },
  );

  tool(
    "list_verdicts",
    "An attempt's verdicts on every head, oldest first.",
    onAttempt,
    async ({ project, attempt }) => {
      const verdicts = await service.listVerdicts(actor, { ...projectPath(project), attempt });
      return answer(`${verdicts.length} verdicts`, { verdicts });
    },
  );

  tool(
    "select_attempt",
    "Select one of the task's open attempts as its merge request, approving its current head and closing the " +
      "task's other active attempts. The task's creator or the project owner may.",
    SelectionSchema.extend(onTask.shape),
    async ({ project, task, attempt }) => {
      return mergeRequestAnswer(await service.selectAttempt(actor, { ...projectPath(project), task, attempt }));
    },
  );

  tool(
    "approve_merge_request",
    "Approve the task's merge request at its source attempt's current head, e.g. after it was dequeued and fixed.",
    onTask,
    async ({ project, task }) => {
      return mergeRequestAnswer(await service.approveMergeRequest(actor, { ...projectPath(project), task }));
    },
  );

  tool("cancel_merge_request", "Cancel the task's open merge request.", onTask, async ({ project, task }) => {
    return mergeRequestAnswer(await service.cancelMergeRequest(actor, { ...projectPath(project), task }));
  });

  tool(
    "get_dequeue",
    "Why the task's merge request was last dequeued, with details: for a conflict, each file's three-way hunks.",
    onTask,
    async ({ project, task }) => {
      const dequeue = await service.getDequeue(actor, { ...projectPath(project), task });
      return answer(`dequeued: ${dequeue.reason}`, { dequeue });
    },
  );

  tool(
    "open_vote",
    "Open a vote to select the task's attempt, under the `vote` selection policy: the attempts passing now are its " +
      "candidates. Optionally with a `deadline` for ballots. The task's creator or the project owner may.",
    OpenVoteSchema.extend(onTask.shape),
    async ({ project, task, deadline }) => {
      return voteAnswer(await service.openVote(actor, { ...projectPath(project), task, deadline }));
    },
  );

  tool(
    "cast_vote",
    "Back one candidate in the task's open vote. You have one ballot, shared with your aliases: casting again " +
      "replaces it. Not for your own attempts.",
    BallotSchema.extend(onTask.shape),
    async ({ project, task, attempt }) => {
      return voteAnswer(await service.castVote(actor, { ...projectPath(project), task, attempt }));
    },
  );

  tool(
    "add_vote_candidate",
    "Add an attempt that passes now to the task's open vote, e.g. one pushed and passing again after a push " +
      "withdrew it. The task's creator or the project owner may.",
    VoteCandidateSchema.extend(onTask.shape),
    async ({ project, task, attempt }) => {
      return voteAnswer(await service.addVoteCandidate(actor, { ...projectPath(project), task, attempt }));
    },
  );

  tool(
    "close_vote",
    "Close the task's open vote, selecting the candidate with the most ballots as its merge request. On a tie, " +
      "name one of the tied candidates as `attempt`. Refused while a candidate is being scored (a follow of the " +
      "task branch moved it to a merge not scored yet, or its head is being rescored): close it once scoring " +
      "finishes. The task's creator or the project owner may.",
    CloseVoteSchema.extend(onTask.shape),
    async ({ project, task, attempt }) => {
      const { vote, mergeRequest } = await service.closeVote(actor, { ...projectPath(project), task, attempt });
      const summary =
        mergeRequest === null
          ? `${vote.task}'s vote closed without a selection`
          : `${vote.task}'s vote selected ${mergeRequest.attempt}; merge request is ${mergeRequest.state}`;
      return answer(summary, { vote, mergeRequest });
    },
  );

  tool(
    "get_vote",
    "The task's latest vote: each candidate's tally, your own ballot, and its winner once closed.",
    onTask,
    async ({ project, task }) => voteAnswer(await service.getVote(actor, { ...projectPath(project), task })),
  );

  return server;
}
