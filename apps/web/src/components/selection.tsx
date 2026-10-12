// Selection: Select on a lane or rail card, and Merge in the single-attempt view. Each asks inline
// before calling `POST …/tasks/{t}/selection`, naming what selection closes and what lands with it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { meQuery, projectQuery, selectAttempt, taskKey, taskQuery } from "@/lib/api";
import { apiError } from "@/lib/errors";
import type { Task } from "@/lib/tasks";

/**
 * Whether the viewer may select an attempt of `task`, and approve or cancel its merge request: the
 * platform lets its creator and the project owner. False until the viewer, project and task are known.
 */
export function useMaySelect(owner: string, project: string, task: Task | undefined): boolean {
  const me = useQuery(meQuery);
  const found = useQuery(projectQuery(owner, project));
  if (!me.isSuccess || !found.isSuccess || task === undefined) return false;
  return me.data.user.id === task.creator.id || me.data.user.id === found.data.owner.id;
}

/**
 * Select for each of the task's `active` attempts (by ref), or null when the viewer may not select:
 * the arena puts it on each lane and rail card.
 */
export function useSelect(
  owner: string,
  project: string,
  task: string,
  active: number,
): ((attempt: string) => ReactNode) | null {
  const found = useQuery(taskQuery(owner, project, task));
  const maySelect = useMaySelect(owner, project, found.data);
  if (!maySelect || found.data === undefined) return null;
  const loaded = found.data;
  return (attempt) => (
    <SelectAttempt owner={owner} project={project} task={loaded} attempt={attempt} others={active - 1} />
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What selecting `attempt` does, as the confirmation says it. */
function selectionQuestion(verb: string, attempt: string, others: number, task: Task): string {
  const parts = [`${verb} ${attempt}?`];
  if (others > 0) parts.push(`The other ${plural(others, "attempt", "attempts")} will be closed and archived.`);
  const commits = task.taskBranch?.commits ?? 0;
  if (commits > 0) parts.push(`The task branch (${plural(commits, "commit", "commits")}) lands with it.`);
  return parts.join(" ");
}

/**
 * Select (or Merge, as `verb`) for `attempt`, one of the task's active attempts; `others` is how many
 * other active attempts selection will close. Only render it for someone who may select.
 */
export function SelectAttempt({
  owner,
  project,
  task,
  attempt,
  others,
  verb = "Select",
}: {
  owner: string;
  project: string;
  task: Task;
  attempt: string;
  others: number;
  verb?: "Select" | "Merge";
}) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const select = useMutation({
    mutationFn: () => selectAttempt(owner, project, task.ref, attempt),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskKey(owner, project, task.ref) });
    },
  });
  if (!confirming) {
    return (
      <Button variant={verb === "Merge" ? "default" : "outline"} size="sm" onClick={() => setConfirming(true)}>
        {verb}
      </Button>
    );
  }
  return (
    <div role="group" aria-label="Confirm selection" className="flex flex-col gap-2 text-sm">
      <p>{selectionQuestion(verb, attempt, others, task)}</p>
      {select.isError && (
        <p role="alert" className="text-destructive">
          {apiError(select.error).message}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={select.isPending} onClick={() => select.mutate()}>
          {verb} {attempt}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
