/** `value`, or a thrown error when it is null or undefined: a precondition the test relies on. */
export function defined<T>(value: T | null | undefined, what = "a value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}, got ${String(value)}`);
  return value;
}

/** The item at `index` (negative counts back from the end), or a thrown error when there is none. */
export function at<T>(items: readonly T[], index: number): T {
  return defined(items.at(index), `an item at ${index} of ${items.length}`);
}
