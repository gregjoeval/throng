// Vote selection in the arena: the banner over the lanes (the open vote's tallies, or the way to open
// one under the `vote` policy, and closing it), and Vote on each lane and rail card.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ELIGIBLE_VOTERS, mayVote, voteLeaders } from "@throng/platform/votes";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addVoteCandidate, castVote, closeVote, meQuery, openVote, rescore, taskKey } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";
import { isPassing } from "@/lib/arena";
import type { ArenaAttempt, TaskArena } from "@/lib/arena";
import { apiError } from "@/lib/errors";

export type Vote = NonNullable<TaskArena["vote"]>;
type Selection = TaskArena["selection"];

interface InTask {
  projectRef: ProjectRef;
  task: string;
}

/** Whether the vote's deadline has passed: it takes no more ballots, though it stays open until closed. */
const ballotsClosed = (vote: Vote) => vote.deadline !== null && Date.parse(vote.deadline) <= Date.now();

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A mutation on the task's vote that refetches the task's queries once it succeeds. */
function useVoteMutation<T>({ projectRef, task }: InTask, mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: taskKey(projectRef, task) });
    },
  });
}

/**
 * The banner over the lanes: the open vote, or under the `vote` policy the way to open one. Nothing
 * under the creator's policy with no vote open. `manage` is whether the viewer may open and close
 * votes; `active` is how many active attempts the task has.
 */
export function VoteBanner({
  projectRef,
  task,
  selection,
  vote,
  manage,
  active,
}: InTask & { selection: Selection; vote: Vote | null; manage: boolean; active: number }) {
  if (vote === null && selection.policy !== "vote") return null;
  return (
    <section aria-label="Vote" className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm">
      {vote === null ? (
        <NoVote projectRef={projectRef} task={task} selection={selection} manage={manage} />
      ) : (
        <OpenVote projectRef={projectRef} task={task} vote={vote} manage={manage} active={active} />
      )}
    </section>
  );
}

/**
 * A candidate's tally, or why it doesn't count now, and how it reads. One whose head has no result
 * yet (being scored, or its scoring errored) isn't struck through: its ballots count again once that
 * head passes.
 */
function tally(candidate: Vote["candidates"][number]): { text: string; style: string } {
  if (candidate.beingScored) return { text: "being scored", style: "text-muted-foreground" };
  if (candidate.erroredRun !== null) {
    return { text: `scoring errored (run ${candidate.erroredRun})`, style: "text-muted-foreground" };
  }
  if (candidate.withdrawn) return { text: "withdrawn", style: "text-muted-foreground line-through" };
  return { text: plural(candidate.votes, "vote", "votes"), style: "" };
}

/** Under the `vote` policy with no vote open: who would vote, and Open vote for whoever may. */
function NoVote({ projectRef, task, selection, manage }: InTask & { selection: Selection; manage: boolean }) {
  const [opening, setOpening] = useState(false);
  const [deadline, setDeadline] = useState("");
  const deadlineId = useId();
  const open = useVoteMutation({ projectRef, task }, (at: string) =>
    openVote(projectRef, task, at === "" ? undefined : new Date(at).toISOString()),
  );
  const among = ELIGIBLE_VOTERS[selection.eligible ?? "anyone"];
  return (
    <>
      <p>
        Selection is by vote, among {among}.{manage ? null : " No vote is open yet."}
      </p>
      {manage && !opening ? (
        <Button size="sm" variant="outline" className="w-fit" onClick={() => setOpening(true)}>
          Open vote
        </Button>
      ) : null}
      {manage && opening ? (
        <div role="group" aria-label="Open a vote" className="flex flex-col gap-2">
          <p>The attempts passing now become its candidates.</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={deadlineId}>Deadline (optional)</Label>
              <Input
                id={deadlineId}
                type="datetime-local"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
                className="w-fit"
              />
            </div>
            <Button size="sm" disabled={open.isPending} onClick={() => open.mutate(deadline)}>
              Open the vote
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpening(false)}>
              Cancel
            </Button>
          </div>
          <MutationError mutation={open} />
        </div>
      ) : null}
    </>
  );
}

/** The open vote: who may vote and until when, each candidate's tally, your ballot, and closing it. */
function OpenVote({
  projectRef,
  task,
  vote,
  manage,
  active,
}: InTask & { vote: Vote; manage: boolean; active: number }) {
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium">Vote open</span>
        <span className="text-muted-foreground">{sentence(ELIGIBLE_VOTERS[vote.eligible])} may vote.</span>
        {vote.deadline === null ? null : (
          <span className="text-muted-foreground">
            {ballotsClosed(vote) ? "Ballots closed" : "Ballots close"} {new Date(vote.deadline).toLocaleString()}.
          </span>
        )}
      </p>
      <ul aria-label="Tallies" className="flex flex-wrap gap-2">
        {vote.candidates.map((candidate) => {
          const { text, style } = tally(candidate);
          return (
            <li key={candidate.attempt} className={`flex gap-2 rounded-md border px-2 py-0.5 ${style}`}>
              <span className="font-mono">{candidate.attempt}</span>
              <span>{text}</span>
            </li>
          );
        })}
      </ul>
      {vote.myBallot === null ? null : <p className="text-muted-foreground">You voted for {vote.myBallot.attempt}.</p>}
      {manage ? <CloseVote projectRef={projectRef} task={task} vote={vote} active={active} /> : null}
    </>
  );
}

/**
 * Why the vote can't close yet, or null when it can: the platform refuses while a candidate's head has
 * no result, being scored or with its scoring errored.
 */
function closeBlocked(vote: Vote): string | null {
  const scoring = vote.candidates.filter((c) => c.beingScored).map((c) => c.attempt);
  if (scoring.length > 0) {
    const which = scoring.length === 1 ? `${scoring[0]} is` : `${scoring.join(", ")} are`;
    return `${which} being scored; close the vote once scoring finishes.`;
  }
  const errored = vote.candidates.filter((c) => c.erroredRun !== null).map((c) => `${c.attempt}'s`);
  if (errored.length > 0) {
    return `${errored.join(", ")} scoring errored; rescore ${errored.length === 1 ? "it" : "them"}, then close the vote.`;
  }
  return null;
}

/**
 * Close vote, asking inline first: it names the attempt the vote selects and what that closes, or on
 * a tie asks which of the tied attempts to select. Disabled, saying why, while `closeBlocked`.
 */
function CloseVote({ projectRef, task, vote, active }: InTask & { vote: Vote; active: number }) {
  const [confirming, setConfirming] = useState(false);
  const close = useVoteMutation({ projectRef, task }, (attempt: string | undefined) =>
    closeVote(projectRef, task, attempt),
  );
  const blocked = closeBlocked(vote);
  if (blocked !== null) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="w-fit" disabled>
          Close vote
        </Button>
        <span className="text-muted-foreground">{blocked}</span>
      </span>
    );
  }
  if (!confirming) {
    return (
      <Button size="sm" variant="outline" className="w-fit" onClick={() => setConfirming(true)}>
        Close vote
      </Button>
    );
  }
  const leaders = voteLeaders(vote.candidates).map((c) => c.attempt);
  const [winner] = leaders;
  const others = plural(active - 1, "attempt", "attempts");
  let question = "Close the vote? Every candidate was withdrawn, so it selects none.";
  if (leaders.length > 1) {
    question = `The vote is tied between ${leaders.slice(0, -1).join(", ")} and ${leaders.at(-1)}. Pick the one to select.`;
  } else if (winner !== undefined) {
    question = `Close the vote? ${winner} has the most votes and will be selected. The other ${others} will be closed and archived.`;
  }
  return (
    <div role="group" aria-label="Confirm closing the vote" className="flex flex-col gap-2">
      <p>{question}</p>
      <MutationError mutation={close} />
      <div className="flex flex-wrap gap-2">
        {leaders.length > 1 ? (
          leaders.map((attempt) => (
            <Button key={attempt} size="sm" disabled={close.isPending} onClick={() => close.mutate(attempt)}>
              Close and select {attempt}
            </Button>
          ))
        ) : (
          <Button size="sm" disabled={close.isPending} onClick={() => close.mutate(undefined)}>
            {winner === undefined ? "Close the vote" : `Close and select ${winner}`}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What the open vote offers on each attempt's lane and card: Vote for a standing candidate (Your vote
 * once you backed it) when you may vote for it; Rescore for a candidate whose scoring errored when
 * you may manage the vote (`manage`) or wrote the attempt, as the platform allows; or Add to vote for
 * a passing attempt that isn't a candidate (or was withdrawn) when you may manage the vote. Nothing
 * for a candidate being scored. Undefined when there is nothing to offer, and null instead of the
 * function when no vote is open.
 */
export function useVoteActions(
  { projectRef, task }: InTask,
  vote: Vote | null,
  manage: boolean,
): ((attempt: ArenaAttempt) => ReactNode | undefined) | null {
  const me = useQuery(meQuery);
  if (vote === null) return null;
  return (attempt) => {
    const candidate = vote.candidates.find((c) => c.attempt === attempt.ref);
    const isAuthor = me.isSuccess && me.data.user.id === attempt.author.id;
    if (candidate !== undefined && candidate.erroredRun !== null) {
      if (!manage && !isAuthor) return undefined;
      return <Rescore projectRef={projectRef} task={task} attempt={attempt.ref} />;
    }
    if (candidate?.beingScored === true) return undefined;
    if (candidate === undefined || candidate.withdrawn) {
      if (!manage || !isPassing(attempt)) return undefined;
      return <AddCandidate projectRef={projectRef} task={task} attempt={attempt.ref} />;
    }
    if (!me.isSuccess || isAuthor || !mayVote(vote.eligible, me.data.alias)) {
      return undefined;
    }
    if (ballotsClosed(vote)) return undefined;
    const mine = vote.myBallot?.attempt === candidate.attempt && vote.myBallot.head === candidate.head;
    return <CastVote projectRef={projectRef} task={task} attempt={attempt.ref} mine={mine} />;
  };
}

function CastVote({ projectRef, task, attempt, mine }: InTask & { attempt: string; mine: boolean }) {
  const cast = useVoteMutation({ projectRef, task }, () => castVote(projectRef, task, attempt));
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={mine ? "default" : "outline"}
        disabled={mine || cast.isPending}
        onClick={() => cast.mutate(undefined)}
      >
        {mine ? "Your vote" : "Vote"}
      </Button>
      <MutationError mutation={cast} />
    </span>
  );
}

function AddCandidate({ projectRef, task, attempt }: InTask & { attempt: string }) {
  const add = useVoteMutation({ projectRef, task }, () => addVoteCandidate(projectRef, task, attempt));
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={add.isPending} onClick={() => add.mutate(undefined)}>
        Add to vote
      </Button>
      <MutationError mutation={add} />
    </span>
  );
}

/** Rescore for a candidate whose scoring errored: it counts again, with its ballots, once its head passes. */
function Rescore({ projectRef, task, attempt }: InTask & { attempt: string }) {
  const again = useVoteMutation({ projectRef, task }, () => rescore(projectRef, attempt));
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={again.isPending} onClick={() => again.mutate(undefined)}>
        Rescore
      </Button>
      <MutationError mutation={again} />
    </span>
  );
}

function MutationError({ mutation }: { mutation: { isError: boolean; error: unknown } }) {
  if (!mutation.isError) return null;
  return (
    <span role="alert" className="text-destructive">
      {apiError(mutation.error).message}
    </span>
  );
}
