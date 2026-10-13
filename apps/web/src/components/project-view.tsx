// The frame every project view shares: the project's name, the view tabs, breadcrumbs for a path,
// and the loading and error states of looking the project up.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RefSwitcher } from "@/components/ref-switcher";
import { ErrorState, Loading } from "@/components/states";
import { projectQuery } from "@/lib/api";
import { attemptHint, buildPath, splitPath } from "@/lib/paths";
import type { BrowseLocation, ProjectLocation } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** The header tab each view sits under. */
const SECTIONS: Record<ProjectLocation["view"], "code" | "commits" | "tasks"> = {
  home: "code",
  tree: "code",
  blob: "code",
  raw: "code",
  commits: "commits",
  commit: "commits",
  tasks: "tasks",
  task: "tasks",
};

export function ProjectView({ location, children }: { location: ProjectLocation; children: ReactNode }) {
  const project = useQuery(projectQuery({ owner: location.owner, project: location.project }));
  const { owner } = location;
  const ref = "ref" in location ? location.ref : "main";
  const home = buildPath({ view: "home", owner, project: location.project });
  const section = SECTIONS[location.view];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-heading text-xl">
          <Link to={buildPath({ view: "home", owner, project: location.project })} className="hover:underline">
            {owner}/<span className="font-semibold">{location.project}</span>
          </Link>
        </h1>
        <nav aria-label="Project views" className="flex gap-1 text-sm">
          <Tab to={home} active={section === "code"}>
            Code
          </Tab>
          <Tab
            to={buildPath({ view: "commits", owner, project: location.project, ref })}
            active={section === "commits"}
          >
            Commits
          </Tab>
          <Tab to={buildPath({ view: "tasks", owner, project: location.project })} active={section === "tasks"}>
            Tasks
          </Tab>
        </nav>
      </div>
      {project.isPending && <Loading />}
      {project.isError && <ErrorState error={project.error} />}
      {project.isSuccess && children}
    </div>
  );
}

function Tab({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      // The section decides which tab is current; the router would also mark `Code` on every page below home.
      activeOptions={{ exact: true, includeSearch: false }}
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

/**
 * Where a code view is: the ref switcher, then `project / dir / file` at that ref, each part
 * linking to its directory. Project home is the root directory at `main`.
 */
export function LocationBar({ location }: { location: BrowseLocation | Extract<ProjectLocation, { view: "home" }> }) {
  const { owner, project } = location;
  const { ref, path, attempt } = location.view === "home" ? { ref: "main", path: "", attempt: undefined } : location;
  const parts = splitPath(path);
  const at = (count: number) =>
    buildPath({
      view: "tree",
      owner,
      project,
      ref,
      path: parts.slice(0, count).join("/"),
      ...attemptHint(attempt),
    });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <RefSwitcher at={location} />
      <nav aria-label="Breadcrumbs" className="flex flex-wrap items-center gap-1 font-mono text-sm">
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
    </div>
  );
}
