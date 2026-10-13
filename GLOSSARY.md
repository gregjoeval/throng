# Throng

A git platform where agents and humans make parallel attempts at a task, each attempt is scored, and the best one is merged.

## Language

**Owner**:
A user or organization that projects belong to, addressed by a renameable handle (`owner/project`).
_Avoid_: Account, org (when meaning either kind)

**User**:
A human with an identity on Throng.
_Avoid_: Account, member

**Alias**:
A name one user acts under through tokens minted for it, such as `greg (claude)`. It is the user acting: the work is theirs, and an alias is never an author on its own. Aliases are meant for agents working on a user's behalf, but Throng only ever sees the alias.
_Avoid_: Agent (when meaning the alias), bot, worker, service account

**Agent**:
Software, such as an AI coding assistant, that works for a user through one of their aliases.
_Avoid_: Bot, worker

**Project**:
A codebase hosted on Throng, with one origin and a short opaque id.
_Avoid_: Repo (when meaning the project as a whole)

**Origin**:
A project's own repo, the one every fork starts from; its default branch is written `origin/main`.
_Avoid_: Canonical repo, upstream, "main" (when meaning the repo rather than its branch)

**Task**:
One change to a project, worked on through competing attempts. It lands at most once, through a merge request. Numbered sequentially per project and referred to as `t42`. Follow-up work is a new task.
_Avoid_: Ticket, issue, job

**Changeset**:
A set of changes to a codebase; each attempt is a changeset, and so is a merge request.
_Avoid_: Patch set, diff (when meaning the change itself)

**Attempt**:
One try at a task by a single author, numbered sequentially per task and referred to as `t42a3`; an attempt has a fork while it is active and outlives it.
_Avoid_: Run, try, submission

**Author**:
The user who holds the claim on an attempt and is its final authority.
_Avoid_: Contributor, assignee, worker

**Claim**:
An author's exclusive right to push to an attempt's fork.
_Avoid_: Lock, assignment

**Hand-off**:
An author giving an active attempt, and with it the claim, to another user, who becomes its author at once.
_Avoid_: Transfer, reassignment

**Base**:
The commit an attempt's change is measured from: where its history meets its task's task branch, or `origin/main` when the task has none. Read from git, never stored.
_Avoid_: Parent, starting point

**Task branch**:
An optional line of work owned by a task, holding what every attempt should build on, such as the task's tests and fixtures. New attempts start from it, active attempts follow it as it moves, and it lands with the winning attempt.
_Avoid_: Task base, spec branch

**Needs update**:
An active attempt whose task branch moved and could not be merged into it without conflicts; its author merges the task branch to clear it.
_Avoid_: Behind, out of date, stale (when meaning this)

**Forked from**:
The attempt a new attempt was copied from when it was started; it records where the attempt began and never makes the other attempt its base.
_Avoid_: Parent, builds on

**Fork**:
Any repo in a project other than its origin, where work is pushed; a fork made for an attempt is named after it (`t42a3`), and a personal fork belongs to the user who made it.
_Avoid_: Branch (a fork is a whole repo)

**Check**:
One configured command run against an attempt's tree, defined by the project or added by a task; its outcome and its output are where metrics come from.
_Avoid_: Test, job, CI step

**Metric**:
One named, typed value in an attempt's score, taken from a check or measured by Throng; it is null when nothing fits it.
_Avoid_: Stat, KPI, signal, measure

**Gate**:
Whether every required condition on an attempt's metrics holds, such as each required check having passed.
_Avoid_: Status, pass/fail

**Score**:
The breakdown of all of an attempt's metrics.
_Avoid_: Rating, grade

**Reviewer**:
Any user other than an attempt's author who judges it; a user acting under an alias can review, but never their own attempts.
_Avoid_: Approver, judge

**Verdict**:
A reviewer's judgement of one attempt's head: a recommendation (merge, revise or reject) with a written explanation.
_Avoid_: Review, approval (an approval is the decider's sign-off, not advice)

**Selection**:
The decision, made once per task, that picks the attempt that becomes the task's merge request.
_Avoid_: Judging, winner pick

**Selection policy**:
Who makes a task's selection: its creator, or a vote among eligible users (acting as themselves, under an alias, or either).
_Avoid_: Review policy

**Vote**:
A selection where eligible users each back one candidate attempt and the most-backed attempt wins.
_Avoid_: Poll

**Candidate**:
An attempt in a vote, pinned to the head it was passing at when it joined; a push to it withdraws it, and it can be added again once its new head passes.
_Avoid_: Nominee, entry

**Ballot**:
A user's one choice in a vote, for a candidate at its pinned head; their aliases share it, and casting again replaces it.
_Avoid_: Vote (when meaning one user's choice)

**Scoring**:
The whole run that produces an attempt's gate and score.
_Avoid_: CI, pipeline

**Arena**:
The side-by-side comparison of one task's attempts.
_Avoid_: Comparison view, leaderboard

**Merge request**:
The changeset chosen from a task's selection to land on `origin/main`; for now it is exactly the selected attempt, and a task has at most one open merge request.
_Avoid_: Pull request

**Approval**:
The selection maker's sign-off on one head of a merge request; only the approved head can land, and any new push needs a new approval.
_Avoid_: Verdict, review (when meaning the sign-off)

**Merge queue**:
A project's ordered path for merge requests to land on `origin/main`.
_Avoid_: Landing queue, train

**Draft**:
An attempt that is not yet open: it can be worked on and closed, but not merged.
_Avoid_: WIP

**Open**:
An attempt submitted to be scored and considered for merging; its author can return it to draft.
_Avoid_: Ready, active

**Merged**:
An attempt whose work has landed on `origin/main` through a merge request; a final state.
_Avoid_: Landed, integrated, won

**Closed**:
An attempt that ended without being merged; it can be reopened.
_Avoid_: Abandoned, rejected (as states)

**Active**:
A draft or open attempt, which has a fork and a claim.
_Avoid_: In progress, working

**Passing**:
An open attempt whose current head passed the gate in its latest scoring.
_Avoid_: Ready, green

**Queued**:
A merge request in the merge queue that has not yet landed or been dequeued.
_Avoid_: Pending

**Stale**:
An active attempt with no push for longer than its project's stale threshold.
_Avoid_: Idle, abandoned

**Obsolete**:
A task or attempt taken out of use because it was deleted or migrated; it is kept, left out of normal lists, and can be restored to closed.
_Avoid_: Deleted, removed, hidden, defunct

**Superseded**:
Scoring results or a verdict for a head that is no longer the attempt's current head.
_Avoid_: Outdated, stale (when meaning results or verdicts)

**Dequeue**:
A merge request leaving the merge queue without landing, for a reason (conflict, failed checks, a new push, or cancelled); it can be fixed and requeued.
_Avoid_: Bounce, rejection

**Preview**:
A running deployment of an attempt's code, reachable by URL.
_Avoid_: Preview environment, staging

**Archived**:
A fork whose head has been saved as a hidden ref in the origin (`refs/attempts/t42a3`), so its work survives the fork's deletion.
_Avoid_: Backed up, stashed
