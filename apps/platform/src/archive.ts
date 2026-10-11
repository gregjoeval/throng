// Where an ended attempt's work is kept once its fork is gone: a hidden ref in the origin, one per
// attempt. Archiving is an internal push (`Repos.copyRef`), so it never reaches the scoring queue.

/**
 * The origin ref prefix archived attempts live under: `refs/attempts/t42a3`. If Artifacts turns
 * out to reject or drop custom refs (the `refs` e2e scenario checks), switch this to the branch
 * namespace `refs/heads/archive/attempts/`; nothing else needs to change.
 */
export const ARCHIVE_REF_PREFIX = "refs/attempts/";

/** The origin ref an attempt (`t42a3`) is archived to. */
export function archiveRef(attempt: string): string {
  return `${ARCHIVE_REF_PREFIX}${attempt}`;
}
