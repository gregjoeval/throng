/**
 * How a metric's value is read out of a check's output and checked against its type. The Worker
 * imports these functions, and the score script runs their source in the container (see
 * `METRIC_VALUES_SOURCE`), so a value is checked the same way on both sides. Each function must
 * stay self-contained: it may call the others here by name, but use nothing else from outside its
 * body, and declare no functions inside it.
 */

/**
 * A metric's type, which decides how its values compare: a number by its `order`, a boolean too
 * (true is the higher), an enum by its `values` best first, and a string not at all.
 */
export const METRIC_TYPES = ["boolean", "number", "string", "enum"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/** How a string metric's value is shown; it never changes how values compare. */
export const METRIC_FORMATS = ["url"] as const;
export type MetricFormat = (typeof METRIC_FORMATS)[number];

/** What a value must be to fit its metric: its type, and an enum's values. */
export type MetricRule = { type: "boolean" | "number" | "string" } | { type: "enum"; values: string[] };

/** A value that fits its metric's type. */
export type TypedValue = boolean | number | string;

/** A metric's value, or null with why. */
export type MetricValue = { value: TypedValue } | { value: null; note: string };

/** What the score script found for a metric's output file in `$THRONG_OUTPUT`. */
export type OutputFile =
  /** No such file; `files` are the names that are there. */
  | { kind: "missing"; files: string[] }
  /** Over the parse guard of `limit` bytes. */
  | { kind: "tooLarge"; limit: number }
  | { kind: "invalid" }
  | { kind: "parsed"; json: unknown };

/** What a JSON value is, for a note: `a number`, `an array`, `null`. */
export function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/** Keys or file names for a note: the first 20, and how many more. */
export function keyList(keys: string[]): string {
  if (keys.length === 0) return "there are none";
  return keys.slice(0, 20).join(", ") + (keys.length > 20 ? `, and ${keys.length - 20} more` : "");
}

/**
 * A value checked against its metric's rule: the value, or what it was instead. A number must be
 * finite, and an enum's value one of its `values`.
 */
export function typedValue(value: unknown, rule: MetricRule): { value: TypedValue } | { problem: string } {
  if (rule.type === "enum") {
    if (typeof value !== "string")
      return { problem: `expected one of ${keyList(rule.values)}, got ${jsonKind(value)}` };
    if (!rule.values.includes(value)) {
      return { problem: `${JSON.stringify(value)} is not one of its values: ${keyList(rule.values)}` };
    }
    return { value };
  }
  if (rule.type === "number" && typeof value === "number" && Number.isFinite(value)) return { value };
  if (rule.type === "boolean" && typeof value === "boolean") return { value };
  if (rule.type === "string" && typeof value === "string") return { value };
  return { problem: `expected a ${rule.type}, got ${jsonKind(value)}` };
}

/**
 * The value at `from` (`<check>.<file>.<path>`) in its output file, checked against `rule`. The
 * path's segments are object keys, or plain numeric indexes into arrays. A null's note starts with
 * `from` up to the segment that failed, and lists the keys (or files) that were there instead.
 */
export function metricValue(from: string, rule: MetricRule, file: OutputFile): MetricValue {
  const segments = from.split(".");
  const name = segments[1] ?? "";
  const fileAt = segments.slice(0, 2).join(".");
  if (file.kind === "missing") {
    return { value: null, note: `${fileAt}: no ${name}.json in $THRONG_OUTPUT; files there: ${keyList(file.files)}` };
  }
  if (file.kind === "tooLarge") {
    const mb = Math.round(file.limit / (1024 * 1024));
    return { value: null, note: `${fileAt}: ${name}.json is over the parse guard of ${mb} MB` };
  }
  if (file.kind === "invalid") return { value: null, note: `${fileAt}: ${name}.json is not valid JSON` };
  let at: unknown = file.json;
  for (let i = 2; i < segments.length; i++) {
    const key = segments[i] ?? "";
    const path = segments.slice(0, i + 1).join(".");
    if (Array.isArray(at)) {
      const index = /^(0|[1-9]\d*)$/u.test(key) ? Number(key) : -1;
      if (index < 0 || index >= at.length) {
        const range = at.length === 0 ? "it is empty" : `indexes there: 0 to ${at.length - 1}`;
        return { value: null, note: `${path}: no index ${key} in an array; ${range}` };
      }
      at = at[index];
    } else if (typeof at === "object" && at !== null) {
      if (!Object.hasOwn(at, key)) {
        return { value: null, note: `${path}: no key ${key}; keys there: ${keyList(Object.keys(at))}` };
      }
      at = Reflect.get(at, key);
    } else {
      const parent = segments[i - 1] ?? "";
      return { value: null, note: `${path}: no key ${key}; ${parent} is ${jsonKind(at)}, not an object or array` };
    }
  }
  const typed = typedValue(at, rule);
  return "problem" in typed ? { value: null, note: `${from}: ${typed.problem}` } : typed;
}

/**
 * These functions as plain JavaScript, for the score script's `node` step to run. Call them by
 * `metricValue.name`, since a bundler may rename them.
 */
export const METRIC_VALUES_SOURCE = [jsonKind, keyList, typedValue, metricValue].map(String).join("\n");
