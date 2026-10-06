// Artifacts push events and how a project routes them.

/** A canonical repo is named after its project; an attempt fork is `<project>--<attempt>`. */
export const FORK_SEPARATOR = "--";

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

export function forkName(project: string, attempt: string): string {
  return `${project}${FORK_SEPARATOR}${attempt}`;
}

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

/** Decides what a push means: `main` moved on a canonical repo, an attempt wants a check, or neither. */
export function routePush(event: unknown, defaultBranch = "main"): PushRoute {
  const push = parsePushEvent(event);
  if (push === null) return { kind: "ignored", reason: "not a push event", push: null };
  if (push.after === ZERO_SHA) return { kind: "ignored", reason: "ref deleted", push };

  const at = push.repo.indexOf(FORK_SEPARATOR);
  if (at === -1) {
    if (push.ref !== `refs/heads/${defaultBranch}`) {
      return { kind: "ignored", reason: `canonical push to ${push.ref}`, push };
    }
    return { kind: "main-advanced", project: push.repo, push };
  }

  const project = push.repo.slice(0, at);
  const attempt = push.repo.slice(at + FORK_SEPARATOR.length);
  if (project === "" || attempt === "") return { kind: "ignored", reason: "malformed fork name", push };
  return { kind: "attempt", project, attempt, push };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export const  probe   =1
