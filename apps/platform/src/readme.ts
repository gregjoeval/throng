// Which file is a directory's README, shared by the platform (a project's description) and the web
// UI (the README rendered below a directory).

const README = /^readme(?:\.md)?$/iu;

/** Whether a file named `name` is a README: `README.md` or `README`, in any case. */
export function isReadme(name: string): boolean {
  return README.test(name);
}
