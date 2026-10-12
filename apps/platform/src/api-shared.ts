// HTTP plumbing more than one route module shares (the REST routes in `api.ts`, `browse-api.ts` and
// `dequeue-api.ts`, and the MCP tools in `mcp.ts`): the project path, multi-segment `{path}` routes,
// the public shape of a file or commit diff with its `text/x-diff` answer, the request schemas the
// MCP tools reuse, and the task service for a request.

import { z } from "@hono/zod-openapi";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AccessBindings } from "./access.ts";
import { DEFAULT_COMMITS_PAGE, MAX_COMMITS_PAGE } from "./browse.ts";
import { DIFF_FLAGS, FILE_STATUSES } from "./diff.ts";
import type { DiffCache } from "./diff.ts";
import type { Repos } from "./repos.ts";
import { taskService } from "./tasks.ts";
import type { TaskBackend } from "./tasks.ts";
import { MAX_VERDICT_BODY, VERDICT_RECOMMENDATIONS } from "./verdicts.ts";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, WAIT_CONDITIONS } from "./waiters.ts";

export const ProjectPathSchema = z.object({
  owner: z.string().openapi({ description: "The owner's handle.", example: "greg" }),
  project: z.string().openapi({ description: "The project's handle.", example: "throng" }),
});

/** Hono matches `{path{.+}}` across slashes; the OpenAPI document shows it as plain `{path}`. */
export const TAIL = "{path{.+}}";

/**
 * For routes whose path holds a multi-segment `{path}`: registers the documented route without the
 * tail and returns the config to route, hidden from the document.
 */
export function tailedRoutes(api: Pick<OpenAPIHono, "openAPIRegistry">) {
  return <R extends { path: string }>(config: R): R & { hide: true } => {
    const { middleware: _middleware, hide: _hide, ...documented } = config as R & RouteConfig;
    api.openAPIRegistry.registerPath({ ...documented, path: config.path.replace(TAIL, "{path}") } as RouteConfig);
    return { ...config, hide: true };
  };
}

const FLAGS_DESCRIPTION =
  "`binary`, `tooLarge` and `tooComplex` files get no patch. `truncated`: listed past the patched-file " +
  "cap with no patch, or cut short (or left out) once the whole diff hit its size cap.";

/** One file's diff, as the commit diff and a conflict's display diff both serve it. */
export const FileDiffSchema = z
  .object({
    path: z.string().openapi({ description: "The new path, or the old one for a deleted file." }),
    oldPath: z.string().optional().openapi({ description: "Only for a rename: where the file was." }),
    status: z.enum(FILE_STATUSES),
    oldMode: z.string().nullable().openapi({ example: "100644" }),
    newMode: z.string().nullable().openapi({ example: "100755" }),
    oldHash: z.string().nullable().openapi({ description: "The old blob's sha; null when there was no file." }),
    newHash: z.string().nullable().openapi({ description: "The new blob's sha; null when the file is gone." }),
    additions: z.number().int(),
    deletions: z.number().int(),
    flags: z.array(z.enum(DIFF_FLAGS)).openapi({ description: FLAGS_DESCRIPTION }),
    patch: z
      .string()
      .optional()
      .openapi({ description: "The git-style unified patch, headers included; absent when a flag left it out." }),
  })
  .openapi("FileDiff");

export const CommitDiffSchema = z
  .object({
    sha: z.string(),
    parent: z.string().nullable().openapi({ description: "The first parent; null for a root commit." }),
    oldTree: z.string().nullable().openapi({ description: "The parent's tree; null for a root commit." }),
    newTree: z.string(),
    files: z.array(FileDiffSchema).openapi({ description: "By path, byte-wise." }),
    totals: z.object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() }),
    truncated: z.boolean().openapi({ description: "More files changed than are listed." }),
  })
  .openapi("CommitDiff");

/** A route's JSON body or response, as `request.body` or a `responses` entry. */
export const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });

/** A diff route's 200: JSON, or the unified patch for `Accept: text/x-diff`. */
export function diffContent<T>(schema: T) {
  return {
    "application/json": { schema },
    "text/x-diff": { schema: z.string().openapi({ description: "The unified patch." }) },
  };
}

/**
 * Answers a diff as the unified patch when the client asked for `text/x-diff`, otherwise as the JSON `body`.
 * Either way the answer varies by `Accept`.
 */
export function diffResponse(c: Context, patch: () => string, body: () => unknown): Response {
  c.header("Vary", "Accept");
  if (wantsPatch(c.req.header("Accept"))) {
    c.header("Content-Type", "text/x-diff; charset=utf-8");
    return c.body(patch(), 200);
  }
  return c.json(body(), 200);
}

/** Whether the client asked for the unified patch rather than JSON. */
export function wantsPatch(accept: string | undefined): boolean {
  return accept?.split(",").some((t) => t.split(";")[0]?.trim().toLowerCase() === "text/x-diff") ?? false;
}

/**
 * The task service for a request, given the environment's repos and task backends. Attempts name
 * their git remotes on the origin the request came in on.
 */
export function requestTaskService(
  repos: (env: AccessBindings) => Repos,
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend,
) {
  return ({ env, req }: { env: AccessBindings; req: { url: string } }) =>
    taskService({ db: env.DB, repos: repos(env), backend: tasks(env), origin: new URL(req.url).origin });
}

export const PostVerdictSchema = z
  .object({
    recommendation: z.enum(VERDICT_RECOMMENDATIONS),
    body: z.string().max(MAX_VERDICT_BODY).openapi({ description: "Markdown, up to 64 KB." }),
  })
  .openapi("PostVerdict");

export const SelectionSchema = z
  .object({ attempt: z.string().openapi({ description: "An open attempt of the task.", example: "t42a3" }) })
  .openapi("Selection");

export const AttemptLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .nullable()
  .openapi({ description: "Overrides the project's cap on active attempts; null to use the project's." });

export const CreateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(65_536).optional().openapi({ description: "Markdown." }),
    attemptLimit: AttemptLimitSchema.optional(),
  })
  .openapi("CreateTask");

export const CreateAttemptsSchema = z
  .object({
    count: z.number().int().min(1).max(100).optional().openapi({ description: "Attempts to create. Defaults to 1." }),
    note: z.string().max(65_536).optional().openapi({ description: "Markdown, set on every new attempt." }),
    from: z
      .string()
      .optional()
      .openapi({
        description:
          "An attempt of the same task, current or archived, whose head every new attempt starts at. Each records it " +
          "as `forkedFrom`; its base is still the task branch or `main`, and it never follows the source.",
        example: "t42a1",
      }),
  })
  .openapi("CreateAttempts");

export const EditAttemptSchema = z
  .object({ note: z.string().max(65_536).openapi({ description: "Markdown." }) })
  .openapi("EditAttempt");

export const HandOffSchema = z
  .object({
    to: z.string().min(1).openapi({ description: "The handle of the user who becomes the author.", example: "bob" }),
  })
  .openapi("HandOff");

/** How long a wait holds, in seconds: the one limit `?wait=` and `wait_for_attempt` share. */
export const WaitSecondsSchema = z.coerce.number().int().min(1).max(MAX_WAIT_SECONDS);

/** `GET …/attempts/{a}`'s wait; `wait_for_attempt` takes the same, with `wait` defaulting to `DEFAULT_WAIT_SECONDS`. */
export const WaitQuerySchema = z.object({
  wait: WaitSecondsSchema.optional().openapi({
    description:
      `Seconds to hold the request until what \`until\` watches changes, 1 to ${MAX_WAIT_SECONDS}; ` +
      `${DEFAULT_WAIT_SECONDS} unless you need less. Without it, the attempt is returned at once. A deploy drops ` +
      "a waiting request, which then answers `changed: false`; wait again.",
    example: DEFAULT_WAIT_SECONDS,
  }),
  until: z
    .enum(WAIT_CONDITIONS)
    .default("any")
    .openapi({
      description:
        "What to wait for, with `wait`: `scored`, the current head has a `done` or `errored` run (at once if it " +
        "already has one); " +
        "`stateChanged`, the attempt's state; `mergeRequestChanged`, its merge request's state or last dequeue; " +
        "`any`, any of them.",
    }),
});

/** The Workers Cache API's default cache, when running in a Worker. */
export function workersCache(): DiffCache | undefined {
  return (globalThis as { caches?: { default?: DiffCache } }).caches?.default;
}

export const AttemptQuerySchema = z.object({
  attempt: z
    .string()
    .optional()
    .openapi({ description: "For a sha that isn't in origin: the attempt whose fork to look in.", example: "t42a3" }),
});

/**
 * `offset` and `limit` query parameters, how every list route pages: skip `offset` items, then take at
 * most `limit`. Its response carries `next`, the next page's offset, null on the last page.
 */
export function pageQuerySchema(items: string, defaultLimit: number, maxLimit: number) {
  return z.object({
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .openapi({ description: `${items} to skip.` }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .default(defaultLimit)
      .openapi({ description: `Defaults to ${defaultLimit}, at most ${maxLimit}.` }),
  });
}

export const PageQuerySchema = pageQuerySchema("Commits", DEFAULT_COMMITS_PAGE, MAX_COMMITS_PAGE);

/** A page's `offset`, `limit` and `next` in a list route's response. */
export const PageSchema = {
  offset: z.number().int(),
  limit: z.number().int(),
  next: z.number().int().nullable().openapi({ description: "The next page's offset; null on the last page." }),
};
