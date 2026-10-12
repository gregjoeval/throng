// One attempt's lane: its header (ref, gate, verdict counts, the author's note and a menu), then its
// change set against its base, file by file. The arena shows several side by side; the
// single-attempt view shows one.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CommitFiles } from "@/components/commit-files";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { compareQuery } from "@/lib/api";
import { GATE_STATE_LABELS, gateState } from "@/lib/arena";
import type { ArenaAttempt } from "@/lib/arena";
import { buildPath } from "@/lib/paths";

interface InProject {
  owner: string;
  project: string;
}

/**
 * A lane for `attempt`. `note` is the author's note from the attempt itself; `actions` goes in the
 * header beside the menu (the selection slice's Select); `onDetails` opens the attempt details sheet,
 * and the menu's Details item is disabled until it's given.
 */
export function Lane({
  owner,
  project,
  attempt,
  note,
  actions,
  onDetails,
}: InProject & {
  attempt: ArenaAttempt;
  note: string;
  actions?: ReactNode;
  onDetails?: () => void;
}) {
  return (
    <section aria-label={`Lane ${attempt.ref}`} className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-col gap-2 rounded-xl border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono font-semibold">{attempt.ref}</h3>
            <GatePill attempt={attempt} />
          </div>
          <div className="flex items-center gap-1">
            {actions}
            <LaneMenu owner={owner} project={project} attempt={attempt} onDetails={onDetails} />
          </div>
        </div>
        <VerdictCounts verdicts={attempt.verdicts} />
        {note === "" ? null : <p className="text-sm text-muted-foreground">{note}</p>}
      </header>
      <LaneChanges owner={owner} project={project} attempt={attempt} />
    </section>
  );
}

/** The lane's menu: the details sheet, the preview, and the attempt in the code browser. */
function LaneMenu({
  owner,
  project,
  attempt,
  onDetails,
}: InProject & { attempt: ArenaAttempt; onDetails?: () => void }) {
  const navigate = useNavigate();
  const preview = attempt.result?.preview;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${attempt.ref} actions`} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuItem disabled={onDetails === undefined} onClick={onDetails}>
          Checks, logs and verdicts
        </DropdownMenuItem>
        {preview?.status === "ready" ? (
          <DropdownMenuItem render={<a href={preview.url} target="_blank" rel="noreferrer" />}>
            Open preview
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>No preview</DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => navigate({ href: buildPath({ view: "tree", owner, project, ref: attempt.ref, path: "" }) })}
        >
          Open in browser
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The attempt's change set: the compare from its base to its head, once it has both. */
function LaneChanges({ owner, project, attempt }: InProject & { attempt: ArenaAttempt }) {
  const { sha, base } = attempt;
  const changes = useQuery({
    ...compareQuery(owner, project, base?.sha ?? "", sha ?? "", attempt.ref),
    enabled: sha !== null && base !== null,
  });
  if (sha === null) return <LaneNotice>Nothing has been pushed to {attempt.ref} yet.</LaneNotice>;
  if (base === null) {
    return (
      <LaneNotice>{attempt.ref} shares no history with the task's line, so it has no base to diff against.</LaneNotice>
    );
  }
  if (changes.isPending) return <Loading label="Loading changes…" />;
  if (changes.isError) return <ErrorState error={changes.error} />;
  return <CommitFiles diff={changes.data} idPrefix={`${attempt.ref}-`} />;
}

function LaneNotice({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

const GATE_PILL_STYLES = {
  passed: "border-green-600/40 text-green-700 dark:text-green-400",
  noChecks: "border-dashed text-muted-foreground",
  failed: "border-red-600/40 text-red-700 dark:text-red-400",
} as const;

/** The attempt's gate, "No checks configured" when nothing gated it, or "Not scored" before a result. */
export function GatePill({ attempt }: { attempt: ArenaAttempt }) {
  const gate = gateState(attempt);
  return (
    <span
      data-slot="gate"
      className={`rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${gate === null ? "text-muted-foreground" : GATE_PILL_STYLES[gate]}`}
    >
      {gate === null ? "Not scored" : GATE_STATE_LABELS[gate]}
    </span>
  );
}

/** The verdicts on the attempt's current head, by recommendation. */
export function VerdictCounts({ verdicts }: { verdicts: ArenaAttempt["verdicts"] }) {
  return (
    <p aria-label="Verdicts" className="flex gap-3 text-xs text-muted-foreground">
      <span>{verdicts.merge} merge</span>
      <span>{verdicts.revise} revise</span>
      <span>{verdicts.reject} reject</span>
    </p>
  );
}
