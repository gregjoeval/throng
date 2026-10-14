// A project's pipelines: `main` runs on `main`, and `default` on every other line (an attempt's fork or
// a task branch). Shared with throng-web, which lists them in the secrets settings.

/** The pipelines, in the order they're listed. */
export const PIPELINES = ["default", "main"] as const;
export type Pipeline = (typeof PIPELINES)[number];
