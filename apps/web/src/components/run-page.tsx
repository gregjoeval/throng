// One run's page: a header with its line, head, pipeline, trigger, trust, status and gate; then its
// steps by stage (setups, checks by group, the landing's `merge` and `land`, post-gate steps), each
// with its outcome, duration, notes and a log to expand; then its metrics.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { RunLog } from "@/components/run-log";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { StartRun } from "@/components/waiting-runs";
import { cancelRun, projectKey, runQuery } from "@/lib/api";
import type { ProjectRef, RunWithOutcome } from "@/lib/api";
import { formatValue, linkTarget } from "@/lib/arena";
import { shortSha } from "@/lib/commits";
import { apiError } from "@/lib/errors";
import { useIsOwner } from "@/lib/owner";
import { buildPath } from "@/lib/paths";
import {
  formatDuration,
  lineHref,
  RUN_STATUS_LABELS,
  runDuration,
  runSections,
  STEP_OUTCOME_LABELS,
  TRIGGER_LABELS,
  triggeredBy,
} from "@/lib/runs";
import type { RunStep } from "@/lib/runs";
import { GATE_LABELS } from "@/lib/tasks";

interface InRun {
  projectRef: ProjectRef;
  run: number;
}

type Outcome = NonNullable<RunWithOutcome["outcome"]>;

export function RunPage({ projectRef, run }: InRun) {
  const found = useQuery(runQuery(projectRef, run));
  if (found.isPending) return <Loading />;
  if (found.isError) return <ErrorState error={found.error} />;
  const { outcome } = found.data;
  return (
    <div className="flex flex-col gap-6">
      <Header projectRef={projectRef} run={found.data} />
      {outcome === null ? null : <Stages projectRef={projectRef} run={run} outcome={outcome} />}
      {outcome === null ? null : <Metrics metrics={outcome.metrics} />}
    </div>
  );
}

function Header({ projectRef, run }: { projectRef: ProjectRef; run: RunWithOutcome }) {
  const duration = runDuration(run);
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-heading text-lg font-medium">Run {run.id}</h2>
        <StartRun projectRef={projectRef} run={run} />
        <Cancel projectRef={projectRef} run={run} />
      </div>
      <dl
        aria-label="Run"
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]"
      >
        <Field label="Line">
          <Link to={lineHref(projectRef, run)} className="font-mono hover:underline">
            {run.line}
          </Link>
        </Field>
        <Field label="Head">
          {run.sha === null ? (
            <span className="text-muted-foreground">Not landed</span>
          ) : (
            <Link to={buildPath({ view: "commit", ...projectRef, sha: run.sha })} className="font-mono hover:underline">
              {shortSha(run.sha)}
            </Link>
          )}
        </Field>
        <Field label="Pipeline">{run.pipeline}</Field>
        <Field label="Trigger">{TRIGGER_LABELS[run.trigger]}</Field>
        <Field label="Status">{RUN_STATUS_LABELS[run.status]}</Field>
        <Field label="Gate">{run.gate === null ? "—" : GATE_LABELS[run.gate]}</Field>
        <Field label="Secrets">{run.trusted ? "Trusted" : "Untrusted"}</Field>
        <Field label="Duration">{duration === null ? "—" : formatDuration(duration)}</Field>
        <Field label="Triggered by">{triggeredBy(run)}</Field>
        {run.superseded ? <Field label="Head moved">Superseded</Field> : null}
        {run.waiting === null ? null : (
          <Field label="Would hold">
            {run.waiting.secrets.length === 0 ? "No secrets" : run.waiting.secrets.join(", ")}
          </Field>
        )}
      </dl>
      {run.error === null ? null : (
        <p role="alert" className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {run.error}
        </p>
      )}
    </header>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The owner's Cancel, while the run can be cancelled. */
function Cancel({ projectRef, run }: { projectRef: ProjectRef; run: RunWithOutcome }) {
  const isOwner = useIsOwner(projectRef);
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelRun(projectRef, run.id),
    // The run and every list it shows in change.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKey(projectRef) }),
  });
  if (!isOwner || !run.cancellable) return null;
  return (
    <>
      <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
        {cancel.isPending ? "Cancelling…" : "Cancel run"}
      </Button>
      {cancel.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {apiError(cancel.error).message}
        </p>
      ) : null}
    </>
  );
}

/** The run's steps by stage; a stage with no steps is left out. */
function Stages({ projectRef, run, outcome }: InRun & { outcome: Outcome }) {
  const { setups, checks, landing, steps } = runSections(outcome.steps);
  const props = { projectRef, run };
  return (
    <>
      {setups.length === 0 ? null : <StepList {...props} title="Setups" steps={setups} />}
      {checks.map(({ group, checks: grouped }) => (
        <StepList key={group ?? ""} {...props} title={group === null ? "Checks" : `Checks: ${group}`} steps={grouped} />
      ))}
      {landing.length === 0 ? null : <StepList {...props} title="Landing" steps={landing} />}
      {steps.length === 0 ? null : <StepList {...props} title="Steps" steps={steps} />}
    </>
  );
}

function StepList({ projectRef, run, title, steps }: InRun & { title: string; steps: RunStep[] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-heading text-sm font-medium">{title}</h3>
      <ul className="divide-y rounded-xl border">
        {steps.map((step) => (
          <StepItem key={step.name} projectRef={projectRef} run={run} step={step} />
        ))}
      </ul>
    </section>
  );
}

/** One step: its outcome, duration, the checks it waited for, its notes, and its log on demand. */
function StepItem({ projectRef, run, step }: InRun & { step: RunStep }) {
  const [open, setOpen] = useState(false);
  return (
    <li aria-label={step.name} data-outcome={step.outcome} className="flex flex-col gap-1.5 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono font-medium">{step.name}</span>
        <span>{STEP_OUTCOME_LABELS[step.outcome]}</span>
        <span className="text-muted-foreground tabular-nums">{formatDuration(step.durationMs)}</span>
        {step.after.length === 0 ? null : (
          <span className="text-muted-foreground">
            after <span className="font-mono">{step.after.join(", ")}</span>
          </span>
        )}
        {step.log === null ? null : (
          <Button
            variant={open ? "secondary" : "outline"}
            size="xs"
            className="ml-auto"
            aria-expanded={open}
            aria-label={`${step.name} log`}
            onClick={() => setOpen(!open)}
          >
            Log
          </Button>
        )}
      </div>
      {step.notes.length === 0 ? null : (
        <ul aria-label={`${step.name} notes`} className="text-xs text-muted-foreground">
          {step.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {open && step.log !== null ? <RunLog projectRef={projectRef} run={run} step={step.log} /> : null}
    </li>
  );
}

/** Every metric the run reported, by name, with its unit; a `url` metric as a link. */
function Metrics({ metrics }: { metrics: Outcome["metrics"] }) {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return null;
  return (
    <section aria-label="Metrics" className="flex flex-col gap-2">
      <h3 className="font-heading text-sm font-medium">Metrics</h3>
      <table className="w-full text-sm">
        <caption className="sr-only">Metrics</caption>
        <tbody>
          {entries.map(([name, metric]) => {
            const href = metric.type === "string" && metric.format === "url" ? linkTarget(metric.value) : null;
            const unit = metric.type === "number" ? (metric.unit ?? null) : null;
            return (
              <tr key={name} aria-label={name} className="border-b last:border-0">
                <td className="py-1 pr-3 font-mono">{name}</td>
                <td className="py-1 font-mono tabular-nums">
                  {href === null ? (
                    formatValue(metric.value, unit)
                  ) : (
                    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-3">
                      {href}
                    </a>
                  )}
                </td>
                <td className="py-1 text-xs text-muted-foreground">{metric.note ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
