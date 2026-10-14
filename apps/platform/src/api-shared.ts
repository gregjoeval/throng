// HTTP plumbing more than one route module shares (the REST routes in `api.ts`, `browse-api.ts` and
// `dequeue-api.ts`, and the MCP tools in `mcp.ts`): the project path, multi-segment `{path}` routes,
// the public shape of a file or commit diff with its `text/x-diff` answer, a landing's conflicting
// file diffed to either side, the request schemas the MCP tools reuse, and the project and task services.

import { z } from "@hono/zod-openapi";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { publicOrigin } from "./access.ts";
import type { AccessBindings } from "./access.ts";
import { DEFAULT_COMMITS_PAGE, MAX_COMMITS_PAGE } from "./browse.ts";
import { SelectionPolicySchema } from "./config.ts";
import { DIFF_FLAGS, diffFile, FILE_STATUSES } from "./diff.ts";
import type { DiffCache, FileSide } from "./diff.ts";
import { ServiceError } from "./errors.ts";
import { MAX_SOURCE_URL } from "./import-source.ts";
import { MAX_PROJECT_HANDLE, PROJECT_HANDLE, projectService } from "./projects.ts";
import type { Repos } from "./repos.ts";
import { DEFAULT_RUNS_PAGE, isLineFilter, MAX_RUNS_PAGE, RUN_STATUSES } from "./scoring.ts";
import { taskService } from "./tasks.ts";
import type { ConflictFileSource, TaskBackend } from "./tasks.ts";
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

/** The sides a conflicting file diffs to from its merge base: `main`, or the approved head. */
export const CONFLICT_SIDES = ["main", "attempt"] as const;
export type ConflictSide = (typeof CONFLICT_SIDES)[number];

export const ConflictSideQuerySchema = z.object({
  side: z.enum(CONFLICT_SIDES).openapi({ description: "Diff to `main`'s file, or to the approved head's." }),
});

/** A conflict diff's description: what it diffs, and the caps and answers it shares with the commit diff. */
export const CONFLICT_DIFF_DESCRIPTION =
  "from its base blob to `main`'s (`side=main`) or the approved head's (`side=attempt`). A side with no file is " +
  "a delete; a base with none, an add. The commit diff's per-file caps apply. With `Accept: text/x-diff`, the " +
  "answer is the patch.";

/**
 * Answers one conflicting file diffed from its merge base to `side`. The base's and `main`'s blobs
 * are in the origin; the approved head's in its fork while the attempt is active, and in the origin
 * once it's archived.
 */
export async function conflictDiffResponse(
  c: Context,
  repos: Repos,
  { file, origin, fork }: ConflictFileSource,
  side: ConflictSide,
): Promise<Response> {
  const sideOf = (s: "base" | ConflictSide): FileSide | null => {
    const hash = file.blobs[s];
    const mode = file.modes[s];
    return hash === null || mode === null ? null : { path: file.path, mode, hash };
  };
  const old = sideOf("base");
  const next = sideOf(side);
  if (old === null && next === null)
    throw new ServiceError("notFound", `neither the base nor ${side} has ${file.path}`);
  const diff = (repo: string) => diffFile(repos, repo, old, next);
  const found = side === "main" ? await diff(origin) : await diff(fork).catch(() => diff(origin));
  return diffResponse(
    c,
    () => found.patch ?? "",
    () => found,
  );
}

/** Whether the client asked for the unified patch rather than JSON. */
export function wantsPatch(accept: string | undefined): boolean {
  return accept?.split(",").some((t) => t.split(";")[0]?.trim().toLowerCase() === "text/x-diff") ?? false;
}

/**
 * The project service for an environment, given its repos and how an import source's host is
 * reached (the global `fetch` when undefined).
 */
export function envProjectService(repos: (env: AccessBindings) => Repos, fetch: typeof globalThis.fetch | undefined) {
  return (env: AccessBindings) => projectService({ db: env.DB, repos: repos(env), fetch });
}

/**
 * The task service for a request, given the environment's repos and task backends. Attempts name
 * their git remotes on the platform's public origin.
 */
export function requestTaskService(
  repos: (env: AccessBindings) => Repos,
  tasks: (env: AccessBindings) => (projectId: string) => TaskBackend,
) {
  return ({ env, req }: { env: AccessBindings; req: { url: string } }) =>
    taskService({ db: env.DB, repos: repos(env), backend: tasks(env), origin: publicOrigin(env, req.url) });
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

/** A task's selection policy as a request gives it, checked like `.throng/config.yml`'s `selection`. */
export const SelectionPolicyInputSchema = SelectionPolicySchema.nullable().openapi({
  description:
    "Overrides the project's selection policy (`.throng/config.yml`'s `selection`); null to use the project's. " +
    "`policy` is `creator` (the task's creator selects) or `vote` (a vote among `eligible` users: `humans` acting " +
    "as themselves, `aliases` acting under an alias, or `anyone`, the default). Only the project owner may set or " +
    "change it, and not while the task has an open vote.",
  example: { policy: "vote", eligible: "humans" },
});

export const OpenVoteSchema = z
  .object({
    deadline: z.iso
      .datetime({ offset: true })
      .optional()
      .openapi({ description: "When ballots stop being taken, in the future; none by default." }),
  })
  .openapi("OpenVote");

export const BallotSchema = z
  .object({ attempt: z.string().openapi({ description: "A candidate in the task's open vote.", example: "t42a3" }) })
  .openapi("Ballot");

export const VoteCandidateSchema = z
  .object({ attempt: z.string().openapi({ description: "An attempt of the task passing now.", example: "t42a3" }) })
  .openapi("VoteCandidate");

export const CloseVoteSchema = z
  .object({
    attempt: z.string().optional().openapi({
      description: "Breaks a tie: one of the tied candidates. If given otherwise, it must be the winner.",
      example: "t42a3",
    }),
  })
  .openapi("CloseVote");

export const AttemptLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .nullable()
  .openapi({ description: "Overrides the project's cap on active attempts; null to use the project's." });

/** A task's checks as a request gives them: checked like `.throng/config.yml`'s, so they're described there. */
export const TaskChecksInputSchema = z.array(z.unknown()).openapi({
  description:
    "The task's own checks, run beside the project's after its `setup`, under its " +
    "`network.allow`, in the shape of `.throng/config.yml`'s `checks`: `name`, `command`, and optionally " +
    "`timeout` and `after` (the checks it waits for, the project's or the task's). Every task check that " +
    "runs must pass for an attempt's gate to pass. Names must " +
    "not start with `_` or clash with a setup, check or metric in the project's config on `main`. Replaces the " +
    "task's checks; its metrics may read them.",
  example: [{ name: "smoke", command: "./smoke.sh", timeout: "2m" }],
});

/** A task's metrics as a request gives them: checked like `.throng/config.yml`'s, so they're described there. */
export const TaskMetricsInputSchema = z.array(z.unknown()).openapi({
  description:
    "The task's own metrics, read after the project's, in the shape of `.throng/config.yml`'s `metrics`: " +
    "`name`, `from`, `type`, and as its type allows `unit`, `order`, `values` and `format`. Names must not " +
    "start with `_` or clash with a check or metric in the project's config on `main`, or one of the task's " +
    "checks, and each `from` must name one of the project's or the task's checks. Replaces the task's metrics.",
  example: [{ name: "lines", from: "test.coverage-summary.total.lines.total", type: "number", order: "asc" }],
});

export const CreateProjectSchema = z
  .object({
    handle: z
      .string()
      .max(MAX_PROJECT_HANDLE)
      .regex(PROJECT_HANDLE, "handle must be lowercase letters and digits, joined by single dashes")
      .openapi({ description: "The project's handle, unique among the owner's projects.", example: "throng" }),
    source: z
      .object({
        url: z
          .string()
          .max(MAX_SOURCE_URL)
          .openapi({
            description:
              "The HTTPS URL of a public git repository on any smart-HTTP host: `https:` only, with no " +
              "credentials, query or fragment.",
            example: "https://github.com/octocat/Hello-World",
          }),
      })
      .optional()
      .openapi({
        description:
          "A repository to import. Its default branch becomes the origin's `main`, whatever its name, with " +
          "its full history. The copy is made once, before the call returns, and never refreshed.",
      }),
  })
  .openapi("CreateProject");

export const CreateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(65_536).optional().openapi({ description: "Markdown." }),
    attemptLimit: AttemptLimitSchema.optional(),
    selection: SelectionPolicyInputSchema.optional(),
    checks: TaskChecksInputSchema.optional(),
    metrics: TaskMetricsInputSchema.optional(),
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
        "What to wait for, with `wait`: `scored`, the current head has a `done` or `errored` run, or one waiting for " +
        "the project owner to start it (at once if it already has one); " +
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

/** Who may grant a secret or start a waiting run: a 403's description on those routes. */
export const OWNER_AS_THEMSELVES = "Only the project owner, acting as themselves (never under an alias), may.";

export const StartRunSchema = z
  .object({
    sha: z.string().min(1).openapi({
      description:
        "The head you reviewed, as the run's `waiting.head` gives it. If the run no longer waits on it, nothing starts.",
      example: "3f2a9c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291",
    }),
  })
  .openapi("StartRun");

/** `GET …/runs`' filters and cursor; `list_runs` takes the same. */
export const RunsQuerySchema = z.object({
  line: z
    .string()
    .refine(isLineFilter, { error: "line must be `main`, `tasks`, a task (`t42`) or an attempt (`t42a3`)" })
    .optional()
    .openapi({
      description:
        "Only this line's runs: `main`, a task's task branch (`t42`) or an attempt (`t42a3`); `tasks` for every " +
        "line but `main`. Every line when absent.",
      example: "main",
    }),
  status: z.enum(RUN_STATUSES).optional().openapi({ description: "Only runs with this status.", example: "waiting" }),
  cursor: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({ description: "Where a page starts: the `next` of the page before it. Absent for the first page." }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RUNS_PAGE)
    .default(DEFAULT_RUNS_PAGE)
    .openapi({ description: `Runs per page: ${DEFAULT_RUNS_PAGE} by default, at most ${MAX_RUNS_PAGE}.` }),
});
