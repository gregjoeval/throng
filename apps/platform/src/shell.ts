// Bash the Workflows write for a Sandbox to run: quoting what goes into it.

/** `s` as one single-quoted bash word, so nothing in it is expanded or splits it. */
export function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
