// What the Workflow tests' fake Sandboxes answer with, and a step that runs each callback once.

import { RESULT_PREFIX } from "../../src/scripts.ts";

/** A script's run that printed `value` as its result. */
export const result = (value: unknown) => ({
  exitCode: 0,
  stdout: `${RESULT_PREFIX}${JSON.stringify(value)}\n`,
  stderr: "",
});

/** A run whose one check passed. */
export const PASSED = {
  base: null,
  shortstat: "",
  builtinMs: 0,
  setupFailed: null,
  checks: [{ exit: 0, durationMs: 1, metrics: {} }],
};

/** A `WorkflowStep` whose `do` runs its callback once, ignoring the step's name and config. */
export const runOnce = {
  do: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => Promise<unknown>)(),
};
