// The route for a merge request's latest dequeue, `/api/projects/{owner}/{project}/tasks/{t}/
// merge-request/dequeue`: why, the landing's run behind it, and the details that run holds. Mounted
// by `api.ts`. Like the other merge request reads, it takes a bearer token or throng-web's forwarded
// identity. The run's own routes serve its steps and logs.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import { json, ProjectPathSchema, requestTaskService } from "./api-shared.ts";
import type { AuthEnv, bearerOrForwarded } from "./auth.ts";
import { CONFLICT_CAPS, CONFLICT_TYPES } from "./conflicts.ts";
import { errorBody, errorResponse } from "./errors.ts";
import { DEQUEUE_REASONS } from "./merge-requests.ts";
import type { Repos } from "./repos.ts";
import { STEP_KINDS, STEP_OUTCOMES } from "./run-outcome.ts";
import type { TaskBackend } from "./tasks.ts";

export interface DequeueOptions {
  auth: ReturnType<typeof bearerOrForwarded>;
  repos: (env: AccessBindings) => Repos;
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend;
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
    startLine: z.number().int().openapi({
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

/** A landing's conflict: what its `merge` step hit, file by file. A run's outcome and a dequeue both show it. */
export const ConflictDetailsSchema = z
  .object({
    attempt: z.string().openapi({ example: "t42a3" }),
    head: z.string().openapi({ description: "The approved head that conflicted." }),
    main: z.string().openapi({ description: "`main`'s sha it conflicted with." }),
    base: z.string().nullable().openapi({ description: "Their merge base; null with no shared history." }),
    files: z.array(ConflictFileSchema).openapi({ description: "Every conflicting path." }),
  })
  .openapi("ConflictDetails");

const FailedStepsDetailsSchema = z
  .object({
    steps: z
      .array(
        z.object({
          name: z.string(),
          kind: z.enum(STEP_KINDS).openapi({ description: "A setup or a check." }),
          outcome: z.enum(STEP_OUTCOMES),
        }),
      )
      .openapi({ description: "The setups and checks that didn't pass the landing's gate, in run order." }),
    error: z
      .string()
      .optional()
      .openapi({ description: "The config's errors, when the merged tree's config is invalid." }),
  })
  .openapi("FailedStepsDetails");

const ErroredDetailsSchema = z
  .object({
    error: z.string().openapi({ description: "What ended the landing's run." }),
    step: z.string().optional().openapi({
      description: "The landing step that kept failing, kept by a dequeue from before landings were runs.",
      example: "conflict check",
    }),
  })
  .openapi("ErroredDetails");

const DequeueSchema = z
  .object({
    reason: z.enum(DEQUEUE_REASONS),
    run: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          "The landing's run behind a `conflict`, `failedChecks` or `errored` dequeue, for `GET …/runs/{runId}`; " +
          "null for `newPush` and `cancelled`, and for a dequeue from before landings were runs.",
      }),
    at: z.string(),
    details: z
      .union([ConflictDetailsSchema, FailedStepsDetailsSchema, ErroredDetailsSchema])
      .nullable()
      .openapi({
        description:
          "From the run, by reason: `conflict`, `failedChecks` and `errored` have theirs; `newPush` and `cancelled` " +
          "have none.",
      }),
  })
  .openapi("MergeRequestDequeue");

const security: Record<string, string[]>[] = [{ bearer: [] }, { web: [] }];
const errors = {
  400: errorResponse("The task reference or the query is invalid."),
  401: errorResponse("No valid bearer token."),
};

const taskPath = ({ t, ...rest }: { owner: string; project: string; t: string }) => ({ ...rest, task: t });

export function dequeueRoutes({ auth, repos, tasks }: DequeueOptions) {
  const service = requestTaskService(repos, tasks);

  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalidRequest", z.prettifyError(result.error)), 400);
      return undefined;
    },
  });

  return api.openapi(
    createRoute({
      method: "get",
      path: "/projects/{owner}/{project}/tasks/{t}/merge-request/dequeue",
      operationId: "getMergeRequestDequeue",
      tags: ["Merge queue"],
      summary: "Get a merge request's latest dequeue, with its details",
      description:
        "Why the task's latest merge request last left the queue without landing, the landing's run behind it, " +
        "and the details that run holds: every conflicting path with its blobs and hunks, the setups and checks " +
        "that failed its gate, or the error that ended it.",
      security,
      middleware: [auth] as const,
      request: { params: TaskPathSchema },
      responses: {
        200: { description: "The latest dequeue.", ...json(DequeueSchema) },
        ...errors,
        404: errorResponse("No such project or task, or its merge request was never dequeued."),
      },
    }),
    async (c) => c.json(await service(c).getDequeue(c.var.actor, taskPath(c.req.valid("param"))), 200),
  );
}
