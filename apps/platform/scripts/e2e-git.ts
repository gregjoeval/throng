// Pure git helpers for the e2e suite (`e2e.ts`), kept apart so unit tests can import them without
// running the suite.

/** A commit as `git cat-file -p` prints it, with its message's trailers by key. */
export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  subject: string;
  trailers: Record<string, string[]>;
}

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/u;

/** Parses `git cat-file -p <commit>`. Trailers are read from the message's last paragraph. */
export function parseCommit(raw: string): Commit {
  const split = raw.indexOf("\n\n");
  const header = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? "" : raw.slice(split + 2).trimEnd();
  const commit: Commit = { tree: "", parents: [], author: "", committer: "", subject: "", trailers: {} };
  for (const line of header.split("\n")) {
    const space = line.indexOf(" ");
    const [key, value] = [line.slice(0, space), line.slice(space + 1)];
    if (key === "tree") commit.tree = value;
    else if (key === "parent") commit.parents.push(value);
    else if (key === "author" || key === "committer") commit[key] = value.replace(/ \d+ [+-]\d{4}$/u, "");
  }
  const paragraphs = message.split(/\n{2,}/u);
  commit.subject = paragraphs[0]?.split("\n")[0] ?? "";
  const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? "").split("\n") : [];
  if (last.length > 0 && last.every((line) => TRAILER.test(line))) {
    for (const line of last) {
      const [, key = "", value = ""] = TRAILER.exec(line) ?? [];
      (commit.trailers[key] ??= []).push(value);
    }
  }
  return commit;
}

/** A git `http.extraHeader` that sends a Throng token as the Basic password, as the git proxy expects. */
export function basicAuthHeader(token: string): string {
  return `Authorization: Basic ${btoa(`e2e:${token}`)}`;
}
