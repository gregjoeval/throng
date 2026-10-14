import { QueryClient } from "@tanstack/react-query";
import type { RunStatus } from "@throng/platform/run-status";
import { DetailedError } from "hono/client";
import { http, HttpResponse } from "msw";
import { describe, expect, expectTypeOf, it } from "vitest";
import { apiQuery, client, meQuery, RUN_POLL_MS, runQuery } from "@/lib/api";
import { me, server } from "./server";

const query = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("the hc client", () => {
  it("is typed by the platform's routes", () => {
    expectTypeOf(client.api.me.$get).toBeFunction();
    expectTypeOf<Awaited<ReturnType<NonNullable<typeof meQuery.queryFn>>>>().toEqualTypeOf<typeof me>();
    // @ts-expect-error: the platform has no such route.
    void client.api.nope;
  });

  it("calls same-origin /api through the global fetch", async () => {
    let seen: URL | undefined;
    server.use(
      http.get("*/api/me", ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(me);
      }),
    );
    expect(await query().fetchQuery(meQuery)).toEqual(me);
    expect(seen?.pathname).toBe("/api/me");
  });
});

describe("apiQuery", () => {
  it("rejects with the status and error body on a failure", async () => {
    const body = { error: { code: "unauthorized", message: "no session" } };
    server.use(http.get("*/api/me", () => HttpResponse.json(body, { status: 401 })));
    const failure = await query()
      .fetchQuery(apiQuery(["me", "failing"], (init) => client.api.me.$get(undefined, { init })))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DetailedError);
    expect(failure).toMatchObject({ statusCode: 401, detail: { data: body } });
  });
});

/** How often a run with `status` is polled, or false once it isn't. */
const pollInterval = (status: RunStatus) =>
  runQuery({ owner: "ada", project: "alpha" }, 7).refetchInterval({ state: { data: { status } } });

describe("a run's polling", () => {
  it("stops once the run ended, and goes on while it waits for the owner, who may start it elsewhere", () => {
    for (const status of ["done", "cancelled", "errored"] as const) expect(pollInterval(status), status).toBeFalsy();
    for (const status of ["queued", "waiting", "running"] as const) {
      expect(pollInterval(status), status).toBe(RUN_POLL_MS);
    }
  });
});
