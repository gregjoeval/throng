# An attempt's base and the task branch

An attempt's **base** is still derived from git and never stored, as decided in #69 (B2). What changes is what it is derived against. A task may now own an optional **task branch**: a hidden ref in the origin (`refs/tasks/t42`) that the task creator or project owner pushes through the git proxy, holding what every attempt should build on, such as the task's tests and fixtures. The base is `merge-base(head, task branch head)` when the task has one, and `merge-base(head, origin/main)` otherwise. One platform function computes it, and scoring, the compare endpoint and the arena all use it.

New attempts start from the task branch, and active attempts **follow it**. When it moves, the platform merges the new task head into each active attempt's fork with a lease on the fork's head, and the new head is scored as usual. If the merge conflicts, nothing is written and the attempt is marked **needs update** for its author to merge the task branch. Another attempt is never a base. Forking `t42a1` copies its commits into a new sibling attempt that records **forked from** `t42a1`, but the sibling's base is the task branch, and it never follows `t42a1` afterwards.

## Considered options

- **Store a start point on each attempt** (the commit it was created from). Rejected: it reverses #69's B2, and a stored base drifts from what git says as soon as an author rebases or merges.
- **Let other attempts be bases**, taking the nearest merge-base among `main`, the task branch and every other attempt's head. Rejected: it makes a fork depend on another attempt that keeps changing, and authors don't expect a copy to track its source.
- **Leave attempts where they are when the task branch moves**, and show them as behind. Rejected: the task branch carries the checks every attempt is judged by, so a behind attempt is scored against old tests.
- **Merge the task branch in only when scoring and landing.** Rejected: what gets scored would no longer be the attempt's real head, and the arena's diffs and the landing would need the same merge repeated.
- **Require authors to update before selection.** Rejected: it turns routine upkeep into manual work for every attempt.

## Consequences

- Platform-written merge commits appear on attempts' forks. Authors pull before pushing, and the git proxy says so when a push is rejected because the task branch was merged in. A push the host accepts that drops the merge (a forced push, or push-to-create into an existing attempt) is followed again.
- Moving the task branch updates a merge request's source too, so the merge request goes to `needsReview` and needs approving again. A landing that has already claimed its push to `main` is left alone.
- The winning attempt's whole history lands, so the task branch's commits land with it. Selection says so when a task branch exists.
- An attempt copied from another carries the copied commits as part of its own change.
- Archived and closed attempts don't follow the task branch; a reopened attempt catches up when it reopens.
- Task check definitions stay task data (#194). The task branch holds code, not check configuration.
