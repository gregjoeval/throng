import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app";
import { bob, me, project, server } from "./server";

const views = () => screen.getByRole("navigation", { name: "Project views" });

const WARNING =
  "Runs of code you or your agents push will hold this. Prefer a token scoped to a separate preview account.";

interface Secret {
  name: string;
  pipelines: ("default" | "main")[];
  changedAt: string;
}

interface SecretUse {
  name: string;
  steps: string[];
  hasValue: boolean;
  notAllowedIn: ("default" | "main")[];
}

/**
 * Serves `ada/alpha`'s secrets from `secrets`, applying each PUT and DELETE to it as the platform
 * would, and recording every write's method, name and body in `writes`; `uses` are where main's config names them.
 */
function serveSecrets(
  secrets: Secret[],
  writes: { method: string; name: string; body: unknown }[] = [],
  uses: SecretUse[] = [],
) {
  const path = "*/api/projects/ada/alpha/secrets";
  return [
    http.get(path, () => HttpResponse.json({ secrets, uses })),
    http.put(`${path}/:name`, async ({ params, request }) => {
      const name = String(params["name"]);
      const body = (await request.json()) as { value?: string; pipelines?: Secret["pipelines"] };
      writes.push({ method: "PUT", name, body });
      const found = secrets.find((s) => s.name === name);
      const changed = { name, pipelines: body.pipelines ?? found?.pipelines ?? [], changedAt: "2026-10-12T09:00:00Z" };
      if (found === undefined) secrets.push(changed);
      else Object.assign(found, changed);
      return HttpResponse.json(changed);
    }),
    http.delete(`${path}/:name`, ({ params }) => {
      const name = String(params["name"]);
      writes.push({ method: "DELETE", name, body: null });
      secrets.splice(
        secrets.findIndex((s) => s.name === name),
        1,
      );
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

const deployToken = (): Secret => ({ name: "DEPLOY_TOKEN", pipelines: ["main"], changedAt: "2026-10-11T08:00:00Z" });

describe("the settings tab", () => {
  it("shows to the project owner and opens the settings", async () => {
    server.use(...serveSecrets([]));
    const { user, path } = await renderApp("/ada/alpha");
    await user.click(await within(views()).findByRole("link", { name: "Settings" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/settings"));
    expect(within(views()).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  it("is hidden from everyone else, and the page says why", async () => {
    server.use(http.get("*/api/projects/bob/gamma", () => HttpResponse.json(project("gamma", { ...me.user, ...bob }))));
    await renderApp("/bob/gamma");
    await within(views()).findByRole("link", { name: "Tasks" });
    expect(within(views()).queryByRole("link", { name: "Settings" })).toBeNull();
    await renderApp("/bob/gamma/settings");
    expect(await screen.findByText("Only the project owner can see its settings.")).toBeInTheDocument();
  });
});

describe("the secrets settings", () => {
  it("shows where main's config names each secret, and flags one with no value or not allowed there", async () => {
    const uses: SecretUse[] = [
      { name: "DEPLOY_TOKEN", steps: ["check preview", "check smoke"], hasValue: true, notAllowedIn: ["default"] },
      { name: "SENTRY_TOKEN", steps: ["setup deps"], hasValue: false, notAllowedIn: [] },
    ];
    const npm: Secret = { name: "NPM_TOKEN", pipelines: [], changedAt: "2026-10-11T08:00:00Z" };
    server.use(...serveSecrets([deployToken(), npm], [], uses));
    await renderApp("/ada/alpha/settings");
    const rows = await screen.findAllByRole("row");
    const named = (row: number) => within(rows[row] as HTMLElement).getAllByRole("cell")[3];
    expect(named(1)).toHaveTextContent("check preview, check smoke");
    expect(named(1)).toHaveTextContent("Not allowed in default: runs there fail");
    expect(named(2)).toHaveTextContent("Not named");
    const unset = screen.getByRole("alert");
    expect(unset).toHaveTextContent("main's config names secrets with no value. Runs naming them fail.");
    expect(unset).toHaveTextContent("SENTRY_TOKEN, named by setup deps");
  });

  it("lists each secret's name, pipelines and last change, never a value", async () => {
    server.use(
      ...serveSecrets([deployToken(), { name: "NPM_TOKEN", pipelines: [], changedAt: "2026-10-11T08:00:00Z" }]),
    );
    await renderApp("/ada/alpha/settings");
    const rows = await screen.findAllByRole("row");
    expect(rows.slice(1).map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "DEPLOY_TOKEN",
      "NPM_TOKEN",
    ]);
    expect(within(rows[1] as HTMLElement).getAllByRole("cell")[1]).toHaveTextContent("main");
    expect(within(rows[2] as HTMLElement).getAllByRole("cell")[1]).toHaveTextContent("No pipeline");
    expect(within(rows[1] as HTMLElement).getByRole("time")).toHaveAttribute("dateTime", "2026-10-11T08:00:00Z");
  });

  it("adds a secret with its value and pipelines", async () => {
    const secrets: Secret[] = [];
    const writes: { method: string; name: string; body: unknown }[] = [];
    server.use(...serveSecrets(secrets, writes));
    const { user } = await renderApp("/ada/alpha/settings");
    await user.click(await screen.findByRole("button", { name: "New secret" }));
    const form = screen.getByRole("form", { name: "New secret" });
    await user.type(within(form).getByLabelText("Name"), "DEPLOY_TOKEN");
    const value = within(form).getByLabelText("Value");
    expect(value).toHaveAttribute("type", "password");
    await user.type(value, "cf-token-0123456789");
    await user.click(within(form).getByRole("checkbox", { name: "main" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", name: "DEPLOY_TOKEN", body: { value: "cf-token-0123456789", pipelines: ["main"] } },
      ]),
    );
    expect(await screen.findByRole("cell", { name: "DEPLOY_TOKEN" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New secret" })).toBeNull();
    expect(screen.queryByText("cf-token-0123456789")).toBeNull();
  });

  it("warns, without blocking, when a change allows a secret in default", async () => {
    const writes: { method: string; name: string; body: unknown }[] = [];
    server.use(...serveSecrets([deployToken()], writes));
    const { user } = await renderApp("/ada/alpha/settings");
    await user.click(await screen.findByRole("button", { name: "Edit DEPLOY_TOKEN" }));
    const form = screen.getByRole("form", { name: "Edit DEPLOY_TOKEN" });
    expect(within(form).queryByText(WARNING)).toBeNull();
    await user.click(within(form).getByRole("checkbox", { name: "default" }));
    expect(within(form).getByText(WARNING)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes).toEqual([{ method: "PUT", name: "DEPLOY_TOKEN", body: { pipelines: ["default", "main"] } }]),
    );
  });

  it("doesn't warn again when a secret already allowed in default changes", async () => {
    server.use(...serveSecrets([{ ...deployToken(), pipelines: ["default", "main"] }]));
    const { user } = await renderApp("/ada/alpha/settings");
    await user.click(await screen.findByRole("button", { name: "Edit DEPLOY_TOKEN" }));
    const form = screen.getByRole("form", { name: "Edit DEPLOY_TOKEN" });
    await user.type(within(form).getByLabelText("New value"), "cf-token-replaced");
    expect(within(form).queryByText(WARNING)).toBeNull();
  });

  it("replaces a secret's value, keeping its pipelines", async () => {
    const writes: { method: string; name: string; body: unknown }[] = [];
    server.use(...serveSecrets([deployToken()], writes));
    const { user } = await renderApp("/ada/alpha/settings");
    await user.click(await screen.findByRole("button", { name: "Edit DEPLOY_TOKEN" }));
    const form = screen.getByRole("form", { name: "Edit DEPLOY_TOKEN" });
    expect(within(form).getByLabelText("New value")).toHaveValue("");
    await user.type(within(form).getByLabelText("New value"), "cf-token-replaced");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        { method: "PUT", name: "DEPLOY_TOKEN", body: { value: "cf-token-replaced", pipelines: ["main"] } },
      ]),
    );
  });

  it("shows the platform's refusal", async () => {
    server.use(
      http.put("*/api/projects/ada/alpha/secrets/:name", () =>
        HttpResponse.json(
          { error: { code: "invalidRequest", message: "a secret's value must be 8 to 65536 characters long" } },
          { status: 400 },
        ),
      ),
      ...serveSecrets([]),
    );
    const { user } = await renderApp("/ada/alpha/settings");
    await user.click(await screen.findByRole("button", { name: "New secret" }));
    const form = screen.getByRole("form", { name: "New secret" });
    await user.type(within(form).getByLabelText("Name"), "SHORT");
    await user.type(within(form).getByLabelText("Value"), "short");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("must be 8 to 65536 characters");
  });

  it("deletes a secret once confirmed", async () => {
    const writes: { method: string; name: string; body: unknown }[] = [];
    server.use(...serveSecrets([deployToken()], writes));
    const { user } = await renderApp("/ada/alpha/settings");
    await user.click(await screen.findByRole("button", { name: "Delete DEPLOY_TOKEN" }));
    expect(writes).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Confirm delete DEPLOY_TOKEN" }));
    await waitFor(() => expect(writes).toEqual([{ method: "DELETE", name: "DEPLOY_TOKEN", body: null }]));
    expect(await screen.findByText("No secrets yet")).toBeInTheDocument();
  });
});
