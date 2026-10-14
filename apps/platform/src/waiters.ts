// Long-poll waits on an attempt (`GET …/attempts/{a}?wait=&until=`). The project's Durable Object
// holds each request, snapshots what its condition watches, and answers once that changes or the
// wait runs out. The store wakes its waiters after every call that may change an attempt's state,
// its scoring runs or its merge request. Waiters live in memory: an in-flight request keeps the
// object awake, so it isn't hibernated under a wait, but a deploy or an eviction drops every wait,
// and `taskService.waitForAttempt` answers each `changed: false` for the client to wait again.

import type { MergeRequestState } from "./merge-requests.ts";
import type { AttemptState } from "./task-store.ts";

/** What a wait watches: its current head getting scored, its state, its merge request, or any of them. */
export const WAIT_CONDITIONS = ["scored", "stateChanged", "mergeRequestChanged", "any"] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];
/** The conditions `any` is made of: every other one. */
const WATCHED = WAIT_CONDITIONS.filter((c): c is Exclude<WaitCondition, "any"> => c !== "any");

/** The longest a request may wait, in seconds. */
export const MAX_WAIT_SECONDS = 30;
/**
 * How long to wait when the caller doesn't say: `wait_for_attempt`'s default, and the length the REST
 * API documents for `?wait=` (which, left out, answers at once).
 */
export const DEFAULT_WAIT_SECONDS = MAX_WAIT_SECONDS;
/** How many requests one user may have waiting at a time in one project; past it, a wait answers at once. */
export const MAX_WAITERS_PER_USER = 10;

/** The fields of an attempt a wait compares against its snapshot from request time. */
export interface AttemptWatch {
  state: AttemptState;
  /**
   * The newest run of its current head that is `done`, `errored` or waiting for the project owner, which
   * rests until someone acts; null when that head has none.
   */
  scoredRun: number | null;
  /** Its latest merge request: which one, its state and when it last left the queue; null when it has none. */
  mergeRequest: { id: number; state: MergeRequestState; dequeuedAt: string | null } | null;
}

/**
 * Whether `until` already holds when the wait arrives, so it answers at once. Only `scored` is a
 * state rather than a change: the current head has a `done` or `errored` run, or one waiting for the owner.
 */
export function alreadyMet(until: WaitCondition, now: AttemptWatch): boolean {
  return until === "scored" && now.scoredRun !== null;
}

/**
 * Whether `after` answers a wait for `until` that snapshotted `before`. `scored` holds once the
 * current head has a settled run it didn't have before, so a push alone doesn't answer it; as part
 * of `any`, that is how a new score counts as a change.
 */
export function watchChanged(until: WaitCondition, before: AttemptWatch, after: AttemptWatch): boolean {
  switch (until) {
    case "scored": {
      return after.scoredRun !== null && after.scoredRun !== before.scoredRun;
    }
    case "stateChanged": {
      return after.state !== before.state;
    }
    case "mergeRequestChanged": {
      return JSON.stringify(after.mergeRequest) !== JSON.stringify(before.mergeRequest);
    }
    case "any": {
      return WATCHED.some((c) => watchChanged(c, before, after));
    }
  }
}

interface Waiter {
  user: string;
  ready: () => boolean;
  resolve: (changed: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** The requests waiting in one project. */
export class Waiters {
  readonly #waiting = new Set<Waiter>();

  /**
   * Waits until `ready` holds at a `wake`, or `ms` pass; resolves whether it held. When `user`
   * already has `MAX_WAITERS_PER_USER` waiting, resolves false at once.
   */
  wait(user: string, ready: () => boolean, ms: number): Promise<boolean> {
    if ([...this.#waiting].filter((w) => w.user === user).length >= MAX_WAITERS_PER_USER) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { user, ready, resolve };
      waiter.timer = setTimeout(() => this.#answer(waiter, false), ms);
      this.#waiting.add(waiter);
    });
  }

  /** Answers every waiter whose condition now holds. One whose check throws is answered too, to read the error. */
  wake(): void {
    for (const waiter of this.#waiting) {
      let ready: boolean;
      try {
        ready = waiter.ready();
      } catch {
        ready = true;
      }
      if (ready) this.#answer(waiter, true);
    }
  }

  #answer(waiter: Waiter, changed: boolean): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    this.#waiting.delete(waiter);
    waiter.resolve(changed);
  }
}
