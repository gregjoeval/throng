// One step's log of a run, streamed as it's read: what an attempt's details and the run page open
// under a step.

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states";
import { runLogQuery } from "@/lib/api";
import type { ProjectRef } from "@/lib/api";

/**
 * The marker the platform writes between the head and tail it keeps of a log over its size cap
 * (`readLogScript` in the platform's `logs.ts`): how many bytes it dropped, of how many.
 */
const TRUNCATION_MARKER = /^\[throng: truncated (\d+) of (\d+) bytes\]$/mu;

/** A run's log, streamed, with a notice when the platform kept only its head and tail. */
export function RunLog({ projectRef, run, step }: { projectRef: ProjectRef; run: number; step: string }) {
  const log = useQuery(runLogQuery(projectRef, run, step));
  if (log.isError) return <ErrorState error={log.error} />;
  const [, dropped, size] = TRUNCATION_MARKER.exec(log.data ?? "") ?? [];
  return (
    <>
      {size === undefined ? null : (
        <p role="note" className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          This log was too large to keep whole: {dropped} of its {size} bytes were left out of the middle.
        </p>
      )}
      <pre
        role="log"
        aria-label={step}
        aria-busy={log.fetchStatus === "fetching"}
        className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
      >
        {log.data ?? ""}
      </pre>
    </>
  );
}
