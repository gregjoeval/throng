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
import { createProject, projectsQuery } from "@/lib/api";
import { apiError } from "@/lib/errors";
import { buildPath } from "@/lib/paths";

/** Creates a project owned by the signed-in user, then opens it. */
export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [handle, setHandle] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      onOpenChange(false);
      setHandle("");
      create.reset();
      await navigate({ href: buildPath({ view: "home", owner: project.owner.handle, project: project.handle }) });
    },
  });
  const error = create.isError ? apiError(create.error).message : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(handle.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>
              You'll own it. Handles are lowercase letters and digits, joined by single dashes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-handle">Handle</Label>
            <Input
              id="project-handle"
              value={handle}
              autoComplete="off"
              placeholder="my-project"
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "project-handle-error"}
              onChange={(event) => setHandle(event.target.value)}
            />
            {error === null ? null : (
              <p id="project-handle-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={handle.trim() === "" || create.isPending}>
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
