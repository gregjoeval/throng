// A task's closed attempts, collapsed under their count, where each author may reopen theirs. Every
// task body with active attempts or none shows it, so attempts closed by a selection can come back
// once its merge request is cancelled.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { meQuery, reopenAttempt, taskKey } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { apiError } from "@/lib/errors";
import type { Attempt } from "@/lib/tasks";

interface InTask {
  projectRef: ProjectRef;
  task: string;
}

type ClosedAttempt = Pick<Attempt, "ref" | "author">;

/** The task's closed attempts, collapsed under their count; each author may reopen theirs. */
export function ClosedAttempts({ projectRef, task, closed }: InTask & { closed: ClosedAttempt[] }) {
  const me = useQuery(meQuery);
  return (
    <details className="rounded-xl border px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">Closed ({closed.length})</summary>
      <ul aria-label="Closed attempts" className="mt-2 flex flex-col gap-1">
        {closed.map((attempt) => (
          <li key={attempt.ref} className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{attempt.ref}</span>
            <span className="text-xs text-muted-foreground">{attempt.author.handle}</span>
            {me.data?.user.id === attempt.author.id ? (
              <ReopenAttempt projectRef={projectRef} task={task} attempt={attempt.ref} />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Reopens a closed attempt as a draft; only its author may. */
function ReopenAttempt({ projectRef, task, attempt }: InTask & { attempt: string }) {
  const queryClient = useQueryClient();
  const reopen = useMutation({
    mutationFn: () => reopenAttempt(projectRef, attempt),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskKey(projectRef, task) });
    },
  });
  return (
    <>
      <Button variant="ghost" size="sm" className="ml-auto" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
        Reopen
      </Button>
      {reopen.isError ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {apiError(reopen.error).message}
        </p>
      ) : null}
    </>
  );
}
