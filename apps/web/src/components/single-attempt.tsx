// The single-attempt view, for a task with exactly one active attempt and no merge request: the
// attempt's lane against its base, its scorecard, and Merge for whoever may select it.

import { useQuery } from "@tanstack/react-query";
import { Lane } from "@/components/lane";
import { Scorecard } from "@/components/scorecard";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { meQuery, projectQuery, taskArenaQuery } from "@/lib/api";
import { metricColumns } from "@/lib/arena";
import type { Attempt, Task } from "@/lib/tasks";

interface InProject {
  owner: string;
  project: string;
}

/**
 * Whether the viewer may select an attempt of `task`: the platform lets its creator and the project
 * owner. False until both the viewer and the project are known.
 */
export function useMaySelect(owner: string, project: string, task: Task): boolean {
  const me = useQuery(meQuery);
  const found = useQuery(projectQuery(owner, project));
  if (!me.isSuccess || !found.isSuccess) return false;
  return me.data.user.id === task.creator.id || me.data.user.id === found.data.owner.id;
}

export function SingleAttemptView({ owner, project, task, attempt }: InProject & { task: Task; attempt: Attempt }) {
  const arena = useQuery(taskArenaQuery(owner, project, task.ref));
  const maySelect = useMaySelect(owner, project, task);
  if (arena.isPending) return <Loading />;
  if (arena.isError) return <ErrorState error={arena.error} />;
  const scored = arena.data.attempts.find((a) => a.ref === attempt.ref);
  if (scored === undefined) return <Loading />;
  return (
    <div data-testid="single-attempt-view" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <Lane owner={owner} project={project} attempt={scored} note={attempt.note} />
      <aside className="flex flex-col gap-3 lg:sticky lg:top-4">
        {/* Selection (#156) wires this to `POST …/tasks/{t}/selection` with its inline confirmation. */}
        {maySelect ? <Button disabled>Merge</Button> : null}
        <Scorecard attempt={scored} columns={metricColumns(arena.data.metrics)} />
      </aside>
    </div>
  );
}
