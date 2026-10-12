// An attempt's base (ADR 0003): where its head's history meets its task's task branch, or
// `origin/main` when the task has none. Derived from git on every read and never stored; the scoring
// run derives it here too and hands it to the score script.

import { forkRepo, missingAsNull, originRepo } from "./repos.ts";
import type { Commit, Repos } from "./repos.ts";
import { parseAttemptRef, taskBranchRef } from "./task-refs.ts";

/** What a base lies on: `main`, or the task's task branch. */
export const BASE_LINES = ["main", "task"] as const;
export type BaseLine = (typeof BASE_LINES)[number];

export interface Base {
  sha: string;
  on: BaseLine;
}

/** Most commits the walk reads before giving up; past it, the base is null as if unrelated. */
const MAX_BASE_WALK = 2000;

/**
 * The base of attempt `attempt` (`t42a3`) at commit `head`, which its fork holds: the merge base of
 * `head` and the task branch (`refs/tasks/t42` in origin) when the task has one, else of `head` and
 * origin's `main`. Null when they share no history, or `main` has no commits yet.
 */
export async function attemptBase(
  repos: Repos,
  project: string,
  { attempt, head }: { attempt: string; head: string },
): Promise<Base | null> {
  const parsed = parseAttemptRef(attempt);
  if (parsed === null) throw new Error(`not an attempt: ${attempt}`);
  const origin = originRepo(project);
  const task = await tip(repos, origin, taskBranchRef(parsed.task));
  const line: { on: BaseLine; sha: string | null } =
    task === null ? { on: "main", sha: await tip(repos, origin, "main") } : { on: "task", sha: task };
  if (line.sha === null) return null;
  const sha = await mergeBase(repos, { repo: forkRepo(project, attempt), sha: head }, { repo: origin, sha: line.sha });
  return sha === null ? null : { sha, on: line.on };
}

/** The head of task `task`'s task branch in the origin, or null when it has none. */
export async function taskBranchHead(repos: Repos, project: string, task: number): Promise<{ sha: string } | null> {
  const sha = await tip(repos, originRepo(project), taskBranchRef(task));
  return sha === null ? null : { sha };
}

/**
 * Task `task`'s task branch in the origin: its head, and how many of its commits `main` doesn't have
 * yet, which land with the selected attempt. Null when it has none.
 */
export async function readTaskBranch(
  repos: Repos,
  project: string,
  task: number,
): Promise<{ sha: string; commits: number } | null> {
  const head = await taskBranchHead(repos, project, task);
  if (head === null) return null;
  const origin = originRepo(project);
  const main = await tip(repos, origin, "main");
  return { sha: head.sha, commits: await commitsNotIn(repos, origin, head.sha, main) };
}

/** `attemptBase` at the attempt's current head, its fork's `main`, scored or not. Null with no head. */
export async function currentBase(repos: Repos, project: string, attempt: string): Promise<Base | null> {
  const head = await tip(repos, forkRepo(project, attempt), "refs/heads/main");
  return head === null ? null : attemptBase(repos, project, { attempt, head });
}

/** The commit `ref` points at in `repo`, or null when it, or the repo, doesn't exist. */
async function tip(repos: Repos, repo: string, ref: string): Promise<string | null> {
  const found = await missingAsNull(repos.listCommits(repo, { ref, limit: 1 }));
  return found?.[0]?.hash ?? null;
}

interface Side {
  repo: string;
  sha: string;
}

const ONE = 1;
const TWO = 2;
const BOTH = ONE | TWO;

/**
 * The newest common ancestor of `one` and `two`, each read from its own repo, found the way
 * `merge-base` does: the first commit, newest first, that both sides reach. Null when there is none
 * within `MAX_BASE_WALK` commits.
 */
async function mergeBase(repos: Repos, one: Side, two: Side): Promise<string | null> {
  const marks = new Map<string, number>([[one.sha, ONE]]);
  marks.set(two.sha, (marks.get(two.sha) ?? 0) | TWO);
  for await (const { next } of walkNewestFirst(repos, one.sha === two.sha ? [one] : [one, two], marks)) {
    if (marks.get(next) === BOTH) return next;
  }
  return null;
}

/**
 * How many commits `head` reaches that `other` (null for none) doesn't, both in `repo`: `git rev-list
 * --count head ^other`. Stops once every commit left to walk is one `other` reaches.
 */
async function commitsNotIn(repos: Repos, repo: string, head: string, other: string | null): Promise<number> {
  const marks = new Map<string, number>([[head, ONE]]);
  if (other !== null) marks.set(other, (marks.get(other) ?? 0) | TWO);
  const walked = new Set<string>();
  const starts = [...marks.keys()].map((sha) => ({ repo, sha }));
  for await (const { next, queued } of walkNewestFirst(repos, starts, marks)) {
    if (queued.every((sha) => (marks.get(sha) ?? 0) & TWO)) break;
    walked.add(next);
  }
  return [...walked].filter((sha) => marks.get(sha) === ONE).length;
}

/**
 * Walks history from `starts`, each read from its own repo, newest commit first the way git does.
 * `marks` holds the sides (`ONE`, `TWO`) that reach each commit, and walking a commit marks its
 * parents with its sides. Before walking each commit it yields it as `next`, with every commit
 * queued (`next` first), so a caller can stop. Stops by itself after `MAX_BASE_WALK` commits.
 */
async function* walkNewestFirst(
  repos: Repos,
  starts: Side[],
  marks: Map<string, number>,
): AsyncGenerator<{ next: string; queued: string[] }> {
  const queue: { commit: Commit; repo: string }[] = [];
  const enqueue = async ({ repo, sha }: Side) => {
    const commit = await missingAsNull(repos.readCommit(repo, sha));
    if (commit !== null) queue.push({ commit, repo });
  };
  await Promise.all(starts.map(enqueue));
  for (let read = 0; queue.length > 0 && read < MAX_BASE_WALK; read++) {
    queue.sort((a, b) => b.commit.committedAt - a.commit.committedAt);
    const { commit, repo } = queue[0] as { commit: Commit; repo: string };
    yield { next: commit.hash, queued: queue.map((q) => q.commit.hash) };
    queue.shift();
    const mark = marks.get(commit.hash) ?? 0;
    const fresh: Side[] = [];
    for (const parent of commit.parents) {
      const seen = marks.get(parent) ?? 0;
      if ((seen | mark) === seen) continue;
      marks.set(parent, seen | mark);
      // A commit already walked is walked again when a new side reaches it, as with skewed dates.
      if (!queue.some((q) => q.commit.hash === parent)) fresh.push({ repo, sha: parent });
    }
    await Promise.all(fresh.map(enqueue));
  }
}
