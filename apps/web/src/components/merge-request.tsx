// The merge request view, for a task with an open merge request: its state, the approved head and
// who approved it, the source attempt's lane, the changes since approval when a push needs review,
// why it last left the queue, and Cancel.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { CommitFiles } from "@/components/commit-files";
import { RelativeTime } from "@/components/commit-meta";
import { ConflictFiles } from "@/components/conflict-files";
import { Lane } from "@/components/lane";
import { useMaySelect } from "@/components/selection";
import { ErrorState, Loading } from "@/components/states";
import { TaskBranchRuns } from "@/components/task-branch-runs";
import { Button } from "@/components/ui/button";
import {
  actOnMergeRequest,
  compareQuery,
  dequeueConflictDiffQuery,
  dequeueQuery,
  mergeRequestQuery,
  TASK_POLL_MS,
  taskArenaQuery,
  taskKey,
} from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import type { ArenaAttempt } from "@/lib/arena";
import { apiError } from "@/lib/errors";
import { buildPath } from "@/lib/paths";
import { STEP_OUTCOME_LABELS } from "@/lib/runs";
import { isOpenMergeRequest } from "@/lib/tasks";
import type { Attempt, Dequeue, MergeRequest, Task } from "@/lib/tasks";

interface InTask {
  projectRef: ProjectRef;
  task: Task;
}

export function MergeRequestView({ projectRef, task, source }: InTask & { source: Attempt }) {
  const mr = useQuery({
    ...mergeRequestQuery(projectRef, task.ref),
    refetchInterval: (query) =>
      query.state.data === undefined || isOpenMergeRequest(query.state.data.state) ? TASK_POLL_MS : false,
  });
  const arena = useQuery(taskArenaQuery(projectRef, task.ref));
  const mayAct = useMaySelect(projectRef, task);
  if (mr.isPending || arena.isPending) return <Loading />;
  if (mr.isError) return <ErrorState error={mr.error} />;
  if (arena.isError) return <ErrorState error={arena.error} />;
  const attempt = arena.data.attempts.find((a) => a.ref === source.ref);
  if (attempt === undefined) return <Loading />;
  const { state } = mr.data;
  const open = isOpenMergeRequest(state);
  return (
    <div data-testid="merge-request-view" className="flex flex-col gap-4">
      <MergeRequestSummary
        mr={mr.data}
        action={open && mayAct ? <CancelMergeRequest projectRef={projectRef} task={task} mr={mr.data} /> : null}
      />
      <TaskBranchRuns projectRef={projectRef} task={task} />
      {state === "needsReview" ? (
        <ChangesSinceApproval projectRef={projectRef} task={task} mr={mr.data} attempt={attempt} mayApprove={mayAct} />
      ) : null}
      {mr.data.lastDequeue !== null && (state === "pending" || state === "needsReview") ? (
        <Dequeued projectRef={projectRef} task={task} mr={mr.data} at={mr.data.lastDequeue.at} />
      ) : null}
      <Lane projectRef={projectRef} attempt={attempt} note={source.note} />
    </div>
  );
}

/** The merge request's state banner and its approval: the approved head, by whom and when. `action` sits beside the banner. */
export function MergeRequestSummary({ mr, action = null }: { mr: MergeRequest; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Banner mr={mr} />
        {action}
      </div>
      <p className="text-muted-foreground">
        Approved <span className="font-mono text-foreground">{mr.approvedHead.slice(0, 7)}</span> by{" "}
        <span className="text-foreground">
          {mr.approvedBy.handle}
          {mr.approvedBy.alias === null ? null : ` (${mr.approvedBy.alias})`}
        </span>{" "}
        <RelativeTime date={mr.approvedAt} />
      </p>
    </div>
  );
}

/** What the merge request's state means now, in a sentence. */
function stateText(mr: MergeRequest): string {
  switch (mr.state) {
    case "pending": {
      return "Pending: waiting for the approved head's gate to pass.";
    }
    case "queued": {
      return `Queued: number ${mr.position ?? "?"} in the merge queue.`;
    }
    case "landing": {
      return "Landing: merging into main.";
    }
    case "needsReview": {
      return `Needs review: ${mr.attempt} has a new head since it was approved.`;
    }
    case "merged": {
      return mr.mergeSha === null ? "Merged." : `Merged as ${mr.mergeSha.slice(0, 7)}.`;
    }
    case "cancelled": {
      return "Cancelled.";
    }
  }
}

const BANNER_STYLES: Record<MergeRequest["state"], string> = {
  pending: "border-dashed",
  queued: "border-blue-600/40 text-blue-700 dark:text-blue-400",
  landing: "border-blue-600/40 text-blue-700 dark:text-blue-400",
  needsReview: "border-amber-600/40 text-amber-700 dark:text-amber-400",
  merged: "border-green-600/40 text-green-700 dark:text-green-400",
  cancelled: "text-muted-foreground",
};

function Banner({ mr }: { mr: MergeRequest }) {
  return (
    <p
      role="status"
      aria-label="Merge request state"
      className={`rounded-full border px-3 py-1 font-medium ${BANNER_STYLES[mr.state]}`}
    >
      {stateText(mr)}
    </p>
  );
}

/** A mutation on the merge request that refreshes everything read about the task once it's done. */
function useMergeRequestAction(projectRef: ProjectRef, task: string, how: "approve" | "cancel") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => actOnMergeRequest(projectRef, task, how),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskKey(projectRef, task) });
    },
  });
}

/** Cancel merge request, behind an inline confirmation. */
function CancelMergeRequest({ projectRef, task, mr }: InTask & { mr: MergeRequest }) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useMergeRequestAction(projectRef, task.ref, "cancel");
  if (!confirming) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Cancel merge request
      </Button>
    );
  }
  return (
    <div role="group" aria-label="Confirm cancel" className="flex flex-col gap-2">
      <p>
        Cancel the merge request from {mr.attempt}? The task stays open, and its closed attempts can be reopened from
        the arena.
      </p>
      <ActionError mutation={cancel} />
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel it
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

function ActionError({ mutation }: { mutation: { isError: boolean; error: unknown } }) {
  if (!mutation.isError) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {apiError(mutation.error).message}
    </p>
  );
}

/** What changed from the approved head to the source's new head, and Approve for it. */
function ChangesSinceApproval({
  projectRef,
  task,
  mr,
  attempt,
  mayApprove,
}: InTask & { mr: MergeRequest; attempt: ArenaAttempt; mayApprove: boolean }) {
  const approve = useMergeRequestAction(projectRef, task.ref, "approve");
  const head = attempt.sha;
  const changes = useQuery({
    ...compareQuery(projectRef, mr.approvedHead, head ?? "", attempt.ref),
    enabled: head !== null,
  });
  return (
    <section aria-label="Changes since approval" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading font-medium">
          Changes since approval{" "}
          <span className="font-mono text-sm font-normal text-muted-foreground">
            {mr.approvedHead.slice(0, 7)} → {head?.slice(0, 7)}
          </span>
        </h3>
        {mayApprove ? (
          <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate()}>
            Approve
          </Button>
        ) : null}
      </div>
      <ActionError mutation={approve} />
      {changes.isPending ? <Loading label="Loading changes…" /> : null}
      {changes.isError ? <ErrorState error={changes.error} /> : null}
      {changes.isSuccess ? <CommitFiles diff={changes.data} idPrefix="review-" /> : null}
    </section>
  );
}

/** Why each dequeue reason took the merge request out of the queue. */
function reasonText(dequeue: { reason: Dequeue["reason"] }, attempt: string): string {
  switch (dequeue.reason) {
    case "conflict": {
      return "It conflicted with main. Merge main into the attempt, push, and approve the new head.";
    }
    case "failedChecks": {
      return "Checks failed on the merge with main.";
    }
    case "errored": {
      return "Landing it errored. Approve it again to requeue it.";
    }
    case "newPush": {
      return `A new push to ${attempt} took it out of the queue.`;
    }
    case "cancelled": {
      return "It was cancelled while in the queue.";
    }
  }
}

/**
 * The merge request's last dequeue: its reason, a link to the landing's run behind it, and the
 * details that run holds: the conflict, the steps that failed, or the error.
 */
function Dequeued({ projectRef, task, mr, at }: InTask & { mr: MergeRequest; at: string }) {
  const reason = mr.lastDequeue?.reason ?? "newPush";
  const run = mr.lastDequeue?.run ?? null;
  const detailed = reason === "conflict" || reason === "failedChecks" || reason === "errored";
  const dequeue = useQuery({ ...dequeueQuery(projectRef, task.ref, at), enabled: detailed });
  return (
    <section aria-label="Dequeued" className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading font-medium">
          Dequeued <RelativeTime date={at} />
        </h3>
        {run === null ? null : (
          <Link to={buildPath({ view: "run", ...projectRef, run })} className="underline">
            View run
          </Link>
        )}
      </div>
      <p>{reasonText({ reason }, mr.attempt)}</p>
      {detailed && dequeue.isPending ? <Loading label="Loading details…" /> : null}
      {dequeue.isError ? <ErrorState error={dequeue.error} /> : null}
      {dequeue.isSuccess ? <DequeueDetails projectRef={projectRef} task={task} at={at} dequeue={dequeue.data} /> : null}
    </section>
  );
}

function DequeueDetails({ projectRef, task, at, dequeue }: InTask & { at: string; dequeue: Dequeue }) {
  const { details } = dequeue;
  if (details === null) return null;
  if ("files" in details) {
    return (
      <ConflictFiles
        details={details}
        diffQuery={(path, side) => dequeueConflictDiffQuery(projectRef, task.ref, at, path, side)}
      />
    );
  }
  if ("steps" in details) {
    return (
      <>
        {details.error === undefined ? null : (
          <pre className="whitespace-pre-wrap text-destructive">{details.error}</pre>
        )}
        <ul aria-label="Failed steps" className="flex flex-col gap-1">
          {details.steps.map((step) => (
            <li key={step.name} className="flex items-center gap-3">
              <span className="font-mono">{step.name}</span>
              <span className="text-muted-foreground">
                {step.kind === "setup"
                  ? `Setup ${STEP_OUTCOME_LABELS[step.outcome].toLowerCase()}`
                  : STEP_OUTCOME_LABELS[step.outcome]}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <p>
      {details.step === undefined ? null : <span className="font-mono">{details.step}: </span>}
      {details.error}
    </p>
  );
}
