// Access never fronts localhost, so `vite dev` signs every `/api` call in as THRONG_DEV_EMAIL instead.
// vite.config.ts bakes this into the Worker as the THRONG_DEV_EMAIL constant. A build always gets
// null, so no deployed Worker can skip Access. No imports: vite.config.ts loads this under Node.

/** The email `vite <command>` signs `/api` calls in as, or null for Access: only `serve` reads `value`, and empty is unset. */
export function devAccessEmail(command: "build" | "serve", value: string | undefined): string | null {
  return command === "serve" && value ? value : null;
}
