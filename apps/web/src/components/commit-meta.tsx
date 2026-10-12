// The small pieces every commit view shows: who wrote it and when.

import { person, relativeDate } from "@/lib/commits";

/** A git identity's name, with the agent alias they acted under as a badge. */
export function Author({ name }: { name: string }) {
  const who = person(name);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-medium">{who.name}</span>
      {who.agent === null ? null : (
        <span title="Agent alias" className="rounded-md border px-1.5 text-xs text-muted-foreground">
          {who.agent}
        </span>
      )}
    </span>
  );
}

/** A date relative to now, with the exact date on hover. */
export function RelativeTime({ date }: { date: string }) {
  return (
    <time dateTime={date} title={new Date(date).toLocaleString()}>
      {relativeDate(date)}
    </time>
  );
}
