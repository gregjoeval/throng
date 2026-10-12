// The routes for a merge request's latest dequeue, under `/api/projects/{owner}/{project}/tasks/{t}/
// merge-request/dequeue`: its details, each conflicting file's display diffs, and the logs of the
// retest behind a `failed_checks` dequeue. Mounted by `api.ts`. Like the other merge request reads,
// they take a bearer token or throng-web's forwarded identity.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import type { AuthEnv, bearerOrForwarded } from "./auth.ts";
import {
  diffContent,
  diffResponse,
  FileDiffSchema,
  ProjectPathSchema,
  publicFileDiff,
  TAIL,
  tailedRoutes,
} from "./api-shared.ts";
import { CONFLICT_CAPS, CONFLICT_TYPES } from "./conflicts.ts";
import { diffFile, type FileSide } from "./diff.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import { CHECK_OUTCOMES } from "./results.ts";
import { DEQUEUE_REASONS } from "./merge-requests.ts";
import { LOG_CONTENT_TYPE, type LogStore } from "./logs.ts";
import type { Repos } from "./repos.ts";
import { taskService, type TaskBackend } from "./tasks.ts";

export interface DequeueOptions {
  auth: ReturnType<typeof bearerOrForwarded>;
  repos: (env: AccessBindings) => Repos;
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend;
  logs: (env: AccessBindings) => LogStore;
}

const TaskPathSchema = ProjectPathSchema.extend({
  t: z.string().openapi({ description: "A task reference: `t42` or `42`.", example: "t42" }),
});

const SidesSchema = (description: string) =>
  z
    .object({ base: z.string().nullable(), main: z.string().nullable(), attempt: z.string().nullable() })
    .openapi({ description: `${description} Null where that side has no file.` });

const ConflictHunkSchema = z
  .object({
    start_line: z.number().int().openapi({
      description: "The 1-based line in the base where the hunk starts (or goes, when it has no base lines).",
    }),
    base: z.array(z.string()).openapi({ description: "The base's lines, without line endings." }),
    main: z.array(z.string()).openapi({ description: "`main`'s lines." }),
    attempt: z.array(z.string()).openapi({ description: "The approved head's lines." }),
  })
  .openapi("ConflictHunk");

const ConflictFileSchema = z
  .object({
    path: z.string(),
    type: z.enum(CONFLICT_TYPES).openapi({ description: "From `git merge-tree --messages`." }),
    blobs: SidesSchema("Each side's blob sha: the merge base, `main` and the approved head."),
    modes: SidesSchema("Each side's git mode."),
    truncated: z.boolean().openapi({
      description:
        `The hunks were left out: over ${CONFLICT_CAPS.fileBytes / 1024} KB for this file, or past ` +
        `${CONFLICT_CAPS.totalBytes / 1024} KB for all of them.`,
    }),
    hunks: z
      .array(ConflictHunkSchema)
      .optional()
      .openapi({
        description:
          "For a `content` conflict: each conflicting region of a zdiff3 re-merge of the three blobs. Absent " +
          "when `truncated`, for other types, and when the blobs couldn't be merged as text.",
      }),
  })
  .openapi("ConflictFile");

const ConflictDetailsSchema = z
  .object({
    attempt: z.string().openapi({ example: "t42a3" }),
    head: z.string().openapi({ description: "The approved head that conflicted." }),
    main: z.string().openapi({ description: "`main`'s sha it conflicted with." }),
    base: z.string().nullable().openapi({ description: "Their merge base; null with no shared history." }),
    files: z.array(ConflictFileSchema).openapi({ description: "Every conflicting path." }),
  })
  .openapi("ConflictDetails");

const FailedChecksDetailsSchema = z
  .object({
    checks: z.array(
      z.object({
        name: z.string(),
        outcome: z.enum(CHECK_OUTCOMES).exclude(["passed"]),
        log: z.string().nullable().openapi({ description: "For `GET …/merge-request/dequeue/logs/{name}`." }),
      }),
    ),
    error: z
      .string()
      .optional()
      .openapi({ description: "The config's errors, when the merged tree's config is invalid." }),
  })
  .openapi("FailedChecksDetails");

const ErroredDetailsSchema = z
  .object({
    step: z.string().openapi({ description: "The landing step that kept failing.", example: "conflict check" }),
    error: z.string(),
  })
  .openapi("ErroredDetails");

const DequeueSchema = z
  .object({
    reason: z.enum(DEQUEUE_REASONS),
    at: z.string(),
    details: z.union([ConflictDetailsSchema, FailedChecksDetailsSchema, ErroredDetailsSchema]).nullable().openapi({
      description:
        "By reason: `conflict`, `failed_checks` and `errored` have theirs; `new_push` and `cancelled` have none.",
    }),
  })
  .openapi("MergeRequestDequeue");

const SIDES = ["main", "attempt"] as const;

const security: Record<string, string[]>[] = [{ bearer: [] }, { web: [] }];
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const errors = {
  400: errorResponse("The task reference or the query is invalid."),
  401: errorResponse("No valid bearer token."),
};

const taskPath = ({ t, ...rest }: { owner: string; project: string; t: string }) => ({ ...rest, task: t });

export function dequeueRoutes({ auth, repos, tasks, logs }: DequeueOptions) {
  const service = (env: AccessBindings) => taskService({ db: env.DB, backend: tasks(env) });

  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalid_request", z.prettifyError(result.error)), 400);
      return undefined;
    },
  });

  const tailed = tailedRoutes(api);

  const base = "/projects/{owner}/{project}/tasks/{t}/merge-request/dequeue";
  return api
    .openapi(
      createRoute({
        method: "get",
        path: base,
        operationId: "getMergeRequestDequeue",
        tags: ["Merge queue"],
        summary: "Get a merge request's latest dequeue, with its details",
        description:
          "Why the task's latest merge request last left the queue without landing, and the details: every " +
          "conflicting path with its blobs and hunks, the checks that failed the retest, or the step that errored.",
        security,
        middleware: [auth] as const,
        request: { params: TaskPathSchema },
        responses: {
          200: { description: "The latest dequeue.", ...json(DequeueSchema) },
          ...errors,
          404: errorResponse("No such project or task, or its merge request was never dequeued."),
        },
      }),
      async (c) => c.json(await service(c.env).getDequeue(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      tailed(
        createRoute({
          method: "get",
          path: `${base}/files/${TAIL}/diff`,
          operationId: "getMergeRequestConflictDiff",
          tags: ["Merge queue"],
          summary: "Diff a conflicting file from the merge base to one side",
          description:
            "The unified diff of one conflicting file of the latest `conflict` dequeue, from its base blob to " +
            "`main`'s (`side=main`) or the approved head's (`side=attempt`). A side with no file is a delete; a " +
            "base with none, an add. The commit diff's per-file caps apply. With `Accept: text/x-diff`, the " +
            "answer is the patch.",
          security,
          middleware: [auth] as const,
          request: {
            params: TaskPathSchema.extend({ path: z.string().openapi({ example: "src/app.ts" }) }),
            query: z.object({ side: z.enum(SIDES) }),
          },
          responses: {
            200: { description: "The file's diff.", content: diffContent(FileDiffSchema) },
            ...errors,
            404: errorResponse("No such project or task, or the latest dequeue has no conflict in that path."),
          },
        }),
      ),
      async (c) => {
        const { path, ...params } = c.req.valid("param");
        const { side } = c.req.valid("query");
        const found = await service(c.env).getDequeueFile(c.var.actor, { ...taskPath(params), path });
        const sideOf = (s: "base" | typeof side): FileSide | null => {
          const hash = found.file.blobs[s];
          const mode = found.file.modes[s];
          return hash === null || mode === null ? null : { path, mode, hash };
        };
        const old = sideOf("base");
        const next = sideOf(side);
        if (old === null && next === null)
          throw new ServiceError("not_found", `neither the base nor ${side} has ${path}`);
        const diff = (repo: string) => diffFile(repos(c.env), repo, old, next);
        // The attempt's blob is in its fork while the attempt is active, and in origin once it's archived.
        const file =
          side === "main" ? await diff(found.origin) : await diff(found.fork).catch(() => diff(found.origin));
        return diffResponse(
          c,
          () => file.patch ?? "",
          () => publicFileDiff(file),
        ) as never;
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: `${base}/logs/{name}`,
        operationId: "getMergeRequestDequeueLog",
        tags: ["Merge queue"],
        summary: "Stream a log of the retest behind a failed checks dequeue",
        description:
          "For a latest dequeue with reason `failed_checks`: the log a failing check's `log` names, from the " +
          "landing's retest. Logs expire like scoring runs' do; an expired log is `not_found`.",
        security,
        middleware: [auth] as const,
        request: { params: TaskPathSchema.extend({ name: z.string().openapi({ example: "test" }) }) },
        responses: {
          200: { description: "The log.", content: { "text/plain": { schema: z.string() } } },
          ...errors,
          404: errorResponse("No such project or task, or the latest dequeue has no such log."),
        },
      }),
      async (c) => {
        const { name, ...params } = c.req.valid("param");
        const key = await service(c.env).dequeueLogKey(c.var.actor, { ...taskPath(params), name });
        const log = await logs(c.env).get(key);
        if (log === null) throw new ServiceError("not_found", `the log ${name} has expired`);
        return c.body(log.body, 200, { "Content-Type": LOG_CONTENT_TYPE }) as never;
      },
    );
}
