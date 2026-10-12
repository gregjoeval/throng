import { QueryClient } from "@tanstack/react-query";
import { DetailedError } from "hono/client";
import { http, HttpResponse } from "msw";
import { describe, expect, expectTypeOf, it } from "vitest";
import { apiQuery, client, meQuery } from "@/lib/api";
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
    const error = { error: { code: "unauthorized", message: "no session" } };
    server.use(http.get("*/api/me", () => HttpResponse.json(error, { status: 401 })));
    const failure = await query()
      .fetchQuery(apiQuery(["me", "failing"], (init) => client.api.me.$get(undefined, { init })))
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DetailedError);
    expect(failure).toMatchObject({ statusCode: 401, detail: { data: error } });
  });
});
