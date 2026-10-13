import { describe, expect, it } from "vitest";
import { connectionErrorCode, isIdempotent, withRetry } from "../scripts/e2e-retry.ts";

/** An error like undici's `fetch failed`, whose cause carries `code`. */
function fetchFailed(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`read ${code}`), { code }) });
}

/** Runs `withRetry` on `outcomes` in turn, recording the retry lines and waits. */
async function retried<T>(outcomes: (T | Error)[], retries?: number) {
  const lines: string[] = [];
  const waits: number[] = [];
  let calls = 0;
  const result = withRetry(
    "GET /api/x",
    async () => {
      const outcome = outcomes[calls++];
      if (outcome instanceof Error) throw outcome;
      return outcome as T;
    },
    { retries, log: (line) => lines.push(line), sleep: async (ms) => void waits.push(ms) },
  );
  return { result, lines, waits, calls: () => calls };
}

describe("connectionErrorCode", () => {
  it("finds a connection error's code in the cause chain", () => {
    expect(connectionErrorCode(fetchFailed("ECONNRESET"))).toBe("ECONNRESET");
    expect(connectionErrorCode(fetchFailed("UND_ERR_SOCKET"))).toBe("UND_ERR_SOCKET");
  });

  it("is null for an error with no connection code", () => {
    expect(connectionErrorCode(new Error("GET /x: 500 boom"))).toBeNull();
    expect(connectionErrorCode(fetchFailed("ENOTFOUND"))).toBeNull();
    expect(connectionErrorCode("ECONNRESET")).toBeNull();
  });
});

describe("isIdempotent", () => {
  it("lets GET, HEAD and DELETE repeat but not POST, PUT or PATCH", () => {
    expect(["GET", "head", "DELETE"].map(isIdempotent)).toEqual([true, true, true]);
    expect(["POST", "PUT", "PATCH"].map(isIdempotent)).toEqual([false, false, false]);
  });
});

describe("withRetry", () => {
  it("sends again after a connection error, logging each retry and doubling the wait", async () => {
    const run = await retried([fetchFailed("ECONNRESET"), fetchFailed("ECONNREFUSED"), "ok"]);
    await expect(run.result).resolves.toBe("ok");
    expect(run.lines).toEqual(["  retry 1/3 GET /api/x after ECONNRESET", "  retry 2/3 GET /api/x after ECONNREFUSED"]);
    expect(run.waits).toEqual([250, 500]);
  });

  it("throws the last connection error once the retries run out", async () => {
    const last = fetchFailed("EPIPE");
    const run = await retried([fetchFailed("ECONNRESET"), fetchFailed("ECONNRESET"), last], 2);
    await expect(run.result).rejects.toBe(last);
    expect(run.calls()).toBe(3);
    expect(run.lines).toHaveLength(2);
  });

  it("throws any other error at once", async () => {
    const failed = new Error("POST /x: 500 boom");
    const run = await retried([failed, "ok"]);
    await expect(run.result).rejects.toBe(failed);
    expect(run.calls()).toBe(1);
    expect(run.lines).toEqual([]);
  });
});
