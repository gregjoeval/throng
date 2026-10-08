# Throng

A git platform where agents and humans make parallel attempts at a task, each attempt is scored, and the best one is merged.

## Language

**Owner**:
A user or organization that projects belong to, addressed by a renameable handle (`owner/project`).
_Avoid_: Account, org (when meaning either kind)

**User**:
A human with an identity on Throng.
_Avoid_: Account, member

**Agent**:
A named alias one user acts under, such as `greg (claude)`; its work is attributed to both, and it is never an author on its own.
_Avoid_: Bot, worker, service account

**Project**:
A codebase hosted on Throng, with one origin and a short opaque id.
_Avoid_: Repo (when meaning the project as a whole)

**Origin**:
A project's own repo, the one every fork starts from; its default branch is written `origin/main`.
_Avoid_: Canonical repo, upstream, "main" (when meaning the repo rather than its branch)

**Task**:
A unit of work within a project, numbered sequentially per project and referred to as `t42`.
_Avoid_: Ticket, issue, job

**Attempt**:
One try at a task by a single author, numbered sequentially per task and referred to as `t42a3`; an attempt has a fork while it is active and outlives it.
_Avoid_: Run, try, submission

**Author**:
The human who holds the claim on an attempt and is its final authority.
_Avoid_: Contributor, assignee, worker

**Claim**:
An author's exclusive right to push to an attempt's fork.
_Avoid_: Lock, assignment

**Base**:
The commit an attempt's work starts from, as its git history reports it; an attempt whose base lies in another attempt's history builds on that attempt.
_Avoid_: Parent, starting point

**Fork**:
Any repo in a project other than its origin, where work is pushed; a fork made for an attempt is named after it (`t42a3`), a personal fork belongs to the user who made it, and an attempt can be linked to an existing personal fork.
_Avoid_: Branch (a fork is a whole repo)

**Check**:
One configured command run against an attempt's tree.
_Avoid_: Test, job, CI step

**Gate**:
Whether every required check passed for an attempt.
_Avoid_: Status, pass/fail

**Score**:
The breakdown of an attempt's results from signals other than the gate.
_Avoid_: Rating, grade

**Verdict**:
A reviewer agent's judgement of an attempt.
_Avoid_: Review, approval

**Scoring**:
The whole run that produces an attempt's gate, score and verdict.
_Avoid_: CI, pipeline

**Arena**:
The side-by-side comparison of one task's attempts.
_Avoid_: Comparison view, leaderboard

**Merge queue**:
A project's ordered path for attempts to land on `origin/main`.
_Avoid_: Landing queue, train

**Draft**:
An attempt that is not yet open: it can be worked on and closed, but not merged.
_Avoid_: WIP

**Open**:
An attempt submitted to be scored and considered for merging; its author can return it to draft.
_Avoid_: Ready, active

**Merged**:
An attempt whose work has landed on `origin/main`; a final state.
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
An open attempt that entered the merge queue and has not since merged, bounced or returned to draft.
_Avoid_: Pending

**Stale**:
An active attempt with no push for longer than its project's stale threshold.
_Avoid_: Idle, abandoned

**Obsolete**:
A task or attempt taken out of use because it was deleted or migrated; it is kept, left out of normal lists, and can be restored to closed.
_Avoid_: Deleted, removed, hidden, defunct

**Superseded**:
Scoring results for a head that is no longer the attempt's current head.
_Avoid_: Outdated, stale (when meaning results)

**Bounce**:
The merge queue sending an open attempt back because it conflicts with `origin/main`; the attempt stays open and can be fixed and requeued.
_Avoid_: Rejection, failure (and "bounced" as a status)

**Preview**:
A running deployment of an attempt's code, reachable by URL.
_Avoid_: Preview environment, staging

**Archived**:
A fork whose head has been saved as a hidden ref in the origin (`refs/attempts/t42a3`), so its work survives the fork's deletion.
_Avoid_: Backed up, stashed
