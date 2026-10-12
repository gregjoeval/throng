// The read API's routes, under `/api/projects/{owner}/{project}`: refs, trees, files, raw bytes,
// history and commits. Mounted by `api.ts`. They take a bearer token or an Access session (or
// throng-web's forwarded identity), since the web UI calls them for a signed-in human.
//
// Caching: what a sha addresses never changes, so those responses are immutable. A response
// addressed by `main` or an attempt resolves the ref first, sends a short max-age and an ETag of
// the resolved sha, and answers a matching `If-None-Match` with 304 before reading anything else.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AccessBindings } from "./access.ts";
import { CommitDiffSchema, diffContent, diffResponse, ProjectPathSchema, TAIL, tailedRoutes } from "./api-shared.ts";
import type { AuthEnv, bearerOrForwarded } from "./auth.ts";
import { browseService, DEFAULT_COMMITS_PAGE, MAX_COMMITS_PAGE, MAX_TEXT_BYTES } from "./browse.ts";
import type { BrowseService, Resolved } from "./browse.ts";
import { DIFF_CAPS, diffCommit, unifiedPatch } from "./diff.ts";
import type { DiffCache } from "./diff.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import type { Repos } from "./repos.ts";
import { ATTEMPT_STATES } from "./task-store.ts";
import type { TaskBackend } from "./tasks.ts";
import type { Actor } from "./tokens.ts";

export const IMMUTABLE = "public, max-age=31536000, immutable";
/** Seconds a ref-addressed response may be reused before revalidating against its ETag. */
export const REF_MAX_AGE_SECONDS = 10;
const REF_CACHE = `private, max-age=${REF_MAX_AGE_SECONDS}`;

/** Lets `/raw` show images and PDFs but never run anything, even when opened directly. */
const RAW_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

export interface BrowseOptions {
  auth: ReturnType<typeof bearerOrForwarded>;
  repos: (env: AccessBindings) => Repos;
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend;
  diffCache: (env: AccessBindings) => DiffCache | undefined;
}

const RefParamSchema = ProjectPathSchema.extend({
  ref: z.string().openapi({
    description: "`main`, an attempt reference (`t42a3`), or a full 40-character commit sha.",
    example: "main",
  }),
});

const PathParamSchema = RefParamSchema.extend({
  path: z
    .string()
    .openapi({ description: "A repository-relative path; slashes need no escaping.", example: "src/app.ts" }),
});

const AttemptQuerySchema = z.object({
  attempt: z
    .string()
    .optional()
    .openapi({ description: "For a sha that isn't in origin: the attempt whose fork to look in.", example: "t42a3" }),
});

const ShaSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{40}$/u, "sha must be 40 hex characters")
  .openapi({ example: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });

const ResolvedSchema = {
  ref: z.string().openapi({ description: "The ref as asked for.", example: "main" }),
  sha: z.string().openapi({ description: "The commit the ref resolved to." }),
};

const EntryType = z.enum(["tree", "blob", "symlink", "gitlink", "exec"]);

const EntrySchema = z
  .object({
    name: z.string(),
    path: z.string().openapi({ description: "Repository-relative.", example: "src/app.ts" }),
    type: EntryType.openapi({ description: "`tree` is a directory and `gitlink` a submodule." }),
    mode: z.string().openapi({ example: "100644" }),
    hash: z.string().openapi({ description: "The object's sha." }),
  })
  .openapi("TreeEntry");

const TreeSchema = z
  .object({
    ...ResolvedSchema,
    path: z.string().openapi({ description: "The directory; empty for the root." }),
    entries: z.array(EntrySchema).openapi({ description: "Directories first, then files, each by name." }),
  })
  .openapi("Tree");

const BlobSchema = z
  .object({
    ...ResolvedSchema,
    ...EntrySchema.shape,
    size: z.number().int().openapi({ description: "Bytes." }),
    binary: z.boolean().openapi({ description: "A NUL byte appears in the first 8,000 bytes." }),
    tooLarge: z.boolean().openapi({ description: `Larger than ${MAX_TEXT_BYTES} bytes.` }),
    content: z.string().nullable().openapi({ description: "UTF-8 text; null when `binary` or `tooLarge`." }),
  })
  .openapi("Blob");

const PersonSchema = z.object({
  name: z.string(),
  email: z.string(),
  date: z.string().openapi({ description: "ISO 8601.", example: "2026-10-10T12:00:00.000Z" }),
});

const CommitSchema = z
  .object({
    sha: z.string(),
    tree: z.string().openapi({ description: "The root tree's sha." }),
    parents: z.array(z.string()).openapi({ description: "In git order; empty for a root commit." }),
    message: z.string(),
    author: PersonSchema,
    committer: PersonSchema,
  })
  .openapi("Commit");

const CommitPageSchema = z
  .object({
    ...ResolvedSchema,
    offset: z.number().int(),
    limit: z.number().int(),
    commits: z.array(CommitSchema).openapi({ description: "First-parent history, newest first." }),
    next: z.number().int().nullable().openapi({ description: "The next page's offset; null on the last page." }),
  })
  .openapi("CommitPage");

const AttemptHeadSchema = z.object({
  ref: z.string().openapi({ example: "t42a3" }),
  state: z.enum(ATTEMPT_STATES),
  sha: z.string().nullable().openapi({ description: "Null when its head can't be found." }),
});

const RefsSchema = z
  .object({
    main: z.object({
      ref: z.literal("main"),
      sha: z.string().nullable().openapi({ description: "Null before the first push." }),
    }),
    active: z.array(AttemptHeadSchema).openapi({ description: "Draft and open attempts: their forks' `main`." }),
    archived: z
      .array(AttemptHeadSchema)
      .openapi({ description: "Closed and merged attempts: their archived heads in origin." }),
  })
  .openapi("Refs");

const PageQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0).openapi({ description: "Commits to skip." }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_COMMITS_PAGE)
    .default(DEFAULT_COMMITS_PAGE)
    .openapi({ description: `Defaults to ${DEFAULT_COMMITS_PAGE}, at most ${MAX_COMMITS_PAGE}.` }),
});

const security: Record<string, string[]>[] = [{ bearer: [] }, { access: [] }];
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const refErrors = {
  304: { description: "Not modified: the ref still resolves to the sha in `If-None-Match`." },
  400: errorResponse("The request is invalid."),
  401: errorResponse("No valid bearer token or Access session."),
  404: errorResponse("No such project, ref or path."),
};

export function browseRoutes({ auth, repos, tasks, diffCache }: BrowseOptions) {
  const browse = (env: AccessBindings) => browseService({ db: env.DB, repos: repos(env), backend: tasks(env) });

  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalidRequest", z.prettifyError(result.error)), 400);
      return undefined;
    },
  });

  const tailed = tailedRoutes(api);

  const treeResponses = { 200: { description: "The directory.", ...json(TreeSchema) }, ...refErrors };
  const treeDescription =
    "Resolves the ref, then lists one directory. A path that is missing or isn't a directory is a 404.";

  return api
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/refs",
        operationId: "listRefs",
        summary: "List the refs a project can be browsed at, each with its head sha",
        description: "`main`, the active attempts, and the archived ones. Obsolete attempts are left out.",
        tags: ["Browse"],
        security,
        middleware: [auth] as const,
        request: { params: ProjectPathSchema },
        responses: {
          200: { description: "The refs.", ...json(RefsSchema) },
          401: refErrors[401],
          404: errorResponse("No such project."),
        },
      }),
      async (c) => {
        const refs = await browse(c.env).refs(c.var.actor, c.req.valid("param"));
        c.header("Cache-Control", REF_CACHE);
        return c.json(refs, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tree/{ref}",
        operationId: "getRootTree",
        summary: "List the root directory at a ref",
        description: treeDescription,
        tags: ["Browse"],
        security,
        middleware: [auth] as const,
        request: { params: RefParamSchema, query: AttemptQuerySchema },
        responses: treeResponses,
      }),
      async (c) => {
        const at = await resolved(c, browse(c.env), c.var.actor, { ...c.req.valid("param"), ...c.req.valid("query") });
        if (at instanceof Response) return at;
        const entries = await browse(c.env).tree(at, "");
        cacheFor(c, at);
        return c.json({ ref: c.req.valid("param").ref, sha: at.sha, path: "", entries }, 200);
      },
    )
    .openapi(
      tailed(
        createRoute({
          method: "get",
          path: `/projects/{owner}/{project}/tree/{ref}/${TAIL}`,
          operationId: "getTree",
          summary: "List a directory at a ref",
          description: treeDescription,
          tags: ["Browse"],
          security,
          middleware: [auth] as const,
          request: { params: PathParamSchema, query: AttemptQuerySchema },
          responses: treeResponses,
        }),
      ),
      async (c) => {
        const { path, ...params } = c.req.valid("param");
        const at = await resolved(c, browse(c.env), c.var.actor, { ...params, ...c.req.valid("query") });
        if (at instanceof Response) return at;
        const entries = await browse(c.env).tree(at, path);
        cacheFor(c, at);
        return c.json({ ref: params.ref, sha: at.sha, path: trimSlashes(path), entries }, 200);
      },
    )
    .openapi(
      tailed(
        createRoute({
          method: "get",
          path: `/projects/{owner}/{project}/blob/{ref}/${TAIL}`,
          operationId: "getBlob",
          summary: "Get a file's metadata, and its text when it is text up to 1 MB",
          description:
            "Binary files (a NUL byte in the first 8,000 bytes) and files over 1 MB come back flagged, " +
            "without content; read those from `/raw`.",
          tags: ["Browse"],
          security,
          middleware: [auth] as const,
          request: { params: PathParamSchema, query: AttemptQuerySchema },
          responses: { 200: { description: "The file.", ...json(BlobSchema) }, ...refErrors },
        }),
      ),
      async (c) => {
        const { path, ...params } = c.req.valid("param");
        const at = await resolved(c, browse(c.env), c.var.actor, { ...params, ...c.req.valid("query") });
        if (at instanceof Response) return at;
        const file = await browse(c.env).blob(at, path);
        cacheFor(c, at);
        return c.json({ ref: params.ref, sha: at.sha, ...file }, 200);
      },
    )
    .openapi(
      tailed(
        createRoute({
          method: "get",
          path: `/projects/{owner}/{project}/raw/{ref}/${TAIL}`,
          operationId: "getRaw",
          summary: "Get a file's raw bytes",
          description:
            "Typed by extension for images, media, fonts, PDFs and JSON; anything else is " +
            "`text/plain` or `application/octet-stream`. The resolved sha is in `ETag`.",
          tags: ["Browse"],
          security,
          middleware: [auth] as const,
          request: { params: PathParamSchema, query: AttemptQuerySchema },
          responses: {
            200: {
              description: "The file's bytes.",
              content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } },
            },
            ...refErrors,
          },
        }),
      ),
      async (c) => {
        const { path, ...params } = c.req.valid("param");
        const at = await resolved(c, browse(c.env), c.var.actor, { ...params, ...c.req.valid("query") });
        if (at instanceof Response) return at;
        const { entry, blob, type } = await browse(c.env).raw(at, path);
        c.header("Content-Type", type);
        c.header("Content-Length", String(blob.size));
        c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
        c.header("Content-Security-Policy", RAW_CSP);
        c.header("X-Content-Type-Options", "nosniff");
        cacheFor(c, at);
        return c.body(blob.stream(), 200) as never;
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/commits/{ref}",
        operationId: "listCommits",
        summary: "List the first-parent history from a ref, newest first",
        description: `Paged by \`offset\` and \`limit\`: ${DEFAULT_COMMITS_PAGE} commits by default, at most ${MAX_COMMITS_PAGE}.`,
        tags: ["Browse"],
        security,
        middleware: [auth] as const,
        request: { params: RefParamSchema, query: AttemptQuerySchema.extend(PageQuerySchema.shape) },
        responses: { 200: { description: "One page of history.", ...json(CommitPageSchema) }, ...refErrors },
      }),
      async (c) => {
        const { offset, limit, attempt } = c.req.valid("query");
        const params = c.req.valid("param");
        const at = await resolved(c, browse(c.env), c.var.actor, { ...params, attempt });
        if (at instanceof Response) return at;
        const page = await browse(c.env).commits(at, { offset, limit });
        cacheFor(c, at);
        return c.json({ ref: params.ref, sha: at.sha, offset, limit, ...page }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/commit/{sha}",
        operationId: "getCommit",
        summary: "Get a commit: its message, author, committer, dates, parents and tree",
        description: "Looks in origin first, then in the fork of the attempt `?attempt=` names.",
        tags: ["Browse"],
        security,
        middleware: [auth] as const,
        request: { params: ProjectPathSchema.extend({ sha: ShaSchema }), query: AttemptQuerySchema },
        responses: { 200: { description: "The commit.", ...json(CommitSchema) }, ...refErrors },
      }),
      async (c) => {
        const { sha, ...params } = c.req.valid("param");
        const at = await resolved(c, browse(c.env), c.var.actor, { ...params, ref: sha, ...c.req.valid("query") });
        if (at instanceof Response) return at;
        const commit = await browse(c.env).commit(at);
        cacheFor(c, at);
        return c.json(commit, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/commit/{sha}/diff",
        operationId: "getCommitDiff",
        summary: "Get a commit's diff against its first parent",
        description:
          "Against `parents[0]`, or the empty tree for a root commit; merge commits get no combined diff. " +
          "Exact renames are paired; similarity renames are not. Each file is flagged when a cap left its " +
          `patch out or cut it short: at most ${DIFF_CAPS.maxFiles} files are listed and ` +
          `${DIFF_CAPS.maxPatchedFiles} given a patch, sides over ${DIFF_CAPS.maxBlobBytes} bytes are ` +
          `\`tooLarge\`, and patches stop at ${DIFF_CAPS.maxPatchBytes} bytes or ${DIFF_CAPS.maxPatchLines} ` +
          "lines in all. With `Accept: text/x-diff`, the answer is the files' patches concatenated, " +
          "ready for `git apply`.",
        tags: ["Browse"],
        security,
        middleware: [auth] as const,
        request: { params: ProjectPathSchema.extend({ sha: ShaSchema }), query: AttemptQuerySchema },
        responses: {
          200: { description: "The diff.", content: diffContent(CommitDiffSchema) },
          ...refErrors,
        },
      }),
      async (c) => {
        const { sha, ...params } = c.req.valid("param");
        const at = await resolved(c, browse(c.env), c.var.actor, { ...params, ref: sha, ...c.req.valid("query") });
        if (at instanceof Response) return at;
        const diff = await diffCommit(repos(c.env), at.repo, at.sha, { cache: diffCache(c.env) });
        if (diff === null) throw new ServiceError("notFound", `no commit ${at.sha}`);
        cacheFor(c, at);
        return diffResponse(
          c,
          () => unifiedPatch(diff),
          () => diff,
        ) as never;
      },
    );
}

/**
 * Resolves the ref. When `If-None-Match` already names the resolved sha, returns the 304 to send
 * instead, so nothing else is read.
 */
async function resolved(
  c: Context,
  browse: BrowseService,
  actor: Actor,
  input: Parameters<BrowseService["resolve"]>[1],
): Promise<Resolved | Response> {
  const at = await browse.resolve(actor, input);
  if (!matches(c.req.header("If-None-Match"), etag(at))) return at;
  cacheFor(c, at);
  return c.body(null, 304);
}

/** Sets a successful read's cache headers. Only then: a 404 for a sha may stop being one. */
function cacheFor(c: Context, at: Resolved): void {
  c.header("ETag", etag(at));
  c.header("Cache-Control", at.immutable ? IMMUTABLE : REF_CACHE);
}

function etag(at: Resolved): string {
  return `"${at.sha}"`;
}

function matches(header: string | undefined, tag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((candidate) => {
    const t = candidate.trim();
    return t === "*" || t === tag || t === `W/${tag}`;
  });
}

function trimSlashes(path: string): string {
  return path
    .split("/")
    .filter((s) => s !== "")
    .join("/");
}
