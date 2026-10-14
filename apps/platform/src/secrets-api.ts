// The routes for a project's secrets, under `/api/projects/{owner}/{project}/secrets`: list their
// names, set one's value or pipelines, and delete one. Mounted by `api.ts`. They take a bearer token
// or throng-web's forwarded identity. No route ever answers with a value.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import { json, OWNER_AS_THEMSELVES, ProjectPathSchema, requestTaskService } from "./api-shared.ts";
import type { AuthEnv, bearerOrForwarded } from "./auth.ts";
import { errorBody, errorResponse } from "./errors.ts";
import { PIPELINES } from "./pipelines.ts";
import type { Repos } from "./repos.ts";
import { MAX_SECRET_LENGTH, MIN_SECRET_LENGTH, RESERVED_SECRET_PREFIX } from "./secrets.ts";
import type { TaskBackend } from "./tasks.ts";

export interface SecretsOptions {
  auth: ReturnType<typeof bearerOrForwarded>;
  repos: (env: AccessBindings) => Repos;
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend;
}

const PipelinesSchema = z.array(z.enum(PIPELINES)).openapi({
  description:
    "The pipelines the secret may be used in: `default` (attempts and task branches) and `main`. A run of code " +
    "you or your agents push to a `default` line will hold a secret allowed there.",
  example: ["main"],
});

export const SecretSchema = z
  .object({
    name: z.string().openapi({ example: "CLOUDFLARE_PROD" }),
    pipelines: PipelinesSchema,
    changedAt: z.string().openapi({ description: "When its value or pipelines last changed." }),
  })
  .openapi("Secret");

const SecretUseSchema = z
  .object({
    name: z.string().openapi({ example: "CLOUDFLARE_PREVIEW" }),
    steps: z.array(z.string()).openapi({
      description: "The setups, checks and post-gate steps in `main`'s config naming it, as a run's errors name them.",
      example: ["check preview"],
    }),
    hasValue: z.boolean().openapi({ description: "False when no secret has this name: every run naming it fails." }),
    notAllowedIn: z.array(z.enum(PIPELINES)).openapi({
      description:
        "The pipelines that run those steps but the secret isn't allowed in: their runs fail. Every setup and " +
        "check runs in every pipeline; a post-gate step only in `main`.",
      example: ["main"],
    }),
  })
  .openapi("SecretUse");

const PutSecretSchema = z
  .object({
    value: z
      .string()
      .min(MIN_SECRET_LENGTH)
      .max(MAX_SECRET_LENGTH)
      .optional()
      .openapi({ description: "The new value. Write-only: no route ever returns it." }),
    pipelines: PipelinesSchema.optional(),
  })
  .refine((body) => body.value !== undefined || body.pipelines !== undefined, "give a value, pipelines, or both")
  .openapi("PutSecret");

const SecretPathSchema = ProjectPathSchema.extend({
  name: z.string().openapi({
    description:
      "An environment variable's name: up to 128 uppercase letters, digits and underscores, not starting with a " +
      `digit or \`${RESERVED_SECRET_PREFIX}\`.`,
    example: "CLOUDFLARE_PROD",
  }),
});

const security: Record<string, string[]>[] = [{ bearer: [] }, { web: [] }];
const unauthorized = errorResponse("No valid bearer token.");

export function secretsRoutes({ auth, repos, tasks }: SecretsOptions) {
  const service = requestTaskService(repos, tasks);
  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalidRequest", z.prettifyError(result.error)), 400);
      return undefined;
    },
  });

  return api
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/secrets",
        operationId: "listSecrets",
        tags: ["Secrets"],
        summary: "List the project's secrets, without their values",
        description:
          "Each secret's name, the pipelines it may be used in and when it last changed, by name; and where " +
          "`main`'s config names secrets, flagging each with no value or not allowed in a pipeline that runs it. " +
          "Its maintainers may, under an alias too; for now that's only the project owner.",
        security,
        middleware: [auth] as const,
        request: { params: ProjectPathSchema },
        responses: {
          200: {
            description: "The secrets, and where main's config names them.",
            ...json(z.object({ secrets: z.array(SecretSchema), uses: z.array(SecretUseSchema) })),
          },
          401: unauthorized,
          403: errorResponse("Only the project's maintainers may."),
          404: errorResponse("No such project."),
        },
      }),
      async (c) => c.json(await service(c).listSecrets(c.var.actor, c.req.valid("param")), 200),
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/projects/{owner}/{project}/secrets/{name}",
        operationId: "putSecret",
        tags: ["Secrets"],
        summary: "Set a secret's value, its pipelines, or both",
        description:
          `Creates the secret, or changes what the body gives. A value is ${MIN_SECRET_LENGTH} to ` +
          `${MAX_SECRET_LENGTH} characters, and a new secret needs one; it's allowed in no pipeline unless ` +
          "`pipelines` names some. The change is journaled with its name and pipelines, never its value.",
        security,
        middleware: [auth] as const,
        request: { params: SecretPathSchema, body: { required: true, ...json(PutSecretSchema) } },
        responses: {
          200: { description: "The secret, without its value.", ...json(SecretSchema) },
          400: errorResponse("The name or the body is invalid."),
          401: unauthorized,
          403: errorResponse(OWNER_AS_THEMSELVES),
          404: errorResponse("No such project, or no such secret to give pipelines without a value."),
        },
      }),
      async (c) => {
        const secret = await service(c).putSecret(c.var.actor, { ...c.req.valid("param"), ...c.req.valid("json") });
        return c.json(secret, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/projects/{owner}/{project}/secrets/{name}",
        operationId: "deleteSecret",
        tags: ["Secrets"],
        summary: "Delete a secret",
        description: "The deletion is journaled with the secret's name and pipelines.",
        security,
        middleware: [auth] as const,
        request: { params: SecretPathSchema },
        responses: {
          204: { description: "Deleted." },
          401: unauthorized,
          403: errorResponse(OWNER_AS_THEMSELVES),
          404: errorResponse("No such project or secret."),
        },
      }),
      async (c) => {
        await service(c).deleteSecret(c.var.actor, c.req.valid("param"));
        return c.body(null, 204);
      },
    );
}
