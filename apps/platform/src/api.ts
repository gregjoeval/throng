// The product API, mounted at `/api` and described by the OpenAPI document at `/api/openapi.json`.
// Access does not sit in front of it: machine clients use Throng bearer tokens. Only `/me` and
// `/tokens` also accept an Access session, so a human can mint their first token. Handlers stay
// thin: they call services, which throw `ServiceError`s that `onError` turns into the error shape.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import { bearerAuth, bearerOrAccess, type AuthEnv, type AuthOptions } from "./auth.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import { MAX_PROJECT_HANDLE, PROJECT_HANDLE, projectService } from "./projects.ts";
import type { Repos } from "./repos.ts";
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

const security: Record<string, string[]>[] = [{ bearer: [] }, { access: [] }];
const bearerOnly: Record<string, string[]>[] = [{ bearer: [] }];
const unauthorized = errorResponse("No valid bearer token or Access session.");
const unauthorizedBearer = errorResponse("No valid bearer token.");

export interface ApiOptions extends AuthOptions {
  /** The environment's repos: production passes the Artifacts-backed `reposFor`, tests a fake. */
  repos?: (env: AccessBindings) => Repos;
}

function noRepos(): Repos {
  throw new Error("this API was built without repos");
}

function publicToken({ id, agent, expires_at, revoked_at, created_at }: z.infer<typeof TokenSchema>) {
  return { id, agent, expires_at, revoked_at, created_at };
}

export function apiRoutes(options: ApiOptions = {}) {
  const now = options.now ?? (() => new Date());
  const auth = bearerOrAccess(options);
  const bearer = bearerAuth(options.now === undefined ? {} : { now: options.now });
  const reposFor = options.repos ?? noRepos;
  const projects = (env: AccessBindings) => projectService({ db: env.DB, repos: reposFor(env) });

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
        method: "post",
        path: "/projects",
        operationId: "createProject",
        tags: ["Projects"],
        summary: "Create a project owned by the caller",
        description:
          "The caller's human becomes the owner, also when an agent's token calls. Creates the project's " +
          "origin repo with `main` as its default branch.",
        security: bearerOnly,
        middleware: [bearer] as const,
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
        security: bearerOnly,
        middleware: [bearer] as const,
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
    );

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
