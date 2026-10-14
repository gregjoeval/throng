// An attempt's details, in a side sheet opened from its lane's menu: its checks and their logs, its
// metrics and run history, and its verdicts with the form to post one.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { ChecksTable, MetricValues } from "@/components/scorecard";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  attemptKey,
  attemptRunsQuery,
  meQuery,
  postVerdict,
  runLogQuery,
  taskArenaQuery,
  taskKey,
  verdictsQuery,
} from "@/lib/api";
import type { ProjectRef, RunDetail, Verdict } from "@/lib/api";
import { metricColumns, taskOf } from "@/lib/arena";
import type { ArenaAttempt } from "@/lib/arena";
import { shortSha } from "@/lib/commits";
import { apiError } from "@/lib/errors";
import { GATE_LABELS } from "@/lib/tasks";

interface InProject {
  projectRef: ProjectRef;
}

type Result = NonNullable<ArenaAttempt["result"]>;

/** The attempt's details sheet, titled by its ref; the lane that owns it opens and closes it. */
export function AttemptDetails({
  projectRef,
  attempt,
  open,
  onOpenChange,
}: InProject & { attempt: ArenaAttempt; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{attempt.ref}</SheetTitle>
          <SheetDescription>Checks, logs and verdicts</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-4">
          {attempt.result === undefined ? null : (
            <>
              <Checks projectRef={projectRef} result={attempt.result} />
              <Metrics projectRef={projectRef} attempt={attempt} />
            </>
          )}
          <Runs projectRef={projectRef} attempt={attempt.ref} />
          <Verdicts projectRef={projectRef} attempt={attempt.ref} />
          <PostVerdict projectRef={projectRef} attempt={attempt} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The result's checks, then its logs: one open at a time, streamed as it's read. */
function Checks({ projectRef, result }: InProject & { result: Result }) {
  const [shown, setShown] = useState<string | null>(null);
  return (
    <DetailsSection title="Checks">
      <ChecksTable checks={result.checks} />
      <div className="flex flex-wrap gap-1.5">
        {result.logs.map((name) => (
          <Button
            key={name}
            variant={shown === name ? "secondary" : "outline"}
            size="xs"
            aria-expanded={shown === name}
            aria-label={`${name} log`}
            onClick={() => setShown(shown === name ? null : name)}
          >
            {name}
          </Button>
        ))}
      </div>
      {shown === null ? null : <RunLog projectRef={projectRef} run={result.run} name={shown} />}
    </DetailsSection>
  );
}

/**
 * The marker the platform writes between the head and tail it keeps of a log over its size cap
 * (`readLogScript` in the platform's `logs.ts`): how many bytes it dropped, of how many.
 */
const TRUNCATION_MARKER = /^\[throng: truncated (\d+) of (\d+) bytes\]$/mu;

/** A run's log, streamed, with a notice when the platform kept only its head and tail. */
function RunLog({ projectRef, run, name }: InProject & { run: number; name: string }) {
  const log = useQuery(runLogQuery(projectRef, run, name));
  if (log.isError) return <ErrorState error={log.error} />;
  const [, dropped, size] = TRUNCATION_MARKER.exec(log.data ?? "") ?? [];
  return (
    <>
      {size === undefined ? null : (
        <p role="note" className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          This log was too large to keep whole: {dropped} of its {size} bytes were left out of the middle.
        </p>
      )}
      <LogText name={name} text={log.data ?? ""} streaming={log.fetchStatus === "fetching"} />
    </>
  );
}

function LogText({ name, text, streaming }: { name: string; text: string; streaming: boolean }) {
  return (
    <pre
      role="log"
      aria-label={name}
      aria-busy={streaming}
      className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
}

/** Every metric the config declares and the built-in measures, with units; a `url` metric as a link. */
function Metrics({ projectRef, attempt }: InProject & { attempt: ArenaAttempt }) {
  // The task's arena is already loaded (and polled) by the page this sheet opens from.
  const arena = useQuery(taskArenaQuery(projectRef, taskOf(attempt)));
  return (
    <DetailsSection title="Metrics">
      <MetricValues attempt={attempt} columns={metricColumns(arena.data?.metrics ?? [])} />
    </DetailsSection>
  );
}

const RUN_STATUS_LABELS: Record<RunDetail["status"], string> = {
  queued: "Queued",
  waiting: "Waiting for the owner",
  running: "Running",
  done: "Done",
  cancelled: "Cancelled",
  errored: "Errored",
};

const TRIGGER_LABELS: Record<RunDetail["trigger"], string> = {
  open: "Open",
  push: "Push",
  scoreNow: "Score now",
  rescore: "Rescore",
};

/** The attempt's scoring runs, newest first; those on an earlier head are dimmed. */
function Runs({ projectRef, attempt }: InProject & { attempt: string }) {
  const runs = useQuery(attemptRunsQuery(projectRef, attempt));
  return (
    <DetailsSection title="Run history">
      {runs.isPending ? <Loading label="Loading runs…" /> : null}
      {runs.isError ? <ErrorState error={runs.error} /> : null}
      {runs.isSuccess ? (
        <ul aria-label="Runs" className="flex flex-col gap-1 text-xs">
          {runs.data.runs.map((run) => (
            <li
              key={run.id}
              aria-label={`Run ${run.id}`}
              data-superseded={run.superseded}
              className="flex flex-wrap items-center gap-x-2 data-[superseded=true]:opacity-50"
            >
              <span className="font-medium">Run {run.id}</span>
              <span className="text-muted-foreground">{TRIGGER_LABELS[run.trigger]}</span>
              <span>{RUN_STATUS_LABELS[run.status]}</span>
              <span className="font-mono text-muted-foreground">{shortSha(run.sha)}</span>
              {run.result === null ? null : <span>Gate {GATE_LABELS[run.result.gate].toLowerCase()}</span>}
              {run.superseded ? <span className="text-muted-foreground">Superseded</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </DetailsSection>
  );
}

const RECOMMENDATION_LABELS: Record<Verdict["recommendation"], string> = {
  merge: "Merge",
  revise: "Revise",
  reject: "Reject",
};

/** Every verdict on the attempt, oldest first; those on an earlier head are dimmed. */
function Verdicts({ projectRef, attempt }: InProject & { attempt: string }) {
  const verdicts = useQuery(verdictsQuery(projectRef, attempt));
  return (
    <DetailsSection title="Verdicts">
      {verdicts.isPending ? <Loading label="Loading verdicts…" /> : null}
      {verdicts.isError ? <ErrorState error={verdicts.error} /> : null}
      {verdicts.isSuccess && verdicts.data.verdicts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No verdicts yet.</p>
      ) : null}
      {verdicts.isSuccess && verdicts.data.verdicts.length > 0 ? (
        <ul aria-label="Verdicts" className="flex flex-col gap-3">
          {verdicts.data.verdicts.map((verdict) => (
            <li
              key={`${verdict.reviewer.id}-${verdict.head}`}
              data-superseded={verdict.superseded}
              className="flex flex-col gap-1 rounded-lg border px-3 py-2 data-[superseded=true]:opacity-50"
            >
              <p className="flex flex-wrap items-center gap-x-2 text-xs">
                <span className="font-medium">
                  {verdict.reviewer.handle}
                  {verdict.alias === null ? null : ` (${verdict.alias})`}
                </span>
                <span>{RECOMMENDATION_LABELS[verdict.recommendation]}</span>
                <span className="font-mono text-muted-foreground">on {shortSha(verdict.head)}</span>
                {verdict.superseded ? <span className="text-muted-foreground">Superseded</span> : null}
              </p>
              <Markdown className="text-sm">{verdict.body}</Markdown>
            </li>
          ))}
        </ul>
      ) : null}
    </DetailsSection>
  );
}

/**
 * The viewer's verdict on the attempt's current head: a recommendation and a markdown explanation.
 * Shown to anyone signed in but the attempt's author, as the platform allows; posting refreshes the
 * task's and the attempt's queries, so the verdict counts and the list update.
 */
function PostVerdict({ projectRef, attempt }: InProject & { attempt: ArenaAttempt }) {
  const me = useQuery(meQuery);
  const [recommendation, setRecommendation] = useState<Verdict["recommendation"]>("merge");
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();
  const post = useMutation({
    mutationFn: () => postVerdict(projectRef, attempt.ref, { recommendation, body }),
    onSuccess: async () => {
      setBody("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: taskKey(projectRef, taskOf(attempt)) }),
        queryClient.invalidateQueries({ queryKey: attemptKey(projectRef, attempt.ref) }),
      ]);
    },
  });
  if (!me.isSuccess || me.data.user.id === attempt.author.id) return null;
  const error = post.isError ? apiError(post.error).message : null;
  const bodyId = `${attempt.ref}-verdict-body`;
  return (
    <form
      aria-label="Post verdict"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        post.mutate();
      }}
    >
      <fieldset className="flex gap-3 text-sm">
        <legend className="mb-1 font-heading text-sm font-medium">Post verdict</legend>
        {Object.entries(RECOMMENDATION_LABELS).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1">
            <input
              type="radio"
              name="recommendation"
              value={value}
              checked={recommendation === value}
              onChange={() => setRecommendation(value as Verdict["recommendation"])}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Label htmlFor={bodyId}>Explanation</Label>
      <textarea
        id={bodyId}
        value={body}
        rows={5}
        placeholder="Markdown"
        aria-invalid={error !== null}
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        onChange={(event) => setBody(event.target.value)}
      />
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="self-end" disabled={body.trim() === "" || post.isPending}>
        {post.isPending ? "Posting…" : "Post verdict"}
      </Button>
    </form>
  );
}

function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-heading text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}
