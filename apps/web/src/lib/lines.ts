// A file view's line anchors: `#L10` for one line, `#L10-L20` for a range.

import type { LineRange } from "@/lib/highlighter";

const ANCHOR = /^L(\d+)(?:-L(\d+))?$/u;

/** The lines a hash (without its `#`) names, in order, or undefined when it names none. */
export function parseLineAnchor(hash: string): LineRange | undefined {
  const match = ANCHOR.exec(hash);
  if (match === null) return undefined;
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (first < 1 || last < 1) return undefined;
  return { start: Math.min(first, last), end: Math.max(first, last) };
}

/** The anchor for a range: `L10`, or `L10-L20` when it spans more than one line. */
export function lineAnchor({ start, end }: LineRange): string {
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

/**
 * The lines selected after clicking `line`: just that line, or with shift held, the range from the
 * current selection's first line to it.
 */
export function selectLine(current: LineRange | undefined, line: number, extend: boolean): LineRange {
  if (!extend || current === undefined) return { start: line, end: line };
  return { start: Math.min(current.start, line), end: Math.max(current.start, line) };
}
