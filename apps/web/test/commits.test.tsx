import { screen, waitFor, within } from "@testing-library/react";
import type { InferResponseType } from "hono/client";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { client } from "@/lib/api";
import { renderApp } from "./app";
import { server } from "./server";

type Commit = InferResponseType<(typeof client.api.projects)[":owner"][":project"]["commit"][":sha"]["$get"], 200>;

const NOW = new Date("2026-10-12T12:00:00.000Z");

/** The `n`th commit of a history, its sha made of `n`'s hex digit run out to 40 characters. */
function commit(n: number, overrides: Partial<Commit> = {}): Commit {
  const sha = n.toString(16).padStart(4, "0").repeat(10);
  const date = new Date(NOW.getTime() - n * 3_600_000).toISOString();
  return {
    sha,
    tree: "f".repeat(40),
    parents: [(n + 1).toString(16).padStart(4, "0").repeat(10)],
    message: `Change number ${n}\n\nThe body of change ${n}.\n`,
    author: { name: "ada", email: "ada@example.com", date },
    committer: { name: "ada", email: "ada@example.com", date },
    ...overrides,
  };
}

/** Serves `history` from `GET /commits/:ref`, paged the way the platform pages it. */
function serveHistory(history: Commit[]) {
  const seen: URL[] = [];
  server.use(
    http.get("*/api/projects/:owner/:project/commits/:ref", ({ request, params }) => {
      const url = new URL(request.url);
      seen.push(url);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const commits = history.slice(offset, offset + limit);
      const next = offset + limit < history.length ? offset + limit : null;
      return HttpResponse.json({
        ref: String(params["ref"]),
        sha: history[0]?.sha ?? "",
        offset,
        limit,
        commits,
        next,
      });
    }),
  );
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const pages = () => screen.getByRole("navigation", { name: "Pages" });
const rows = () => within(screen.getByRole("list", { name: "Commits" })).getAllByRole("listitem");

describe("the commit log", () => {
  it("lists each commit's subject, author, relative date and short sha, linking to the commit", async () => {
    serveHistory([commit(1), commit(2)]);
    await renderApp("/ada/alpha/commits/main");
    const first = await screen.findByRole("listitem", { name: "Change number 1" });
    expect(within(first).getByRole("link", { name: "Change number 1" })).toHaveAttribute(
      "href",
      `/ada/alpha/commit/${commit(1).sha}`,
    );
    expect(first).toHaveTextContent("ada");
    expect(within(first).getByText("1 hour ago")).toHaveAttribute("dateTime", commit(1).author.date);
    expect(within(first).getByRole("link", { name: commit(1).sha.slice(0, 7) })).toBeInTheDocument();
    expect(first).not.toHaveTextContent("The body of change 1");
    expect(rows()).toHaveLength(2);
  });

  it("shows the alias an author acted under", async () => {
    serveHistory([commit(1, { author: { ...commit(1).author, name: "ada (claude)" } })]);
    await renderApp("/ada/alpha/commits/main");
    const row = await screen.findByRole("listitem", { name: "Change number 1" });
    expect(within(row).getByText("ada")).toBeInTheDocument();
    expect(within(row).getByText("claude")).toHaveAttribute("title", "Alias");
  });

  it("pages through the history with older and newer links", async () => {
    const history = Array.from({ length: 120 }, (_, i) => commit(i + 1));
    const seen = serveHistory(history);
    const { user, path } = await renderApp("/ada/alpha/commits/main");
    await screen.findByRole("listitem", { name: "Change number 1" });
    expect(rows()).toHaveLength(50);
    expect(within(pages()).queryByRole("link", { name: "Newer" })).toBeNull();

    await user.click(within(pages()).getByRole("link", { name: "Older" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/commits/main?offset=50"));
    await screen.findByRole("listitem", { name: "Change number 51" });
    expect(seen.at(-1)?.searchParams.get("offset")).toBe("50");

    await user.click(within(pages()).getByRole("link", { name: "Older" }));
    await screen.findByRole("listitem", { name: "Change number 101" });
    expect(rows()).toHaveLength(20);
    expect(within(pages()).queryByRole("link", { name: "Older" })).toBeNull();

    await user.click(within(pages()).getByRole("link", { name: "Newer" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/commits/main?offset=50"));
    await screen.findByRole("listitem", { name: "Change number 51" });
  });

  it("keeps the attempt hint on commit and page links", async () => {
    serveHistory(Array.from({ length: 60 }, (_, i) => commit(i + 1)));
    const sha = "b".repeat(40);
    await renderApp(`/ada/alpha/commits/${sha}?attempt=t42a3`);
    const row = await screen.findByRole("listitem", { name: "Change number 1" });
    expect(within(row).getByRole("link", { name: "Change number 1" })).toHaveAttribute(
      "href",
      `/ada/alpha/commit/${commit(1).sha}?attempt=t42a3`,
    );
    expect(screen.getByRole("link", { name: "Older" })).toHaveAttribute(
      "href",
      `/ada/alpha/commits/${sha}?attempt=t42a3&offset=50`,
    );
  });

  it("says so when the ref has no commits", async () => {
    serveHistory([]);
    await renderApp("/ada/alpha/commits/main");
    expect(await screen.findByText("No commits yet")).toBeInTheDocument();
  });

  it("shows notFound for an unknown ref", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project/commits/:ref", () =>
        HttpResponse.json({ error: { code: "notFound", message: "no ref nope" } }, { status: 404 }),
      ),
    );
    await renderApp("/ada/alpha/commits/nope");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not found");
    expect(alert).toHaveTextContent("no ref nope");
  });
});
