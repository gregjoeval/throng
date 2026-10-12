import { describe, expect, it } from "vitest";
import { metricValue, parseFrom } from "../src/metric-values.ts";

describe("parseFrom", () => {
  it("splits a metric's from into its check, its file and the keys into it", () => {
    expect(parseFrom("test.coverage-summary.total.lines.pct")).toEqual({
      check: "test",
      file: "coverage-summary",
      path: ["total", "lines", "pct"],
    });
  });
});

describe("metricValue", () => {
  const rule = { type: "number" } as const;

  it("reads the value at the path", () => {
    expect(metricValue("test.report.a.0", rule, { kind: "parsed", json: { a: [7] } })).toEqual({ value: 7 });
  });

  it("names the file as the parent when the file's JSON isn't an object", () => {
    expect(metricValue("test.report.a", rule, { kind: "parsed", json: 3 })).toEqual({
      value: null,
      note: "test.report.a: no key a; report is a number, not an object or array",
    });
  });
});
