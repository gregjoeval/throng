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
  CreateAttemptsSchema,
  CreateTaskSchema,
  EditAttemptSchema,
  HandOffSchema,
  json,
  OpenVoteSchema,
  PostVerdictSchema,
  ProjectPathSchema,
  requestTaskService,
  SelectionPolicyInputSchema,
  SelectionSchema,
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
  MAX_CHECK_TIMEOUT_MS,
  MAX_CONFIG_BYTES,
  METRIC_ORDERS,
  parseConfig,
  SELECTION_POLICIES,
  SOURCES,
  VOTE_ELIGIBILITIES,
} from "./config.ts";
import { dequeueRoutes } from "./dequeue-api.ts";
import type { DiffCache } from "./diff.ts";
import { errorBody, errorResponse, ServiceError } from "./errors.ts";
import { FORWARDED_EMAIL_HEADER } from "./forwarded.ts";
import { LOG_CONTENT_TYPE, LOG_RETENTION_DAYS, MAX_LOG_BYTES, missingLog } from "./logs.ts";
import type { LogStore } from "./logs.ts";
import { DEQUEUE_REASONS, MERGE_REQUEST_STATES } from "./merge-requests.ts";
import { METRIC_FORMATS, METRIC_TYPES } from "./metric-values.ts";
import { MAX_PROJECT_HANDLE, PROJECT_HANDLE, projectService } from "./projects.ts";
import type { Repos } from "./repos.ts";
import { CHECK_OUTCOMES, GATES } from "./results.ts";
import { ATTEMPT_SCORING_STATUSES, RUN_STATUSES, SCORING_TRIGGERS } from "./scoring.ts";
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

const ConfigCheckSchema = z
  .object({
    name: ConfigNameSchema.openapi({ example: "test" }),
    command: z.string().openapi({ example: "pnpm test" }),
    required: z.boolean().openapi({ description: "Whether the gate needs it to pass." }),
    timeoutMs: z
      .number()
      .int()
      .max(MAX_CHECK_TIMEOUT_MS)
      .openapi({ description: "Defaults to 10 minutes.", example: 600_000 }),
    source: ConfigLayerSchema,
  })
  .openapi("Check", { description: "A check the config declares: a command whose exit code is its outcome." });

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
                "Its head moved from `head`, or it stopped being open. The task's creator can add it again once it passes.",
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

const ScoringRunFields = z.object({
  id: z.number().int(),
  ref: z.string().openapi({ description: "The attempt it scores.", example: "t42a3" }),
  sha: z.string().openapi({ description: "The head it scores." }),
  trigger: z.enum(SCORING_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  requestedBy: UserRefSchema.nullable(),
  alias: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const ScoringSchema = z
  .object({
    queued: z.boolean().openapi({ description: "Whether this request queued a new run." }),
    reason: z.string().nullable().openapi({
      description: "Why nothing was queued: the head is already queued, running or scored.",
      example: "already scored",
    }),
    run: ScoringRunFields.openapi("ScoringRun", {
      description: "The run that was queued, or the one already covering the head.",
    }),
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
    gate: z
      .enum(GATES)
      .openapi({ description: "Passed when every required check passed; failed on an invalid config." }),
    checks: z
      .array(
        z
          .object({
            name: z.string().openapi({ example: "test" }),
            source: z.enum(SOURCES),
            required: z.boolean(),
            outcome: z.enum(CHECK_OUTCOMES),
            durationMs: z.number(),
            notes: z.array(z.string()).openapi({
              description:
                "What the run noticed about it, such as why it was skipped or why the Preview didn't deploy.",
            }),
          })
          .openapi("CheckResult"),
      )
      .openapi({
        description:
          "Every check in run order: Throng's `_diff` (finding the base and diffing), the config's checks, then " +
          "`_preview` (deploying the Preview). `_preview` is `skipped` without a `preview` section or a passing gate, " +
          "`failed` when its build or deploy failed and `errored` when the infrastructure kept failing; it never " +
          "changes the gate.",
      }),
    metrics: z.record(z.string(), MetricResultSchema).openapi({
      description:
        "Every metric by name: each check's outcome metric (an enum named after the check), followed by that " +
        "check's own metrics, such as `_diff.filesChanged` and `_preview.url`.",
    }),
    logs: z.array(z.string()).openapi({
      description:
        "The run's stored logs by name, in run order, for `GET …/runs/{runId}/logs/{name}`. A step that never ran has none.",
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

const RunDetailSchema = ScoringRunFields.extend({
  superseded: z.boolean().openapi({ description: "Whether its head is no longer the attempt's current head." }),
  error: z.string().nullable().openapi({ description: "What ended it, once `errored`." }),
  result: ScoringResultSchema.nullable().openapi({ description: "Its result, once `done`." }),
}).openapi("RunDetail", { description: "A scoring run, with its result or error." });

const RunPathSchema = ProjectPathSchema.extend({
  runId: z.coerce.number().int().min(1).openapi({ description: "A scoring run's id.", example: 7 }),
});

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
      .object({ reason: z.enum(DEQUEUE_REASONS), at: z.string() })
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
  name: z.string().openapi({
    description: "The log's name: a check's name, `setup.<n>` for the nth setup command, or `preview.deploy`.",
    example: "test",
  }),
});

const ConfigSchema = z
  .object({
    setup: z.array(z.string()).openapi({ description: "Commands run once, in order, before the checks." }),
    network: z.object({
      allow: z.array(z.string()).openapi({ description: "Extra HTTPS hosts checks may reach, lowercased." }),
    }),
    checks: z.array(ConfigCheckSchema).openapi({ description: "Run in order." }),
    metrics: z.array(MetricSchema).openapi({ description: "Read from the checks' output files, in order." }),
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
        description: "Any signed-in user may. The caller is its creator. The task starts open.",
        security: bearerOrWeb,
        middleware: [browser] as const,
        request: { params: ProjectPathSchema, body: { required: true, ...json(CreateTaskSchema) } },
        responses: {
          201: { description: "The new task.", ...json(TaskSchema) },
          400: errorResponse("The request is invalid."),
          401: unauthorizedBearer,
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
          409: errorResponse("`invalidState`: the task is obsolete."),
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
        bearerRoute,
        "rescore",
        "rescoreAttempt",
        "Score an open attempt's head again",
        "Queues a new run for the head even if it already has a finished one. A head already queued or running " +
          "isn't queued again.",
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
        path: "/projects/{owner}/{project}/runs/{runId}",
        operationId: "getRun",
        tags: ["Scoring"],
        summary: "Get one scoring run",
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
        return c.json(await tasks(c).getScoringRun(c.var.actor, { ...path, run: runId }), 200);
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
        path: "/projects/{owner}/{project}/runs/{runId}/logs/{name}",
        operationId: "getRunLog",
        tags: ["Scoring"],
        summary: "Stream one log of a scoring run",
        description:
          "Each setup command, check and preview of a run writes a log. Logs over " +
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
        const { runId, name, ...path } = c.req.valid("param");
        const key = await tasks(c).runLogKey(c.var.actor, { ...path, run: runId, name });
        const log = await logsFor(c.env).get(key);
        if (log === null) throw missingLog(runId, name);
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
          "current head, open to the users the policy's `eligible` lets vote. A push to a candidate during the vote " +
          "withdraws it, as does a rescore of its head that fails the gate, and its ballots stop counting; one back at " +
          "its pinned head and passing there stands again. " +
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
          "vote closes without a selection. Journals `voteClosed`, then selection's events.",
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
          409: errorResponse("`invalidState`: the task has no open vote, or its winner can't be selected."),
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
    .route("/", dequeueRoutes({ auth: browser, repos: reposFor, tasks: backendFor, logs: logsFor }));

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
