// The settings' Danger zone: deleting the project, for good. The owner confirms by typing its name.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteProject, projectKey, projectQuery, projectsQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { apiError } from "@/lib/errors";

export function DangerZone({ projectRef }: { projectRef: ProjectRef }) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="danger-zone-heading"
      className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-4"
    >
      <h2 id="danger-zone-heading" className="font-heading text-lg font-medium text-destructive">
        Danger zone
      </h2>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Delete this project</p>
          <p className="text-sm text-muted-foreground">
            Its repos, tasks, attempts, runs, secrets, logs and caches go with it. This can't be undone.
          </p>
        </div>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Delete project
        </Button>
      </div>
      <DeleteProjectDialog projectRef={projectRef} open={open} onOpenChange={setOpen} />
    </section>
  );
}

/** Asks the owner to type `owner/project`, then deletes it and goes home, where their projects are. */
function DeleteProjectDialog({
  projectRef,
  open,
  onOpenChange,
}: {
  projectRef: ProjectRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const name = `${projectRef.owner}/${projectRef.project}`;
  const [typed, setTyped] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteProject(projectRef),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: projectKey(projectRef) });
      queryClient.removeQueries({ queryKey: projectQuery(projectRef).queryKey });
      await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      await navigate({ to: "/" });
    },
  });
  const error = remove.isError ? apiError(remove.error).message : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped("");
          remove.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed === name) remove.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {name}</DialogTitle>
            <DialogDescription>
              This deletes the project and everything it holds, for good, and stops its runs. It can't be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="delete-project-name">
              Type <code>{name}</code> to confirm
            </Label>
            <Input
              id="delete-project-name"
              value={typed}
              autoComplete="off"
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "delete-project-error"}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {error === null ? null : (
            <p id="delete-project-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={typed !== name || remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete this project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
