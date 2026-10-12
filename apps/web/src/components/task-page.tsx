// The task page (`/:owner/:project/tasks/:t`): the task's header, then a body chosen by its state.
// The single-attempt, arena and merge request views are placeholders their own slices fill in.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { Placeholder } from "@/components/project-view";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { TaskActions } from "@/components/task-actions";
import { taskAttemptsQuery, taskQuery } from "@/lib/api";
import { buildPath } from "@/lib/paths";
import { gitRemotePath, isActive, TASK_STATE_LABELS, taskBody } from "@/lib/tasks";
import type { Attempt, Task } from "@/lib/tasks";

interface TaskAt {
  owner: string;
  project: string;
}

export function TaskPage({ owner, project, task: ref }: TaskAt & { task: string }) {
  const task = useQuery(taskQuery(owner, project, ref));
  const attempts = useQuery(taskAttemptsQuery(owner, project, ref));
  if (task.isPending) return <Loading />;
  if (task.isError) return <ErrorState error={task.error} />;
  return (
    <div className="flex flex-col gap-4">
      <TaskHeader owner={owner} project={project} task={task.data} attempts={attempts.data?.attempts ?? []} />
      <section aria-label="Task body">
        {attempts.isPending && <Loading />}
        {attempts.isError && <ErrorState error={attempts.error} />}
        {attempts.isSuccess && (
          <TaskBody owner={owner} project={project} task={task.data} attempts={attempts.data.attempts} />
        )}
      </section>
    </div>
  );
}

function TaskHeader({ owner, project, task, attempts }: TaskAt & { task: Task; attempts: Attempt[] }) {
  const active = attempts.filter(isActive);
  return (
    <div className="flex flex-col gap-3 border-b pb-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-lg font-semibold">
            {task.title} <span className="font-mono font-normal text-muted-foreground">{task.ref}</span>
          </h2>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span data-slot="task-state" className="rounded-full border px-2 py-0.5 text-xs text-foreground">
              {TASK_STATE_LABELS[task.state]}
            </span>
            <span>
              opened by <span className="font-medium text-foreground">{task.creator.handle}</span>
            </span>
          </p>
        </div>
        <TaskActions owner={owner} project={project} task={task} active={active.length} />
      </div>
      {task.body === "" ? null : <Description body={task.body} />}
      {active.length === 0 ? null : (
        <ul aria-label="Attempt remotes" className="flex flex-col gap-1 text-sm">
          {active.map((attempt) => (
            <li key={attempt.ref} className="flex gap-2">
              <span className="font-mono">{attempt.ref}</span>
              <code className="text-muted-foreground">{gitRemotePath(owner, project, attempt.ref)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The task's markdown body, shown until collapsed. */
function Description({ body }: { body: string }) {
  const [open, setOpen] = useState(true);
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon className="size-4" aria-hidden />
        Description
      </button>
      {open && <Markdown className="rounded-xl border px-4 py-3">{body}</Markdown>}
    </div>
  );
}

function TaskBody({ owner, project, task, attempts }: TaskAt & { task: Task; attempts: Attempt[] }) {
  const body = taskBody(task, attempts);
  switch (body.kind) {
    case "noAttempts": {
      return <NoAttempts owner={owner} project={project} task={task} />;
    }
    case "singleAttempt": {
      return (
        <Slot id="single-attempt-view">
          The single-attempt view of <span className="font-mono">{body.attempt.ref}</span> will show here: its change
          set against its base, its scorecard, and Merge.
        </Slot>
      );
    }
    case "arena": {
      return (
        <Slot id="arena">
          The arena of <span className="font-mono">{body.attempts.map((a) => a.ref).join(", ")}</span> will show here.
        </Slot>
      );
    }
    case "mergeRequest": {
      return (
        <Slot id="merge-request-view">
          The merge request from <span className="font-mono">{body.source.ref}</span> will show here.
        </Slot>
      );
    }
    case "ended": {
      return <Ended owner={owner} project={project} task={task} merged={body.merged} archived={body.archived} />;
    }
  }
}

/** Where a later slice's view goes; tests find it by `id`. */
function Slot({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-testid={id}>
      <Placeholder>{children}</Placeholder>
    </div>
  );
}

/** How to start an attempt: the MCP tool, or a push of a branch reserved for this task. */
function NoAttempts({ owner, project, task }: TaskAt & { task: Task }) {
  return (
    <EmptyState title="No active attempts">
      <div className="flex max-w-xl flex-col gap-3 text-left">
        <p>
          Ask an agent to start attempts with the MCP <code className="text-foreground">start_attempts</code> tool for{" "}
          <span className="font-mono text-foreground">{task.ref}</span>, or push a branch to the project's origin. Use a
          Throng token as the password, with <code className="text-foreground">$THRONG</code> set to the platform's URL:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-foreground">
          <code>
            git push $THRONG{gitRemotePath(owner, project)} HEAD:{task.ref}/my-change
          </code>
        </pre>
        <p>
          A branch under <code className="text-foreground">{task.ref}/</code> becomes an open attempt at this task.
        </p>
      </div>
    </EmptyState>
  );
}

/** A closed or obsolete task: the merged attempt and its merge commit, and the archived attempts. */
function Ended({
  owner,
  project,
  task,
  merged,
  archived,
}: TaskAt & { task: Task; merged: Attempt | null; archived: Attempt[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm">
      {merged?.mergedSha ? (
        <p>
          <span className="font-mono">{merged.ref}</span> was merged in{" "}
          <Link
            to={buildPath({ view: "commit", owner, project, sha: merged.mergedSha })}
            className="font-mono hover:underline"
          >
            {merged.mergedSha.slice(0, 7)}
          </Link>
          .
        </p>
      ) : (
        <p>{task.state === "obsolete" ? "Made obsolete." : "Closed without merging."}</p>
      )}
      {archived.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Archived attempts:</span>
          {archived.map((attempt) => (
            <Link
              key={attempt.ref}
              to={buildPath({ view: "tree", owner, project, ref: attempt.archivedSha ?? "", path: "" })}
              className="font-mono hover:underline"
            >
              {attempt.ref}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
