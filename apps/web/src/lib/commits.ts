// How the browser reads a commit: its subject, who wrote it, and when, relative to now.

import { DateTime } from "luxon";

/** The message's first line. */
export function subject(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/** Everything after the subject and the blank line under it, or "" when there's no body. */
export function body(message: string): string {
  const newline = message.indexOf("\n");
  return newline === -1 ? "" : message.slice(newline + 1).trim();
}

/**
 * A git identity's name split into the user and the alias they acted under. Throng names work done
 * under an alias `ada (claude)`, as in its `Co-authored-by` trailers; any other name has no alias.
 */
export function person(name: string): { name: string; alias: string | null } {
  const match = /^(.+?) \(([^()]+)\)$/u.exec(name);
  return match?.[1] === undefined || match[2] === undefined
    ? { name, alias: null }
    : { name: match[1], alias: match[2] };
}

/** `3 hours ago`, from an ISO 8601 date. */
export function relativeDate(iso: string): string {
  return DateTime.fromISO(iso).toRelative() ?? iso;
}

/** A sha's first seven characters, as git shows it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
