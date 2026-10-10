// The contract between throng-web and the platform for forwarded Access identity. Kept free of
// imports so throng-web can bundle it without pulling in the platform.

/**
 * The header throng-web sets to the Access-verified user's email when it forwards `/api/*` over the
 * `PLATFORM` service binding. Only the binding's entrypoint (`WebEntrypoint`) trusts it; the public
 * hostname rejects any request that carries it.
 */
export const FORWARDED_EMAIL_HEADER = "X-Throng-Access-Email";
