// The arena (variant D): a rail of attempt cards on the left, and the shown attempts' lanes side by
// side. Clicking a card toggles its lane; lanes keep the order they were added in.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { GatePill, Lane, VerdictCounts } from "@/components/lane";
import { useSelect } from "@/components/selection";
import { ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { meQuery, reopenAttempt, taskArenaQuery, taskKey } from "@/lib/api";
import {
  bestValues,
  formatValue,
  initialLanes,
  isActiveAttempt,
  isPassing,
  metricColumns,
  sortRail,
  toggleLane,
} from "@/lib/arena";
import type { ArenaAttempt, MetricColumn, RailSort } from "@/lib/arena";
import { apiError } from "@/lib/errors";
import type { Attempt } from "@/lib/tasks";

/** Past this many lanes, each keeps a minimum width and the lanes scroll sideways. */
const SHARED_WIDTH_LANES = 2;
/** The width a lane keeps once the lanes scroll sideways. */
const LANE_MIN_WIDTH = "520px";

interface InTask {
  owner: string;
  project: string;
  task: string;
}

/**
 * The arena of a task with two or more active attempts. `attempts` are the task's attempts as the
 * attempts list gives them, for what the arena endpoint doesn't carry (the author's note).
 */
export function Arena({ owner, project, task, attempts }: InTask & { attempts: Attempt[] }) {
  const arena = useQuery(taskArenaQuery(owner, project, task));
  if (arena.isPending) return <Loading />;
  if (arena.isError) return <ErrorState error={arena.error} />;
  const notes = new Map(attempts.map((a) => [a.ref, a.note]));
  return (
    <ArenaLayout
      owner={owner}
      project={project}
      task={task}
      attempts={arena.data.attempts}
      columns={metricColumns(arena.data.metrics)}
      notes={notes}
    />
  );
}

function ArenaLayout({
  owner,
  project,
  task,
  attempts,
  columns,
  notes,
}: InTask & {
  attempts: ArenaAttempt[];
  columns: MetricColumn[];
  notes: Map<string, string>;
}) {
  const active = attempts.filter(isActiveAttempt);
  const closed = attempts.filter((a) => a.state === "closed");
  const [lanes, toggle] = useLanes(active);
  const shown = lanes.flatMap((ref) => active.filter((a) => a.ref === ref));
  const sideways = shown.length > SHARED_WIDTH_LANES;
  const select = useSelect(owner, project, task, active.length);
  return (
    <div data-testid="arena" className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
      <Rail
        owner={owner}
        project={project}
        task={task}
        attempts={active}
        closed={closed}
        columns={columns}
        lanes={lanes}
        onToggle={toggle}
        select={select}
      />
      <section aria-label="Lanes" className="min-w-0 overflow-x-auto pb-2">
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${shown.length}, minmax(${sideways ? LANE_MIN_WIDTH : "0"}, 1fr))`,
          }}
        >
          {shown.map((attempt) => (
            <Lane
              key={attempt.ref}
              owner={owner}
              project={project}
              attempt={attempt}
              note={notes.get(attempt.ref) ?? ""}
              actions={select?.(attempt.ref)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * The refs shown as lanes, in the order they were added, and the toggle for a card. Until the viewer
 * toggles one it's `initialLanes`; refs that stop being active drop out, and if none is left the
 * initial lanes come back.
 */
function useLanes(active: ArenaAttempt[]): [string[], (ref: string) => void] {
  const [picked, setPicked] = useState<string[] | null>(null);
  const live = picked?.filter((ref) => active.some((a) => a.ref === ref)) ?? [];
  const lanes = live.length === 0 ? initialLanes(active) : live;
  return [lanes, (ref) => setPicked(toggleLane(lanes, ref))];
}

const SORT_LABELS = { number: "Number", gate: "Gate" } as const;

/** The attempt cards, sortable, then the closed attempts, collapsed. */
function Rail({
  owner,
  project,
  task,
  attempts,
  closed,
  columns,
  lanes,
  onToggle,
  select,
}: InTask & {
  attempts: ArenaAttempt[];
  closed: ArenaAttempt[];
  columns: MetricColumn[];
  lanes: string[];
  onToggle: (ref: string) => void;
  select: ((ref: string) => ReactNode) | null;
}) {
  const [sort, setSort] = useState<RailSort>("number");
  const best = bestValues(attempts, columns);
  return (
    <aside aria-label="Attempt rail" className="flex flex-col gap-3 lg:sticky lg:top-4">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {lanes.length} of {attempts.length} shown
        </span>
        <label className="flex items-center gap-1 text-muted-foreground">
          Sort by
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="rounded-md border bg-background px-1.5 py-0.5 text-foreground"
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {columns.map((column) => (
              <option key={column.key} value={column.key}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul aria-label="Attempts" className="flex flex-col gap-2">
        {sortRail(attempts, sort, columns).map((attempt) => (
          <li key={attempt.ref}>
            <RailCard
              attempt={attempt}
              columns={columns}
              best={best}
              shown={lanes.includes(attempt.ref)}
              onToggle={() => onToggle(attempt.ref)}
              footer={select?.(attempt.ref)}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Click a card to add or remove its lane.</p>
      {closed.length === 0 ? null : <ClosedGroup owner={owner} project={project} task={task} closed={closed} />}
    </aside>
  );
}

const SCORING_LABELS: Partial<Record<ArenaAttempt["status"], string>> = {
  queued: "Scoring queued",
  running: "Scoring…",
  errored: "Scoring errored",
};

/**
 * One attempt's card: its ref, author, gate and scoring status, every metric (the best among passing
 * attempts marked), and its verdict counts. The whole card toggles its lane; `footer` sits below it,
 * outside the toggle, for actions of its own (the selection slice's Select).
 */
export function RailCard({
  attempt,
  columns,
  best,
  shown,
  onToggle,
  footer,
}: {
  attempt: ArenaAttempt;
  columns: MetricColumn[];
  best: Map<string, number>;
  shown: boolean;
  onToggle: () => void;
  footer?: ReactNode;
}) {
  const scoring = SCORING_LABELS[attempt.status];
  return (
    <div
      className={`relative flex flex-col rounded-xl border bg-card text-sm ${shown ? "border-primary shadow-[inset_3px_0_0_var(--color-primary)]" : ""}`}
    >
      <button
        type="button"
        aria-label={attempt.ref}
        aria-pressed={shown}
        onClick={onToggle}
        className="flex flex-col gap-2 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden
          className={`absolute top-2.5 right-2.5 grid size-4 place-items-center rounded border ${shown ? "border-primary bg-primary text-primary-foreground" : ""}`}
        >
          {shown ? <CheckIcon className="size-3" /> : null}
        </span>
        <span className="flex flex-wrap items-center gap-2 pr-6">
          <span className="font-mono font-semibold">{attempt.ref}</span>
          <GatePill attempt={attempt} />
        </span>
        <span className="text-xs text-muted-foreground">{attempt.author.handle}</span>
        <span className="flex flex-wrap gap-1 empty:hidden">
          {scoring === undefined ? null : <Badge>{scoring}</Badge>}
          {attempt.needsUpdate ? <Badge>Needs update</Badge> : null}
          {attempt.forkedFrom ? <Badge>forked from {attempt.forkedFrom}</Badge> : null}
        </span>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
          {columns.map((column) => (
            <MetricRow key={column.key} column={column} attempt={attempt} best={best.get(column.key)} />
          ))}
        </dl>
        <VerdictCounts verdicts={attempt.verdicts} />
      </button>
      {footer === undefined ? null : <div className="border-t px-3 py-2">{footer}</div>}
    </div>
  );
}

function MetricRow({
  column,
  attempt,
  best,
}: {
  column: MetricColumn;
  attempt: ArenaAttempt;
  best: number | undefined;
}) {
  const value = column.value(attempt);
  const text = formatValue(value, column.unit);
  const isBest = value !== null && value === best && isPassing(attempt);
  return (
    <>
      <dt className="text-muted-foreground">{column.label}</dt>
      <dd className="text-right font-mono tabular-nums">
        {isBest ? (
          <mark
            title={`Best among passing attempts (${column.order === "asc" ? "lower" : "higher"} is better)`}
            className="rounded bg-yellow-200/70 px-1 text-foreground dark:bg-yellow-500/30"
          >
            {text}
          </mark>
        ) : (
          text
        )}
      </dd>
    </>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-md border px-1.5 text-xs text-muted-foreground">{children}</span>;
}

/** The task's closed attempts, collapsed under their count; each author may reopen theirs. */
function ClosedGroup({ owner, project, task, closed }: InTask & { closed: ArenaAttempt[] }) {
  const me = useQuery(meQuery);
  return (
    <details className="rounded-xl border px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">Closed ({closed.length})</summary>
      <ul aria-label="Closed attempts" className="mt-2 flex flex-col gap-1">
        {closed.map((attempt) => (
          <li key={attempt.ref} className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{attempt.ref}</span>
            <span className="text-xs text-muted-foreground">{attempt.author.handle}</span>
            {me.data?.user.id === attempt.author.id ? (
              <ReopenAttempt owner={owner} project={project} task={task} attempt={attempt.ref} />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Reopens a closed attempt as a draft; only its author may. */
function ReopenAttempt({ owner, project, task, attempt }: InTask & { attempt: string }) {
  const queryClient = useQueryClient();
  const reopen = useMutation({
    mutationFn: () => reopenAttempt(owner, project, attempt),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskKey(owner, project, task) });
    },
  });
  return (
    <>
      <Button variant="ghost" size="sm" className="ml-auto" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
        Reopen
      </Button>
      {reopen.isError ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {apiError(reopen.error).message}
        </p>
      ) : null}
    </>
  );
}
