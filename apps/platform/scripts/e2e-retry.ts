// Retries for the e2e suite's HTTP calls (`e2e.ts`), kept apart so unit tests can import them without
// running the suite. The edge sometimes resets a connection mid-run (#240); a reset is a flake, not a
// finding, so a call that is safe to repeat is sent again, and each retry is logged so flakes stay visible.

/** Error codes for a connection that failed before a response came back. */
const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Methods whose repeat leaves the server as one call would. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "DELETE"]);

/** The connection error code in `error` or its `cause` chain, if it has one. */
export function connectionErrorCode(error: unknown): string | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === "string" && CONNECTION_CODES.has(code)) return code;
  }
  return null;
}

/** Whether a `method` call may be sent again by default. */
export function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

export interface RetryOptions {
  /** Retries after the first try. */
  retries?: number;
  /** The wait before the first retry; each later one doubles it. */
  backoffMs?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `send`, and runs it again while it fails with a connection error, at most `retries` more
 * times. `what` names the call in the retry lines (`GET /api/...`). Any other error is thrown at once.
 */
export async function withRetry<T>(
  what: string,
  send: () => Promise<T>,
  {
    retries = 3,
    backoffMs = 250,
    log = console.log,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }: RetryOptions = {},
): Promise<T> {
  for (let retry = 1; ; retry++) {
    try {
      return await send();
    } catch (error) {
      const code = connectionErrorCode(error);
      if (code === null || retry > retries) throw error;
      log(`  retry ${retry}/${retries} ${what} after ${code}`);
      await sleep(backoffMs * 2 ** (retry - 1));
    }
  }
}
