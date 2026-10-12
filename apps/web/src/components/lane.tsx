// One attempt's lane: its header (ref, gate, verdict counts, the author's note and a menu), then its
// change set against its base or current main, file by file. The arena shows several side by side;
// the single-attempt view shows one.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { AttemptDetails } from "@/components/attempt-details";
import { CommitFiles } from "@/components/commit-files";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { compareQuery, mainHeadQuery, meQuery, projectKey, scoreNow } from "@/lib/api";
import type { Compare } from "@/lib/api";
import { GATE_STATE_LABELS, gateState } from "@/lib/arena";
import type { ArenaAttempt } from "@/lib/arena";
import type { Layout, Reference } from "@/lib/arena-view";
import { apiError } from "@/lib/errors";
import { buildPath } from "@/lib/paths";

interface InProject {
  owner: string;
  project: string;
}

/**
 * A lane for `attempt`. `note` is the author's note from the attempt itself; `actions` goes in the
 * header beside the menu (the selection slice's Select). The menu opens the attempt's details. Its
 * change set is against `reference`, its diffs laid out by `layout`; with `files` false it lists no
 * files, only its notices (the arena's by-file arrangement shows the files in rows instead).
 */
export function Lane({
  owner,
  project,
  attempt,
  note,
  actions,
  reference = "base",
  layout = "split",
  files = true,
}: InProject & {
  attempt: ArenaAttempt;
  note: string;
  actions?: ReactNode;
  reference?: Reference;
  layout?: Layout;
  files?: boolean;
}) {
  const [details, setDetails] = useState(false);
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
            <LaneMenu owner={owner} project={project} attempt={attempt} onDetails={() => setDetails(true)} />
          </div>
        </div>
        <VerdictCounts verdicts={attempt.verdicts} />
        {note === "" ? null : <p className="text-sm text-muted-foreground">{note}</p>}
      </header>
      <LaneChanges
        owner={owner}
        project={project}
        attempt={attempt}
        reference={reference}
        layout={layout}
        files={files}
      />
      <AttemptDetails owner={owner} project={project} attempt={attempt} open={details} onOpenChange={setDetails} />
    </section>
  );
}

/** The lane's menu: the details sheet, the preview, and the attempt in the code browser. */
function LaneMenu({
  owner,
  project,
  attempt,
  onDetails,
}: InProject & { attempt: ArenaAttempt; onDetails: () => void }) {
  const navigate = useNavigate();
  const preview = attempt.result?.preview;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${attempt.ref} actions`} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuItem onClick={onDetails}>Checks, logs and verdicts</DropdownMenuItem>
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

/** The attempt's notices, then its change set against `reference` unless `files` is false. */
function LaneChanges({
  owner,
  project,
  attempt,
  reference,
  layout,
  files,
}: InProject & { attempt: ArenaAttempt; reference: Reference; layout: Layout; files: boolean }) {
  const changes = useLaneCompare(owner, project, attempt, reference);
  if (changes.state === "none") return <LaneNotice>Nothing has been pushed to {attempt.ref} yet.</LaneNotice>;
  return (
    <>
      {changes.fellBack ? (
        <LaneNotice>
          {attempt.ref} has no base (it shares no history with the task's line), so it's diffed against current main.
        </LaneNotice>
      ) : null}
      <ScoreNow owner={owner} project={project} attempt={attempt} />
      {changes.state === "noMain" ? <LaneNotice>main has no commits to diff {attempt.ref} against.</LaneNotice> : null}
      {files ? <LaneFiles changes={changes} attempt={attempt} layout={layout} /> : null}
    </>
  );
}

function LaneFiles({ changes, attempt, layout }: { changes: LaneCompare; attempt: ArenaAttempt; layout: Layout }) {
  switch (changes.state) {
    case "pending": {
      return <Loading label="Loading changes…" />;
    }
    case "error": {
      return <ErrorState error={changes.error} />;
    }
    case "ready": {
      return <CommitFiles diff={changes.diff} idPrefix={`${attempt.ref}-`} layout={layout} />;
    }
    default: {
      return null;
    }
  }
}

/**
 * A lane's change set as it loads: `none` before the attempt has a head, `noMain` when it's diffed
 * against a `main` with no commits. `fellBack` says an attempt with no base is diffed against `main`.
 */
type LaneCompare = { fellBack: boolean } & (
  | { state: "none" | "noMain" | "pending" }
  | { state: "error"; error: unknown }
  | { state: "ready"; diff: Compare }
);

/**
 * What the attempt's change set is diffed against for `reference`: its base, or `main` (`onMain`).
 * An attempt with a head but no base falls back to `main` (`fellBack`).
 */
export function laneReference(attempt: ArenaAttempt, reference: Reference) {
  const fellBack = attempt.sha !== null && reference === "base" && attempt.base === null;
  const onMain = attempt.sha !== null && (reference === "main" || fellBack);
  return { fellBack, onMain };
}

/** The compare query of the attempt's change set from `from` (a sha, or null while unknown). */
export const laneCompareQuery = (owner: string, project: string, attempt: ArenaAttempt, from: string | null) => ({
  ...compareQuery(owner, project, from ?? "", attempt.sha ?? "", attempt.ref),
  enabled: attempt.sha !== null && from !== null,
});

/** The attempt's change set against `reference`, both ends by sha (see `laneReference`). */
function useLaneCompare(owner: string, project: string, attempt: ArenaAttempt, reference: Reference): LaneCompare {
  const { fellBack, onMain } = laneReference(attempt, reference);
  const main = useQuery({ ...mainHeadQuery(owner, project), enabled: onMain });
  const from = onMain ? (main.data ?? null) : (attempt.base?.sha ?? null);
  const compare = useQuery(laneCompareQuery(owner, project, attempt, from));
  if (attempt.sha === null) return { fellBack, state: "none" };
  if (onMain && main.isError) return { fellBack, state: "error", error: main.error };
  if (onMain && main.isSuccess && main.data === null) return { fellBack, state: "noMain" };
  if (compare.isError) return { fellBack, state: "error", error: compare.error };
  if (compare.isSuccess) return { fellBack, state: "ready", diff: compare.data };
  return { fellBack, state: "pending" };
}

/**
 * Score now, for a draft's author while its head has no result, since drafts aren't scored on push.
 * Once asked, the arena's polling shows the run.
 */
function ScoreNow({ owner, project, attempt }: InProject & { attempt: ArenaAttempt }) {
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const score = useMutation({
    mutationFn: () => scoreNow(owner, project, attempt.ref),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKey(owner, project) }),
  });
  const unscored = attempt.result === undefined && (attempt.status === "none" || attempt.status === "errored");
  const isAuthor = me.isSuccess && me.data.user.id === attempt.author.id;
  if (attempt.state !== "draft" || !unscored || !isAuthor) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>Drafts aren't scored on push.</span>
      <Button size="sm" variant="outline" disabled={score.isPending || score.isSuccess} onClick={() => score.mutate()}>
        Score now
      </Button>
      {score.isError ? <span role="alert">{apiError(score.error).message}</span> : null}
    </div>
  );
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
