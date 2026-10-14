// What the project owner can do to a run: Start one waiting for them, pinned to the head it waits
// on, and Cancel one that can be cancelled. Each is the owner's alone, acting as themselves, and
// refreshes everything shown about the project once it's done, since the run shows in its lists and
// may move its merge request.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cancelRun, projectKey, startRun } from "@/lib/api";
import type { ProjectRef, Run } from "@/lib/api";
import { apiError } from "@/lib/errors";
import { useIsOwner } from "@/lib/owner";

/** The owner's Start, pinned to the head the run waits on; nothing for anyone else, or a run that isn't waiting. */
export function StartRun({ projectRef, run }: { projectRef: ProjectRef; run: Pick<Run, "id" | "waiting"> }) {
  const head = run.waiting?.head ?? null;
  return (
    <OwnerAction
      projectRef={projectRef}
      shown={head !== null}
      act={() => startRun(projectRef, run.id, head ?? "")}
      label="Start"
      pendingLabel="Starting…"
      ariaLabel={`Start run ${run.id}`}
    />
  );
}

/** The owner's Cancel, while the run can be cancelled. */
export function CancelRun({ projectRef, run }: { projectRef: ProjectRef; run: Pick<Run, "id" | "cancellable"> }) {
  return (
    <OwnerAction
      projectRef={projectRef}
      shown={run.cancellable}
      act={() => cancelRun(projectRef, run.id)}
      label="Cancel run"
      pendingLabel="Cancelling…"
      variant="outline"
    />
  );
}

/** A button only the owner sees while `shown`, which runs `act`, then refreshes the project, or says why it failed. */
function OwnerAction({
  projectRef,
  shown,
  act,
  label,
  pendingLabel,
  ariaLabel,
  variant,
}: {
  projectRef: ProjectRef;
  shown: boolean;
  act: () => Promise<unknown>;
  label: string;
  pendingLabel: string;
  ariaLabel?: string;
  variant?: "outline";
}) {
  const isOwner = useIsOwner(projectRef);
  const queryClient = useQueryClient();
  const action = useMutation({
    mutationFn: act,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKey(projectRef) }),
  });
  if (!isOwner || !shown) return null;
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        disabled={action.isPending}
        aria-label={ariaLabel}
        onClick={() => action.mutate()}
      >
        {action.isPending ? pendingLabel : label}
      </Button>
      {action.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {apiError(action.error).message}
        </p>
      ) : null}
    </>
  );
}
