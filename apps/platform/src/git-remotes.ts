// The URLs the git proxy serves repos at, and the clone command an agent runs against one. The
// command names the token as `$THRONG_TOKEN`, so no response ever carries the token itself.

/** A project as URLs name it: its owner's handle and its own. */
export interface ProjectPath {
  owner: string;
  project: string;
}

/** An attempt's git remote: `<baseUrl>/git/<owner>/<project>/t42a3.git`. */
export function attemptRemote(baseUrl: string, { owner, project }: ProjectPath, attempt: string): string {
  return `${baseUrl}/git/${owner}/${project}/${attempt}.git`;
}

/** Clones `remote`, sending the token in the agent's `THRONG_TOKEN` as a bearer header. */
export function cloneCommand(remote: string): string {
  return `git -c http.extraHeader="Authorization: Bearer $THRONG_TOKEN" clone ${remote}`;
}
