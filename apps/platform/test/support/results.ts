import type { ScoringResult } from "../../src/results.ts";

/** A result with no config, checks or metrics whose gate passed. */
export const PASSED: ScoringResult = {
  base: null,
  config: { kind: "none" },
  gate: "passed",
  checks: [],
  metrics: {},
  logs: [],
};
