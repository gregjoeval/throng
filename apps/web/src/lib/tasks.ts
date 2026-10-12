// What the task pages show about tasks, attempts and merge requests, in the platform's own values.

import type { InferResponseType } from "hono/client";
import type { client } from "@/lib/api";

type Tasks = (typeof client.api.projects)[":owner"][":project"]["tasks"];
export type ListedTask = InferResponseType<Tasks["$get"], 200>["tasks"][number];
export type Gate = NonNullable<ListedTask["bestGate"]>;
export type MergeRequestState = NonNullable<ListedTask["mergeRequestState"]>;

export const GATE_LABELS: Record<Gate, string> = { passed: "Passed", failed: "Failed" };

export const MERGE_REQUEST_LABELS: Record<MergeRequestState, string> = {
  pending: "Pending",
  queued: "Queued",
  landing: "Landing",
  needsReview: "Needs review",
  merged: "Merged",
  cancelled: "Cancelled",
};
