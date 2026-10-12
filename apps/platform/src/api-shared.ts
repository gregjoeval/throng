// HTTP plumbing the browse and merge queue routes share: the project path, multi-segment `{path}`
// routes, and the public shape of a file or commit diff with its `text/x-diff` answer.

import { z } from "@hono/zod-openapi";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { DIFF_FLAGS, FILE_STATUSES } from "./diff.ts";

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
