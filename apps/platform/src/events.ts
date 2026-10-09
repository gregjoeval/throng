// Artifacts push events and how a project routes them.

import { parseRepoName } from "./repos.ts";

const ZERO_SHA = "0".repeat(40);

export interface PushEvent {
  namespace: string;
  repo: string;
  ref: string;
  before: string;
  after: string;
  /**
   * When Artifacts emitted the event (ms since epoch). Queue deliveries carry `metadata.eventTimestamp`;
   * events delivered by a Workflow trigger carry no `metadata`, so this is null there.
   */
  emittedAt: number | null;
}

export type PushRoute =
  | { kind: "main-advanced"; project: string; push: PushEvent }
  | { kind: "attempt"; project: string; attempt: string; push: PushEvent }
  | { kind: "ignored"; reason: string; push: PushEvent | null };

/** Parses a `cf.artifacts.repo.pushed` event; returns null for anything else. */
export function parsePushEvent(event: unknown): PushEvent | null {
  if (!isRecord(event) || event.type !== "cf.artifacts.repo.pushed") return null;
  const { source, payload, metadata } = event;
  if (!isRecord(source) || !isRecord(payload)) return null;
  const { namespace, repoName } = source;
  const { ref, before, after } = payload;
  if (
    typeof namespace !== "string" ||
    typeof repoName !== "string" ||
    typeof ref !== "string" ||
    typeof before !== "string" ||
    typeof after !== "string"
  ) {
    return null;
  }
  const emitted = isRecord(metadata) ? metadata.eventTimestamp : undefined;
  const emittedAt = typeof emitted === "string" || typeof emitted === "number" ? Date.parse(String(emitted)) : NaN;
  return {
    namespace,
    repo: repoName,
    ref,
    before,
    after,
    emittedAt: Number.isNaN(emittedAt) ? null : emittedAt,
  };
}

/** Decides what a push means: `main` moved on an origin, an attempt wants a check, or neither. */
export function routePush(event: unknown, defaultBranch = "main"): PushRoute {
  const push = parsePushEvent(event);
  if (push === null) return { kind: "ignored", reason: "not a push event", push: null };
  if (push.after === ZERO_SHA) return { kind: "ignored", reason: "ref deleted", push };

  const repo = parseRepoName(push.repo);
  if (repo === null) return { kind: "ignored", reason: `unrecognised repo ${push.repo}`, push };
  if (repo.kind === "fork") return { kind: "attempt", project: repo.project, attempt: repo.attempt, push };
  if (push.ref !== `refs/heads/${defaultBranch}`) {
    return { kind: "ignored", reason: `origin push to ${push.ref}`, push };
  }
  return { kind: "main-advanced", project: repo.project, push };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
