// The URLs the git proxy serves repos at.

/** A project as URLs name it: its owner's handle and its own. */
export interface ProjectPath {
  owner: string;
  project: string;
}

/** An attempt's git remote: `<baseUrl>/git/<owner>/<project>/t42a3.git`. */
export function attemptRemote(baseUrl: string, { owner, project }: ProjectPath, attempt: string): string {
  return `${baseUrl}/git/${owner}/${project}/${attempt}.git`;
}
