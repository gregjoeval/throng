// Where an ended attempt's work is kept once its fork is gone: a hidden ref in the origin, one per
// attempt. Push routing and push-to-create must ignore these refs, so this module stays tiny and
// dependency-free for them to import.

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

/** Whether a full ref name is an attempt archive, which no push handling should act on. */
export function isArchiveRef(ref: string): boolean {
  return ref.startsWith(ARCHIVE_REF_PREFIX);
}
