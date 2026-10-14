// Throng's own `.throng/config.yml`, which a project imported from this repo runs under (the demo
// project among them). Its commands are only proven in a Sandbox; this keeps it valid as the schema moves.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

const text = readFileSync(new URL("../../../.throng/config.yml", import.meta.url), "utf8");

describe("Throng's own config", () => {
  it("is valid, installing once and checking the web app in parallel on standard-2", () => {
    const result = parseConfig(text);
    if (result.kind !== "valid") throw new Error(result.kind === "invalid" ? result.error : "no config");

    expect(result.config.sandbox.size).toBe("standard-2");
    expect(result.config.setup.map((setup) => setup.name)).toEqual(["deps"]);
    expect(result.config.checks.map((check) => [check.name, check.after])).toEqual([
      ["typecheck", []],
      ["test", []],
      ["lint", []],
      ["format", []],
    ]);
  });
});
