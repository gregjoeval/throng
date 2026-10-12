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
import { createTask, projectKey } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { apiError } from "@/lib/errors";
import { buildPath } from "@/lib/paths";

/** Creates a task in the project from a title and a markdown body, then opens it. */
export function NewTaskDialog({
  projectRef,
  open,
  onOpenChange,
}: {
  projectRef: ProjectRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => createTask(projectRef, { title: title.trim(), body }),
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: [...projectKey(projectRef), "tasks"] });
      onOpenChange(false);
      setTitle("");
      setBody("");
      create.reset();
      await navigate({
        href: buildPath({ view: "task", owner: projectRef.owner, project: projectRef.project, task: task.ref }),
      });
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
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>Attempts at it compete; the one selected is merged.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              autoComplete="off"
              aria-invalid={error !== null}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-body">Description</Label>
            <textarea
              id="task-body"
              value={body}
              rows={8}
              placeholder="Markdown"
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={title.trim() === "" || create.isPending}>
              {create.isPending ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
