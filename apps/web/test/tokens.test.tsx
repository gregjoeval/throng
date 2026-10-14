import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Token } from "@/lib/api";
import { renderApp } from "./app";
import { server } from "./server";

const PLAINTEXT = "thr_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const PLATFORM_URL = "https://throng.example";
const DAY = 24 * 60 * 60;

/**
 * Serves the signed-in user's `tokens`, applying each mint and revoke to them as the platform would,
 * and recording every mint's body in `mints`.
 */
function serveTokens(tokens: Token[], mints: unknown[] = []) {
  return [
    http.get("*/api/tokens", () => HttpResponse.json({ tokens })),
    http.post("*/api/tokens", async ({ request }) => {
      const body = (await request.json()) as { alias: string | null; expiresIn: number };
      mints.push(body);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + body.expiresIn * 1000).toISOString();
      const token: Token = { id: `tok${tokens.length + 1}`, alias: body.alias, expiresAt, revokedAt: null, createdAt };
      tokens.unshift(token);
      return HttpResponse.json({ ...token, token: PLAINTEXT, url: PLATFORM_URL }, { status: 201 });
    }),
    http.delete("*/api/tokens/:id", ({ params }) => {
      const found = tokens.find((t) => t.id === params["id"]);
      if (found === undefined)
        return HttpResponse.json({ error: { code: "notFound", message: "no such token" } }, { status: 404 });
      found.revokedAt = new Date().toISOString();
      return HttpResponse.json(found);
    }),
  ];
}

const mintForm = () => screen.getByRole("form", { name: "New token" });

describe("the tokens page", () => {
  it("opens from the header", async () => {
    server.use(...serveTokens([]));
    const { user, path } = await renderApp("/");
    await user.click(await screen.findByRole("link", { name: "Tokens" }));
    await waitFor(() => expect(path()).toBe("/tokens"));
    expect(await screen.findByRole("heading", { name: "Tokens" })).toBeInTheDocument();
  });

  it("mints a token for claude for a day by default, and shows it with the setup to paste", async () => {
    const mints: unknown[] = [];
    server.use(...serveTokens([], mints));
    const { user } = await renderApp("/tokens");
    expect(within(mintForm()).getByLabelText("Alias")).toHaveValue("claude");
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    await waitFor(() => expect(mints).toEqual([{ alias: "claude", expiresIn: DAY }]));
    const minted = await screen.findByRole("region", { name: "Your new token" });
    expect(within(minted).getByText("It won't be shown again: copy it now.")).toBeInTheDocument();
    expect(within(minted).getByText(PLAINTEXT)).toBeInTheDocument();
    expect(
      within(minted).getByText(
        `claude mcp add --transport http throng ${PLATFORM_URL}/mcp --header "Authorization: Bearer ${PLAINTEXT}"`,
      ),
    ).toBeInTheDocument();
    expect(within(minted).getByText(`${PLATFORM_URL}/llms.txt`)).toBeInTheDocument();
    const json = within(minted).getByText(/"mcpServers"/u).textContent ?? "";
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        throng: { type: "http", url: `${PLATFORM_URL}/mcp`, headers: { Authorization: `Bearer ${PLAINTEXT}` } },
      },
    });
  });

  it("copies the token", async () => {
    server.use(...serveTokens([]));
    const { user } = await renderApp("/tokens");
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    const minted = await screen.findByRole("region", { name: "Your new token" });
    await user.click(within(minted).getByRole("button", { name: "Copy Token" }));
    expect(await navigator.clipboard.readText()).toBe(PLAINTEXT);
    expect(within(minted).getByRole("button", { name: "Copy Token" })).toHaveTextContent("Copied");
  });

  it("shows the token only once: not after leaving the page and coming back", async () => {
    server.use(...serveTokens([]));
    const { user, router } = await renderApp("/tokens");
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    expect(await screen.findByText(PLAINTEXT)).toBeInTheDocument();
    await router.navigate({ to: "/" });
    await router.navigate({ to: "/tokens" });
    expect(await screen.findByRole("form", { name: "New token" })).toBeInTheDocument();
    expect(screen.queryByText(PLAINTEXT)).toBeNull();
    expect(screen.queryByRole("region", { name: "Your new token" })).toBeNull();
  });

  it("shows the token only once: not after a reload", async () => {
    server.use(...serveTokens([]));
    const { user } = await renderApp("/tokens");
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    expect(await screen.findByText(PLAINTEXT)).toBeInTheDocument();
    cleanup();
    await renderApp("/tokens");
    expect(await screen.findByRole("row", { name: /claude/u })).toBeInTheDocument();
    expect(screen.queryByText(PLAINTEXT)).toBeNull();
  });

  it("mints for the user themselves when the alias is empty, for the days chosen", async () => {
    const mints: unknown[] = [];
    server.use(...serveTokens([], mints));
    const { user } = await renderApp("/tokens");
    await user.clear(within(mintForm()).getByLabelText("Alias"));
    const days = within(mintForm()).getByLabelText("Expires in (days)");
    await user.clear(days);
    await user.type(days, "7");
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    await waitFor(() => expect(mints).toEqual([{ alias: null, expiresIn: 7 * DAY }]));
  });

  it("shows the platform's refusal", async () => {
    server.use(
      http.post("*/api/tokens", () =>
        HttpResponse.json(
          { error: { code: "invalidRequest", message: "alias must be printable text" } },
          { status: 400 },
        ),
      ),
      ...serveTokens([]),
    );
    const { user } = await renderApp("/tokens");
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    expect(await within(mintForm()).findByRole("alert")).toHaveTextContent("alias must be printable text");
  });
});

/** A token minted on 2026-10-10 that expires in a year, unless `fields` say otherwise. */
const token = (id: string, fields: Partial<Token> = {}): Token => ({
  id,
  alias: "claude",
  createdAt: "2026-10-10T12:00:00.000Z",
  expiresAt: "2099-10-10T12:00:00.000Z",
  revokedAt: null,
  ...fields,
});

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

describe("the tokens list", () => {
  it("lists each token's alias, creation, expiry and status, never a plaintext", async () => {
    server.use(
      ...serveTokens([
        token("a"),
        token("b", { alias: null }),
        token("c", { expiresAt: "2026-10-11T12:00:00.000Z" }),
        token("d", { revokedAt: "2026-10-10T13:00:00.000Z" }),
      ]),
    );
    await renderApp("/tokens");
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows.map((row) => [cells(row)[0], cells(row)[3]])).toEqual([
      ["claude", "Active"],
      ["You", "Active"],
      ["claude", "Expired"],
      ["claude", "Revoked"],
    ]);
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole("time")
        .map((t) => t.getAttribute("dateTime")),
    ).toEqual(["2026-10-10T12:00:00.000Z", "2099-10-10T12:00:00.000Z"]);
    expect(screen.queryByText(/thr_/u)).toBeNull();
  });

  it("offers no revoke for a token that already can't be used", async () => {
    server.use(
      ...serveTokens([
        token("c", { expiresAt: "2026-10-11T12:00:00.000Z" }),
        token("d", { revokedAt: "2026-10-10T13:00:00.000Z" }),
      ]),
    );
    await renderApp("/tokens");
    await screen.findAllByRole("row");
    expect(screen.queryByRole("button", { name: /^Revoke/u })).toBeNull();
  });

  it("lists a newly minted token", async () => {
    server.use(...serveTokens([]));
    const { user } = await renderApp("/tokens");
    expect(await screen.findByText("No tokens yet")).toBeInTheDocument();
    await user.click(within(mintForm()).getByRole("button", { name: "Mint token" }));
    const rows = await screen.findAllByRole("row");
    expect(within(rows[1] as HTMLElement).getAllByRole("cell")[0]).toHaveTextContent("claude");
  });

  it("revokes a token once confirmed", async () => {
    const tokens = [token("a")];
    server.use(...serveTokens(tokens));
    const { user } = await renderApp("/tokens");
    await user.click(await screen.findByRole("button", { name: "Revoke claude token a" }));
    expect(tokens[0]?.revokedAt).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm revoke claude token a" }));
    const row = (await screen.findAllByRole("row"))[1] as HTMLElement;
    await waitFor(() => expect(within(row).getAllByRole("cell")[3]).toHaveTextContent("Revoked"));
    expect(tokens[0]?.revokedAt).not.toBeNull();
  });
});
