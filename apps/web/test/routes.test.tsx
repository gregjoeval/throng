import { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { buildPath } from "@/lib/paths";
import { getRouter } from "@/router";
import { me, project, projects, server } from "./server";

/** Renders the whole app, router and all, at `path`. */
async function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = getRouter({ history: createMemoryHistory({ initialEntries: [path] }), queryClient });
  // The root's shell renders <html>; mount at the document so it isn't nested in a <div>.
  render(<RouterProvider router={router} />, { container: document });
  await router.load();
  return { router, user: userEvent.setup(), path: () => router.state.location.href };
}

const header = () => screen.getByRole("banner");
const openSwitcher = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(within(header()).getByRole("button", { name: /select a project|\//i }));

describe("the app shell", () => {
  it("shows the signed-in user, a sign-out link to Access and the theme toggle", async () => {
    await renderApp("/");
    expect(await within(header()).findByText(me.user.handle)).toBeInTheDocument();
    expect(within(header()).getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
    expect(within(header()).getByRole("button", { name: /switch to (dark|light) theme/i })).toBeInTheDocument();
  });

  it("lists the user's projects on the home page", async () => {
    await renderApp("/");
    const links = await screen.findAllByRole("link", { name: /^ada\// });
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/ada/alpha", "/ada/beta"]);
  });

  it("has an empty state when the user has no projects", async () => {
    server.use(http.get("*/api/projects", () => HttpResponse.json({ projects: [] })));
    await renderApp("/");
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("button", { name: "Create project" })).toBeInTheDocument();
  });
});

describe("project switching", () => {
  it("lists the user's projects and opens the one picked", async () => {
    const { user, path } = await renderApp("/ada/alpha");
    expect(within(header()).getByRole("button", { name: "ada/alpha" })).toBeInTheDocument();
    await openSwitcher(user);
    await user.click(await screen.findByRole("menuitem", { name: "ada/beta" }));
    await waitFor(() => expect(path()).toBe("/ada/beta"));
    expect(await within(header()).findByRole("button", { name: "ada/beta" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "ada/beta" })).toBeInTheDocument();
  });

  it("says so when the projects can't be loaded", async () => {
    server.use(http.get("*/api/projects", () => new HttpResponse(null, { status: 502 })));
    const { user } = await renderApp("/ada/alpha");
    await openSwitcher(user);
    expect(await screen.findByRole("menuitem", { name: "Couldn't load projects" })).toBeInTheDocument();
  });
});

describe("create project", () => {
  it("creates the project from the switcher, then opens it", async () => {
    const created = project("gamma");
    let body: unknown;
    server.use(
      http.post("*/api/projects", async ({ request }) => {
        body = await request.json();
        projects.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    try {
      const { user, path } = await renderApp("/");
      await openSwitcher(user);
      await user.click(await screen.findByRole("menuitem", { name: "Create project" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Handle"), "gamma");
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(path()).toBe("/ada/gamma"));
      expect(body).toEqual({ handle: "gamma" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await openSwitcher(user);
      expect(await screen.findByRole("menuitem", { name: "ada/gamma" })).toBeInTheDocument();
    } finally {
      projects.pop();
    }
  });

  it("shows the platform's error and stays open when the handle is taken", async () => {
    server.use(
      http.post("*/api/projects", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "project ada/alpha already exists" } },
          { status: 409 },
        ),
      ),
    );
    const { user, path } = await renderApp("/");
    await user.click(await within(screen.getByRole("main")).findByRole("button", { name: "Create project" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Handle"), "alpha");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("project ada/alpha already exists");
    expect(path()).toBe("/");
  });
});

describe("views", () => {
  it.each([
    ["/ada/alpha", "The root directory at main"],
    ["/ada/alpha/tree/main", "This directory's entries"],
    ["/ada/alpha/tree/t42a3/src/lib", "This directory's entries"],
    ["/ada/alpha/blob/main/README.md", "This file's contents"],
    ["/ada/alpha/raw/main/README.md", "Open the raw file"],
    ["/ada/alpha/commits/main", "The commit log"],
    [`/ada/alpha/commit/${"a".repeat(40)}`, "The commit and its diff"],
  ])("renders %s", async (path, text) => {
    await renderApp(path);
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });

  it("decodes paths with spaces and unicode into breadcrumbs that link back", async () => {
    const path = "docs/my notes/naïve 日本語 #1.md";
    await renderApp(buildPath({ view: "blob", owner: "ada", project: "alpha", ref: "main", path }));
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByText("naïve 日本語 #1.md")).toHaveAttribute("aria-current", "page");
    expect(within(crumbs).getByRole("link", { name: "my notes" })).toHaveAttribute(
      "href",
      buildPath({ view: "tree", owner: "ada", project: "alpha", ref: "main", path: "docs/my notes" }),
    );
  });

  it("navigates through an encoded breadcrumb link to the same path", async () => {
    const { user, path } = await renderApp("/ada/alpha/blob/main/a%20%C3%A9/b%23c/d.txt");
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumbs" });
    await user.click(within(crumbs).getByRole("link", { name: "b#c" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tree/main/a%20%C3%A9/b%23c"));
    expect(await screen.findByText("This directory's entries will show here.")).toBeInTheDocument();
    const after = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(after).getByText("b#c")).toHaveAttribute("aria-current", "page");
  });

  it("keeps the attempt hint on breadcrumb links", async () => {
    await renderApp(`/ada/alpha/blob/${"b".repeat(40)}/src/a.ts?attempt=t42a3`);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByRole("link", { name: "src" })).toHaveAttribute(
      "href",
      `/ada/alpha/tree/${"b".repeat(40)}/src?attempt=t42a3`,
    );
  });
});

describe("error states", () => {
  it("shows not_found for an unknown project", async () => {
    await renderApp("/ada/nothing/tree/main");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not found");
    expect(alert).toHaveTextContent("no project ada/nothing");
  });

  it("shows forbidden when the platform refuses", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ error: { code: "forbidden", message: "not yours" } }, { status: 403 }),
      ),
    );
    await renderApp("/ada/alpha");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Forbidden");
    expect(alert).toHaveTextContent("not yours");
  });

  it("shows not_found inside the shell for a URL no route matches", async () => {
    await renderApp("/ada/alpha/settings/main");
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
    expect(header()).toBeInTheDocument();
  });

  it("shows a generic error when the platform is unreachable", async () => {
    server.use(http.get("*/api/projects", () => new HttpResponse(null, { status: 502 })));
    await renderApp("/");
    expect(await screen.findByRole("alert")).toHaveTextContent("The platform is unreachable.");
  });
});
