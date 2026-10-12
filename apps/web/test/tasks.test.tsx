import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app";
import { server, serveTasks, task } from "./server";

const views = () => screen.getByRole("navigation", { name: "Project views" });

describe("the task list", () => {
  const tasks = [
    task(1, { title: "Fix login", attemptCount: 3, bestGate: "passed", mergeRequestState: "needsReview" }),
    task(2, { title: "Add search", attemptCount: 1, bestGate: "failed" }),
    task(3, { title: "Old work", state: "closed", attemptCount: 2, mergeRequestState: "merged" }),
    task(4, { title: "Migrated", state: "obsolete" }),
  ];

  it("is linked from the project header", async () => {
    server.use(...serveTasks(tasks));
    const { user, path } = await renderApp("/ada/alpha");
    await user.click(await within(views()).findByRole("link", { name: "Tasks" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tasks"));
    expect(within(views()).getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(within(views()).getByRole("link", { name: "Code" })).not.toHaveAttribute("aria-current");
  });

  it("shows open tasks by default, each with its number, title, attempts, best gate and merge request", async () => {
    server.use(...serveTasks(tasks));
    await renderApp("/ada/alpha/tasks");
    const rows = await screen.findAllByRole("row");
    const cells = rows.slice(1).map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
    expect(cells).toEqual([
      ["t1", "Fix login", "3", "Passed", "Needs review"],
      ["t2", "Add search", "1", "Failed", "—"],
    ]);
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Fix login" })).toHaveAttribute(
      "href",
      "/ada/alpha/tasks/t1",
    );
  });

  it.each([
    ["Closed", "/ada/alpha/tasks?state=closed", "Old work"],
    ["Obsolete", "/ada/alpha/tasks?state=obsolete", "Migrated"],
  ])("has a %s tab", async (tab, href, title) => {
    server.use(...serveTasks(tasks));
    const { user, path } = await renderApp("/ada/alpha/tasks");
    await screen.findByText("Fix login");
    await user.click(screen.getByRole("link", { name: tab }));
    await waitFor(() => expect(path()).toBe(href));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText("Fix login")).toBeNull();
    expect(screen.getByRole("link", { name: tab })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Open" })).not.toHaveAttribute("aria-current");
  });

  it("has an empty state", async () => {
    server.use(...serveTasks([]));
    await renderApp("/ada/alpha/tasks");
    expect(await screen.findByText("No open tasks")).toBeInTheDocument();
  });
});

describe("the New task dialog", () => {
  it("creates the task from a title and a markdown body, then opens it", async () => {
    const tasks = [task(1)];
    let body: unknown;
    server.use(
      http.post("*/api/projects/ada/alpha/tasks", async ({ request }) => {
        body = await request.json();
        const created = task(2, { title: "Add search", body: "Search *everything*." });
        tasks.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
      ...serveTasks(tasks),
    );
    const { user, path } = await renderApp("/ada/alpha/tasks");
    await user.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Title"), "Add search");
    await user.type(within(dialog).getByLabelText("Description"), "Search *everything*.");
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tasks/t2"));
    expect(body).toEqual({ title: "Add search", body: "Search *everything*." });
    expect(await screen.findByRole("heading", { name: /Add search/u })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the platform's error and stays open", async () => {
    server.use(
      http.post("*/api/projects/ada/alpha/tasks", () =>
        HttpResponse.json({ error: { code: "invalidRequest", message: "title is too long" } }, { status: 400 }),
      ),
      ...serveTasks([]),
    );
    const { user, path } = await renderApp("/ada/alpha/tasks");
    await user.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Title"), "x");
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("title is too long");
    expect(path()).toBe("/ada/alpha/tasks");
  });
});
