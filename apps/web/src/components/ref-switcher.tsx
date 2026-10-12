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
import { buildPath } from "@/lib/paths";
import type { BrowseLocation } from "@/lib/paths";

const SHA = /^[0-9a-f]{40}$/iu;

/** How a ref reads in the switcher: a sha shortened, anything else as is. */
const refLabel = (ref: string) => (SHA.test(ref) ? shortSha(ref) : ref);

/**
 * Where switching `at` to `ref` goes: the same path at that ref when it's there, else that ref's
 * root directory. The attempt hint is dropped, since only a sha needs one.
 */
export async function switchedTo(
  at: BrowseLocation,
  ref: string,
  exists: (to: BrowseLocation) => Promise<unknown>,
): Promise<BrowseLocation> {
  const { owner, project, view, path } = at;
  const root: BrowseLocation = { view: "tree", owner, project, ref, path: "" };
  if (path === "") return root;
  const to: BrowseLocation = { view, owner, project, ref, path };
  return exists(to).then(
    () => to,
    () => root,
  );
}

export function RefSwitcher({ at }: { at: BrowseLocation }) {
  const projectRef = { owner: at.owner, project: at.project };
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

  const groups: [string, Refs["active"]][] =
    refs.data === undefined
      ? []
      : [
          ["Active attempts", refs.data.active],
          ["Archived attempts", refs.data.archived],
        ];
  const item = (ref: string) => (
    <DropdownMenuItem key={ref} onClick={() => void open(ref)}>
      <span className="truncate font-mono">{ref}</span>
      {ref === at.ref ? <CheckIcon className="ml-auto" aria-hidden /> : null}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="font-mono" />}
        aria-label={`Ref: ${refLabel(at.ref)}`}
      >
        <GitBranchIcon className="text-muted-foreground" aria-hidden />
        <span className="truncate">{refLabel(at.ref)}</span>
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
