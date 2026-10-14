// Throng's own `.throng/config.yml`, which a project imported from this repo runs under. Its commands
// are only proven in a Sandbox; this keeps it valid as the schema moves.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_PATH, parseConfig } from "../src/config.ts";

const OWN_CONFIG = readFileSync(new URL(`../../../${CONFIG_PATH}`, import.meta.url), "utf8");

describe("Throng's own config", () => {
  it("is valid, with every check running in parallel", () => {
    const result = parseConfig(OWN_CONFIG);
    const waiting = result.kind === "valid" ? result.config.checks.filter((check) => check.after.length > 0) : null;

    expect(result).toMatchObject({ kind: "valid" });
    expect(waiting).toEqual([]);
  });
});
