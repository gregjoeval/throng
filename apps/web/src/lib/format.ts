const UNITS = ["B", "KB", "MB", "GB"] as const;

/** A byte count for people: `20 B`, `1.5 KB`, `2.0 MB`, in powers of 1,024. */
export function formatBytes(size: number): string {
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
