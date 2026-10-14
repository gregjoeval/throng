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

/**
 * Creates a project owned by the signed-in user, empty or imported from a public git URL, then opens
 * it. An import runs inside the request, so the button says so until it's done.
 */
export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [handle, setHandle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      onOpenChange(false);
      setHandle("");
      setSourceUrl("");
      create.reset();
      await navigate({ href: buildPath({ view: "home", owner: project.owner.handle, project: project.handle }) });
    },
  });
  const error = create.isError ? apiError(create.error).message : null;
  const source = sourceUrl.trim();
  let submit = "Create";
  if (create.isPending) submit = source === "" ? "Creating…" : "Importing…";

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
            create.mutate({ handle: handle.trim(), ...(source === "" ? {} : { sourceUrl: source }) });
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
              aria-describedby={error === null ? undefined : "project-create-error"}
              onChange={(event) => setHandle(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-source">Import from a public git URL (optional)</Label>
            <Input
              id="project-source"
              value={sourceUrl}
              autoComplete="off"
              placeholder="https://github.com/owner/repo"
              aria-describedby="project-source-hint"
              onChange={(event) => setSourceUrl(event.target.value)}
            />
            <p id="project-source-hint" className="text-sm text-muted-foreground">
              Its default branch is copied once into <code>main</code>, with its full history.
            </p>
          </div>
          {error === null ? null : (
            <p id="project-create-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={handle.trim() === "" || create.isPending}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
