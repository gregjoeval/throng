import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { projectsQuery } from "@/lib/api";
import { buildPath } from "@/lib/paths";

/** The signed-in user's projects, to jump between, and "Create project". */
export function ProjectSwitcher() {
  const projects = useQuery(projectsQuery);
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const current = params.owner && params.project ? `${params.owner}/${params.project}` : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" className="min-w-40 justify-between" />}>
          <span className="truncate">{current ?? "Select a project"}</span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Your projects</DropdownMenuLabel>
            {projects.isPending ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
            {projects.isError ? <DropdownMenuItem disabled>Couldn't load projects</DropdownMenuItem> : null}
            {projects.data?.projects.length === 0 ? (
              <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
            ) : null}
            {projects.data?.projects.map((project) => {
              const name = `${project.owner.handle}/${project.handle}`;
              return (
                <DropdownMenuItem
                  key={project.id}
                  onClick={() =>
                    navigate({
                      href: buildPath({ view: "home", owner: project.owner.handle, project: project.handle }),
                    })
                  }
                >
                  <span className="truncate">{name}</span>
                  {name === current ? <CheckIcon className="ml-auto" aria-hidden /> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <PlusIcon />
            Create project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
