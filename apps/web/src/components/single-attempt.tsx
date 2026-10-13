// The single-attempt view, for a task with exactly one active attempt and no merge request: the
// attempt's lane against its base, its scorecard, Merge for whoever may select it (or, under the `vote`
// policy, the vote banner and Vote), and the closed attempts.

import { useQuery } from "@tanstack/react-query";
import { ClosedAttempts } from "@/components/closed-attempts";
import { Lane } from "@/components/lane";
import { Scorecard } from "@/components/scorecard";
import { SelectAttempt, useMaySelect } from "@/components/selection";
import { ErrorState, Loading } from "@/components/states";
import { useVoteActions, VoteBanner } from "@/components/vote";
import { taskArenaQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { metricColumns } from "@/lib/arena";
import type { Attempt, Task } from "@/lib/tasks";

interface InProject {
  projectRef: ProjectRef;
}

export function SingleAttemptView({
  projectRef,
  task,
  attempt,
  closed,
}: InProject & { task: Task; attempt: Attempt; closed: Attempt[] }) {
  const arena = useQuery(taskArenaQuery(projectRef, task.ref));
  const maySelect = useMaySelect(projectRef, task);
  const voteActions = useVoteActions({ projectRef, task: task.ref }, arena.data?.vote ?? null, maySelect);
  if (arena.isPending) return <Loading />;
  if (arena.isError) return <ErrorState error={arena.error} />;
  const scored = arena.data.attempts.find((a) => a.ref === attempt.ref);
  if (scored === undefined) return <Loading />;
  return (
    <div data-testid="single-attempt-view" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <Lane projectRef={projectRef} attempt={scored} note={attempt.note} />
      <aside className="flex flex-col gap-3 lg:sticky lg:top-4">
        {arena.data.selection.policy === "vote" ? (
          <>
            <VoteBanner
              projectRef={projectRef}
              task={task.ref}
              selection={arena.data.selection}
              vote={arena.data.vote}
              attempts={arena.data.attempts}
              manage={maySelect}
              active={1}
            />
            {voteActions?.(scored)}
          </>
        ) : null}
        {maySelect && arena.data.selection.policy !== "vote" ? (
          <SelectAttempt projectRef={projectRef} task={task} attempt={attempt.ref} others={0} verb="Merge" />
        ) : null}
        <Scorecard attempt={scored} columns={metricColumns(arena.data.metrics)} />
        {closed.length === 0 ? null : <ClosedAttempts projectRef={projectRef} task={task.ref} closed={closed} />}
      </aside>
    </div>
  );
}
