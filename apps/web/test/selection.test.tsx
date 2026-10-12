// Selection from the arena and the single-attempt view, and the merge request view that follows it.

import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ArenaAttempt } from "@/lib/arena";
import { renderApp } from "./app";
import { addedFile, arenaAttempt, bob, me, result, serveArena, serveCompare, server, task } from "./server";

const passing = (n: number, fields: Partial<ArenaAttempt> = {}) =>
  arenaAttempt(1, n, { status: "done", result: result(), ...fields });

/** Every selection the platform was asked for, as `t1:t1a2`. */
function serveSelection(asked: string[]) {
  return http.post("*/api/projects/:owner/:project/tasks/:t/selection", async ({ params, request }) => {
    const { attempt } = (await request.json()) as { attempt: string };
    asked.push(`${String(params["t"])}:${attempt}`);
    return HttpResponse.json({});
  });
}

const lane = (ref: string) => screen.getByRole("region", { name: `Lane ${ref}` });
const rail = () => screen.getByRole("list", { name: "Attempts" });

describe("selecting an attempt in the arena", () => {
  it("asks inline from a lane, naming how many attempts will be archived and the task branch, then selects", async () => {
    const asked: string[] = [];
    server.use(
      serveSelection(asked),
      serveCompare((to) => [addedFile(`${to.slice(0, 2)}.txt`)]),
      ...serveArena(task(1, { taskBranch: { sha: "7".repeat(40), commits: 3 } }), [passing(1), passing(2), passing(3)]),
    );
    const { user } = await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Lanes" });

    await user.click(within(lane("t1a2")).getByRole("button", { name: "Select" }));
    const confirm = within(lane("t1a2")).getByRole("group", { name: "Confirm selection" });
    expect(confirm).toHaveTextContent(
      "Select t1a2? The other 2 attempts will be closed and archived. The task branch (3 commits) lands with it.",
    );
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(lane("t1a2")).queryByRole("group", { name: "Confirm selection" })).toBeNull();
    expect(asked).toEqual([]);

    await user.click(within(lane("t1a2")).getByRole("button", { name: "Select" }));
    await user.click(within(lane("t1a2")).getByRole("button", { name: "Select t1a2" }));
    await expect.poll(() => asked).toEqual(["t1:t1a2"]);
  });

  it("selects from a rail card too, without toggling its lane", async () => {
    const asked: string[] = [];
    server.use(
      serveSelection(asked),
      serveCompare(() => []),
      ...serveArena(task(1), [passing(1), passing(2), passing(3)]),
    );
    const { user } = await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Lanes" });
    const item = within(rail()).getByRole("button", { name: "t1a3" }).closest("li") as HTMLElement;

    await user.click(within(item).getByRole("button", { name: "Select" }));
    expect(within(item).getByRole("group", { name: "Confirm selection" })).toHaveTextContent(
      "Select t1a3? The other 2 attempts will be closed and archived.",
    );
    expect(within(item).getByRole("group", { name: "Confirm selection" })).not.toHaveTextContent("task branch");
    expect(within(rail()).getByRole("button", { name: "t1a3" })).toHaveAttribute("aria-pressed", "false");
    await user.click(within(item).getByRole("button", { name: "Select t1a3" }));
    await expect.poll(() => asked).toEqual(["t1:t1a3"]);
  });

  it("offers Select only to the task's creator and the project owner", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "p", handle: "alpha", owner: bob, createdAt: "2026-10-10T12:00:00.000Z" }),
      ),
      serveCompare(() => []),
      ...serveArena(task(1, { creator: bob }), [passing(1), passing(2)]),
    );
    await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Lanes" });
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
  });

  it("shows why the platform refused", async () => {
    server.use(
      http.post("*/api/projects/:owner/:project/tasks/:t/selection", () =>
        HttpResponse.json({ error: { code: "invalidState", message: "t1a1 isn't open" } }, { status: 409 }),
      ),
      serveCompare(() => []),
      ...serveArena(task(1), [passing(1), passing(2)]),
    );
    const { user } = await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Lanes" });
    await user.click(within(lane("t1a1")).getByRole("button", { name: "Select" }));
    await user.click(within(lane("t1a1")).getByRole("button", { name: "Select t1a1" }));
    expect(await within(lane("t1a1")).findByRole("alert")).toHaveTextContent("t1a1 isn't open");
  });
});

describe("the closed attempts group", () => {
  it("lets an attempt's author reopen it, after a cancelled merge request closed it", async () => {
    const reopened: string[] = [];
    server.use(
      http.post("*/api/projects/:owner/:project/attempts/:a/reopen", ({ params }) => {
        reopened.push(String(params["a"]));
        return HttpResponse.json({});
      }),
      serveCompare(() => []),
      ...serveArena(task(1), [
        passing(1),
        passing(2),
        arenaAttempt(1, 3, { state: "closed", author: { id: me.user.id, handle: "ada" } }),
        arenaAttempt(1, 4, { state: "closed" }),
      ]),
    );
    const { user } = await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Lanes" });
    const closed = screen.getByRole("list", { name: "Closed attempts", hidden: true });
    await user.click(screen.getByText("Closed (2)"));
    const [mine, bobs] = within(closed).getAllByRole("listitem");
    expect(within(bobs as HTMLElement).queryByRole("button", { name: "Reopen" })).toBeNull();
    await user.click(within(mine as HTMLElement).getByRole("button", { name: "Reopen" }));
    await expect.poll(() => reopened).toEqual(["t1a3"]);
  });
});

describe("merging the one attempt", () => {
  it("asks inline, then selects it", async () => {
    const asked: string[] = [];
    server.use(
      serveSelection(asked),
      serveCompare(() => []),
      ...serveArena(task(1), [passing(1)]),
    );
    const { user } = await renderApp("/ada/alpha/tasks/t1");
    const view = await screen.findByTestId("single-attempt-view");

    await user.click(within(view).getByRole("button", { name: "Merge" }));
    expect(within(view).getByRole("group", { name: "Confirm selection" })).toHaveTextContent("Merge t1a1?");
    await user.click(within(view).getByRole("button", { name: "Merge t1a1" }));
    await expect.poll(() => asked).toEqual(["t1:t1a1"]);
  });
});
