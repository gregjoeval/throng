// The product API, mounted at `/api` and described by the OpenAPI document at `/api/openapi.json`.
// Access does not sit in front of it: machine clients use Throng bearer tokens. Only `/me` and
// `/tokens` also accept an Access session, so a human can mint their first token. Over the service
// binding (see `app.ts`), those, the project routes and the read API (`browse-api.ts`) the browser
// needs also take throng-web's forwarded identity. Handlers stay thin: they call a service function
// `(actor, input)`, which checks permissions itself (MCP tools call the same functions) and throws
// `ServiceError`s that `onError` turns into the error shape.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessBindings } from "./access.ts";
import {
  AttemptLimitSchema,
  BallotSchema,
  CloseVoteSchema,
  CONFLICT_DIFF_DESCRIPTION,
  conflictDiffResponse,
  ConflictSideQuerySchema,
  CreateAttemptsSchema,
  CreateTaskSchema,
  diffContent,
  EditAttemptSchema,
  FileDiffSchema,
  HandOffSchema,
  json,
  OpenVoteSchema,
  OWNER_AS_THEMSELVES,
  pageQuerySchema,
  PageSchema,
  PostVerdictSchema,
  ProjectPathSchema,
  requestTaskService,
  RunsQuerySchema,
  SelectionPolicyInputSchema,
  SelectionSchema,
  StartRunSchema,
  TAIL,
  tailedRoutes,
  TaskChecksInputSchema,
  TaskMetricsInputSchema,
  VoteCandidateSchema,
  WaitQuerySchema,
  workersCache,
} from "./api-shared.ts";
import { bearerAuth, bearerOrAccess, bearerOrForwarded } from "./auth.ts";
import type { AuthEnv, AuthOptions } from "./auth.ts";
import { BASE_LINES } from "./base.ts";
import { browseRoutes } from "./browse-api.ts";
import {
  CONFIG_LAYERS,
  CONFIG_NAME,
  DEFAULT_SANDBOX_SIZE,
  MAX_CHECK_TIMEOUT_MS,
  MAX_CONFIG_BYTES,
  METRIC_ORDERS,
  parseConfig,
  SANDBOX_SIZES,
  SELECTION_POLICIES,
  SOURCES,
  VOTE_ELIGIBILITIES,
} from "./config.ts";
import { ConflictDetailsSchema, dequeueRoutes } from "./dequeue-api.ts";
import type { DiffCache } from "./diff.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import { FORWARDED_EMAIL_HEADER } from "./forwarded.ts";
import { firstLog, LOG_CONTENT_TYPE, LOG_RETENTION_DAYS, MAX_LOG_BYTES, missingLog } from "./logs.ts";
import type { LogStore } from "./logs.ts";
import { DEQUEUE_REASONS, MERGE_REQUEST_STATES } from "./merge-requests.ts";
import { METRIC_FORMATS, METRIC_TYPES } from "./metric-values.ts";
import { DEFAULT_LISTING_PAGE, MAX_LISTING_PAGE, myListings } from "./my-listings.ts";
import { PIPELINES } from "./pipelines.ts";
import { MAX_PROJECTION_RETRY_MS } from "./projection.ts";
import { MAX_PROJECT_HANDLE, PROJECT_HANDLE, projectService } from "./projects.ts";
import type { Repos } from "./repos.ts";
import { CHECK_OUTCOMES, GATES } from "./results.ts";
import { STEP_KINDS, STEP_OUTCOMES } from "./run-outcome.ts";
import { ATTEMPT_SCORING_STATUSES, RUN_STATUSES, SCORING_TRIGGERS } from "./scoring.ts";
import { secretsRoutes } from "./secrets-api.ts";
import { SECRET_NAME } from "./secrets.ts";
import { ATTEMPT_STATES, TASK_STATES } from "./task-store.ts";
import type { TaskBackend } from "./tasks.ts";
import { DEFAULT_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS, tokenService } from "./tokens.ts";
import type { Token } from "./tokens.ts";
import type { User } from "./users.ts";
import { VERDICT_RECOMMENDATIONS } from "./verdicts.ts";
import { VOTE_STATES } from "./votes.ts";
import { MAX_WAITERS_PER_USER } from "./waiters.ts";

const UserSchema = z
  .object({ id: z.string(), handle: z.string(), email: z.string(), createdAt: z.string() })
  .openapi("User");

const TokenSchema = z
  .object({
    id: z.string(),
    alias: z.string().nullable(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Token");

const MeSchema = z
  .object({
    user: UserSchema,
    alias: z.string().nullable().openapi({ description: "The alias the caller's token acts under, if any." }),
    token: z
      .object({ id: z.string(), expiresAt: z.string() })
      .nullable()
      .openapi({ description: "The caller's token; null under an Access session." }),
  })
  .openapi("Me");

const MintTokenSchema = z
  .object({
    alias: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^\p{C}()]+$/u, "alias must be printable text without parentheses")
      .nullable()
      .optional()
      .openapi({
        description:
          "An alias of the caller, e.g. `claude`, or null for the caller as themselves. Omitted, it is the alias the " +
          "caller's token acts under, if any.",
      }),
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

const ConfigNameSchema = z.string().regex(CONFIG_NAME);

/** Who defined a declared check or metric. */
const ConfigLayerSchema = z
  .enum(CONFIG_LAYERS)
  .openapi({ description: "Who defined it: the project's config, or the task." });

/** The fields only some metric types have, described once for a declared metric and a metric result. */
const METRIC_TYPE_FIELDS = {
  numberOrder: z.enum(METRIC_ORDERS).openapi({ description: "`asc` when lower is better, `desc` when higher is." }),
  booleanOrder: z.enum(METRIC_ORDERS).openapi({ description: "`desc` when true is better, `asc` when false is." }),
  unit: z.string().openapi({ example: "%" }),
  format: z.enum(METRIC_FORMATS).openapi({ description: "`url`: shown as a link." }),
  values: z.array(z.string()).openapi({ description: "Every value it may take, best first." }),
};

const configMetricFields = {
  name: ConfigNameSchema.openapi({ example: "coverage" }),
  from: z.string().openapi({
    description:
      "Where its value is read: the check, a JSON file it writes into `$THRONG_OUTPUT` (without `.json`), then " +
      "object keys and array indexes.",
    example: "test.coverage-summary.total.lines.pct",
  }),
  source: ConfigLayerSchema,
};

const MetricSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...configMetricFields,
      type: z.literal("number"),
      unit: METRIC_TYPE_FIELDS.unit.nullable(),
      order: METRIC_TYPE_FIELDS.numberOrder,
    }),
    z.object({
      ...configMetricFields,
      type: z.literal("boolean"),
      order: METRIC_TYPE_FIELDS.booleanOrder,
    }),
    z.object({
      ...configMetricFields,
      type: z.literal("string"),
      format: METRIC_TYPE_FIELDS.format.nullable(),
    }),
    z.object({
      ...configMetricFields,
      type: z.literal("enum"),
      values: METRIC_TYPE_FIELDS.values,
    }),
  ])
  .openapi("Metric", {
    description:
      `A metric the config declares. Its \`type\` (${METRIC_TYPES.join(", ")}) decides how its values compare; a ` +
      "string never ranks.",
  });

const SecretNameSchema = z.string().regex(SECRET_NAME);

const SecretNamesSchema = z.array(SecretNameSchema).openapi({
  description:
    "The secrets it uses, by name. A trusted run's container holds each one the project settings allow in its " +
    "pipeline; a task's check names none.",
  example: ["NPM_TOKEN"],
});

const CacheNamesSchema = z.array(ConfigNameSchema).openapi({
  description:
    "The caches it uses, by name: each is restored before it runs when an entry matches its key exactly, and a " +
    "trusted run saves it once it passed. A task's check may name only caches the project's config defines.",
  example: ["pnpm"],
});

const ConfigCacheSchema = z
  .object({
    name: ConfigNameSchema.openapi({ example: "pnpm" }),
    path: z.array(z.string()).openapi({
      description: "The paths it keeps, absolute or under `~/`.",
      example: ["~/.local/share/pnpm/store", "~/.cache/pnpm"],
    }),
    key: z.array(z.string()).openapi({
      description: "The files in the tree whose contents key it: paths or globs.",
      example: ["pnpm-lock.yaml"],
    }),
  })
  .openapi("Cache", {
    description:
      "A named cache the config declares. Runs restore it only on an exact match of its key; only trusted runs " +
      "save it.",
  });

const ConfigCheckSchema = z
  .object({
    name: ConfigNameSchema.openapi({ example: "test" }),
    command: z.string().openapi({ example: "pnpm test" }),
    timeoutMs: z
      .number()
      .int()
      .max(MAX_CHECK_TIMEOUT_MS)
      .openapi({ description: "Defaults to 10 minutes.", example: 600_000 }),
    after: z.array(ConfigNameSchema).openapi({
      description: "The checks it waits for: it runs only once each of them passed, and is skipped otherwise.",
      example: ["typecheck"],
    }),
    secrets: SecretNamesSchema,
    caches: CacheNamesSchema,
    group: ConfigNameSchema.nullable().openapi({
      description:
        "The one group it is in, which a pipeline's `groups` choose it by; null outside one, and always for a " +
        "task's check, which runs on every attempt of its task.",
      example: "verify",
    }),
    source: ConfigLayerSchema,
  })
  .openapi("Check", {
    description:
      "A check the config declares: a command whose exit code is its outcome. Every check that runs must pass.",
  });

const ConfigSetupSchema = z
  .object({
    name: ConfigNameSchema.openapi({ example: "deps" }),
    command: z.string().openapi({ example: "pnpm install --frozen-lockfile" }),
    secrets: SecretNamesSchema,
    caches: CacheNamesSchema,
  })
  .openapi("Setup", {
    description: "A setup the config declares: a command run before every check. A failed setup stops the run.",
  });

const VoteEligibilitySchema = z.enum(VOTE_ELIGIBILITIES).openapi({
  description: "Who may vote: `humans` acting as themselves, `aliases` acting under an alias, or `anyone`.",
});

/** A selection policy as a response shows it; `config.ts`'s `SelectionPolicySchema` reads one from a request. */
const SelectionPolicyOutSchema = z
  .object({
    policy: z.enum(SELECTION_POLICIES),
    eligible: VoteEligibilitySchema.optional().openapi({ description: "With `vote` only." }),
  })
  .openapi("SelectionPolicy", {
    description: "Who makes a task's selection: its creator, or a vote among eligible users.",
  });

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
    checks: z
      .array(ConfigCheckSchema)
      .openapi({ description: "The task's own checks, run after the project's; empty by default." }),
    metrics: z
      .array(MetricSchema)
      .openapi({ description: "The task's own metrics, read after the project's; empty by default." }),
    taskBranch: z
      .object({
        sha: z.string().openapi({ description: "The task branch's head." }),
        commits: z.number().int().openapi({
          description: "How many of its commits `main` doesn't have yet: they land with the selected attempt.",
        }),
      })
      .nullable()
      .openapi("TaskBranch", {
        description:
          "The task's task branch, `refs/tasks/t42` in the origin, which new attempts start from; null when it has none. " +
          "The task creator or project owner pushes it with `git push throng HEAD:refs/tasks/t42`.",
      }),
    selection: SelectionPolicyOutSchema.nullable().openapi({
      description: "Overrides the project's selection policy; null to use the project's.",
    }),
  })
  .openapi("Task");

const VerdictSummarySchema = z
  .object({
    head: z.string().nullable().openapi({ description: "The attempt's current head; null before any push." }),
    merge: z.number().int(),
    revise: z.number().int(),
    reject: z.number().int(),
  })
  .openapi("VerdictSummary", {
    description: "The verdicts on the attempt's current head, counted by recommendation. Superseded ones don't count.",
  });

const VerdictSchema = z
  .object({
    reviewer: UserRefSchema,
    alias: z.string().nullable().openapi({ description: "The alias the reviewer posted under, if any." }),
    head: z.string().openapi({ description: "The head it judges: the attempt's current head when it was posted." }),
    recommendation: z.enum(VERDICT_RECOMMENDATIONS),
    body: z.string().openapi({ description: "Markdown." }),
    at: z.string().openapi({ description: "When it was posted, or last replaced." }),
    superseded: z.boolean().openapi({ description: "Whether its head is no longer the attempt's current head." }),
  })
  .openapi("Verdict");

const ActorRefSchema = UserRefSchema.extend({
  alias: z.string().nullable().openapi({ description: "The alias they acted under, if any." }),
}).openapi("ActorRef");

const VoteSchema = z
  .object({
    task: z.string().openapi({ example: "t42" }),
    state: z.enum(VOTE_STATES),
    eligible: VoteEligibilitySchema,
    deadline: z.string().nullable().openapi({ description: "When ballots stop being taken; null for none." }),
    openedBy: ActorRefSchema,
    openedAt: z.string(),
    closedBy: ActorRefSchema.nullable().openapi({ description: "Null while open, or when it closed with its task." }),
    closedAt: z.string().nullable(),
    winner: z
      .string()
      .nullable()
      .openapi({ description: "The attempt it selected, once closed with a selection.", example: "t42a3" }),
    candidates: z
      .array(
        z
          .object({
            attempt: z.string().openapi({ example: "t42a3" }),
            head: z.string().openapi({ description: "The head it is a candidate at: the one it was passing at." }),
            addedAt: z.string(),
            votes: z.number().int().openapi({ description: "The ballots for it at `head`; none while withdrawn." }),
            withdrawn: z.boolean().openapi({
              description:
                "It doesn't count now: it counts only while its attempt is open and passing at `head`. Its author " +
                "pushed it away from `head`, or `head`'s latest scoring failed the gate; the task's creator can add it " +
                "again once it passes. A follow of the task branch isn't its author's push: it moves `head`, with the " +
                "ballots, to its merge. Also true while `beingScored` or with an `erroredRun`.",
            }),
            beingScored: z.boolean().openapi({
              description:
                "Withdrawn only until `head`, its attempt's head, finishes being scored: a follow's merge, or a rescore " +
                "queued or running. It counts again if `head` passes, and stays withdrawn if it fails. The vote can't " +
                "be closed meanwhile. Always false once the vote closed.",
            }),
            erroredRun: z
              .number()
              .int()
              .nullable()
              .openapi({
                description:
                  "The run whose error left `head` with no result (`GET …/runs/{runId}` and its logs say why). The " +
                  "candidate keeps its ballots and is withdrawn only until a rescore of `head` passes, which its " +
                  "attempt's author, the task's creator or the project owner may ask for; the vote can't be closed " +
                  "meanwhile. Always null once the vote closed.",
              }),
          })
          .openapi("VoteCandidateTally"),
      )
      .openapi({ description: "In the order they were added." }),
    myBallot: z
      .object({
        attempt: z.string().openapi({ example: "t42a3" }),
        head: z.string(),
        alias: z.string().nullable().openapi({ description: "The alias it was cast under, if any." }),
        at: z.string(),
      })
      .nullable()
      .openapi({ description: "The caller's ballot: their user's, cast as themselves or under any alias." }),
  })
  .openapi("Vote", { description: "A task's selection by vote." });

const ListedTaskSchema = TaskSchema.extend({
  attemptCount: z.number().int().openapi({ description: "Its attempts, obsolete ones left out.", example: 3 }),
  bestGate: z.enum(GATES).nullable().openapi({
    description:
      "The best gate among those attempts' current results: `passed` beats `failed`. Null when none has a result.",
  }),
  mergeRequestState: z
    .enum(MERGE_REQUEST_STATES)
    .nullable()
    .openapi({ description: "Its latest merge request's state, or null when it has none." }),
}).openapi("ListedTask");

const PROJECTION_NOTE =
  "Read from a copy every project publishes after each change, so it trails the project: usually by seconds, " +
  `but by up to ${MAX_PROJECTION_RETRY_MS / 60_000} minutes while that copy can't be written. ` +
  "Obsolete ones are left out unless `state=obsolete` asks for them. " +
  `Paged by \`offset\` and \`limit\`: ${DEFAULT_LISTING_PAGE} by default, at most ${MAX_LISTING_PAGE}.`;

const MyListingQuerySchema = pageQuerySchema("Items", DEFAULT_LISTING_PAGE, MAX_LISTING_PAGE);

/** A task as a listing across projects shows it: the fields the projection carries, and its project. */
const MyTaskSchema = TaskSchema.pick({
  ref: true,
  number: true,
  title: true,
  state: true,
  creator: true,
  createdAt: true,
  closedAt: true,
})
  .extend({ project: ProjectSchema })
  .openapi("MyTask");

/** Where an attempt was copied from: provenance only, never its base. */
const AliasSchema = z.string().nullable().openapi({
  description:
    "The alias its author started it under (`claude`); null when they acted as themselves, or after a hand-off.",
});

const ForkedFromSchema = z
  .string()
  .optional()
  .openapi({
    description:
      "The attempt of the same task this one was copied from when it was started. Absent when it wasn't. " +
      "Provenance only: never its base.",
    example: "t42a1",
  });

const NeedsUpdateSchema = z.boolean().openapi({
  description:
    "True while the task's task branch has moved and merging it into this active attempt conflicted. Nothing " +
    "was written; its author merges the task branch (`refs/tasks/t42`) and pushes, which clears it.",
});

const AttemptSchema = z
  .object({
    ref: z.string().openapi({ description: "The attempt's reference.", example: "t42a3" }),
    task: z.number().int().openapi({ example: 42 }),
    number: z.number().int().openapi({ description: "Per task, 1-based and never reused.", example: 3 }),
    author: UserRefSchema,
    alias: AliasSchema,
    state: z.enum(ATTEMPT_STATES),
    fork: z.string().openapi({ description: "The logical fork name, kept for the attempt's life.", example: "t42a3" }),
    remote: z.string().openapi({
      description:
        "The attempt's git remote, its fork. Clone and push with a Throng token as the bearer or Basic password.",
      example: "https://throng.example/git/greg/throng/t42a3.git",
    }),
    branch: z.string().nullable().openapi({ description: "The origin branch a push created it from." }),
    note: z.string().openapi({ description: "Markdown." }),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
    mergedSha: z.string().nullable(),
    archivedSha: z.string().nullable(),
    forkedFrom: ForkedFromSchema,
    needsUpdate: NeedsUpdateSchema,
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
    verdicts: VerdictSummarySchema,
  })
  .openapi("Attempt");

const RunSchema = z
  .object({
    id: z.number().int(),
    line: z.string().openapi({
      description: "The line it runs on: an attempt's fork (`t42a3`), a task's task branch (`t42`) or `main`.",
      example: "t42a3",
    }),
    pipeline: z.enum(PIPELINES).openapi({ description: "`main` on the `main` line, `default` on every other." }),
    sha: z.string().nullable().openapi({
      description: "The head it runs; null for a merge request's landing until it lands, when it is the landed commit.",
    }),
    trigger: z.enum(SCORING_TRIGGERS).openapi({
      description: "`merge` for a merge request's landing; `start` once the project owner started it after it waited.",
    }),
    status: z.enum(RUN_STATUSES).openapi({
      description: "`waiting` while it needs the project owner to start it; it holds no slot meanwhile.",
    }),
    waiting: z
      .object({
        head: z.string().openapi({
          description:
            "The head it would run, which Start names: its own, or for a merge request's landing the approved head.",
        }),
        attempt: z.string().nullable().openapi({
          description: "The attempt `head` is on: the run's own line, or a landing's source attempt; null otherwise.",
          example: "t42a3",
        }),
        base: z
          .string()
          .nullable()
          .openapi({
            description:
              "Where to diff `head` from to review it (`compare/{base}...{head}`): an attempt's base, or where a task " +
              "branch meets `main`. Null for a merge request's landing, whose approved head is diffed from `main`, and " +
              "when they share no history.",
          }),
        secrets: z.array(SecretNameSchema).openapi({ description: "The secrets it would hold once started, by name." }),
        taskCheck: z
          .object({
            name: z.string().openapi({ example: "lint" }),
            writtenBy: UserRefSchema,
          })
          .nullable()
          .openapi({
            description:
              "Why a run of code the owner pushed waits: a task check it runs that someone other than the owner " +
              "wrote, and who. Null when it waits because its head isn't the owner's.",
          }),
      })
      .nullable()
      .openapi({
        description:
          "While it waits for the project owner, what starting it means; null otherwise. A run of code that isn't the " +
          "owner's waits when it names a secret, and a merge request no owner approved waits when `main` names one.",
      }),
    trusted: z.boolean().openapi({ description: "Whether it may hold the secrets its pipeline allows." }),
    requestedBy: UserRefSchema.nullable().openapi({ description: "Who triggered it; null when no user did." }),
    alias: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    superseded: z.boolean().openapi({ description: "Whether its head is no longer its line's current head." }),
    gate: z.enum(GATES).nullable().openapi({ description: "Its gate once `done`; null until then." }),
    cancellable: z.boolean().openapi({
      description:
        "Whether the project owner may cancel it now: while it is queued, waiting, or running on any line but " +
        "`main`. Never a landing, which only its merge request leaving the queue cancels.",
    }),
  })
  .openapi("Run", { description: "One pipeline run on one of the project's lines." });

const ScoringSchema = z
  .object({
    queued: z.boolean().openapi({ description: "Whether this request queued a new run." }),
    reason: z.string().nullable().openapi({
      description: "Why nothing was queued: the head is already queued, running or scored.",
      example: "already scored",
    }),
    run: RunSchema.openapi({ description: "The run that was queued, or the one already covering the head." }),
  })
  .openapi("ScoringRequest");

const metricFields = {
  source: z.enum(SOURCES).openapi({ description: "Who defined it: Throng, the project's config or the task." }),
  note: z.string().optional().openapi({
    description:
      "Why its value is null; on a value, what to know about it, such as that an older result was converted.",
  }),
};

const MetricResultSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...metricFields,
      type: z.literal("number"),
      value: z.number().nullable(),
      order: METRIC_TYPE_FIELDS.numberOrder,
      unit: METRIC_TYPE_FIELDS.unit.optional(),
    }),
    z.object({
      ...metricFields,
      type: z.literal("boolean"),
      value: z.boolean().nullable(),
      order: METRIC_TYPE_FIELDS.booleanOrder,
    }),
    z.object({
      ...metricFields,
      type: z.literal("string"),
      value: z.string().nullable(),
      format: METRIC_TYPE_FIELDS.format.optional(),
    }),
    z.object({
      ...metricFields,
      type: z.literal("enum"),
      value: z.string().nullable(),
      values: METRIC_TYPE_FIELDS.values,
    }),
  ])
  .openapi("MetricResult", { description: "One typed value in a run's score; null when it couldn't be measured." });

const ScoringResultSchema = z
  .object({
    base: z
      .string()
      .nullable()
      .openapi({
        description:
          "The head's base at scoring time: its merge-base with the task branch, or with `origin/main` when the task has " +
          "none; null with no shared history.",
      }),
    config: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("valid") }),
        z.object({ kind: z.literal("invalid"), error: z.string() }),
      ])
      .openapi({ description: "How the `.throng/config.yml` on `origin/main` it was scored under parsed." }),
    gate: z.enum(GATES).openapi({
      description:
        "Passed when setup passed and every check that ran passed; failed on an invalid config. Throng's own " +
        "checks never change it.",
    }),
    checks: z
      .array(
        z
          .object({
            name: z.string().openapi({ example: "test" }),
            source: z.enum(SOURCES),
            outcome: z.enum(CHECK_OUTCOMES),
            durationMs: z.number(),
            notes: z.array(z.string()).openapi({
              description: "What the run noticed about it, such as why it was skipped.",
            }),
          })
          .openapi("CheckResult"),
      )
      .openapi({
        description:
          "Every check in run order: Throng's `_diff` (finding the base and diffing), then the config's checks.",
      }),
    metrics: z.record(z.string(), MetricResultSchema).openapi({
      description:
        "Every metric by name: each check's outcome metric (an enum named after the check), followed by that " +
        "check's own metrics, such as `_diff.filesChanged`.",
    }),
    logs: z.array(z.string()).openapi({
      description:
        "The run's stored logs by name, in run order, for `GET …/runs/{runId}/logs/{step}`. A step that never ran has none.",
      example: ["setup.1", "test"],
    }),
  })
  .openapi("ScoringResult");

const CurrentResultSchema = ScoringResultSchema.extend({
  run: z.number().int().openapi({ description: "The run it came from." }),
  finishedAt: z.string(),
}).openapi("CurrentResult", {
  description: "The attempt's current result: the latest `done` run for its current head.",
});

const RunStepSchema = z
  .object({
    name: z.string().openapi({ description: "`setup.<n>`, a check's name, or a post-gate step's.", example: "test" }),
    kind: z.enum(STEP_KINDS).openapi({ description: "A setup, a check, or a post-gate step." }),
    source: z.enum(SOURCES),
    group: z.string().nullable().openapi({ description: "The check's group; null outside one." }),
    after: z.array(z.string()).openapi({ description: "The checks it waited for." }),
    outcome: z.enum(STEP_OUTCOMES),
    durationMs: z.number(),
    notes: z.array(z.string()).openapi({ description: "What the run noticed about it, such as why it was skipped." }),
    log: z.string().nullable().openapi({
      description: "Its stored log's name, for `GET …/runs/{runId}/logs/{step}`; null when it stored none.",
      example: "test",
    }),
  })
  .openapi("RunStep");

const RunOutcomeSchema = ScoringResultSchema.pick({ base: true, config: true, gate: true, metrics: true })
  .extend({
    steps: z.array(RunStepSchema).openapi({
      description:
        "Every step in run order: Throng's `_diff`, the setups, the checks, then any post-gate steps. A landing " +
        "has Throng's `merge` after `_diff` and `land` before the post-gate steps.",
    }),
    landed: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("landed"), sha: z.string().openapi({ description: "The commit it landed." }) }),
        z.object({
          kind: z.literal("conflict"),
          details: ConflictDetailsSchema.openapi({
            description:
              "The conflict its `merge` hit, file by file; `GET …/runs/{runId}/conflict/files/{path}/diff` diffs a " +
              "file from the merge base to either side.",
          }),
        }),
      ])
      .optional()
      .openapi({
        description:
          "For a landing: what it landed, or the conflict that stopped it; absent otherwise, and when its gate failed.",
      }),
  })
  .openapi("RunOutcome");

const RunDetailSchema = RunSchema.extend({
  error: z.string().nullable().openapi({ description: "What ended it, once `errored`." }),
  outcome: RunOutcomeSchema.nullable().openapi({ description: "How it went, step by step, once `done`." }),
  result: ScoringResultSchema.nullable().openapi({
    description: "The slice of its outcome an attempt's scoring reads, once `done`.",
  }),
}).openapi("RunDetail", { description: "A run, with its outcome or error." });

const RunPathSchema = ProjectPathSchema.extend({
  runId: z.coerce.number().int().min(1).openapi({ description: "A run's id.", example: 7 }),
});

const RunsListSchema = z
  .object({
    runs: z.array(RunSchema).openapi({ description: "Newest first." }),
    next: z.number().int().nullable().openapi({ description: "The next page's `cursor`; null on the last page." }),
  })
  .openapi("RunsList");

const ScoringStatusSchema = z
  .object({
    status: z.enum(ATTEMPT_SCORING_STATUSES),
    sha: z.string().nullable().openapi({ description: "The head it applies to; null before any push." }),
    result: CurrentResultSchema.optional().openapi({
      description: "Absent until the head has a `done` run. Results for older heads are superseded, never current.",
    }),
  })
  .openapi("ScoringStatus");

const BaseSchema = z
  .object({
    sha: z.string().openapi({ description: "The base commit." }),
    on: z.enum(BASE_LINES).openapi({
      description: "`task` when it lies on the task's task branch, `main` when the task has none.",
    }),
  })
  .openapi("Base", {
    description: "Where an attempt's history meets its task branch, or `origin/main` when the task has none.",
  });

const TaskArenaSchema = z
  .object({
    task: z.string().openapi({ example: "t42" }),
    metrics: z.array(MetricSchema).openapi({
      description:
        "Every metric the task's attempts are scored on: those the `.throng/config.yml` on `origin/main` declares, " +
        "then the task's own, in order, each with its `source`; empty when they don't merge into a valid config.",
    }),
    selection: SelectionPolicyOutSchema.openapi({
      description:
        "The selection policy in effect: the task's override, else the `.throng/config.yml` on `origin/main`'s; the " +
        "creator's when neither sets one.",
    }),
    vote: VoteSchema.nullable().openapi({ description: "The task's open vote, or null when it has none." }),
    attempts: z.array(
      ScoringStatusSchema.extend({
        ref: z.string().openapi({ example: "t42a3" }),
        state: z.enum(ATTEMPT_STATES),
        author: UserRefSchema,
        alias: AliasSchema,
        forkedFrom: ForkedFromSchema,
        needsUpdate: NeedsUpdateSchema,
        base: BaseSchema.nullable().openapi({
          description:
            "An active attempt's base at its current head (its fork's `main`), scored or not; diff it with " +
            "`compare/{base.sha}...{ref}`. Null for an ended attempt, a fork with no commits, or no shared history.",
        }),
        verdicts: VerdictSummarySchema,
      }).openapi("ArenaAttempt"),
    ),
  })
  .openapi("TaskArena");

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
      .object({
        reason: z.enum(DEQUEUE_REASONS),
        run: z.number().int().nullable().openapi({
          description: "The landing's run behind it; null for `newPush` and `cancelled`.",
        }),
        at: z.string(),
      })
      .nullable()
      .openapi({ description: "Why it last left the queue without landing." }),
    mergeSha: z.string().nullable().openapi({ description: "The merge commit on `main`, once merged." }),
    mergedAt: z.string().nullable(),
    createdAt: z.string(),
    createdBy: ActorRefSchema,
  })
  .openapi("MergeRequest");

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

const EditTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(65_536).optional().openapi({ description: "Markdown." }),
    attemptLimit: AttemptLimitSchema.optional(),
    selection: SelectionPolicyInputSchema.optional(),
    checks: TaskChecksInputSchema.optional(),
    metrics: TaskMetricsInputSchema.optional(),
  })
  .openapi("EditTask");

const TaskPathSchema = ProjectPathSchema.extend({
  t: z.string().openapi({ description: "A task reference: `t42` or `42`.", example: "t42" }),
});

const AttemptPathSchema = ProjectPathSchema.extend({
  a: z.string().openapi({ description: "An attempt reference.", example: "t42a3" }),
});

/** An attempt as a listing across projects shows it: the fields the projection carries, its task and project. */
const MyAttemptSchema = AttemptSchema.pick({
  ref: true,
  number: true,
  state: true,
  author: true,
  createdAt: true,
  closedAt: true,
})
  .extend({
    project: ProjectSchema,
    task: z.object({ ref: z.string().openapi({ example: "t42" }), number: z.number().int(), title: z.string() }),
  })
  .openapi("MyAttempt");

const WaitedAttemptSchema = AttemptSchema.extend({
  changed: z
    .boolean()
    .optional()
    .openapi({
      description:
        "With `wait` only: whether what `until` watches changed before the wait ran out. False at once when the " +
        `caller's user already has ${MAX_WAITERS_PER_USER} requests waiting in the project.`,
    }),
}).openapi("WaitedAttempt");

const RunLogPathSchema = RunPathSchema.extend({
  step: z.string().openapi({
    description: "The step whose log to read, as its `log` names it: a check's name, or `setup.<n>` for the nth setup.",
    example: "test",
  }),
});

const ConfigStepSchema = z
  .object({
    name: ConfigNameSchema.openapi({ example: "deploy" }),
    command: z.string().openapi({ example: "pnpm deploy" }),
    caches: CacheNamesSchema,
  })
  .openapi("Step", {
    description:
      "A post-gate step `main`'s config declares: a command run once the gate passes, in order with the others, " +
      "each in its own container. The first that fails stops the rest.",
  });

const ConfigPipelineSchema = z
  .object({
    groups: z
      .array(ConfigNameSchema)
      .nullable()
      .openapi({
        description:
          "The groups whose checks it runs; null to run every check. A task's checks always run on its attempts.",
        example: ["verify"],
      }),
    steps: z
      .array(ConfigStepSchema)
      .openapi({ description: "Run in order once the gate passes; only `main` has any." }),
  })
  .openapi("PipelineConfig");

const ConfigSchema = z
  .object({
    caches: z.array(ConfigCacheSchema).openapi({ description: "The named caches its steps may use." }),
    setup: z.array(ConfigSetupSchema).openapi({ description: "Run once, in order, before the checks." }),
    network: z.object({
      allow: z.array(z.string()).openapi({ description: "Extra HTTPS hosts checks may reach, lowercased." }),
    }),
    checks: z
      .array(ConfigCheckSchema)
      .openapi({ description: "Run in parallel once the setups passed, each once the checks it waits for passed." }),
    metrics: z.array(MetricSchema).openapi({ description: "Read from the checks' output files, in order." }),
    attempts: z.object({
      limit: z.number().int().nullable().openapi({ description: "Null to use the default cap on active attempts." }),
    }),
    sandbox: z.object({
      size: z.enum(SANDBOX_SIZES).openapi({
        description: `The size of the containers that run the project's code; \`${DEFAULT_SANDBOX_SIZE}\` unless set.`,
      }),
    }),
    pipelines: z
      .object({ default: ConfigPipelineSchema, main: ConfigPipelineSchema })
      .openapi({ description: "What each pipeline runs: `main` on `main`, `default` on attempts and task branches." }),
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
        example: "metrics[0].from: no check is named tests",
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
  /** Where commit diffs and blob sizes are cached: the Workers Cache API by default, none outside a Worker. */
  diffCache?: (env: AccessBindings) => DiffCache | undefined;
}

/** The caller's tasks and attempts across projects, read from the D1 projection. */
const myListingsFor = (env: AccessBindings) => myListings({ db: env.DB });

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
type Browser = ReturnType<typeof bearerOrForwarded>;

const AUTHOR_ONLY = "Only the attempt's author, or their aliases, may.";
const OWNER_ONLY = "Only the project owner may.";
const TASK_MANAGERS = "Only the project owner or the task's creator may.";
const RESCORERS = "Only the attempt's author (or their aliases), the task's creator or the project owner may.";

/** A task transition route: `POST …/tasks/{t}/<verb>`, also open to throng-web. */
function taskTransition<V extends string>(
  browser: Browser,
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
    security: bearerOrWeb,
    middleware: [browser] as const,
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

/** A merge request action route: `POST …/tasks/{t}/merge-request/<verb>`, also open to throng-web. */
function mergeRequestAction<V extends string>(
  browser: Browser,
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
    security: bearerOrWeb,
    middleware: [browser] as const,
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

/**
 * Who a route lets in, and the security its OpenAPI operation declares to match: bearer tokens only,
 * or, with the `browser` middleware, throng-web's forwarded user too.
 */
interface RouteAuth {
  middleware: Bearer | Browser;
  security: Record<string, string[]>[];
}

/** An attempt action route: `POST …/attempts/{a}/<verb>`, under `auth`. */
function attemptAction<V extends string, S extends z.ZodType>(auth: RouteAuth, verb: V, action: AttemptAction<S>) {
  return createRoute({
    method: "post",
    path: `/projects/{owner}/{project}/attempts/{a}/${verb}`,
    operationId: action.operationId,
    tags: action.tags,
    summary: action.summary,
    ...(action.description === undefined ? {} : { description: action.description }),
    security: auth.security,
    middleware: [auth.middleware] as const,
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
  auth: RouteAuth,
  verb: V,
  operationId: string,
  summary: string,
  forbidden: string,
  conflicts: string[],
) {
  return attemptAction(auth, verb, {
    operationId,
    tags: ["Attempts"],
    summary,
    forbidden,
    conflict: conflicts.join(" "),
    ok: { description: "The attempt after the transition.", schema: AttemptSchema },
  });
}

/** A scoring request route: `POST …/attempts/{a}/<verb>`, under `auth` (see `attemptAction`). */
function scoringRoute<V extends string>(
  auth: RouteAuth,
  verb: V,
  operationId: string,
  summary: string,
  description: string,
  forbidden: string,
  conflict: string,
) {
  return attemptAction(auth, verb, {
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
function publicToken({ id, alias, expires_at, revoked_at, created_at }: Token): z.infer<typeof TokenSchema> {
  return { id, alias, expiresAt: expires_at, revokedAt: revoked_at, createdAt: created_at };
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
  const bearerRoute: RouteAuth = { middleware: bearer, security: bearerOnly };
  const webRoute: RouteAuth = { middleware: browser, security: bearerOrWeb };
  const reposFor = options.repos ?? noRepos;
  const projects = (env: AccessBindings) => projectService({ db: env.DB, repos: reposFor(env) });
  const backendFor = options.tasks ?? noTasks;
  const logsFor = options.logs ?? noLogs;
  const tasks = requestTaskService(reposFor, backendFor);
  const tokens = (env: AccessBindings) => tokenService({ db: env.DB, now });
  const taskPath = ({ t, ...rest }: z.infer<typeof TaskPathSchema>) => ({ ...rest, task: t });
  const attemptPath = ({ a, ...rest }: z.infer<typeof AttemptPathSchema>) => ({ ...rest, attempt: a });

  const api = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("invalidRequest", z.prettifyError(result.error)), 400);
      return undefined;
    },
  });
  const tailed = tailedRoutes(api);

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
        summary: "The caller: their user, and the alias and token they act with",
        security,
        middleware: [auth] as const,
        responses: {
          200: { description: "The caller.", content: { "application/json": { schema: MeSchema } } },
          401: unauthorized,
        },
      }),
      (c) => {
        const { user, alias } = c.var.actor;
        const token = c.var.token === null ? null : { id: c.var.token.id, expiresAt: c.var.token.expires_at };
        return c.json({ user: publicUser(user), alias, token }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/me/tasks",
        operationId: "listMyTasks",
        tags: ["Users"],
        summary: "List the tasks the caller created, across every project",
        description: `The caller's user's tasks, also when an alias's token calls, newest first. ${PROJECTION_NOTE}`,
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { query: MyListingQuerySchema.extend({ state: z.enum(TASK_STATES).optional() }) },
        responses: {
          200: {
            description: "One page of the caller's tasks.",
            ...json(z.object({ tasks: z.array(MyTaskSchema), ...PageSchema })),
          },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
        },
      }),
      async (c) => {
        const query = c.req.valid("query");
        const page = await myListingsFor(c.env).tasks(c.var.actor, query);
        return c.json({ ...page, offset: query.offset, limit: query.limit }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/me/attempts",
        operationId: "listMyAttempts",
        tags: ["Users"],
        summary: "List the attempts the caller authors, across every project",
        description: `The caller's user's attempts, also when an alias's token calls, newest first. ${PROJECTION_NOTE}`,
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { query: MyListingQuerySchema.extend({ state: z.enum(ATTEMPT_STATES).optional() }) },
        responses: {
          200: {
            description: "One page of the caller's attempts.",
            ...json(z.object({ attempts: z.array(MyAttemptSchema), ...PageSchema })),
          },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
        },
      }),
      async (c) => {
        const query = c.req.valid("query");
        const page = await myListingsFor(c.env).attempts(c.var.actor, query);
        return c.json({ ...page, offset: query.offset, limit: query.limit }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/tokens",
        operationId: "mintToken",
        tags: ["Tokens"],
        summary: "Mint a token for the caller or one of their aliases",
        description:
          "Returns the plaintext once. A token-authenticated caller can't mint a token that outlives its own, " +
          "and an alias's token can only mint tokens for that same alias.",
        security,
        middleware: [auth] as const,
        request: {
          body: { required: false, content: { "application/json": { schema: MintTokenSchema } } },
        },
        responses: {
          201: { description: "The new token.", content: { "application/json": { schema: MintedTokenSchema } } },
          400: errorResponse("The request is invalid, e.g. `expiresIn` is above 7 days."),
          401: unauthorized,
          403: errorResponse("An alias's token tried to mint for the user themselves or another alias."),
        },
      }),
      async (c) => {
        const input = { ...c.req.valid("json"), via: c.var.token };
        const { token, plaintext } = await tokens(c.env).mint(c.var.actor, input);
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
        description: "An alias's token lists only that alias's tokens.",
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
        const list = await tokens(c.env).list(c.var.actor);
        return c.json({ tokens: list.map(publicToken) }, 200);
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
      async (c) => c.json(publicToken(await tokens(c.env).revoke(c.var.actor, c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects",
        operationId: "listProjects",
        tags: ["Projects"],
        summary: "List the projects the caller owns",
        description:
          "The projects owned by the caller's user, also when an alias's token calls, ordered by handle. " +
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
          "The caller's user becomes the owner, also when an alias's token calls. Creates the project's " +
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
        description:
          "Any signed-in user may. The caller is its creator. The task starts open. Only the project owner may give " +
          "it a `selection` policy of its own.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: ProjectPathSchema, body: { required: true, ...json(CreateTaskSchema) } },
        responses: {
          201: { description: "The new task.", ...json(TaskSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          403: errorResponse("`selection` is set and the caller isn't the project owner."),
          404: errorResponse("No such project."),
        },
      }),
      async (c) => {
        const task = await tasks(c).createTask(c.var.actor, { ...c.req.valid("param"), ...c.req.valid("json") });
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
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: ProjectPathSchema, query: z.object({ state: z.enum(TASK_STATES).optional() }) },
        responses: {
          200: { description: "The tasks, by number.", ...json(z.object({ tasks: z.array(ListedTaskSchema) })) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project."),
        },
      }),
      async (c) => {
        const list = await tasks(c).listTasks(c.var.actor, { ...c.req.valid("param"), ...c.req.valid("query") });
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
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema },
        responses: {
          200: { description: "The task.", ...json(TaskSchema) },
          400: errorResponse("The task reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task."),
        },
      }),
      async (c) => c.json(await tasks(c).getTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/projects/{owner}/{project}/tasks/{t}",
        operationId: "editTask",
        tags: ["Tasks"],
        summary: "Edit a task's title, body, attempt limit, selection policy, checks or metrics",
        description:
          "The project owner or the task's creator may, but only the project owner may change `selection`. Obsolete " +
          "tasks can't be edited. While the task has an open vote, its `checks`, `metrics` and `selection` can't " +
          "change (sending what they are already is fine): a rescore could withdraw a candidate. Close the vote first.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema, body: { required: true, ...json(EditTaskSchema) } },
        responses: {
          200: { description: "The edited task.", ...json(TaskSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          403: errorResponse(`${TASK_MANAGERS} Only the project owner may change \`selection\`.`),
          404: errorResponse("No such project or task."),
          409: errorResponse(
            "`invalidState`: the task is obsolete, or it has an open vote and the edit changes its checks, metrics or " +
              "selection policy.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).editTask(c.var.actor, input), 200);
      },
    )
    .openapi(
      taskTransition(browser, "close", "closeTask", "Close an open task, and its active attempts", TASK_MANAGERS, [
        "the task isn't open.",
      ]),
      async (c) => c.json(await tasks(c).closeTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      taskTransition(browser, "reopen", "reopenTask", "Reopen a closed task", TASK_MANAGERS, [
        "the task isn't closed, or one of its attempts merged.",
      ]),
      async (c) => c.json(await tasks(c).reopenTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      taskTransition(browser, "obsolete", "obsoleteTask", "Make a task obsolete, and its active attempts", OWNER_ONLY, [
        "the task is already obsolete.",
      ]),
      async (c) => c.json(await tasks(c).obsoleteTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      taskTransition(browser, "restore", "restoreTask", "Restore an obsolete task to closed", OWNER_ONLY, [
        "the task isn't obsolete.",
      ]),
      async (c) => c.json(await tasks(c).restoreTask(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/attempts",
        operationId: "createAttempts",
        tags: ["Attempts"],
        summary: "Fan a task out to new draft attempts, each with its own fork",
        description:
          "Any signed-in user may; the caller's user authors every attempt. Creates `count` attempts or none: " +
          "the batch fails whole if it would exceed the task's cap on active attempts or a fork fails.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: TaskPathSchema, body: { required: false, ...json(CreateAttemptsSchema) } },
        responses: {
          201: {
            description: "The new attempts, each with its git remote.",
            ...json(z.object({ attempts: z.array(AttemptSchema) })),
          },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task."),
          409: errorResponse("`invalidState`: the task isn't open; `attemptLimit`: the batch would exceed the cap."),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json({ attempts: await tasks(c).createAttempts(c.var.actor, input) }, 201);
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
        security: bearerOrWeb,
        middleware: [browser] as const,
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
        return c.json({ attempts: await tasks(c).listAttempts(c.var.actor, input) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/attempts/{a}",
        operationId: "getAttempt",
        tags: ["Attempts"],
        summary: "Get an attempt by its reference, or wait for it to change",
        description:
          "With `wait`, the request is held until what `until` watches changes from when it arrived, or `wait` " +
          "seconds pass, and the attempt comes back with `changed`. Use it instead of polling.",
        security: bearerOnly,
        middleware: [bearer] as const,
        request: { params: AttemptPathSchema, query: WaitQuerySchema },
        responses: {
          200: { description: "The attempt.", ...json(WaitedAttemptSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or attempt."),
        },
      }),
      async (c) => {
        const { wait, until } = c.req.valid("query");
        const path = attemptPath(c.req.valid("param"));
        const service = tasks(c);
        const answer =
          wait === undefined
            ? await service.getAttempt(c.var.actor, path)
            : await service.waitForAttempt(c.var.actor, { ...path, wait, until });
        return c.json(answer, 200);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/projects/{owner}/{project}/attempts/{a}",
        operationId: "editAttempt",
        tags: ["Attempts"],
        summary: "Edit an attempt's note",
        description: "Only the attempt's author, or their aliases, may. Obsolete attempts can't be edited.",
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
        return c.json(await tasks(c).editAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      attemptTransition(
        bearerRoute,
        "open",
        "openAttempt",
        "Open a draft attempt for scoring and merging",
        AUTHOR_ONLY,
        ["`invalidState`: the attempt isn't a draft."],
      ),
      async (c) => c.json(await tasks(c).openAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearerRoute, "draft", "draftAttempt", "Return an open attempt to draft", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't open.",
      ]),
      async (c) => c.json(await tasks(c).draftAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearerRoute, "close", "closeAttempt", "Close a draft or open attempt", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't active.",
      ]),
      async (c) => c.json(await tasks(c).closeAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(webRoute, "reopen", "reopenAttempt", "Reopen a closed attempt as a draft", AUTHOR_ONLY, [
        "`invalidState`: the attempt isn't closed or its task isn't open;",
        "`attemptLimit`: the task is at its cap; `conflict`: another active attempt has its branch.",
      ]),
      async (c) => c.json(await tasks(c).reopenAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearerRoute, "obsolete", "obsoleteAttempt", "Make an attempt obsolete", OWNER_ONLY, [
        "`invalidState`: the attempt is merged or already obsolete.",
      ]),
      async (c) => c.json(await tasks(c).obsoleteAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      attemptTransition(bearerRoute, "restore", "restoreAttempt", "Restore an obsolete attempt to closed", OWNER_ONLY, [
        "`invalidState`: the attempt isn't obsolete.",
      ]),
      async (c) => c.json(await tasks(c).restoreAttempt(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      scoringRoute(
        webRoute,
        "score",
        "scoreAttempt",
        "Score a draft attempt's head now",
        "Drafts aren't scored on push; this queues a run for the head anyway. A head already queued, running " +
          "or scored isn't queued again. The arena's Score now button calls this too.",
        AUTHOR_ONLY,
        "the attempt isn't a draft",
      ),
      async (c) => c.json(await tasks(c).scoreNow(c.var.actor, attemptPath(c.req.valid("param"))), 200),
    )
    .openapi(
      scoringRoute(
        webRoute,
        "rescore",
        "rescoreAttempt",
        "Score an open attempt's head again",
        "Queues a new run for the head even if it already has a finished one. A head already queued or running " +
          "isn't queued again. The arena's Rescore button, on a vote candidate whose scoring errored, calls this too.",
        RESCORERS,
        "the attempt isn't open",
      ),
      async (c) => c.json(await tasks(c).rescore(c.var.actor, attemptPath(c.req.valid("param"))), 200),
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
      async (c) => c.json(await tasks(c).getScoring(c.var.actor, attemptPath(c.req.valid("param"))), 200),
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
      async (c) => c.json(await tasks(c).taskArena(c.var.actor, taskPath(c.req.valid("param"))), 200),
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
        const runs = await tasks(c).listScoringRuns(c.var.actor, attemptPath(c.req.valid("param")));
        return c.json({ runs }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/runs",
        operationId: "listRuns",
        tags: ["Runs"],
        summary: "List the project's runs",
        description:
          "Every run on every line, newest first, migrated scoring runs included, paged by `cursor`: pass a page's " +
          "`next` to read the one after it. Filter by `line` and `status`; `status=waiting` lists the runs waiting " +
          "for the owner. Any signed-in user may read them.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: ProjectPathSchema, query: RunsQuerySchema },
        responses: {
          200: { description: "A page of runs, newest first.", ...json(RunsListSchema) },
          400: errorResponse("A filter, the cursor or the limit is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project."),
        },
      }),
      async (c) => {
        const input = { ...c.req.valid("param"), ...c.req.valid("query") };
        return c.json(await tasks(c).listRuns(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/runs/{runId}",
        operationId: "getRun",
        tags: ["Runs"],
        summary: "Get one run, with its outcome step by step",
        description:
          "Its outcome lists every step in run order (setups, checks with their group and `after`, then post-gate " +
          "steps), each with its outcome, duration, notes and log, and the run's metrics.",
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
        return c.json(await tasks(c).getRun(c.var.actor, { ...path, run: runId }), 200);
      },
    )
    .openapi(
      tailed(
        createRoute({
          method: "get",
          path: `/projects/{owner}/{project}/runs/{runId}/conflict/files/${TAIL}/diff`,
          operationId: "getRunConflictDiff",
          tags: ["Runs"],
          summary: "Diff a landing's conflicting file from the merge base to one side",
          description: `One conflicting file of the conflict a landing's \`merge\` hit, ${CONFLICT_DIFF_DESCRIPTION}`,
          security: bearerOrWeb,
          middleware: [browser] as const,
          request: {
            params: RunPathSchema.extend({ path: z.string().openapi({ example: "src/app.ts" }) }),
            query: ConflictSideQuerySchema,
          },
          responses: {
            200: { description: "The file's diff.", content: diffContent(FileDiffSchema) },
            400: errorResponse("The run id or the side is invalid."),
            401: unauthorizedBearer,
            404: errorResponse("No such project or run, or the run's merge didn't conflict in that path."),
          },
        }),
      ),
      async (c) => {
        const { runId, path, ...project } = c.req.valid("param");
        const found = await tasks(c).runConflictFile(c.var.actor, { ...project, run: runId, path });
        return (await conflictDiffResponse(c, reposFor(c.env), found, c.req.valid("query").side)) as never;
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/runs/{runId}/cancel",
        operationId: "cancelRun",
        tags: ["Runs"],
        summary: "Cancel a run",
        description:
          "Only the project owner may, and only while the run is `cancellable`: queued, waiting, or running on any " +
          "line but `main`, whose running run may be deploying. A running run's containers are torn down. Journals " +
          "`runCancelled`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: RunPathSchema },
        responses: {
          200: { description: "The cancelled run.", ...json(RunDetailSchema) },
          400: errorResponse("The run id is invalid."),
          401: unauthorizedBearer,
          403: errorResponse(OWNER_ONLY),
          404: errorResponse("No such project or run."),
          409: errorResponse("`invalidState`: the run can't be cancelled now."),
        },
      }),
      async (c) => {
        const { runId, ...path } = c.req.valid("param");
        return c.json(await tasks(c).cancelRun(c.var.actor, { ...path, run: runId }), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/runs/{runId}/start",
        operationId: "startRun",
        tags: ["Runs"],
        summary: "Start a run waiting for the owner",
        description:
          "Starts a `waiting` run of code that isn't the owner's, after the owner reviewed its head: it is queued " +
          "again as a trusted run, triggered `start`, and holds the secrets it names. Only the project owner acting as " +
          "themselves may, never under an alias, and there is no MCP tool for it. `sha` pins the head reviewed: it is " +
          "refused when the run waits on another, when its line moved on since, or, for a merge request's landing, " +
          "when the merge request no longer approves it or can't join the queue. Each secret the run names, as " +
          "`main`'s config is now, must have a value and be allowed in its pipeline. A started landing joins the merge " +
          "queue and lands in its turn. Journals `runQueued`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: RunPathSchema, body: { required: true, ...json(StartRunSchema) } },
        responses: {
          200: { description: "The started run, queued.", ...json(RunDetailSchema) },
          400: errorResponse("The run id or the body is invalid."),
          401: unauthorizedBearer,
          403: errorResponse(OWNER_AS_THEMSELVES),
          404: errorResponse("No such project or run."),
          409: errorResponse(
            "`invalidState`: the run isn't waiting, waits on another head, its line or merge request moved on, or a " +
              "secret it names has no value or isn't allowed in its pipeline.",
          ),
        },
      }),
      async (c) => {
        const { runId, ...path } = c.req.valid("param");
        return c.json(await tasks(c).startRun(c.var.actor, { ...path, run: runId, ...c.req.valid("json") }), 200);
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
          "Only the attempt's author, or their aliases, may, and only while it is a draft or open. " +
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
        return c.json(await tasks(c).handOffAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/attempts/{a}/verdicts",
        operationId: "postVerdict",
        tags: ["Verdicts"],
        summary: "Post a verdict on an attempt's current head",
        description:
          "Recommends `merge`, `revise` or `reject` for the attempt's current head, with a markdown explanation. Anyone " +
          "but the attempt's author, or their aliases, may, while it is a draft, open or merged. Posting again for the same " +
          "head replaces your verdict; after a push, your verdict on the old head stays, superseded. Verdicts are advice: " +
          "they never change the gate, the score or the merge queue. Journals `verdictPosted`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: AttemptPathSchema, body: { required: true, ...json(PostVerdictSchema) } },
        responses: {
          201: { description: "The verdict as stored.", ...json(VerdictSchema) },
          400: errorResponse("The request is invalid: a bad reference or recommendation, or a body over 64 KB."),
          401: unauthorizedBearer,
          403: errorResponse("The attempt's author, or their aliases, can't post a verdict on it."),
          404: errorResponse("No such project or attempt."),
          409: errorResponse("`invalidState`: the attempt is closed or obsolete, or nothing has been pushed to it."),
        },
      }),
      async (c) => {
        const input = { ...attemptPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).postVerdict(c.var.actor, input), 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/attempts/{a}/verdicts",
        operationId: "listVerdicts",
        tags: ["Verdicts"],
        summary: "List an attempt's verdicts",
        description:
          "Every reviewer's verdict on every head the attempt has had, oldest first. One per reviewer and head; " +
          "`superseded` marks those on a head that is no longer current.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: AttemptPathSchema },
        responses: {
          200: { description: "The verdicts, oldest first.", ...json(z.object({ verdicts: z.array(VerdictSchema) })) },
          400: errorResponse("The attempt reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or attempt."),
        },
      }),
      async (c) => {
        const verdicts = await tasks(c).listVerdicts(c.var.actor, attemptPath(c.req.valid("param")));
        return c.json({ verdicts }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/runs/{runId}/logs/{step}",
        operationId: "getRunLog",
        tags: ["Runs"],
        summary: "Stream one step's log of a run",
        description:
          "Each step of a run that ran writes a log, which its `log` names. Logs over " +
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
        const { runId, step, ...path } = c.req.valid("param");
        const keys = await tasks(c).runLogKeys(c.var.actor, { ...path, run: runId, name: step });
        const log = await firstLog(logsFor(c.env), keys);
        if (log === null) throw missingLog(runId, step);
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
          "Merge button calls this too. The task's creator or the project owner (or their aliases) may; the creator may " +
          "select their own attempt. Under the `vote` selection policy, closing a vote selects instead, and this is " +
          "refused. Journals `selected` and `approved`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema, body: { required: true, ...json(SelectionSchema) } },
        responses: {
          200: { description: "The new merge request.", ...json(MergeRequestSchema) },
          400: errorResponse("The request is invalid, or the attempt isn't one of the task's."),
          401: unauthorizedBearer,
          403: errorResponse(TASK_MANAGERS),
          404: errorResponse("No such project, task or attempt."),
          409: errorResponse(
            "`invalidState`: the attempt isn't open, the task isn't open, the task already has an open merge request, " +
              "its selection policy is `vote`, or the attempt has no commits.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).selectAttempt(c.var.actor, input), 200);
      },
    )
    .openapi(
      mergeRequestAction(
        browser,
        "approve",
        "approveMergeRequest",
        "Approve the source attempt's current head",
        "Moves a merge request in `needsReview` back to `pending`, approving the source attempt's current head. From " +
          "`pending` it re-approves the same head, which requeues one held after a dequeue (an `errored` one, say). Then, " +
          "as on selection, it enters the queue once the head's gate has passed. Journals `approved`.",
      ),
      async (c) => c.json(await tasks(c).approveMergeRequest(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      mergeRequestAction(
        browser,
        "cancel",
        "cancelMergeRequest",
        "Cancel the task's open merge request",
        "From any open state. A queued or landing one is dequeued with reason `cancelled`. The task stays open and can be " +
          "selected again. Journals `cancelled`.",
      ),
      async (c) => c.json(await tasks(c).cancelMergeRequest(c.var.actor, taskPath(c.req.valid("param"))), 200),
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
      async (c) => c.json(await tasks(c).getMergeRequest(c.var.actor, taskPath(c.req.valid("param"))), 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/vote/open",
        operationId: "openVote",
        tags: ["Votes"],
        summary: "Open a vote to select the task's attempt",
        description:
          "Under the `vote` selection policy, opens a vote among the attempts passing now, each a candidate at its " +
          "current head, open to the users the policy's `eligible` lets vote. A candidate counts while it is passing " +
          "at that head; `withdrawn`, `beingScored` and `erroredRun` in `VoteCandidateTally` say when it doesn't. " +
          "While the vote is open the task's checks, metrics and selection policy can't change. " +
          "Journals `voteOpened`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema, body: { required: false, ...json(OpenVoteSchema) } },
        responses: {
          200: { description: "The new vote.", ...json(VoteSchema) },
          400: errorResponse("The request is invalid, or the deadline isn't in the future."),
          401: unauthorizedBearer,
          403: errorResponse(TASK_MANAGERS),
          404: errorResponse("No such project or task."),
          409: errorResponse(
            "`invalidState`: the task isn't open, its selection policy isn't `vote`, it already has an open vote or " +
              "merge request, or no attempt is passing.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).openVote(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/vote",
        operationId: "castVote",
        tags: ["Votes"],
        summary: "Cast your ballot in the task's open vote",
        description:
          "Backs one candidate. Each user has one ballot: casting again replaces it, and a ballot cast under an alias " +
          "is its user's. Not for your own attempt, and only for the users the vote's `eligible` lets in, before its " +
          "deadline. Journals `voteCast`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema, body: { required: true, ...json(BallotSchema) } },
        responses: {
          200: { description: "The vote with your ballot counted.", ...json(VoteSchema) },
          400: errorResponse("The request is invalid, or the attempt isn't one of the task's."),
          401: unauthorizedBearer,
          403: errorResponse("The vote's eligibility leaves you out, or the attempt is yours."),
          404: errorResponse("No such project, task or attempt."),
          409: errorResponse(
            "`invalidState`: the task has no open vote, its deadline has passed, or the attempt isn't a candidate.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).castVote(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/vote/candidates",
        operationId: "addVoteCandidate",
        tags: ["Votes"],
        summary: "Add an attempt that passes now to the task's open vote",
        description:
          "Makes an attempt a candidate at its current head: one that started passing after the vote opened, or a " +
          "withdrawn candidate passing again at a new head. Ballots for an earlier head don't count. Journals " +
          "`candidateAdded`.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema, body: { required: true, ...json(VoteCandidateSchema) } },
        responses: {
          200: { description: "The vote with the candidate.", ...json(VoteSchema) },
          400: errorResponse("The request is invalid, or the attempt isn't one of the task's."),
          401: unauthorizedBearer,
          403: errorResponse(TASK_MANAGERS),
          404: errorResponse("No such project, task or attempt."),
          409: errorResponse(
            "`invalidState`: the task has no open vote, the attempt isn't passing, or it is already a candidate.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).addVoteCandidate(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/projects/{owner}/{project}/tasks/{t}/vote/close",
        operationId: "closeVote",
        tags: ["Votes"],
        summary: "Close the task's open vote, selecting its winner",
        description:
          "The candidate with the most ballots wins and is selected, at the head it is a candidate at, as `selection` " +
          "does: it becomes the task's merge request and the task's other active attempts are closed. A tie goes to " +
          "the task's creator, who names one of the tied candidates as `attempt`. With every candidate withdrawn, the " +
          "vote closes without a selection. Not while a candidate is `beingScored` (wait for its scoring to finish) " +
          "or has an `erroredRun` (rescore it). Journals `voteClosed`, then selection's events.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema, body: { required: false, ...json(CloseVoteSchema) } },
        responses: {
          200: {
            description: "The closed vote, and the merge request it selected (null when it selected none).",
            ...json(z.object({ vote: VoteSchema, mergeRequest: MergeRequestSchema.nullable() })),
          },
          400: errorResponse(
            "The request is invalid, the vote is tied and `attempt` names none of the tied candidates, or `attempt` " +
              "isn't the winner.",
          ),
          401: unauthorizedBearer,
          403: errorResponse(TASK_MANAGERS),
          404: errorResponse("No such project or task."),
          409: errorResponse(
            "`invalidState`: the task has no open vote, a candidate is still `beingScored` or has an `erroredRun`, or " +
              "its winner can't be selected.",
          ),
        },
      }),
      async (c) => {
        const input = { ...taskPath(c.req.valid("param")), ...c.req.valid("json") };
        return c.json(await tasks(c).closeVote(c.var.actor, input), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/projects/{owner}/{project}/tasks/{t}/vote",
        operationId: "getVote",
        tags: ["Votes"],
        summary: "Get a task's vote",
        description: "Its latest vote, open or closed, with each candidate's tally and your own ballot.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: TaskPathSchema },
        responses: {
          200: { description: "The vote.", ...json(VoteSchema) },
          400: errorResponse("The task reference is invalid."),
          401: unauthorizedBearer,
          404: errorResponse("No such project or task, or the task has never had a vote."),
        },
      }),
      async (c) => c.json(await tasks(c).getVote(c.var.actor, taskPath(c.req.valid("param"))), 200),
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
      async (c) => c.json({ queue: await tasks(c).mergeQueue(c.var.actor, c.req.valid("param")) }, 200),
    )
    .route(
      "/",
      browseRoutes({ auth: browser, repos: reposFor, tasks: backendFor, diffCache: options.diffCache ?? workersCache }),
    )
    .route("/", dequeueRoutes({ auth: browser, repos: reposFor, tasks: backendFor }))
    .route("/", secretsRoutes({ auth: browser, repos: reposFor, tasks: backendFor }));

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
