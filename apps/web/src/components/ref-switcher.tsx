// Picks the ref a project is browsed at: `main`, an active attempt or an archived one.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, GitBranchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { blobQuery, refsQuery, treeQuery } from "@/lib/api";
import type { Refs } from "@/lib/api";
import { shortSha } from "@/lib/commits";
import { apiError } from "@/lib/errors";
import { buildPath, projectRefOf } from "@/lib/paths";
import type { BrowseLocation, ProjectLocation } from "@/lib/paths";

/** A view the switcher can move to another ref: project home (which is at `main`), a directory or file, or a commit log. */
export type SwitchableLocation = Extract<ProjectLocation, { view: "home" | "tree" | "blob" | "raw" | "commits" }>;

/** The heads of a group of attempts, active or archived. */
type AttemptHeads = Refs["active"] | Refs["archived"];

const SHA = /^[0-9a-f]{40}$/iu;

/** How a ref reads in the switcher: a sha shortened, anything else as is. */
const refLabel = (ref: string) => (SHA.test(ref) ? shortSha(ref) : ref);

/** The ref a view is at: project home shows `main`. */
const refOf = (at: SwitchableLocation) => (at.view === "home" ? "main" : at.ref);

/**
 * Where switching `at` to `ref` goes. Project home stays home for `main`. A commit log goes to
 * `ref`'s log. A directory or file goes to the same path at `ref`, as a file or a folder, whichever
 * it is there, else to `ref`'s root directory. The attempt hint is dropped, since only a sha needs one.
 */
async function switchedTo(
  at: SwitchableLocation,
  ref: string,
  exists: (to: BrowseLocation) => Promise<unknown>,
): Promise<SwitchableLocation> {
  const { owner, project } = at;
  const root: BrowseLocation = { view: "tree", owner, project, ref, path: "" };
  if (at.view === "home") return ref === "main" ? at : root;
  if (at.view === "commits") return { view: "commits", owner, project, ref };
  if (at.path === "") return root;
  const { path } = at;
  const same: BrowseLocation = { view: at.view, owner, project, ref, path };
  const other: BrowseLocation = { ...same, view: same.view === "tree" ? "blob" : "tree" };
  // Only a 404 says the path isn't there; on any other failure the view at `to` shows what went wrong.
  const found = (to: BrowseLocation, otherwise: () => Promise<BrowseLocation>) =>
    exists(to).then(
      () => to,
      (error: unknown) => (apiError(error).code === "notFound" ? otherwise() : to),
    );
  return found(same, () => found(other, async () => root));
}

export function RefSwitcher({ at }: { at: SwitchableLocation }) {
  const projectRef = projectRefOf(at);
  const refs = useQuery(refsQuery(projectRef));
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const open = async (ref: string) => {
    const to = await switchedTo(at, ref, (location) =>
      location.view === "tree"
        ? queryClient.fetchQuery(treeQuery(projectRef, location))
        : queryClient.fetchQuery(blobQuery(projectRef, location)),
    );
    await navigate({ href: buildPath(to) });
  };

  const groups: [string, AttemptHeads][] =
    refs.data === undefined
      ? []
      : [
          ["Active attempts", refs.data.active],
          ["Archived attempts", refs.data.archived],
        ];
  const item = (ref: string) => (
    <DropdownMenuItem key={ref} onClick={() => void open(ref)}>
      <span className="truncate font-mono">{ref}</span>
      {ref === refOf(at) ? <CheckIcon className="ml-auto" aria-hidden /> : null}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="font-mono" />}
        aria-label={`Ref: ${refLabel(refOf(at))}`}
      >
        <GitBranchIcon className="text-muted-foreground" aria-hidden />
        <span className="truncate">{refLabel(refOf(at))}</span>
        <ChevronsUpDownIcon className="text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Main</DropdownMenuLabel>
          {item("main")}
        </DropdownMenuGroup>
        {refs.isPending ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
        {refs.isError ? <DropdownMenuItem disabled>Couldn't load attempts</DropdownMenuItem> : null}
        {groups.map(([label, attempts]) =>
          attempts.length === 0 ? null : (
            <DropdownMenuGroup key={label}>
              <DropdownMenuLabel>{label}</DropdownMenuLabel>
              {attempts.map((attempt) => item(attempt.ref))}
            </DropdownMenuGroup>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
