// The frame every project view shares: the project's name, the view tabs, breadcrumbs for a path,
// and the loading and error states of looking the project up.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ErrorState, Loading } from "@/components/states";
import { projectQuery } from "@/lib/api";
import { buildPath, splitPath, type ProjectLocation } from "@/lib/paths";
import { cn } from "@/lib/utils";

export function ProjectView({ location, children }: { location: ProjectLocation; children: ReactNode }) {
  const project = useQuery(projectQuery(location.owner, location.project));
  const { owner } = location;
  const ref = "ref" in location ? location.ref : "main";
  const home = buildPath({ view: "home", owner, project: location.project });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-heading text-xl">
          <Link to={buildPath({ view: "home", owner, project: location.project })} className="hover:underline">
            {owner}/<span className="font-semibold">{location.project}</span>
          </Link>
        </h1>
        <nav aria-label="Project views" className="flex gap-1 text-sm">
          <Tab to={home} active={location.view !== "commits" && location.view !== "commit"}>
            Code
          </Tab>
          <Tab
            to={buildPath({ view: "commits", owner, project: location.project, ref })}
            active={location.view === "commits" || location.view === "commit"}
          >
            Commits
          </Tab>
        </nav>
      </div>
      {project.isPending ? <Loading /> : project.isError ? <ErrorState error={project.error} /> : children}
    </div>
  );
}

function Tab({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

/** `project / dir / file` at a ref, each part linking to its directory. */
export function Breadcrumbs({ location }: { location: Extract<ProjectLocation, { path: string }> }) {
  const parts = splitPath(location.path);
  const { owner, project, ref } = location;
  const at = (count: number) =>
    buildPath({ view: "tree", owner, project, ref, path: parts.slice(0, count).join("/"), ...attemptOf(location) });
  return (
    <nav aria-label="Breadcrumbs" className="flex flex-wrap items-center gap-1 font-mono text-sm">
      <span className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground" title="ref">
        {ref}
      </span>
      <Link to={at(0)} className="font-semibold hover:underline">
        {project}
      </Link>
      {parts.map((part, index) => (
        <span key={index} className="flex items-center gap-1">
          <span className="text-muted-foreground">/</span>
          {index === parts.length - 1 ? (
            <span aria-current="page">{part}</span>
          ) : (
            <Link to={at(index + 1)} className="hover:underline">
              {part}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

function attemptOf(location: { attempt?: string }) {
  return location.attempt === undefined ? {} : { attempt: location.attempt };
}

/** Where a view's content goes until its slice lands. */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
