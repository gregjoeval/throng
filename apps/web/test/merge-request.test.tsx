// The merge request view: its state banner, the approved head, re-approval after a new push, the
// dequeue details, cancelling, and polling.

import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Dequeue, ListedTask, MergeRequest } from "@/lib/tasks";
import { renderApp } from "./app";
import {
  addedFile,
  arenaAttempt,
  attempt,
  BASE,
  bob,
  me,
  result,
  runDetail,
  serveCompare,
  server,
  serveTasks,
  task,
} from "./server";

const APPROVED = "a9".padEnd(40, "0");
const HEAD = "11".padEnd(40, "c");

/** Task t1's merge request from t1a1, pending and approved by ada at its head. */
function mergeRequest(fields: Partial<MergeRequest> = {}): MergeRequest {
  return {
    task: "t1",
    attempt: "t1a1",
    state: "pending",
    approvedHead: HEAD,
    approvedBy: { id: me.user.id, handle: "ada", alias: null },
    approvedAt: "2026-10-10T12:00:00.000Z",
    queuedAt: null,
    position: null,
    lastDequeue: null,
    mergeSha: null,
    mergedAt: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    createdBy: { id: me.user.id, handle: "ada", alias: null },
    ...fields,
  };
}

/**
 * Task t1 (`t`) with its merge request from t1a1 (open, at `HEAD`) and t1a2 closed by selection: the
 * attempts, the arena, the merge request (`mr()` each time it's read) and every compare.
 */
function serveMergeRequest(mr: () => MergeRequest, asked: string[], t: ListedTask) {
  const source = attempt(1, 1, {
    state: "open",
    note: "Fixes the login race.",
    mergeRequest: { state: "pending", lastDequeue: null },
  });
  return [
    http.get("*/api/projects/:owner/:project/tasks/:t/merge-request", () => HttpResponse.json(mr())),
    http.get("*/api/projects/:owner/:project/tasks/:t/arena", () =>
      HttpResponse.json({
        task: "t1",
        metrics: [],
        attempts: [
          arenaAttempt(1, 1, { status: "done", result: result() }),
          arenaAttempt(1, 2, { state: "closed", base: null }),
        ],
      }),
    ),
    serveCompare((to) => [addedFile(`${to.slice(0, 2)}.txt`)], asked),
    ...serveTasks([t], [source, attempt(1, 2, { state: "closed" })]),
  ];
}

async function openMergeRequest(mr: MergeRequest | (() => MergeRequest), asked: string[] = [], t = task(1)) {
  server.use(...serveMergeRequest(typeof mr === "function" ? mr : () => mr, asked, t));
  const rendered = await renderApp("/ada/alpha/tasks/t1");
  await screen.findByTestId("merge-request-view");
  return rendered;
}

const view = () => screen.getByTestId("merge-request-view");
const banner = () => within(view()).findByRole("status", { name: "Merge request state" });

describe("the merge request view", () => {
  it("shows the state, the approved head and who approved it, and the source lane against its base", async () => {
    const asked: string[] = [];
    await openMergeRequest(mergeRequest(), asked);
    expect(await banner()).toHaveTextContent("Pending: waiting for the approved head's gate to pass.");
    expect(
      within(view())
        .getByText(/Approved/u)
        .closest("p"),
    ).toHaveTextContent(`Approved ${HEAD.slice(0, 7)} by ada`);
    const lane = within(view()).getByRole("region", { name: "Lane t1a1" });
    expect(lane).toHaveTextContent("Fixes the login race.");
    expect(await within(lane).findByRole("list", { name: "Files changed" })).toHaveTextContent("11.txt");
    expect(asked).toEqual([`${BASE}...${HEAD}?attempt=t1a1`]);
  });

  it.each([
    [mergeRequest({ state: "queued", position: 3 }), "Queued: number 3 in the merge queue."],
    [mergeRequest({ state: "landing", position: 1 }), "Landing: merging into main."],
    [
      mergeRequest({ state: "needsReview", approvedHead: APPROVED }),
      "Needs review: t1a1 has a new head since it was approved.",
    ],
    [mergeRequest({ state: "merged", mergeSha: "f".repeat(40) }), "Merged as fffffff."],
    [mergeRequest({ state: "cancelled" }), "Cancelled."],
  ])("says the merge request is %#", async (mr, text) => {
    await openMergeRequest(mr);
    expect(await banner()).toHaveTextContent(text);
  });

  it("shows the task branch's runs beside the banner", async () => {
    const { error: _e, outcome: _o, result: _r, ...run } = runDetail(4, HEAD, { line: "t1", status: "running" });
    server.use(
      http.get("*/api/projects/:owner/:project/runs", ({ request }) =>
        HttpResponse.json({ runs: new URL(request.url).searchParams.get("line") === "t1" ? [run] : [], next: null }),
      ),
    );
    await openMergeRequest(mergeRequest());
    const runs = await within(view()).findByRole("region", { name: "Task branch runs" });
    expect(within(runs).getByRole("listitem", { name: "Run 4" })).toHaveTextContent(`Run 4${HEAD.slice(0, 7)}Running`);
  });

  it("shows no task branch runs while the task branch has none", async () => {
    await openMergeRequest(mergeRequest());
    await banner();
    expect(within(view()).queryByRole("region", { name: "Task branch runs" })).toBeNull();
  });

  it("names the alias an approval came through", async () => {
    await openMergeRequest(mergeRequest({ approvedBy: { ...bob, alias: "claude" } }));
    await banner();
    expect(
      within(view())
        .getByText(/Approved/u)
        .closest("p"),
    ).toHaveTextContent("by bob (claude)");
  });

  it("polls the merge request while it's open", async () => {
    let reads = 0;
    await openMergeRequest(() => {
      reads += 1;
      return mergeRequest(reads < 2 ? {} : { state: "queued", position: 1 });
    });
    expect(await banner()).toHaveTextContent("Pending");
    await expect.poll(async () => (await banner()).textContent, { timeout: 4500 }).toMatch(/Queued: number 1/u);
  }, 8000);
});

describe("a merge request that needs review", () => {
  it("shows the changes since the approved head, and approves the new head", async () => {
    const asked: string[] = [];
    const approved: string[] = [];
    server.use(
      http.post("*/api/projects/:owner/:project/tasks/:t/merge-request/approve", ({ params }) => {
        approved.push(String(params["t"]));
        return HttpResponse.json(mergeRequest());
      }),
    );
    const { user } = await openMergeRequest(mergeRequest({ state: "needsReview", approvedHead: APPROVED }), asked);
    const review = await within(view()).findByRole("region", { name: "Changes since approval" });
    expect(await within(review).findByRole("list", { name: "Files changed" })).toHaveTextContent("11.txt");
    expect(asked).toContain(`${APPROVED}...${HEAD}?attempt=t1a1`);
    await user.click(within(review).getByRole("button", { name: "Approve" }));
    await expect.poll(() => approved).toEqual(["t1"]);
  });

  it("offers Approve only to the task's creator and the project owner", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "p", handle: "alpha", owner: bob, createdAt: "2026-10-10T12:00:00.000Z" }),
      ),
    );
    await openMergeRequest(
      mergeRequest({ state: "needsReview", approvedHead: APPROVED }),
      [],
      task(1, { creator: bob }),
    );
    await within(view()).findByRole("region", { name: "Changes since approval" });
    expect(within(view()).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(view()).queryByRole("button", { name: "Cancel merge request" })).toBeNull();
  });
});

/** A `conflict` dequeue: `src/a.ts` with one content hunk, and `big.json` too large for hunks. */
const CONFLICT: Dequeue = {
  reason: "conflict",
  run: 9,
  at: "2026-10-10T12:05:00.000Z",
  details: {
    attempt: "t1a1",
    head: HEAD,
    main: "e".repeat(40),
    base: BASE,
    files: [
      {
        path: "src/a.ts",
        type: "content",
        blobs: { base: "1".repeat(40), main: "2".repeat(40), attempt: "3".repeat(40) },
        modes: { base: "100644", main: "100644", attempt: "100644" },
        truncated: false,
        hunks: [{ startLine: 4, base: ["const a = 1;"], main: ["const a = 2;"], attempt: ["const a = 3;"] }],
      },
      {
        path: "big.json",
        type: "modifyDelete",
        blobs: { base: "4".repeat(40), main: null, attempt: "5".repeat(40) },
        modes: { base: "100644", main: null, attempt: "100644" },
        truncated: true,
      },
    ],
  },
};

/** The dequeue handler. */
function serveDequeue(dequeue: Dequeue) {
  return [http.get("*/api/projects/:owner/:project/tasks/:t/merge-request/dequeue", () => HttpResponse.json(dequeue))];
}

describe("a dequeued merge request", () => {
  it("lists each conflicting file with its type and its hunks side by side, and links its run", async () => {
    server.use(...serveDequeue(CONFLICT));
    await openMergeRequest(mergeRequest({ lastDequeue: { reason: "conflict", run: 9, at: CONFLICT.at } }));
    const dequeue = await within(view()).findByRole("region", { name: "Dequeued" });
    expect(dequeue).toHaveTextContent("It conflicted with main");
    expect(within(dequeue).getByRole("link", { name: "View run" })).toHaveAttribute("href", "/ada/alpha/runs/9");

    const file = await within(dequeue).findByRole("region", { name: "Conflict in src/a.ts" });
    expect(file).toHaveTextContent("Both changed it");
    const hunk = within(file).getByRole("table", { name: "Hunk at line 4" });
    expect(
      within(hunk)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Base", "main", "t1a1"]);
    expect(
      within(hunk)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["const a = 1;", "const a = 2;", "const a = 3;"]);

    const big = within(dequeue).getByRole("region", { name: "Conflict in big.json" });
    expect(big).toHaveTextContent("Deleted on one side, changed on the other");
    expect(within(big).getByRole("note")).toHaveTextContent("Its hunks were left out: they were too large to show.");
    expect(within(big).queryByRole("table")).toBeNull();
  });

  it("lists the setups and checks that failed its landing's gate, and links its run", async () => {
    const dequeue: Dequeue = {
      reason: "failedChecks",
      run: 12,
      at: "2026-10-10T12:05:00.000Z",
      details: {
        steps: [
          { name: "deps", kind: "setup", outcome: "failed" },
          { name: "test", kind: "check", outcome: "errored" },
        ],
      },
    };
    server.use(...serveDequeue(dequeue));
    await openMergeRequest(mergeRequest({ lastDequeue: { reason: "failedChecks", run: 12, at: dequeue.at } }));
    const section = await within(view()).findByRole("region", { name: "Dequeued" });
    expect(section).toHaveTextContent("Checks failed on the merge with main");
    const steps = await within(section).findByRole("list", { name: "Failed steps" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["depsSetup failed", "testErrored"]);
    expect(within(section).getByRole("link", { name: "View run" })).toHaveAttribute("href", "/ada/alpha/runs/12");
  });

  it("shows an errored landing's error", async () => {
    const dequeue: Dequeue = {
      reason: "errored",
      run: 13,
      at: "2026-10-10T12:05:00.000Z",
      details: { error: "land: main moved; the lease failed" },
    };
    server.use(...serveDequeue(dequeue));
    await openMergeRequest(mergeRequest({ lastDequeue: { reason: "errored", run: 13, at: dequeue.at } }));
    const section = await within(view()).findByRole("region", { name: "Dequeued" });
    expect(await within(section).findByText("land: main moved; the lease failed")).toBeInTheDocument();
  });

  it("says why for a reason without details, with no run to link", async () => {
    await openMergeRequest(
      mergeRequest({ lastDequeue: { reason: "newPush", run: null, at: "2026-10-10T12:05:00.000Z" } }),
    );
    const section = await within(view()).findByRole("region", { name: "Dequeued" });
    expect(section).toHaveTextContent("A new push to t1a1 took it out of the queue.");
    expect(within(section).queryByRole("link", { name: "View run" })).toBeNull();
  });
});

describe("cancelling a merge request", () => {
  it("asks inline, then cancels", async () => {
    const cancelled: string[] = [];
    server.use(
      http.post("*/api/projects/:owner/:project/tasks/:t/merge-request/cancel", ({ params }) => {
        cancelled.push(String(params["t"]));
        return HttpResponse.json(mergeRequest({ state: "cancelled" }));
      }),
    );
    const { user } = await openMergeRequest(mergeRequest({ state: "queued", position: 2 }));
    await banner();
    await user.click(within(view()).getByRole("button", { name: "Cancel merge request" }));
    const confirm = within(view()).getByRole("group", { name: "Confirm cancel" });
    expect(confirm).toHaveTextContent("Cancel the merge request from t1a1? The task stays open");
    await user.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(within(view()).queryByRole("group", { name: "Confirm cancel" })).toBeNull();

    await user.click(within(view()).getByRole("button", { name: "Cancel merge request" }));
    await user.click(within(view()).getByRole("button", { name: "Cancel it" }));
    await expect.poll(() => cancelled).toEqual(["t1"]);
  });
});
