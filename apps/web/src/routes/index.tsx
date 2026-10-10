import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { projectsQuery } from "@/lib/api";
import { buildPath } from "@/lib/paths";

export const Route = createFileRoute("/")({ component: Home });

/** The signed-in user's projects. */
function Home() {
  const projects = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  const create = (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon />
      Create project
    </Button>
  );

  let body;
  if (projects.isPending) body = <Loading />;
  else if (projects.isError) body = <ErrorState error={projects.error} />;
  else if (projects.data.projects.length === 0) {
    body = <EmptyState title="No projects yet">{create}</EmptyState>;
  } else {
    body = (
      <ul className="divide-y rounded-xl border">
        {projects.data.projects.map((project) => (
          <li key={project.id}>
            <Link
              to={buildPath({ view: "home", owner: project.owner.handle, project: project.handle })}
              className="block px-4 py-3 hover:bg-muted"
            >
              {project.owner.handle}/<span className="font-semibold">{project.handle}</span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-xl font-semibold">Your projects</h1>
        {projects.data?.projects.length ? create : null}
      </div>
      {body}
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
