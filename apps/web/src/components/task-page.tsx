// The task page (`/:owner/:project/tasks/:t`): the task's header, then a body chosen by its state.

import { useQuery } from "@tanstack/react-query";
import { ErrorState, Loading } from "@/components/states";
import { taskQuery } from "@/lib/api";

export function TaskPage({ owner, project, task: ref }: { owner: string; project: string; task: string }) {
  const task = useQuery(taskQuery(owner, project, ref));
  if (task.isPending) return <Loading />;
  if (task.isError) return <ErrorState error={task.error} />;
  return (
    <h2 className="font-heading text-lg font-semibold">
      {task.data.title} <span className="font-normal text-muted-foreground">{task.data.ref}</span>
    </h2>
  );
}
