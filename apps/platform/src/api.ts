// The product API, mounted at `/api` and described by the OpenAPI document at `/api/openapi.json`.
// Access does not sit in front of it: machine clients use Throng bearer tokens. Only `/me` and
// `/tokens` also accept an Access session, so a human can mint their first token. Over the service
// binding (see `app.ts`), those, the project routes and the read API (`browse-api.ts`) the browser
// needs also take throng-web's forwarded identity. Handlers stay thin: they call services, which
// throw `ServiceError`s that `onError` turns into the error shape.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import { bearerAuth, bearerOrAccess, bearerOrForwarded, type AuthEnv, type AuthOptions } from "./auth.ts";
import { browseRoutes } from "./browse-api.ts";
import { CONFIG_NAME, MAX_CHECK_TIMEOUT_MS, MAX_CONFIG_BYTES, parseConfig } from "./config.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import { FORWARDED_EMAIL_HEADER } from "./forwarded.ts";
import { MAX_PROJECT_HANDLE, PROJECT_HANDLE, projectService } from "./projects.ts";
import type { Repos } from "./repos.ts";
import { ATTEMPT_STATES, TASK_STATES } from "./task-store.ts";
import { taskService, type TaskBackend } from "./tasks.ts";
import { DEFAULT_TOKEN_TTL_SECONDS, listTokens, MAX_TOKEN_TTL_SECONDS, mintToken, revokeToken } from "./tokens.ts";

const UserSchema = z
  .object({ id: z.string(), handle: z.string(), email: z.string(), created_at: z.string() })
  .openapi("User");

const TokenSchema = z
  .object({
    id: z.string(),
    agent: z.string().nullable(),
    expires_at: z.string(),
    revoked_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Token");

const MeSchema = z
  .object({
    user: UserSchema,
    agent: z.string().nullable().openapi({ description: "The agent alias the caller's token acts under." }),
    token: z
      .object({ id: z.string(), expires_at: z.string() })
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
    expires_in: z
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
    created_at: z.string(),
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

const ProjectPathSchema = z.object({
  owner: z.string().openapi({ description: "The owner's handle.", example: "greg" }),
  project: z.string().openapi({ description: "The project's handle.", example: "throng" }),
});

const UserRefSchema = z.object({ id: z.string(), handle: z.string().openapi({ example: "greg" }) }).openapi("UserRef");

const TaskSchema = z
  .object({
    ref: z.string().openapi({ description: "The task's reference.", example: "t42" }),
    number: z.number().int().openapi({ description: "Per project, 1-based and never reused.", example: 42 }),
    title: z.string(),
    body: z.string().openapi({ description: "Markdown." }),
    creator: UserRefSchema,
    state: z.enum(TASK_STATES),
    created_at: z.string(),
    closed_at: z.string().nullable(),
    closed_by: UserRefSchema.nullable(),
    attempt_limit: z
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
    created_at: z.string(),
    closed_at: z.string().nullable(),
    merged_sha: z.string().nullable(),
    archived_sha: z.string().nullable(),
  })
  .openapi("Attempt");

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
    attempt_limit: AttemptLimitSchema.optional(),
  })
  .openapi("CreateTask");

const EditTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(65_536).optional().openapi({ description: "Markdown." }),
    attempt_limit: AttemptLimitSchema.optional(),
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
            .openapi({ description: "Defaults to 10 minutes.", example: 600000 }),
          metrics: z.array(
            z.object({
              name: ConfigNameSchema.openapi({ example: "coverage" }),
              unit: z.string().nullable().openapi({ example: "%" }),
              order: z
                .enum(["asc", "desc"])
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
}

function noRepos(): Repos {
  throw new Error("this API was built without repos");
}

function noTasks(): (projectId: string) => TaskBackend {
  throw new Error("this API was built without a task backend");
}

type Bearer = ReturnType<typeof bearerAuth>;

const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });

/** A task transition route: `POST …/tasks/{t}/<verb>`. */
function taskTransition(
  bearer: Bearer,
  verb: string,
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
      409: errorResponse(`\`invalid_state\`: ${conflicts.join(" ")}`),
    },
  });
}

/** An attempt transition route: `POST …/attempts/{a}/<verb>`. */
function attemptTransition(
  bearer: Bearer,
  verb: string,
  operationId: string,
  summary: string,
  forbidden: string,
  conflicts: string[],
) {
  return createRoute({
    method: "post",
    path: `/projects/{owner}/{project}/attempts/{a}/${verb}`,
    operationId,
    tags: ["Attempts"],
    summary,
    security: bearerOnly,
    middleware: [bearer] as const,
    request: { params: AttemptPathSchema },
    responses: {
      200: { description: "The attempt after the transition.", ...json(AttemptSchema) },
      400: errorResponse("The attempt reference is invalid."),
      401: unauthorizedBearer,
      403: errorResponse(forbidden),
      404: errorResponse("No such project or attempt."),
      409: errorResponse(conflicts.join(" ")),
    },
  });
}

const AUTHOR_ONLY = "Only the attempt's author, or their agents, may.";
const OWNER_ONLY = "Only the project owner may.";
const TASK_MANAGERS = "Only the project owner or the task's creator may.";

function publicToken({ id, agent, expires_at, revoked_at, created_at }: z.infer<typeof TokenSchema>) {
  return { id, agent, expires_at, revoked_at, created_at };
}

export function apiRoutes(options: ApiOptions = {}) {
  const now = options.now ?? (() => new Date());
  const auth = bearerOrAccess(options);
  const bearer = bearerAuth(options.now === undefined ? {} : { now: options.now });
  const browser = bearerOrForwarded(options);
  const reposFor = options.repos ?? noRepos;
  const projects = (env: AccessBindings) => projectService({ db: env.DB, repos: reposFor(env) });
  const backendFor = options.tasks ?? noTasks;
  const tasks = (env: AccessBindings) => taskService({ db: env.DB, backend: backendFor(env) });
  const taskPath = ({ t, ...rest }: z.infer<typeof TaskPathSchema>) => ({ ...rest, task: t });
  const attemptPath = ({ a, ...rest }: z.infer<typeof AttemptPathSchema>) => ({ ...rest, attempt: a });

  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalid_request", z.prettifyError(result.error)), 400);
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
        const token = c.var.token === null ? null : { id: c.var.token.id, expires_at: c.var.token.expires_at };
        return c.json({ user, agent, token }, 200);
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
          400: errorResponse("The request is invalid, e.g. `expires_in` is above 7 days."),
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
        let ttlSeconds = body.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS;
        if (caller !== null) {
          // A token can't be used to extend itself: what it mints expires no later than it does.
          const remaining = Math.floor((Date.parse(caller.expires_at) - at.getTime()) / 1000);
          if (body.expires_in === undefined) ttlSeconds = Math.min(ttlSeconds, remaining);
          if (ttlSeconds > remaining || ttlSeconds < 1) {
            return c.json(errorBody("invalid_request", "a token can't mint a token that outlives it"), 400);
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
        if (revoked === null) return c.json(errorBody("not_found", "no such token"), 404);
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
          409: errorResponse("`invalid_state`: the task is obsolete."),
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
          409: errorResponse("`invalid_state`: the task isn't open; `attempt_limit`: the batch would exceed the cap."),
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
          409: errorResponse("`invalid_state`: the attempt is obsolete."),
        },
      }),
      async (c) => {
        const input = { ...attemptPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c.env).editAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      attemptTransition(bearer, "open", "openAttempt", "Open a draft attempt for scoring and merging", AUTHOR_ONLY, [
        "`invalid_state`: the attempt isn't a draft.",
      ]),
      async (c) => c.json(await tasks(c.env).openAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "draft", "draftAttempt", "Return an open attempt to draft", AUTHOR_ONLY, [
        "`invalid_state`: the attempt isn't open.",
      ]),
      async (c) => c.json(await tasks(c.env).draftAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "close", "closeAttempt", "Close a draft or open attempt", AUTHOR_ONLY, [
        "`invalid_state`: the attempt isn't active.",
      ]),
      async (c) => c.json(await tasks(c.env).closeAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "reopen", "reopenAttempt", "Reopen a closed attempt as a draft", AUTHOR_ONLY, [
        "`invalid_state`: the attempt isn't closed or its task isn't open;",
        "`attempt_limit`: the task is at its cap; `conflict`: another active attempt has its branch.",
      ]),
      async (c) => c.json(await tasks(c.env).reopenAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "obsolete", "obsoleteAttempt", "Make an attempt obsolete", OWNER_ONLY, [
        "`invalid_state`: the attempt is merged or already obsolete.",
      ]),
      async (c) => c.json(await tasks(c.env).obsoleteAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearer, "restore", "restoreAttempt", "Restore an obsolete attempt to closed", OWNER_ONLY, [
        "`invalid_state`: the attempt isn't obsolete.",
      ]),
      async (c) => c.json(await tasks(c.env).restoreAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
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
          "on the next push, so the old author's pushes are refused from then on. Journals `handed_off`.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: AttemptPathSchema, body: { required: true, ...json(HandOffSchema) } },
        responses: {
          200: { description: "The attempt with its new author.", ...json(AttemptSchema) },
          400: errorResponse("The request is invalid, or `to` already authors the attempt."),
          401: unauthorizedBearer,
          403: errorResponse(AUTHOR_ONLY),
          404: errorResponse("No such project, attempt or user."),
          409: errorResponse("`invalid_state`: the attempt isn't active."),
        },
      }),
      async (c) => {
        const input = { ...attemptPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c.env).handOffAttempt(c.var.actor, input), 200);
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
    .route("/", browseRoutes({ auth: browser, repos: reposFor, tasks: backendFor }));

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
