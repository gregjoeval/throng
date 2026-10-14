import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Attempt, ListedTask } from "@/lib/tasks";
import { renderApp } from "./app";
import { attempt, BASE, bob, me, runDetail, server, serveTasks, task } from "./server";

const SHA = "c0ffee".padEnd(40, "0");
const ARCHIVED = "a1".padEnd(40, "0");

/** Opens `t1` of `ada/alpha`, served with `attempts`. */
async function openTask(t1: ListedTask, attempts: Attempt[] = []) {
  server.use(...serveTasks([t1], attempts));
  const rendered = await renderApp("/ada/alpha/tasks/t1");
  await screen.findByRole("heading", { name: new RegExp(t1.title, "u") });
  return rendered;
}

const body = () => screen.getByRole("region", { name: "Task body" });

/** Serves t1's merge request from t1a2, approved by `me`, with `fields` over a pending one. */
function serveMergeRequest(fields: Record<string, unknown>) {
  server.use(
    http.get("*/api/projects/:owner/:project/tasks/:t/merge-request", () =>
      HttpResponse.json({
        task: "t1",
        attempt: "t1a2",
        state: "pending",
        approvedHead: SHA,
        approvedBy: { ...me.user, alias: null },
        approvedAt: me.user.createdAt,
        queuedAt: null,
        position: null,
        lastDequeue: null,
        mergeSha: null,
        mergedAt: null,
        createdAt: me.user.createdAt,
        createdBy: { ...me.user, alias: null },
        ...fields,
      }),
    ),
  );
}

describe("the task page header", () => {
  it("shows the title, number, state, creator, the rendered body and the attempts' remotes", async () => {
    const t1 = task(1, { title: "Fix login", body: "Login *fails* on Safari." });
    await openTask(t1, [attempt(1, 1), attempt(1, 2, { state: "open" }), attempt(1, 3, { state: "closed" })]);
    const heading = screen.getByRole("heading", { name: /Fix login/u });
    expect(heading).toHaveTextContent("t1");
    expect(screen.getByText("Open", { selector: "[data-slot=task-state]" })).toBeInTheDocument();
    expect(screen.getByText(/opened by/u)).toHaveTextContent("opened by ada");
    expect(await screen.findByText("fails", { selector: "em" })).toBeInTheDocument();
    const remotes = screen.getByRole("list", { name: "Attempt remotes" });
    expect(
      within(remotes)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["t1a1/git/ada/alpha/t1a1.git", "t1a2/git/ada/alpha/t1a2.git"]);
  });

  it("lets the body collapse", async () => {
    const { user } = await openTask(task(1, { body: "Some *detail*." }));
    const toggle = screen.getByRole("button", { name: "Description" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("detail")).toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("detail")).toBeNull();
  });

  it("shows notFound for an unknown task", async () => {
    server.use(...serveTasks([]));
    await renderApp("/ada/alpha/tasks/t9");
    expect(await screen.findByRole("alert")).toHaveTextContent("no task t9");
  });
});

describe("the task page body", () => {
  it("explains how to start an attempt when there are no active attempts", async () => {
    await openTask(task(1), [attempt(1, 1, { state: "closed" })]);
    expect(within(body()).getByText("No active attempts")).toBeInTheDocument();
    expect(within(body()).getByText(/start_attempts/u)).toBeInTheDocument();
    expect(within(body()).getByText(/git push \S+\/git\/ada\/alpha\.git HEAD:t1\/my-change/u)).toBeInTheDocument();
  });

  it("shows the single-attempt view for one active attempt", async () => {
    await openTask(task(1), [attempt(1, 1, { state: "open" }), attempt(1, 2, { state: "closed" })]);
    const view = await within(body()).findByTestId("single-attempt-view");
    expect(within(view).getAllByRole("region", { name: /^Lane /u })).toHaveLength(1);
    expect(within(view).getByRole("region", { name: "Lane t1a1" })).toBeInTheDocument();
  });

  it("shows the arena for two or more active attempts", async () => {
    await openTask(task(1), [attempt(1, 1), attempt(1, 2, { state: "open" })]);
    const arena = await within(body()).findByTestId("arena");
    expect(within(arena).getByRole("list", { name: "Attempts" })).toHaveTextContent(/t1a1.*t1a2/u);
  });

  it("shows the merge request view while a merge request is open", async () => {
    const source = attempt(1, 2, { state: "open", mergeRequest: { state: "queued", lastDequeue: null } });
    serveMergeRequest({ state: "queued", queuedAt: me.user.createdAt, position: 1 });
    await openTask(task(1), [attempt(1, 1, { state: "closed" }), source]);
    const view = await within(body()).findByTestId("merge-request-view");
    expect(within(view).getByRole("region", { name: "Lane t1a2" })).toBeInTheDocument();
  });

  it("goes back to the attempts once the merge request is cancelled, where the closed ones can be reopened", async () => {
    const source = attempt(1, 1, { state: "open", mergeRequest: { state: "cancelled", lastDequeue: null } });
    const reopened: string[] = [];
    server.use(
      http.post("*/api/projects/:owner/:project/attempts/:a/reopen", ({ params }) => {
        reopened.push(String(params["a"]));
        return HttpResponse.json(attempt(1, 2, { author: me.user, state: "draft" }));
      }),
    );
    const { user } = await openTask(task(1), [source, attempt(1, 2, { author: me.user, state: "closed" })]);
    const view = await within(body()).findByTestId("single-attempt-view");
    const closed = within(view).getByRole("list", { name: "Closed attempts", hidden: true });
    await user.click(within(view).getByText("Closed (1)"));
    await user.click(await within(closed).findByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(reopened).toEqual(["t1a2"]));
  });

  it("lists closed attempts to reopen when no attempt is active", async () => {
    await openTask(task(1), [attempt(1, 1, { state: "closed" })]);
    expect(within(body()).getByRole("list", { name: "Closed attempts", hidden: true })).toHaveTextContent("t1a1");
  });

  it("summarises a closed task: its merged merge request, merge commit and archived attempts", async () => {
    serveMergeRequest({ state: "merged", mergeSha: SHA, mergedAt: me.user.createdAt });
    const merged = attempt(1, 2, {
      state: "merged",
      mergedSha: SHA,
      mergeRequest: { state: "merged", lastDequeue: null },
    });
    await openTask(task(1, { state: "closed", closedBy: bob }), [
      attempt(1, 1, { state: "closed", archivedSha: ARCHIVED }),
      merged,
    ]);
    expect(await within(body()).findByRole("status", { name: "Merge request state" })).toHaveTextContent(
      `Merged as ${SHA.slice(0, 7)}.`,
    );
    expect(body()).toHaveTextContent(`Approved ${SHA.slice(0, 7)} by ${me.user.handle}`);
    expect(body()).toHaveTextContent(`t1a2 was merged in ${SHA.slice(0, 7)}.`);
    expect(within(body()).getByRole("link", { name: SHA.slice(0, 7) })).toHaveAttribute(
      "href",
      `/ada/alpha/commit/${SHA}`,
    );
    expect(within(body()).getByRole("link", { name: "t1a1" })).toHaveAttribute("href", `/ada/alpha/tree/${ARCHIVED}`);
  });

  it("shows the task branch's latest runs beside a merged merge request's banner, each linking to its page", async () => {
    const asked: string[] = [];
    serveMergeRequest({ state: "merged", mergeSha: SHA, mergedAt: me.user.createdAt });
    server.use(
      http.get("*/api/projects/:owner/:project/runs", ({ request }) => {
        asked.push(new URL(request.url).search);
        const { error: _e, outcome: _o, result: _r, ...run } = runDetail(9, SHA, { line: "t1" });
        const older = { ...run, id: 8, status: "cancelled" as const, gate: null, superseded: true };
        return HttpResponse.json({ runs: [run, older], next: null });
      }),
    );
    await openTask(task(1, { state: "closed", closedBy: bob }), [
      attempt(1, 2, { state: "merged", mergedSha: SHA, mergeRequest: { state: "merged", lastDequeue: null } }),
    ]);
    const runs = await within(body()).findByRole("region", { name: "Task branch runs" });
    // It asks only for the few it shows.
    expect(asked).toContain("?line=t1&limit=3");
    expect(within(runs).getByRole("listitem", { name: "Run 9" })).toHaveTextContent(
      `Run 9${SHA.slice(0, 7)}DoneGate passed`,
    );
    expect(within(runs).getByRole("listitem", { name: "Run 8" })).toHaveAttribute("data-superseded", "true");
    expect(within(runs).getByRole("link", { name: "Run 9" })).toHaveAttribute("href", "/ada/alpha/runs/9");
    expect(within(runs).getByRole("link", { name: "All runs on t1" })).toHaveAttribute(
      "href",
      "/ada/alpha/runs?line=t1",
    );
  });

  it("shows the task's runs waiting for the owner, with their secrets, head, diff and Start", async () => {
    const started: unknown[] = [];
    /** A waiting run on `line`, whose head is on attempt `on`, as the runs list gives it. */
    const waiting = (id: number, line: string, on: string | null) => {
      const {
        error: _e,
        outcome: _o,
        result: _r,
        ...run
      } = runDetail(id, SHA, {
        line,
        status: "waiting",
        gate: null,
        ...(line === "main" ? { sha: null, pipeline: "main" as const, trigger: "merge" as const } : {}),
        waiting: { head: SHA, attempt: on, base: line === "main" ? null : BASE, secrets: ["DEPLOY"], taskCheck: null },
      });
      return run;
    };
    server.use(
      http.get("*/api/projects/:owner/:project/runs", () =>
        HttpResponse.json({
          runs: [
            waiting(7, "t1a2", "t1a2"),
            waiting(6, "t2a1", "t2a1"),
            waiting(5, "main", "t1a2"),
            waiting(4, "t1", null),
          ],
          next: null,
        }),
      ),
      http.post("*/api/projects/:owner/:project/runs/:id/start", async ({ params, request }) => {
        started.push({ id: params["id"], ...((await request.json()) as object) });
        return HttpResponse.json(runDetail(7, SHA, { status: "queued" }));
      }),
    );
    const { user } = await openTask(task(1), [attempt(1, 2, { state: "open" })]);
    const list = await screen.findByRole("region", { name: "Waiting for the owner" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Run 7", "Run 5", "Run 4"]);
    const item = within(list).getByRole("listitem", { name: "Run 7" });
    expect(item).toHaveTextContent(`Run 7t1a2${SHA.slice(0, 7)}DiffSecrets: DEPLOY`);
    expect(within(item).getByRole("link", { name: "Diff" })).toHaveAttribute(
      "href",
      `/ada/alpha/compare/${BASE}...${SHA}?attempt=t1a2`,
    );
    const diff = (id: number) =>
      within(within(list).getByRole("listitem", { name: `Run ${id}` })).getByRole("link", { name: "Diff" });
    expect(diff(4)).toHaveAttribute("href", `/ada/alpha/compare/${BASE}...${SHA}`);
    expect(diff(5)).toHaveAttribute("href", `/ada/alpha/compare/main...${SHA}?attempt=t1a2`);
    await user.click(within(item).getByRole("button", { name: "Start run 7" }));
    await waitFor(() => expect(started).toEqual([{ id: "7", sha: SHA }]));
  });

  it("shows the task's waiting runs without Start to anyone but the owner", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "id-alpha", handle: "alpha", owner: bob, createdAt: me.user.createdAt }),
      ),
      http.get("*/api/projects/:owner/:project/runs", () => {
        const {
          error: _e,
          outcome: _o,
          result: _r,
          ...run
        } = runDetail(7, SHA, {
          line: "t1a1",
          status: "waiting",
          waiting: { head: SHA, attempt: "t1a1", base: BASE, secrets: ["DEPLOY"], taskCheck: null },
        });
        return HttpResponse.json({ runs: [run], next: null });
      }),
    );
    await openTask(task(1), [attempt(1, 1, { state: "open" })]);
    const list = await screen.findByRole("region", { name: "Waiting for the owner" });
    expect(within(list).getByRole("listitem", { name: "Run 7" })).toHaveTextContent("Secrets: DEPLOY");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("says when a closed task never merged", async () => {
    await openTask(task(1, { state: "closed", closedBy: me.user }), []);
    expect(within(body()).getByText("Closed without merging.")).toBeInTheDocument();
  });

  it("polls the task while the page is open", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/projects/:owner/:project/tasks/t1", () => {
        calls += 1;
        return HttpResponse.json(task(1, { title: calls === 1 ? "Before" : "After" }));
      }),
      ...serveTasks([task(1)]),
    );
    await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("heading", { name: /Before/u });
    expect(await screen.findByRole("heading", { name: /After/u }, { timeout: 4500 })).toBeInTheDocument();
  }, 8000);
});

describe("closing and obsoleting a task", () => {
  const active = [attempt(1, 1), attempt(1, 2, { state: "open" }), attempt(1, 3, { state: "open" })];

  it("asks first, naming the attempts it closes; cancelling makes no call", async () => {
    let posted = false;
    server.use(
      http.post("*/api/projects/:owner/:project/tasks/:t/close", () => {
        posted = true;
        return HttpResponse.json(task(1, { state: "closed" }));
      }),
    );
    const { user } = await openTask(task(1), active);
    await user.click(screen.getByRole("button", { name: "Close task" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Close t1? Its 3 active attempts will be closed too.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toBeFalsy();
  });

  it("closes the task once confirmed", async () => {
    const t1 = task(1);
    let posted: string | undefined;
    server.use(
      http.post("*/api/projects/:owner/:project/tasks/:t/close", ({ params }) => {
        posted = `${params["owner"]}/${params["project"]} ${params["t"]}`;
        Object.assign(t1, { state: "closed", closedBy: me.user });
        return HttpResponse.json(t1);
      }),
    );
    const { user } = await openTask(t1, active);
    await user.click(screen.getByRole("button", { name: "Close task" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close task" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toBe("ada/alpha t1");
    expect(await within(body()).findByText("Closed without merging.")).toBeInTheDocument();
  });

  it("marks the task obsolete once confirmed, for the project owner", async () => {
    let posted = false;
    server.use(
      http.post("*/api/projects/:owner/:project/tasks/:t/obsolete", () => {
        posted = true;
        return HttpResponse.json(task(1, { state: "obsolete" }));
      }),
    );
    const { user } = await openTask(task(1), [attempt(1, 1)]);
    await user.click(screen.getByRole("button", { name: "Mark obsolete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Mark t1 obsolete? Its 1 active attempt will be made obsolete too.");
    await user.click(within(dialog).getByRole("button", { name: "Mark obsolete" }));
    await waitFor(() => expect(posted).toBeTruthy());
  });

  it("is only offered to the task's creator and the project owner", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "p", handle: "alpha", owner: bob, createdAt: me.user.createdAt }),
      ),
    );
    await openTask(task(1, { creator: bob }), active);
    expect(screen.queryByRole("button", { name: "Close task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark obsolete" })).toBeNull();
  });

  it("lets the creator close but not obsolete when someone else owns the project", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "p", handle: "alpha", owner: bob, createdAt: me.user.createdAt }),
      ),
    );
    await openTask(task(1), active);
    expect(screen.getByRole("button", { name: "Close task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark obsolete" })).toBeNull();
  });
});
