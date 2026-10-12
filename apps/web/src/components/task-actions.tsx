// Close task and Mark obsolete, in the task header. Each ends the task's active attempts too, so it
// is never one click: a dialog names what else happens before anything is called.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { endTask, meQuery, projectKey, projectQuery } from "@/lib/api";
import { apiError } from "@/lib/errors";
import type { Task } from "@/lib/tasks";

type How = "close" | "obsolete";

const ACTIONS: Record<How, { label: string; question: (ref: string) => string; ended: string }> = {
  close: { label: "Close task", question: (ref) => `Close ${ref}?`, ended: "closed" },
  obsolete: { label: "Mark obsolete", question: (ref) => `Mark ${ref} obsolete?`, ended: "made obsolete" },
};

/**
 * The actions the viewer may take, as the platform allows them: the task's creator or the project
 * owner may close an open task; only the project owner may make a task obsolete.
 */
export function TaskActions({
  owner,
  project,
  task,
  active,
}: {
  owner: string;
  project: string;
  task: Task;
  /** How many active attempts the task has, to say they end with it. */
  active: number;
}) {
  const me = useQuery(meQuery);
  const found = useQuery(projectQuery(owner, project));
  const [confirming, setConfirming] = useState<How | null>(null);
  if (!me.isSuccess || !found.isSuccess) return null;
  const viewer = me.data.user.id;
  const isOwner = viewer === found.data.owner.id;
  const allowed: How[] = [];
  if (task.state === "open" && (isOwner || viewer === task.creator.id)) allowed.push("close");
  if (task.state !== "obsolete" && isOwner) allowed.push("obsolete");
  if (allowed.length === 0) return null;

  return (
    <div className="flex gap-2">
      {allowed.map((how) => (
        <Button key={how} variant="outline" size="sm" onClick={() => setConfirming(how)}>
          {ACTIONS[how].label}
        </Button>
      ))}
      {confirming === null ? null : (
        <ConfirmEnd
          owner={owner}
          project={project}
          task={task}
          active={active}
          how={confirming}
          onDone={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function ConfirmEnd({
  owner,
  project,
  task,
  active,
  how,
  onDone,
}: {
  owner: string;
  project: string;
  task: Task;
  active: number;
  how: How;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const end = useMutation({
    mutationFn: () => endTask(owner, project, task.ref, how),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectKey(owner, project) });
      onDone();
    },
  });
  const action = ACTIONS[how];
  const consequence =
    active === 0
      ? "It has no active attempts."
      : `Its ${active} active ${active === 1 ? "attempt" : "attempts"} will be ${action.ended} too.`;
  const error = end.isError ? apiError(end.error).message : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>
            {action.question(task.ref)} {consequence}
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" disabled={end.isPending} onClick={() => end.mutate()}>
            {action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
