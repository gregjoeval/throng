// What the task pages show about tasks, attempts and merge requests, in the platform's own values,
// and which body a task page shows for a task's state.

import type { InferResponseType } from "hono/client";
import type { client } from "@/lib/api";

type Tasks = (typeof client.api.projects)[":owner"][":project"]["tasks"];
export type Task = InferResponseType<Tasks[":t"]["$get"], 200>;
export type ListedTask = InferResponseType<Tasks["$get"], 200>["tasks"][number];
export type Attempt = InferResponseType<Tasks[":t"]["attempts"]["$get"], 200>["attempts"][number];
export type Gate = NonNullable<ListedTask["bestGate"]>;
export type MergeRequestState = NonNullable<ListedTask["mergeRequestState"]>;

export const GATE_LABELS: Record<Gate, string> = { passed: "Passed", failed: "Failed" };

export const TASK_STATE_LABELS: Record<Task["state"], string> = {
  open: "Open",
  closed: "Closed",
  obsolete: "Obsolete",
};

/** Each merge request state's label, and whether a merge request in it is open. */
const MERGE_REQUEST_STATES: Record<MergeRequestState, { label: string; open: boolean }> = {
  pending: { label: "Pending", open: true },
  queued: { label: "Queued", open: true },
  landing: { label: "Landing", open: true },
  needsReview: { label: "Needs review", open: true },
  merged: { label: "Merged", open: false },
  cancelled: { label: "Cancelled", open: false },
};

export const mergeRequestLabel = (state: MergeRequestState) => MERGE_REQUEST_STATES[state].label;

/** Whether a merge request in `state` is open: pending, queued, landing or needing review. */
export const isOpenMergeRequest = (state: MergeRequestState) => MERGE_REQUEST_STATES[state].open;

type MergeRequestApi = Tasks[":t"]["merge-request"];
export type MergeRequest = InferResponseType<MergeRequestApi["$get"], 200>;
/** Why a merge request last left the queue without landing, with its reason's details. */
export type Dequeue = InferResponseType<MergeRequestApi["dequeue"]["$get"], 200>;
export type DequeueReason = Dequeue["reason"];

/** Draft and open attempts are active: they have a fork and a claim. */
export const isActive = (attempt: Attempt) => attempt.state === "draft" || attempt.state === "open";

/** What a task page's body shows, by the task's state (the arena spec's **Body by state**). */
export type TaskBody =
  | { kind: "noAttempts" }
  | { kind: "singleAttempt"; attempt: Attempt }
  | { kind: "arena"; attempts: Attempt[] }
  | { kind: "mergeRequest"; source: Attempt }
  | { kind: "ended"; merged: Attempt | null; archived: Attempt[] };

export function taskBody(task: Task, attempts: Attempt[]): TaskBody {
  if (task.state !== "open") {
    const merged = attempts.find((a) => a.state === "merged") ?? null;
    return { kind: "ended", merged, archived: attempts.filter((a) => a !== merged && a.archivedSha !== null) };
  }
  const source = attempts.find((a) => a.mergeRequest !== null && isOpenMergeRequest(a.mergeRequest.state));
  if (source !== undefined) return { kind: "mergeRequest", source };
  const active = attempts.filter(isActive);
  const [only] = active;
  if (only === undefined) return { kind: "noAttempts" };
  if (active.length === 1) return { kind: "singleAttempt", attempt: only };
  return { kind: "arena", attempts: active };
}

/** The platform path of a project's git remote: its origin, or an attempt's fork. */
export function gitRemotePath(owner: string, project: string, attempt?: string): string {
  const name = attempt === undefined ? project : `${project}/${attempt}`;
  return `/git/${encodeURIComponent(owner)}/${name.split("/").map(encodeURIComponent).join("/")}.git`;
}
