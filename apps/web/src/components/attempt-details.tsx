// An attempt's details, in a side sheet opened from its lane's menu: its checks and their logs, its
// metrics and run history, and its verdicts with the form to post one.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { RunLog } from "@/components/run-log";
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
  runQuery,
  taskArenaQuery,
  taskKey,
  verdictsQuery,
} from "@/lib/api";
import type { ProjectRef, Verdict } from "@/lib/api";
import { metricColumns, taskOf } from "@/lib/arena";
import type { ArenaAttempt } from "@/lib/arena";
import { shortSha } from "@/lib/commits";
import { apiError } from "@/lib/errors";
import { buildPath } from "@/lib/paths";
import {
  failedSetup,
  formatDuration,
  RUN_STATUS_LABELS,
  runSections,
  STEP_OUTCOME_LABELS,
  TRIGGER_LABELS,
} from "@/lib/runs";
import type { RunStep } from "@/lib/runs";
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
            <Scored projectRef={projectRef} attempt={attempt} result={attempt.result} />
          )}
          <Runs projectRef={projectRef} attempt={attempt.ref} />
          <Verdicts projectRef={projectRef} attempt={attempt.ref} />
          <PostVerdict projectRef={projectRef} attempt={attempt} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The current result: its checks, its post-gate steps when the run had any, and its metrics. */
function Scored({ projectRef, attempt, result }: InProject & { attempt: ArenaAttempt; result: Result }) {
  // The result's run gives its steps, which the result itself doesn't keep.
  const run = useQuery(runQuery(projectRef, result.run));
  const steps = run.data?.outcome?.steps ?? [];
  return (
    <>
      <Checks projectRef={projectRef} result={result} steps={steps} />
      <Steps projectRef={projectRef} run={result.run} steps={steps} />
      <Metrics projectRef={projectRef} attempt={attempt} />
    </>
  );
}

/**
 * The result's checks, "Setup failed" when a setup did (no check ran then), then its logs: one open
 * at a time, streamed as it's read.
 */
function Checks({ projectRef, result, steps }: InProject & { result: Result; steps: RunStep[] }) {
  const [shown, setShown] = useState<string | null>(null);
  const setup = failedSetup(steps);
  return (
    <DetailsSection title="Checks">
      {setup === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          Setup failed: <span className="font-mono">{setup.name}</span>
        </p>
      )}
      <ChecksTable checks={result.checks} />
      <LogButtons logs={result.logs} shown={shown} onShow={setShown} />
      {shown === null ? null : <RunLog projectRef={projectRef} run={result.run} step={shown} />}
    </DetailsSection>
  );
}

/** One button per log, the shown one pressed; pressing it again hides it. */
function LogButtons({
  logs,
  shown,
  onShow,
}: {
  logs: string[];
  shown: string | null;
  onShow: (log: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {logs.map((name) => (
        <Button
          key={name}
          variant={shown === name ? "secondary" : "outline"}
          size="xs"
          aria-expanded={shown === name}
          aria-label={`${name} log`}
          onClick={() => onShow(shown === name ? null : name)}
        >
          {name}
        </Button>
      ))}
    </div>
  );
}

/** The run's post-gate steps, when it had any: each one's outcome and duration, and its log. */
function Steps({ projectRef, run, steps }: InProject & { run: number; steps: RunStep[] }) {
  const [shown, setShown] = useState<string | null>(null);
  const { steps: postGate } = runSections(steps);
  if (postGate.length === 0) return null;
  return (
    <DetailsSection title="Steps">
      <table className="w-full text-xs">
        <caption className="sr-only">Steps</caption>
        <tbody>
          {postGate.map((step) => (
            <tr key={step.name} aria-label={step.name}>
              <td className="py-0.5 font-mono">{step.name}</td>
              <td>{STEP_OUTCOME_LABELS[step.outcome]}</td>
              <td className="text-right tabular-nums">{formatDuration(step.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <LogButtons logs={postGate.flatMap((s) => (s.log === null ? [] : [s.log]))} shown={shown} onShow={setShown} />
      {shown === null ? null : <RunLog projectRef={projectRef} run={run} step={shown} />}
    </DetailsSection>
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

/** The attempt's scoring runs, newest first, each linking to its run page; those on an earlier head are dimmed. */
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
              <Link to={buildPath({ view: "run", ...projectRef, run: run.id })} className="font-medium hover:underline">
                Run {run.id}
              </Link>
              <span className="text-muted-foreground">{TRIGGER_LABELS[run.trigger]}</span>
              <span>{RUN_STATUS_LABELS[run.status]}</span>
              <span className="font-mono text-muted-foreground">{shortSha(run.sha)}</span>
              {run.gate === null ? null : <span>Gate {GATE_LABELS[run.gate].toLowerCase()}</span>}
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
