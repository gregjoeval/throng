// The product API, mounted at `/api` and described by the OpenAPI document at `/api/openapi.json`.
// Access does not sit in front of it: machine clients use Throng bearer tokens. Only `/me` and
// `/tokens` also accept an Access session, so a human can mint their first token. Over the service
// binding (see `app.ts`), those, the project routes and the read API (`browse-api.ts`) the browser
// needs also take throng-web's forwarded identity. Handlers stay thin: they call services, which
// throw `ServiceError`s that `onError` turns into the error shape.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import { json, ProjectPathSchema } from "./api-shared.ts";
import { bearerAuth, bearerOrAccess, bearerOrForwarded } from "./auth.ts";
import type { AuthEnv, AuthOptions } from "./auth.ts";
import { browseRoutes } from "./browse-api.ts";
import { CONFIG_NAME, MAX_CHECK_TIMEOUT_MS, MAX_CONFIG_BYTES, METRIC_ORDERS, parseConfig } from "./config.ts";
import { dequeueRoutes } from "./dequeue-api.ts";
import type { DiffCache } from "./diff.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import { FORWARDED_EMAIL_HEADER } from "./forwarded.ts";
import { LOG_CONTENT_TYPE, LOG_RETENTION_DAYS, MAX_LOG_BYTES, missingLog } from "./logs.ts";
import type { LogStore } from "./logs.ts";
import { DEQUEUE_REASONS, MERGE_REQUEST_STATES } from "./merge-requests.ts";
import { MAX_PROJECT_HANDLE, PROJECT_HANDLE, projectService } from "./projects.ts";
import type { Repos } from "./repos.ts";
import { CHECK_OUTCOMES, GATES } from "./results.ts";
import { ATTEMPT_SCORING_STATUSES, RUN_STATUSES, SCORING_TRIGGERS } from "./scoring.ts";
import { ATTEMPT_STATES, TASK_STATES } from "./task-store.ts";
import { taskService } from "./tasks.ts";
import type { TaskBackend } from "./tasks.ts";
import { DEFAULT_TOKEN_TTL_SECONDS, listTokens, MAX_TOKEN_TTL_SECONDS, mintToken, revokeToken } from "./tokens.ts";
import type { Token } from "./tokens.ts";
import type { User } from "./users.ts";

const UserSchema = z
  .object({ id: z.string(), handle: z.string(), email: z.string(), createdAt: z.string() })
  .openapi("User");

const TokenSchema = z
  .object({
    id: z.string(),
    agent: z.string().nullable(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Token");

const MeSchema = z
  .object({
    user: UserSchema,
    agent: z.string().nullable().openapi({ description: "The agent alias the caller's token acts under." }),
    token: z
      .object({ id: z.string(), expiresAt: z.string() })
      .nullable()
      .openapi({ description: "The caller's token; null under an Access session." }),
  })
  .openapi("Me");

const MintTokenSchema = z
  .object({
    agent: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^\p{C}()]+$/u, "agent must be printable text without parentheses")
      .optional()
      .openapi({ description: "An agent alias of the caller, e.g. `claude`. Omit for the human." }),
    expiresIn: z
      .number()
      .int()
      .min(1)
      .max(MAX_TOKEN_TTL_SECONDS)
      .optional()
      .openapi({ description: `Seconds until the token expires. Defaults to ${DEFAULT_TOKEN_TTL_SECONDS}.` }),
  })
  .openapi("MintToken");

const MintedTokenSchema = TokenSchema.extend({
  token: z.string().openapi({ description: "The plaintext `thr_…` token. It is shown only in this response." }),
}).openapi("MintedToken");

const ProjectSchema = z
  .object({
    id: z.string().openapi({ description: "The opaque project id, which names its repos.", example: "k3x9q2" }),
    handle: z.string().openapi({ example: "throng" }),
    owner: z.object({ id: z.string(), handle: z.string().openapi({ example: "greg" }) }),
    createdAt: z.string(),
  })
  .openapi("Project");

const CreateProjectSchema = z
  .object({
    handle: z
      .string()
      .max(MAX_PROJECT_HANDLE)
      .regex(PROJECT_HANDLE, "handle must be lowercase letters and digits, joined by single dashes")
      .openapi({ description: "The project's handle, unique among the owner's projects.", example: "throng" }),
  })
  .openapi("CreateProject");

const UserRefSchema = z.object({ id: z.string(), handle: z.string().openapi({ example: "greg" }) }).openapi("UserRef");

const TaskSchema = z
  .object({
    ref: z.string().openapi({ description: "The task's reference.", example: "t42" }),
    number: z.number().int().openapi({ description: "Per project, 1-based and never reused.", example: 42 }),
    title: z.string(),
    body: z.string().openapi({ description: "Markdown." }),
    creator: UserRefSchema,
    state: z.enum(TASK_STATES),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
    closedBy: UserRefSchema.nullable(),
    attemptLimit: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Overrides the project's cap on active attempts; null to use the project's." }),
  })
  .openapi("Task");

const AttemptSchema = z
  .object({
    ref: z.string().openapi({ description: "The attempt's reference.", example: "t42a3" }),
    task: z.number().int().openapi({ example: 42 }),
    number: z.number().int().openapi({ description: "Per task, 1-based and never reused.", example: 3 }),
    author: UserRefSchema,
    state: z.enum(ATTEMPT_STATES),
    fork: z.string().openapi({ description: "The logical fork name, kept for the attempt's life.", example: "t42a3" }),
    branch: z.string().nullable().openapi({ description: "The origin branch a push created it from." }),
    note: z.string().openapi({ description: "Markdown." }),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
    mergedSha: z.string().nullable(),
    archivedSha: z.string().nullable(),
    scoring: z
      .object({
        status: z.enum(ATTEMPT_SCORING_STATUSES),
        sha: z.string().nullable().openapi({ description: "The head it applies to; null before any push." }),
      })
      .openapi("AttemptScoring", {
        description:
          "The current head's scoring status, for polling. `none` when the head has no run yet, or its run was cancelled.",
      }),
    mergeRequest: z
      .object({
        state: z.enum(MERGE_REQUEST_STATES),
        lastDequeue: z.object({ reason: z.enum(DEQUEUE_REASONS) }).nullable(),
      })
      .nullable()
      .openapi("AttemptMergeRequest", {
        description:
          "The latest merge request this attempt is the source of, for polling: its state and why it last left the queue. " +
          "Null when it was never selected.",
      }),
  })
  .openapi("Attempt");

const ScoringRunFields = z.object({
  id: z.number().int(),
  ref: z.string().openapi({ description: "The attempt it scores.", example: "t42a3" }),
  sha: z.string().openapi({ description: "The head it scores." }),
  trigger: z.enum(SCORING_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  requestedBy: UserRefSchema.nullable(),
  agent: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const ScoringSchema = z
  .object({
    queued: z.boolean().openapi({ description: "Whether this request queued a new run." }),
    reason: z.string().nullable().openapi({
      description: "Why nothing was queued: the head is already queued, running or scored.",
      example: "already scored",
    }),
    run: ScoringRunFields.openapi("ScoringRun", {
      description: "The run that was queued, or the one already covering the head.",
    }),
  })
  .openapi("ScoringRequest");

const MetricsSchema = z.record(z.string(), z.number()).openapi({ example: { coverage: 81.5 } });

const ScoringResultSchema = z
  .object({
    base: z.string().nullable().openapi({
      description: "The merge-base of the head and `origin/main` at scoring time; null with no shared history.",
    }),
    config: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("valid") }),
        z.object({ kind: z.literal("invalid"), error: z.string() }),
      ])
      .openapi({ description: "How the `.throng/config.yml` on `origin/main` it was scored under parsed." }),
    gate: z.enum(GATES).openapi({ description: "Passed when every required check passed." }),
    checks: z.array(
      z
        .object({
          name: z.string().openapi({ example: "test" }),
          required: z.boolean(),
          outcome: z.enum(CHECK_OUTCOMES),
          durationMs: z.number(),
          metrics: MetricsSchema.openapi({ description: "The metrics it declared and reported, by name." }),
          notes: z.array(z.string()).openapi({ description: "Ignored metrics, or why it was skipped." }),
          error: z.string().optional().openapi({ description: "Only on the `config` entry of an invalid config." }),
        })
        .openapi("CheckResult"),
    ),
    builtin: z
      .object({ filesChanged: z.number(), additions: z.number(), deletions: z.number(), durationMs: z.number() })
      .openapi({ description: "Diff size against the base." }),
    preview: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("none") }),
        z.object({
          status: z.literal("ready"),
          url: z.string().openapi({ description: "Where the Preview is served." }),
        }),
        z.object({ status: z.literal("failed") }),
        z.object({
          status: z.literal("errored"),
          error: z.string().openapi({ description: "The infrastructure error it kept failing on." }),
        }),
      ])
      .openapi("PreviewResult", {
        description:
          "The attempt's Worker Preview: `none` without a `preview` config or a passing gate, `failed` when its build or deploy failed, `errored` when the infrastructure kept failing. Neither changes the gate.",
      }),
    logs: z.array(z.string()).openapi({
      description:
        "The run's stored logs by name, in run order, for `GET …/runs/{runId}/logs/{name}`. A step that never ran has none.",
      example: ["setup.1", "test"],
    }),
  })
  .openapi("ScoringResult");

const CurrentResultSchema = ScoringResultSchema.extend({
  run: z.number().int().openapi({ description: "The run it came from." }),
  finishedAt: z.string(),
  metrics: MetricsSchema.openapi({ description: "Every check's metrics in one map; metric names are unique." }),
}).openapi("CurrentResult", {
  description: "The attempt's current result: the latest `done` run for its current head.",
});

const RunDetailSchema = ScoringRunFields.extend({
  superseded: z.boolean().openapi({ description: "Whether its head is no longer the attempt's current head." }),
  error: z.string().nullable().openapi({ description: "What ended it, once `errored`." }),
  result: ScoringResultSchema.nullable().openapi({ description: "Its result, once `done`." }),
}).openapi("RunDetail", { description: "A scoring run, with its result or error." });

const RunPathSchema = ProjectPathSchema.extend({
  runId: z.coerce.number().int().min(1).openapi({ description: "A scoring run's id.", example: 7 }),
});

const ScoringStatusSchema = z
  .object({
    status: z.enum(ATTEMPT_SCORING_STATUSES),
    sha: z.string().nullable().openapi({ description: "The head it applies to; null before any push." }),
    result: CurrentResultSchema.optional().openapi({
      description: "Absent until the head has a `done` run. Results for older heads are superseded, never current.",
    }),
  })
  .openapi("ScoringStatus");

const TaskArenaSchema = z
  .object({
    task: z.string().openapi({ example: "t42" }),
    attempts: z.array(
      ScoringStatusSchema.extend({
        ref: z.string().openapi({ example: "t42a3" }),
        state: z.enum(ATTEMPT_STATES),
        author: UserRefSchema,
      }).openapi("ArenaAttempt"),
    ),
  })
  .openapi("TaskArena");

const ActorRefSchema = UserRefSchema.extend({
  agent: z.string().nullable().openapi({ description: "The agent alias they acted under, if any." }),
}).openapi("ActorRef");

const MergeRequestSchema = z
  .object({
    task: z.string().openapi({ description: "The task, which also names its merge request.", example: "t42" }),
    attempt: z.string().openapi({ description: "The source attempt.", example: "t42a3" }),
    state: z.enum(MERGE_REQUEST_STATES),
    approvedHead: z.string().openapi({ description: "The only head that can land." }),
    approvedBy: ActorRefSchema,
    approvedAt: z.string(),
    queuedAt: z.string().nullable().openapi({ description: "When it entered the queue, while queued or landing." }),
    position: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Its 1-based place in the merge queue while queued or landing; the landing one is 1." }),
    lastDequeue: z
      .object({ reason: z.enum(DEQUEUE_REASONS), at: z.string() })
      .nullable()
      .openapi({ description: "Why it last left the queue without landing." }),
    mergeSha: z.string().nullable().openapi({ description: "The merge commit on `main`, once merged." }),
    mergedAt: z.string().nullable(),
    createdAt: z.string(),
    createdBy: ActorRefSchema,
  })
  .openapi("MergeRequest");

const SelectionSchema = z
  .object({ attempt: z.string().openapi({ description: "An open attempt of the task.", example: "t42a3" }) })
  .openapi("Selection");

const MergeQueueSchema = z
  .object({
    queue: z.array(
      z
        .object({
          position: z.number().int().openapi({ description: "1-based; the landing merge request is first." }),
          task: z.string().openapi({ example: "t42" }),
          attempt: z.string().openapi({ example: "t42a3" }),
          state: z.enum(MERGE_REQUEST_STATES),
        })
        .openapi("MergeQueueEntry"),
    ),
  })
  .openapi("MergeQueue");

const AttemptLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .nullable()
  .openapi({ description: "Overrides the project's cap on active attempts; null to use the project's." });

const CreateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(65_536).optional().openapi({ description: "Markdown." }),
    attemptLimit: AttemptLimitSchema.optional(),
  })
  .openapi("CreateTask");

const EditTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(65_536).optional().openapi({ description: "Markdown." }),
    attemptLimit: AttemptLimitSchema.optional(),
  })
  .openapi("EditTask");

const CreateAttemptsSchema = z
  .object({
    count: z.number().int().min(1).max(100).optional().openapi({ description: "Attempts to create. Defaults to 1." }),
    note: z.string().max(65_536).optional().openapi({ description: "Markdown, set on every new attempt." }),
  })
  .openapi("CreateAttempts");

const EditAttemptSchema = z
  .object({ note: z.string().max(65_536).openapi({ description: "Markdown." }) })
  .openapi("EditAttempt");

const HandOffSchema = z
  .object({
    to: z.string().min(1).openapi({ description: "The handle of the user who becomes the author.", example: "bob" }),
  })
  .openapi("HandOff");

const TaskPathSchema = ProjectPathSchema.extend({
  t: z.string().openapi({ description: "A task reference: `t42` or `42`.", example: "t42" }),
});

const AttemptPathSchema = ProjectPathSchema.extend({
  a: z.string().openapi({ description: "An attempt reference.", example: "t42a3" }),
});

const RunLogPathSchema = RunPathSchema.extend({
  name: z.string().openapi({
    description: "The log's name: a check's name, `setup.<n>` for the nth setup command, or `preview.deploy`.",
    example: "test",
  }),
});

const ConfigNameSchema = z.string().regex(CONFIG_NAME);

const ConfigSchema = z
  .object({
    setup: z.array(z.string()).openapi({ description: "Commands run once, in order, before the checks." }),
    network: z.object({
      allow: z.array(z.string()).openapi({ description: "Extra HTTPS hosts checks may reach, lowercased." }),
    }),
    checks: z
      .array(
        z.object({
          name: ConfigNameSchema.openapi({ example: "test" }),
          command: z.string().openapi({ example: "pnpm test" }),
          required: z.boolean().openapi({ description: "Whether the gate needs it to pass." }),
          timeoutMs: z
            .number()
            .int()
            .max(MAX_CHECK_TIMEOUT_MS)
            .openapi({ description: "Defaults to 10 minutes.", example: 600_000 }),
          metrics: z.array(
            z.object({
              name: ConfigNameSchema.openapi({ example: "coverage" }),
              unit: z.string().nullable().openapi({ example: "%" }),
              order: z
                .enum(METRIC_ORDERS)
                .openapi({ description: "`asc` when lower is better, `desc` when higher is." }),
            }),
          ),
        }),
      )
      .openapi({ description: "Run in order." }),
    preview: z
      .object({ command: z.string().nullable().openapi({ description: "Builds before the preview deploys." }) })
      .nullable()
      .openapi({ description: "Null when the project doesn't deploy previews." }),
    attempts: z.object({
      limit: z.number().int().nullable().openapi({ description: "Null to use the default cap on active attempts." }),
    }),
  })
  .openapi("Config");

const ConfigResultSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("valid"), config: ConfigSchema }),
    z.object({
      kind: z.literal("invalid"),
      error: z.string().openapi({
        description: "One line per problem, each prefixed with its path.",
        example: "checks[0].metrics[0].order: order is required: ascending, asc, descending or desc",
      }),
    }),
  ])
  .openapi("ConfigResult");

const security: Record<string, string[]>[] = [{ bearer: [] }, { access: [] }];
const bearerOnly: Record<string, string[]>[] = [{ bearer: [] }];
const bearerOrWeb: Record<string, string[]>[] = [{ bearer: [] }, { web: [] }];
const unauthorized = errorResponse("No valid bearer token or Access session.");
const unauthorizedBearer = errorResponse("No valid bearer token.");

export interface ApiOptions extends AuthOptions {
  /** The environment's repos: production passes the Artifacts-backed `reposFor`, tests a fake. */
  repos?: (env: AccessBindings) => Repos;
  /** A project's task backend: production passes its Durable Object, tests an in-process store. */
  tasks?: (env: AccessBindings) => (projectId: string) => TaskBackend;
  /** The environment's logs bucket: production passes its R2 binding, tests one in memory. */
  logs?: (env: AccessBindings) => LogStore;
  /** Where commit diffs are cached: the Workers Cache API by default, none outside a Worker. */
  diffCache?: (env: AccessBindings) => DiffCache | undefined;
}

/** The Workers Cache API's default cache, when running in a Worker. */
function workersCache(): DiffCache | undefined {
  return (globalThis as { caches?: { default?: DiffCache } }).caches?.default;
}

function noRepos(): Repos {
  throw new Error("this API was built without repos");
}

function noTasks(): (projectId: string) => TaskBackend {
  throw new Error("this API was built without a task backend");
}

function noLogs(): LogStore {
  throw new Error("this API was built without a logs bucket");
}

type Bearer = ReturnType<typeof bearerAuth>;

const AUTHOR_ONLY = "Only the attempt's author, or their agents, may.";
const OWNER_ONLY = "Only the project owner may.";
const TASK_MANAGERS = "Only the project owner or the task's creator may.";
const RESCORERS = "Only the attempt's author (or their agents), the task's creator or the project owner may.";

/** A task transition route: `POST …/tasks/{t}/<verb>`. */
function taskTransition<V extends string>(
  bearer: Bearer,
  verb: V,
  operationId: string,
  summary: string,
  forbidden: string,
  conflicts: string[],
) {
  return createRoute({
    method: "post",
    path: `/projects/{owner}/{project}/tasks/{t}/${verb}`,
    operationId,
    tags: ["Tasks"],
    summary,
    security: bearerOnly,
    middleware: [bearer] as const,
    request: { params: TaskPathSchema },
    responses: {
      200: { description: "The task after the transition.", ...json(TaskSchema) },
      400: errorResponse("The task reference is invalid."),
      401: unauthorizedBearer,
      403: errorResponse(forbidden),
      404: errorResponse("No such project or task."),
      409: errorResponse(`\`invalidState\`: ${conflicts.join(" ")}`),
    },
  });
}

/** A merge request action route: `POST …/tasks/{t}/merge-request/<verb>`. */
function mergeRequestAction<V extends string>(
  bearer: Bearer,
  verb: V,
  operationId: string,
  summary: string,
  description: string,
) {
  return createRoute({
    method: "post",
    path: `/projects/{owner}/{project}/tasks/{t}/merge-request/${verb}`,
    operationId,
    tags: ["Merge queue"],
    summary,
    description,
    security: bearerOnly,
    middleware: [bearer] as const,
    request: { params: TaskPathSchema },
    responses: {
      200: { description: "The merge request after the action.", ...json(MergeRequestSchema) },
      400: errorResponse("The task reference is invalid."),
      401: unauthorizedBearer,
      403: errorResponse(TASK_MANAGERS),
      404: errorResponse("No such project or task."),
      409: errorResponse(
        "`invalidState`: the task has no open merge request, or it isn't in a state that allows this.",
      ),
    },
  });
}

/** What an attempt action route documents beyond its verb. */
interface AttemptAction<S extends z.ZodType> {
  operationId: string;
  tags: string[];
  summary: string;
  description?: string;
  /** Who may, for the 403. */
  forbidden: string;
  /** The 409 causes. */
  conflict: string;
  /** The 200 body's description and schema. */
  ok: { description: string; schema: S };
}

/** An attempt action route: `POST …/attempts/{a}/<verb>`, bearer-only. */
function attemptAction<V extends string, S extends z.ZodType>(bearer: Bearer, verb: V, action: AttemptAction<S>) {
  return createRoute({
    method: "post",
    path: `/projects/{owner}/{project}/attempts/{a}/${verb}`,
    operationId: action.operationId,
    tags: action.tags,
    summary: action.summary,
    ...(action.description === undefined ? {} : { description: action.description }),
    security: bearerOnly,
    middleware: [bearer] as const,
    request: { params: AttemptPathSchema },
    responses: {
      200: { description: action.ok.description, ...json(action.ok.schema) },
      400: errorResponse("The attempt reference is invalid."),
      401: unauthorizedBearer,
      403: errorResponse(action.forbidden),
      404: errorResponse("No such project or attempt."),
      409: errorResponse(action.conflict),
    },
  });
}

/** An attempt transition route: `POST …/attempts/{a}/<verb>`. */
function attemptTransition<V extends string>(
  bearer: Bearer,
  verb: V,
  operationId: string,
  summary: string,
  forbidden: string,
  conflicts: string[],
) {
  return attemptAction(bearer, verb, {
    operationId,
    tags: ["Attempts"],
    summary,
    forbidden,
    conflict: conflicts.join(" "),
    ok: { description: "The attempt after the transition.", schema: AttemptSchema },
  });
}

/** A scoring request route: `POST …/attempts/{a}/<verb>`. */
function scoringRoute<V extends string>(
  bearer: Bearer,
  verb: V,
  operationId: string,
  summary: string,
  description: string,
  forbidden: string,
  conflict: string,
) {
  return attemptAction(bearer, verb, {
    operationId,
    tags: ["Scoring"],
    summary,
    description,
    forbidden,
    conflict: `\`invalidState\`: ${conflict}, or its fork has no commits.`,
    ok: { description: "The run now covering the attempt's head.", schema: ScoringSchema },
  });
}

/** A token row as the API shows it. */
function publicToken({ id, agent, expires_at, revoked_at, created_at }: Token): z.infer<typeof TokenSchema> {
  return { id, agent, expiresAt: expires_at, revokedAt: revoked_at, createdAt: created_at };
}

/** A user row as the API shows it. */
function publicUser({ id, handle, email, created_at }: User): z.infer<typeof UserSchema> {
  return { id, handle, email, createdAt: created_at };
}

export function apiRoutes(options: ApiOptions = {}) {
  const now = options.now ?? (() => new Date());
  const auth = bearerOrAccess(options);
  const bearer = bearerAuth(options.now === undefined ? {} : { now: options.now });
  const browser = bearerOrForwarded(options);
  const reposFor = options.repos ?? noRepos;
  const projects = (env: AccessBindings) => projectService({ db: env.DB, repos: reposFor(env) });
  const backendFor = options.tasks ?? noTasks;
  const logsFor = options.logs ?? noLogs;
  const tasks = (env: AccessBindings) => taskService({ db: env.DB, backend: backendFor(env) });
  const taskPath = ({ t, ...rest }: z.infer<typeof TaskPathSchema>) => ({ ...rest, task: t });
  const attemptPath = ({ a, ...rest }: z.infer<typeof AttemptPathSchema>) => ({ ...rest, attempt: a });

  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalidRequest", z.prettifyError(result.error)), 400);
      return undefined;
    },
  });

  api.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description: "A Throng token (`thr_…`).",
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "access", {
    type: "apiKey",
    in: "header",
    name: "Cf-Access-Jwt-Assertion",
    description: "A Cloudflare Access session, added by Access for signed-in humans.",
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "web", {
    type: "apiKey",
    in: "header",
    name: FORWARDED_EMAIL_HEADER,
    description:
      "The signed-in user throng-web forwards over its service binding. The public hostname rejects any " +
      "request carrying this header.",
  });

  const routes = api
    .openapi(
      createRoute({
        method: "get",
        path: "/me",
        operationId: "getMe",
        tags: ["Users"],
        summary: "The caller: their user, and the agent alias and token they act with",
        security,
        middleware: [auth] as const,
        responses: {
          200: { description: "The caller.", content: { "application/json": { schema: MeSchema } } },
          401: unauthorized,
        },
      }),
      (c) => {
        const { user, agent } = c.var.actor;
        const token = c.var.token === null ? null : { id: c.var.token.id, expiresAt: c.var.token.expires_at };
        return c.json({ user: publicUser(user), agent, token }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/tokens",
        operationId: "mintToken",
        tags: ["Tokens"],
        summary: "Mint a token for the caller or one of their agent aliases",
        description:
          "Returns the plaintext once. A token-authenticated caller can't mint a token that outlives its own, " +
          "and an agent's token can only mint tokens for that same agent.",
        security,
        middleware: [auth] as const,
        request: {
          body: { required: false, content: { "application/json": { schema: MintTokenSchema } } },
        },
        responses: {
          201: { description: "The new token.", content: { "application/json": { schema: MintedTokenSchema } } },
          400: errorResponse("The request is invalid, e.g. `expiresIn` is above 7 days."),
          401: unauthorized,
          403: errorResponse("An agent's token tried to mint for the human or another agent."),
        },
      }),
      async (c) => {
        const body = c.req.valid("json") ?? {};
        const { actor, token: caller } = c.var;
        if (actor.agent !== null && body.agent !== undefined && body.agent !== actor.agent) {
          return c.json(errorBody("forbidden", "an agent's token can only mint tokens for that agent"), 403);
        }
        const at = now();
        let ttlSeconds = body.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS;
        if (caller !== null) {
          // A token can't be used to extend itself: what it mints expires no later than it does.
          const remaining = Math.floor((Date.parse(caller.expires_at) - at.getTime()) / 1000);
          if (body.expiresIn === undefined) ttlSeconds = Math.min(ttlSeconds, remaining);
          if (ttlSeconds > remaining || ttlSeconds < 1) {
            return c.json(errorBody("invalidRequest", "a token can't mint a token that outlives it"), 400);
          }
        }
        const { token, plaintext } = await mintToken(c.env.DB, {
          userId: actor.user.id,
          agent: actor.agent ?? body.agent ?? null,
          ttlSeconds,
          now: at,
        });
        return c.json({ ...publicToken(token), token: plaintext }, 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/tokens",
        operationId: "listTokens",
        tags: ["Tokens"],
        summary: "List the caller's tokens, without secrets",
        description: "An agent's token lists only that agent's tokens.",
        security,
        middleware: [auth] as const,
        responses: {
          200: {
            description: "The caller's tokens, newest first, including expired and revoked ones.",
            content: { "application/json": { schema: z.object({ tokens: z.array(TokenSchema) }) } },
          },
          401: unauthorized,
        },
      }),
      async (c) => {
        const { user, agent } = c.var.actor;
        const tokens = await listTokens(c.env.DB, user.id, agent);
        return c.json({ tokens: tokens.map(publicToken) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/tokens/{id}",
        operationId: "revokeToken",
        tags: ["Tokens"],
        summary: "Revoke one of the caller's tokens",
        description: "Revoking an already revoked token keeps its first revocation time.",
        security,
        middleware: [auth] as const,
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: { description: "The revoked token.", content: { "application/json": { schema: TokenSchema } } },
          401: unauthorized,
          404: errorResponse("The caller has no token with this id."),
        },
      }),
      async (c) => {
        const { user, agent } = c.var.actor;
        const revoked = await revokeToken(c.env.DB, {
          userId: user.id,
          agent,
          id: c.req.valid("param").id,
          now: now(),
        });
        if (revoked === null) return c.json(errorBody("notFound", "no such token"), 404);
        return c.json(publicToken(revoked), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects",
        operationId: "listProjects",
        tags: ["Projects"],
        summary: "List the projects the caller owns",
        description:
          "The projects owned by the caller's human, also when an agent's token calls, ordered by handle. " +
          "Other owners' projects can still be read by `owner/project`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        responses: {
          200: {
            description: "The caller's projects.",
            content: { "application/json": { schema: z.object({ projects: z.array(ProjectSchema) }) } },
          },
          401: unauthorizedBearer,
        },
      }),
      async (c) => {
        const list = await projects(c.env).list(c.var.actor);
        return c.json({ projects: list }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects",
        operationId: "createProject",
        tags: ["Projects"],
        summary: "Create a project owned by the caller",
        description:
          "The caller's human becomes the owner, also when an agent's token calls. Creates the project's " +
          "origin repo with `main` as its default branch.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { body: { required: true, content: { "application/json": { schema: CreateProjectSchema } } } },
        responses: {
          201: { description: "The new project.", content: { "application/json": { schema: ProjectSchema } } },
          400: errorResponse("The handle is invalid."),
          401: unauthorizedBearer,
          409: errorResponse("The caller already owns a project with this handle."),
        },
      }),
      async (c) => {
        const project = await projects(c.env).create(c.var.actor, c.req.valid("json"));
        return c.json(project, 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}",
        operationId: "getProject",
        tags: ["Projects"],
        summary: "Get a project by its owner's handle and its own",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: ProjectPathSchema },
        responses: {
          200: { description: "The project.", content: { "application/json": { schema: ProjectSchema } } },
          401: unauthorizedBearer,
          404: errorResponse("No such owner, or the owner has no project with this handle."),
        },
      }),
      async (c) => {
        const project = await projects(c.env).get(c.var.actor, c.req.valid("param"));
        return c.json(project, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks",
        operationId: "createTask",
        tags: ["Tasks"],
        summary: "Create a task in a project",
        description: "Any signed-in user may. The caller's human is its creator. The task starts open.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: ProjectPathSchema, body: { required: true, ...json(CreateTaskSchema) } },
        responses: {
          201: { description: "The new task.", ...json(TaskSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project."),
        },
      }),
      async (c) => {
        const task = await tasks(c.env).createTask(c.var.actor, { ...c.req.valid("param"), ...c.req.valid("json") });
        return c.json(task, 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tasks",
        operationId: "listTasks",
        tags: ["Tasks"],
        summary: "List a project's tasks",
        description: "Obsolete tasks are left out unless `state=obsolete` asks for them.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: ProjectPathSchema, query: z.object({ state: z.enum(TASK_STATES).optional() }) },
        responses: {
          200: { description: "The tasks, by number.", ...json(z.object({ tasks: z.array(TaskSchema) })) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project."),
        },
      }),
      async (c) => {
        const list = await tasks(c.env).listTasks(c.var.actor, { ...c.req.valid("param"), ...c.req.valid("query") });
        return c.json({ tasks: list }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tasks/{t}",
        operationId: "getTask",
        tags: ["Tasks"],
        summary: "Get a task by its reference",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema },
        responses: {
          200: { description: "The task.", ...json(TaskSchema) },
          400: errorResponse("The task reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task."),
        },
      }),
      async (c) => c.json(await tasks(c.env).getTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/projects/{owner}/{project}/tasks/{t}",
        operationId: "editTask",
        tags: ["Tasks"],
        summary: "Edit a task's title, body or attempt limit",
        description: "The project owner or the task's creator may. Obsolete tasks can't be edited.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema, body: { required: true, ...json(EditTaskSchema) } },
        responses: {
          200: { description: "The edited task.", ...json(TaskSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          403: errorResponse(TASK_MANAGERS),
          404: errorResponse("No such project or task."),
          409: errorResponse("`invalidState`: the task is obsolete."),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c.env).editTask(c.var.actor, input), 200);
      },
    )
    .openapi(
      taskTransition(bearer, "close", "closeTask", "Close an open task, and its active attempts", TASK_MANAGERS, [
        "the task isn't open.",
      ]),
      async (c) => c.json(await tasks(c.env).closeTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      taskTransition(bearer, "reopen", "reopenTask", "Reopen a closed task", TASK_MANAGERS, [
        "the task isn't closed, or one of its attempts merged.",
      ]),
      async (c) => c.json(await tasks(c.env).reopenTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      taskTransition(bearer, "obsolete", "obsoleteTask", "Make a task obsolete, and its active attempts", OWNER_ONLY, [
        "the task is already obsolete.",
      ]),
      async (c) => c.json(await tasks(c.env).obsoleteTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      taskTransition(bearer, "restore", "restoreTask", "Restore an obsolete task to closed", OWNER_ONLY, [
        "the task isn't obsolete.",
      ]),
      async (c) => c.json(await tasks(c.env).restoreTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/attempts",
        operationId: "createAttempts",
        tags: ["Attempts"],
        summary: "Fan a task out to new draft attempts, each with its own fork",
        description:
          "Any signed-in user may; the caller's human authors every attempt. Creates `count` attempts or none: " +
          "the batch fails whole if it would exceed the task's cap on active attempts or a fork fails.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema, body: { required: false, ...json(CreateAttemptsSchema) } },
        responses: {
          201: { description: "The new attempts.", ...json(z.object({ attempts: z.array(AttemptSchema) })) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task."),
          409: errorResponse("`invalidState`: the task isn't open; `attemptLimit`: the batch would exceed the cap."),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json({ attempts: await tasks(c.env).createAttempts(c.var.actor, input) }, 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tasks/{t}/attempts",
        operationId: "listAttempts",
        tags: ["Attempts"],
        summary: "List a task's attempts",
        description: "Obsolete attempts are left out unless `state=obsolete` asks for them.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema, query: z.object({ state: z.enum(ATTEMPT_STATES).optional() }) },
        responses: {
          200: { description: "The attempts, by number.", ...json(z.object({ attempts: z.array(AttemptSchema) })) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task."),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("query") };
        return c.json({ attempts: await tasks(c.env).listAttempts(c.var.actor, input) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/attempts/{a}",
        operationId: "getAttempt",
        tags: ["Attempts"],
        summary: "Get an attempt by its reference",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: AttemptPathSchema },
        responses: {
          200: { description: "The attempt.", ...json(AttemptSchema) },
          400: errorResponse("The attempt reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or attempt."),
        },
      }),
      async (c) => c.json(await tasks(c.env).getAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/projects/{owner}/{project}/attempts/{a}",
        operationId: "editAttempt",
        tags: ["Attempts"],
        summary: "Edit an attempt's note",
        description: "Only the attempt's author, or their agents, may. Obsolete attempts can't be edited.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: AttemptPathSchema, body: { required: true, ...json(EditAttemptSchema) } },
        responses: {
          200: { description: "The edited attempt.", ...json(AttemptSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          403: errorResponse(AUTHOR_ONLY),
          404: errorResponse("No such project or attempt."),
          409: errorResponse("`invalidState`: the attempt is obsolete."),
        },
      }),
      async (c) => {
        const input = { ...attemptPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c.env).editAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      attemptTransition(bearer, "open", "openAttempt", "Open a draft attempt for scoring and merging", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't a draft.",
      ]),
      async (c) => c.json(await tasks(c.env).openAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "draft", "draftAttempt", "Return an open attempt to draft", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't open.",
      ]),
      async (c) => c.json(await tasks(c.env).draftAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "close", "closeAttempt", "Close a draft or open attempt", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't active.",
      ]),
      async (c) => c.json(await tasks(c.env).closeAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "reopen", "reopenAttempt", "Reopen a closed attempt as a draft", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't closed or its task isn't open;",
        "`attemptLimit`: the task is at its cap; `conflict`: another active attempt has its branch.",
      ]),
      async (c) => c.json(await tasks(c.env).reopenAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "obsolete", "obsoleteAttempt", "Make an attempt obsolete", OWNER_ONLY, [
        "`invalidState`: the attempt is merged or already obsolete.",
      ]),
      async (c) => c.json(await tasks(c.env).obsoleteAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "restore", "restoreAttempt", "Restore an obsolete attempt to closed", OWNER_ONLY, [
        "`invalidState`: the attempt isn't obsolete.",
      ]),
      async (c) => c.json(await tasks(c.env).restoreAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      scoringRoute(
        bearer,
        "score",
        "scoreAttempt",
        "Score a draft attempt's head now",
        "Drafts aren't scored on push; this queues a run for the head anyway. A head already queued, running " +
          "or scored isn't queued again.",
        AUTHOR_ONLY,
        "the attempt isn't a draft",
      ),
      async (c) => c.json(await tasks(c.env).scoreNow(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      scoringRoute(
        bearer,
        "rescore",
        "rescoreAttempt",
        "Score an open attempt's head again",
        "Queues a new run for the head even if it already has a finished one. A head already queued or running " +
          "isn't queued again.",
        RESCORERS,
        "the attempt isn't open",
      ),
      async (c) => c.json(await tasks(c.env).rescore(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/attempts/{a}/scoring",
        operationId: "getAttemptScoring",
        tags: ["Scoring"],
        summary: "Poll an attempt's scoring: its current head's status and result",
        description:
          "`status` is the current head's latest run that wasn't cancelled, or `none`. `result` is the latest " +
          "`done` run for the head, so it stays while a rescore of the same head runs.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: AttemptPathSchema },
        responses: {
          200: { description: "The attempt's scoring.", ...json(ScoringStatusSchema) },
          400: errorResponse("The attempt reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or attempt."),
        },
      }),
      async (c) => c.json(await tasks(c.env).getScoring(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tasks/{t}/arena",
        operationId: "getTaskArena",
        tags: ["Scoring"],
        summary: "The arena: the current result of every attempt in a task",
        description:
          "Every attempt, obsolete ones included, by number, with its state, its scoring status and, once its current head has a " +
          "`done` run, that result: `base`, the gate, the checks and every metric in one `metrics` map.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema },
        responses: {
          200: { description: "The task's attempts with their current results.", ...json(TaskArenaSchema) },
          400: errorResponse("The task reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task."),
        },
      }),
      async (c) => c.json(await tasks(c.env).taskArena(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/attempts/{a}/runs",
        operationId: "listAttemptRuns",
        tags: ["Scoring"],
        summary: "List an attempt's scoring runs",
        description: "Its whole run history, newest first, including superseded and cancelled runs.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: AttemptPathSchema },
        responses: {
          200: { description: "The runs, newest first.", ...json(z.object({ runs: z.array(RunDetailSchema) })) },
          400: errorResponse("The attempt reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or attempt."),
        },
      }),
      async (c) => {
        const runs = await tasks(c.env).listScoringRuns(c.var.actor, attemptPath(c.req.valid("param")));
        return c.json({ runs }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/runs/{runId}",
        operationId: "getRun",
        tags: ["Scoring"],
        summary: "Get one scoring run",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: RunPathSchema },
        responses: {
          200: { description: "The run.", ...json(RunDetailSchema) },
          400: errorResponse("The run id is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or run."),
        },
      }),
      async (c) => {
        const { runId, ...path } = c.req.valid("param");
        return c.json(await tasks(c.env).getScoringRun(c.var.actor, { ...path, run: runId }), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/attempts/{a}/handoff",
        operationId: "handOffAttempt",
        tags: ["Attempts"],
        summary: "Hand an active attempt to another user",
        description:
          "Only the attempt's author, or their agents, may, and only while it is a draft or open. " +
          "The user named by `to` becomes its author at once, and the git proxy checks the new author " +
          "on the next push, so the old author's pushes are refused from then on. Journals `handedOff`.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: AttemptPathSchema, body: { required: true, ...json(HandOffSchema) } },
        responses: {
          200: { description: "The attempt with its new author.", ...json(AttemptSchema) },
          400: errorResponse("The request is invalid, or `to` already authors the attempt."),
          401: unauthorizedBearer,
          403: errorResponse(AUTHOR_ONLY),
          404: errorResponse("No such project, attempt or user."),
          409: errorResponse("`invalidState`: the attempt isn't active."),
        },
      }),
      async (c) => {
        const input = { ...attemptPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c.env).handOffAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/runs/{runId}/logs/{name}",
        operationId: "getRunLog",
        tags: ["Scoring"],
        summary: "Stream one log of a scoring run",
        description:
          "Each setup command, check and preview of a run writes a log. Logs over " +
          `${MAX_LOG_BYTES / (1024 * 1024)} MB keep their head and tail, with a marker between them. Logs are ` +
          `deleted ${LOG_RETENTION_DAYS} days after the run; an expired log is \`notFound\`, like a missing one.`,
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: RunLogPathSchema },
        responses: {
          200: { description: "The log.", content: { "text/plain": { schema: z.string() } } },
          400: errorResponse("The run id is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project, run or log, or the log has expired."),
        },
      }),
      async (c) => {
        const { runId, name, ...path } = c.req.valid("param");
        const key = await tasks(c.env).runLogKey(c.var.actor, { ...path, run: runId, name });
        const log = await logsFor(c.env).get(key);
        if (log === null) throw missingLog(runId, name);
        // Streamed straight from R2; the typed response only knows the documented string body.
        return c.body(log.body, 200, { "Content-Type": LOG_CONTENT_TYPE }) as never;
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/config/validate",
        operationId: "validateConfig",
        tags: ["Config"],
        summary: "Validate a `.throng/config.yml` before pushing it",
        description:
          "Parses the body as a project config, the same way scoring will. An invalid config is still a 200, " +
          `with \`kind: invalid\`; an empty body is a valid config with every default. Bodies over ${MAX_CONFIG_BYTES} ` +
          "bytes are invalid. Any valid token may call.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: {
          body: {
            required: true,
            content: {
              "application/yaml": {
                schema: z.string().openapi({ example: "checks:\n  - name: test\n    command: pnpm test\n" }),
              },
              "text/plain": { schema: z.string() },
            },
          },
        },
        responses: {
          200: { description: "The parse result.", ...json(ConfigResultSchema) },
          401: unauthorizedBearer,
        },
      }),
      async (c) => c.json(parseConfig(await c.req.text()), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/selection",
        operationId: "selectAttempt",
        tags: ["Merge queue"],
        summary: "Select an attempt as the task's merge request",
        description:
          "Creates the task's merge request from one of its open attempts, approving the attempt's current head, and " +
          "closes the task's other active attempts (archiving their forks). The merge request is `pending`, and enters the " +
          "merge queue once the approved head's latest scoring run is done with a passing gate. A single-attempt task's " +
          "Merge button calls this too. The task's creator or the project owner (or their agents) may; the creator may " +
          "select their own attempt. Journals `selected` and `approved`.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema, body: { required: true, ...json(SelectionSchema) } },
        responses: {
          200: { description: "The new merge request.", ...json(MergeRequestSchema) },
          400: errorResponse("The request is invalid, or the attempt isn't one of the task's."),
          401: unauthorizedBearer,
          403: errorResponse(TASK_MANAGERS),
          404: errorResponse("No such project, task or attempt."),
          409: errorResponse(
            "`invalidState`: the attempt isn't open, the task isn't open, the task already has an open merge request, " +
              "or the attempt has no commits.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c.env).selectAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      mergeRequestAction(
        bearer,
        "approve",
        "approveMergeRequest",
        "Approve the source attempt's current head",
        "Moves a merge request in `needsReview` back to `pending`, approving the source attempt's current head. From " +
          "`pending` it re-approves the same head, which requeues one held after a dequeue (an `errored` one, say). Then, " +
          "as on selection, it enters the queue once the head's gate has passed. Journals `approved`.",
      ),
      async (c) => c.json(await tasks(c.env).approveMergeRequest(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      mergeRequestAction(
        bearer,
        "cancel",
        "cancelMergeRequest",
        "Cancel the task's open merge request",
        "From any open state. A queued or landing one is dequeued with reason `cancelled`. The task stays open and can be " +
          "selected again. Journals `cancelled`.",
      ),
      async (c) => c.json(await tasks(c.env).cancelMergeRequest(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tasks/{t}/merge-request",
        operationId: "getMergeRequest",
        tags: ["Merge queue"],
        summary: "Get a task's merge request",
        description: "Its latest merge request, open or not. `lastDequeue` leaves out the dequeue's details.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema },
        responses: {
          200: { description: "The merge request.", ...json(MergeRequestSchema) },
          400: errorResponse("The task reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task, or the task has no merge request."),
        },
      }),
      async (c) => c.json(await tasks(c.env).getMergeRequest(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/merge-queue",
        operationId: "getMergeQueue",
        tags: ["Merge queue"],
        summary: "The project's merge queue",
        description: "The landing merge request first, then the queued ones, first in first out.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: ProjectPathSchema },
        responses: {
          200: { description: "The queue, front first.", ...json(MergeQueueSchema) },
          401: unauthorizedBearer,
          404: errorResponse("No such project."),
        },
      }),
      async (c) => c.json({ queue: await tasks(c.env).mergeQueue(c.var.actor, c.req.valid("param")) }, 200),
    )
    .route(
      "/",
      browseRoutes({ auth: browser, repos: reposFor, tasks: backendFor, diffCache: options.diffCache ?? workersCache }),
    )
    .route("/", dequeueRoutes({ auth: browser, repos: reposFor, tasks: backendFor, logs: logsFor }));

  api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "Throng API", version: "0.0.0" } });

  api.onError((err, c) => {
    if (err instanceof ServiceError) return c.json(errorBody(err.code, err.message), err.status);
    console.error({ event: "api.error", path: c.req.path, error: String(err) });
    return c.json(errorBody("internal", "internal error"), 500);
  });

  return routes;
}

/** The API's route types, for a typed `hc` client. */
export type ApiRoutes = ReturnType<typeof apiRoutes>;
