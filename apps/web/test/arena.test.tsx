import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { RequestHandler } from "msw";
import { describe, expect, it } from "vitest";
import type { ArenaAttempt, Metric } from "@/lib/arena";
import { renderApp } from "./app";
import {
  addedFile,
  arenaAttempt,
  BASE,
  bob,
  MAIN,
  me,
  result,
  serveArena,
  serveCompare,
  server,
  serveRefs,
  task,
} from "./server";

const passing = (n: number, fields: Partial<ArenaAttempt> = {}) =>
  arenaAttempt(1, n, { status: "done", result: result(), ...fields });
const failing = (n: number, fields: Partial<ArenaAttempt> = {}) =>
  arenaAttempt(1, n, { status: "done", result: result({ gate: "failed" }), ...fields });

/** Each attempt's change set: one file named after it. */
const filesByHead = (to: string) => [addedFile(`${to.slice(0, 2)}.txt`)];

/**
 * Opens the arena of `t1` with `attempts` (each changing one file of its own), plus any other
 * `handlers`, at `search`, returning every compare range asked for.
 */
async function openArena(
  attempts: ArenaAttempt[],
  metrics: Metric[] = [],
  handlers: RequestHandler[] = [],
  search = "",
) {
  const asked: string[] = [];
  server.use(serveCompare(filesByHead, asked), ...serveArena(task(1), attempts, metrics), ...handlers);
  const rendered = await renderApp(`/ada/alpha/tasks/t1${search}`);
  await screen.findByRole("region", { name: "Lanes" });
  return { ...rendered, asked };
}

const METRICS: Metric[] = [
  { name: "coverage", unit: "%", order: "desc" },
  { name: "bundle_kb", unit: "KB", order: "asc" },
];

const rail = () => screen.getByRole("list", { name: "Attempts" });
const card = (ref: string) => within(rail()).getByRole("button", { name: ref });
const railOrder = () =>
  within(rail())
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-pressed"))
    .map((b) => b.getAttribute("aria-label"));
const lanes = () =>
  screen.getAllByRole("region", { name: /^Lane /u }).map((lane) => lane.getAttribute("aria-label")?.slice(5));
const grid = () => screen.getByRole("region", { name: "Lanes" }).firstElementChild as HTMLElement;
const lane = (ref: string) => screen.getByRole("region", { name: `Lane ${ref}` });
/** The layout of every diff on the page. */
const layouts = () => [...document.querySelectorAll("[data-layout]")].map((d) => d.getAttribute("data-layout"));

describe("the arena's lanes", () => {
  it("opens with the first two passing attempts, each diffed against its own base", async () => {
    const { asked } = await openArena([failing(1), passing(2), passing(3), passing(4)]);
    expect(lanes()).toEqual(["t1a2", "t1a3"]);
    expect(card("t1a2")).toHaveAttribute("aria-pressed", "true");
    expect(card("t1a1")).toHaveAttribute("aria-pressed", "false");
    const files = await within(lane("t1a2")).findByRole("list", { name: "Files changed" });
    expect(within(files).getByRole("listitem")).toHaveAccessibleName("12.txt");
    expect(asked).toContain(`${BASE}...${passing(2).sha}?attempt=t1a2`);
  });

  it("opens with the first two by number when fewer than two pass", async () => {
    await openArena([failing(1), arenaAttempt(1, 2), passing(3)]);
    expect(lanes()).toEqual(["t1a1", "t1a3"]);
  });

  it("toggles a lane from its card, keeping lanes in the order they were added", async () => {
    const { user } = await openArena([passing(1), passing(2), passing(3), passing(4)]);
    await user.click(card("t1a4"));
    await user.click(card("t1a3"));
    expect(lanes()).toEqual(["t1a1", "t1a2", "t1a4", "t1a3"]);
    await user.click(card("t1a1"));
    expect(lanes()).toEqual(["t1a2", "t1a4", "t1a3"]);
    expect(card("t1a1")).toHaveAttribute("aria-pressed", "false");
    await user.click(card("t1a1"));
    expect(lanes()).toEqual(["t1a2", "t1a4", "t1a3", "t1a1"]);
  });

  it("always keeps one lane shown", async () => {
    const { user } = await openArena([passing(1), passing(2)]);
    await user.click(card("t1a1"));
    await user.click(card("t1a2"));
    expect(lanes()).toEqual(["t1a2"]);
    expect(card("t1a2")).toHaveAttribute("aria-pressed", "true");
  });

  it("lets two lanes share the width, and gives three or more a minimum width that scrolls sideways", async () => {
    const { user } = await openArena([passing(1), passing(2), passing(3)]);
    expect(grid().style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    await user.click(card("t1a3"));
    expect(grid().style.gridTemplateColumns).toBe("repeat(3, minmax(520px, 1fr))");
    expect(screen.getByRole("region", { name: "Lanes" })).toHaveClass("overflow-x-auto");
  });

  it("heads each lane with its gate, verdict counts, the author's note and a menu", async () => {
    const t1a1 = passing(1, {
      verdicts: { head: "x", merge: 2, revise: 1, reject: 0 },
      result: result({ preview: { status: "ready", url: "https://t1a1.preview.test" } }),
    });
    const asked: string[] = [];
    server.use(
      serveCompare(filesByHead, asked),
      ...serveArena(task(1), [t1a1, passing(2)], [], { t1a1: "Kept it small." }),
    );
    const { user, path } = await renderApp("/ada/alpha/tasks/t1");
    const header = within(await screen.findByRole("region", { name: "Lane t1a1" })).getByRole("banner");
    expect(header).toHaveTextContent("Gate passed");
    expect(within(header).getByLabelText("Verdicts")).toHaveTextContent("2 merge1 revise0 reject");
    expect(header).toHaveTextContent("Kept it small.");
    await user.click(within(header).getByRole("button", { name: "t1a1 actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open preview" })).toHaveAttribute(
      "href",
      "https://t1a1.preview.test",
    );
    expect(within(menu).getByRole("menuitem", { name: "Checks, logs and verdicts" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Open in browser" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/tree/t1a1"));
  });

  it("says when an attempt has nothing pushed", async () => {
    await openArena([arenaAttempt(1, 1, { sha: null, base: null }), passing(2)]);
    expect(within(lane("t1a1")).getByRole("note")).toHaveTextContent("Nothing has been pushed to t1a1 yet.");
  });
});

/** `t1a1` changes `b.txt` and `shared.txt`, `t1a2` changes `a.txt` and `shared.txt`, `t1a3` only `c.txt`. */
const overlapping = (to: string) =>
  ({
    [passing(1).sha ?? ""]: [addedFile("b.txt"), addedFile("shared.txt")],
    [passing(2).sha ?? ""]: [addedFile("a.txt"), addedFile("shared.txt")],
    [passing(3).sha ?? ""]: [addedFile("c.txt")],
  })[to] ?? [];

const fileRows = () => screen.getAllByRole("region", { name: /^File /u }).map((row) => row.getAttribute("aria-label"));
const fileRow = (path: string) => screen.getByRole("region", { name: `File ${path}` });
const cell = (path: string, ref: string) => within(fileRow(path)).getByRole("group", { name: ref });

describe("the arena's views", () => {
  it("arranges by file: a row per path any lane changed, sorted, with each lane's diff or none", async () => {
    server.use(serveCompare(overlapping), ...serveArena(task(1), [passing(1), passing(2)]));
    const { user } = await renderApp("/ada/alpha/tasks/t1");
    await user.click(await screen.findByRole("radio", { name: "By file" }));
    await screen.findByRole("region", { name: "File a.txt" });
    expect(fileRows()).toEqual(["File a.txt", "File b.txt", "File shared.txt"]);
    expect(fileRow("a.txt")).toHaveTextContent("changed by 1 of 2");
    expect(fileRow("shared.txt")).toHaveTextContent("changed by 2 of 2");
    expect(cell("a.txt", "t1a1")).toHaveTextContent("t1a1 left this file alone.");
    expect(cell("a.txt", "t1a2")).not.toHaveTextContent("left this file alone");
    expect(cell("b.txt", "t1a2")).toHaveTextContent("t1a2 left this file alone.");
    expect(lanes()).toEqual(["t1a1", "t1a2"]);
    await user.click(screen.getByRole("radio", { name: "By attempt" }));
    expect(screen.queryByRole("region", { name: /^File /u })).toBeNull();
    expect(within(lane("t1a1")).getByRole("list", { name: "Files changed" })).toHaveTextContent("b.txt");
  });

  it("diffs each lane against current main instead of its base, saying what that shows", async () => {
    const { user, asked } = await openArena([passing(1), passing(2)]);
    await within(lane("t1a1")).findByRole("list", { name: "Files changed" });
    expect(asked).toEqual([`${BASE}...${passing(1).sha}?attempt=t1a1`, `${BASE}...${passing(2).sha}?attempt=t1a2`]);
    server.use(serveRefs());
    await user.click(screen.getByRole("radio", { name: "Current main" }));
    expect(screen.getByText(/newer commits as removals/u)).toBeInTheDocument();
    await waitFor(() => expect(asked).toHaveLength(4));
    expect(asked.slice(2)).toEqual([
      `${MAIN}...${passing(1).sha}?attempt=t1a1`,
      `${MAIN}...${passing(2).sha}?attempt=t1a2`,
    ]);
    await user.click(screen.getByRole("radio", { name: "Its own base" }));
    expect(screen.queryByText(/newer commits as removals/u)).toBeNull();
    expect(asked).toHaveLength(4);
  });

  it("falls back to main for an attempt with no base, and offers its author Score now on a draft", async () => {
    const mine = { id: me.user.id, handle: me.user.handle };
    const draft = arenaAttempt(1, 2, { state: "draft", base: null, author: mine });
    const scored: string[] = [];
    const { user, asked } = await openArena(
      [passing(1), draft],
      [],
      [
        serveRefs(),
        http.post("*/api/projects/:owner/:project/attempts/:a/score", ({ params }) => {
          scored.push(String(params["a"]));
          return HttpResponse.json({ queued: true, reason: null, run: null });
        }),
      ],
    );
    expect(within(lane("t1a2")).getByRole("note")).toHaveTextContent(
      "t1a2 has no base (it shares no history with the task's line), so it's diffed against current main.",
    );
    await within(lane("t1a2")).findByRole("list", { name: "Files changed" });
    expect(asked).toContain(`${MAIN}...${draft.sha}?attempt=t1a2`);
    expect(within(lane("t1a1")).queryByRole("button", { name: "Score now" })).toBeNull();
    await user.click(within(lane("t1a2")).getByRole("button", { name: "Score now" }));
    await waitFor(() => expect(scored).toEqual(["t1a2"]));
  });

  it("offers Score now to no one but the draft's author", async () => {
    await openArena([passing(1), arenaAttempt(1, 2, { state: "draft" })]);
    await within(lane("t1a2")).findByRole("list", { name: "Files changed" });
    expect(screen.queryByRole("button", { name: "Score now" })).toBeNull();
  });

  it("opens the view the URL describes, and keeps the URL in step as it changes", async () => {
    const { user, router } = await openArena(
      [passing(1), passing(2), passing(3)],
      [],
      [serveRefs()],
      "?lanes=t1a3,t1a1&by=file&ref=main&layout=unified",
    );
    expect(lanes()).toEqual(["t1a3", "t1a1"]);
    expect(screen.getByRole("radio", { name: "By file" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Current main" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Unified" })).toBeChecked();
    await screen.findByRole("region", { name: "File 13.txt" });
    expect(fileRows()).toEqual(["File 11.txt", "File 13.txt"]);
    await user.click(card("t1a2"));
    await user.click(screen.getByRole("radio", { name: "By attempt" }));
    await user.click(screen.getByRole("radio", { name: "Its own base" }));
    await user.click(screen.getByRole("radio", { name: "Split" }));
    expect(router.state.location.search).toEqual({
      lanes: "t1a3,t1a1,t1a2",
      by: "attempt",
      ref: "base",
      layout: "split",
    });
    expect(lanes()).toEqual(["t1a3", "t1a1", "t1a2"]);
  });

  it("restores the view stored for the task, the URL winning where it says otherwise", async () => {
    const first = await openArena([passing(1), passing(2), passing(3)], [], [serveRefs()]);
    await first.user.click(card("t1a3"));
    await first.user.click(screen.getByRole("radio", { name: "By file" }));
    await first.user.click(screen.getByRole("radio", { name: "Unified" }));
    cleanup();
    const { router } = await openArena([passing(1), passing(2), passing(3)], [], [serveRefs()], "?by=attempt");
    expect(lanes()).toEqual(["t1a1", "t1a2", "t1a3"]);
    expect(screen.getByRole("radio", { name: "By attempt" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Unified" })).toBeChecked();
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ lanes: "t1a1,t1a2,t1a3", by: "attempt", layout: "unified" }),
    );
  });

  it("opens with the defaults when storage can't be read", async () => {
    localStorage.setItem("throng:arena:ada/alpha/t1", "{not json");
    await openArena([passing(1), passing(2)]);
    expect(lanes()).toEqual(["t1a1", "t1a2"]);
    expect(screen.getByRole("radio", { name: "By attempt" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Its own base" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Split" })).toBeChecked();
  });

  it("suggests unified at three lanes, and lays the diffs out as chosen", async () => {
    const { user } = await openArena([passing(1), passing(2), passing(3)]);
    expect(screen.queryByText(/Unified fits/u)).toBeNull();
    await user.click(card("t1a3"));
    expect(screen.getByText("Unified fits 3 lanes better.")).toBeInTheDocument();
    await waitFor(() => expect(layouts()).toEqual(["split", "split", "split"]));
    await user.click(screen.getByRole("button", { name: "Use unified" }));
    expect(screen.getByRole("radio", { name: "Unified" })).toBeChecked();
    expect(screen.queryByText(/Unified fits/u)).toBeNull();
    expect(layouts()).toEqual(["unified", "unified", "unified"]);
  });
});

/** The one attempt of the single-attempt view: passing, with a required and an optional check. */
const only = () =>
  arenaAttempt(1, 1, {
    status: "done",
    result: result({
      metrics: { coverage: 81.5 },
      checks: [
        { name: "test", required: true, outcome: "passed", durationMs: 1200, metrics: { coverage: 81.5 }, notes: [] },
        { name: "lint", required: false, outcome: "failed", durationMs: 300, metrics: {}, notes: [] },
      ],
    }),
  });

describe("the single-attempt view", () => {
  it("shows the attempt's lane against its base, its scorecard, and Merge for the task's creator", async () => {
    const asked: string[] = [];
    server.use(
      serveCompare(filesByHead, asked),
      ...serveArena(task(1), [only(), arenaAttempt(1, 2, { state: "closed", base: null })], METRICS),
    );
    await renderApp("/ada/alpha/tasks/t1");
    const view = await screen.findByTestId("single-attempt-view");
    expect(within(view).queryByRole("list", { name: "Attempts" })).toBeNull();
    expect(await within(lane("t1a1")).findByRole("list", { name: "Files changed" })).toHaveTextContent("11.txt");
    expect(asked).toEqual([`${BASE}...${only().sha}?attempt=t1a1`]);
    const scorecard = within(view).getByRole("region", { name: "Scorecard" });
    expect(within(scorecard).getByRole("row", { name: /test/u })).toHaveTextContent("testRequiredPassed1.2 s");
    expect(within(scorecard).getByRole("row", { name: /lint/u })).toHaveTextContent("lintOptionalFailed0.3 s");
    expect(scorecard).toHaveTextContent("coverage81.5%");
    expect(scorecard).toHaveTextContent("Files changed1");
    expect(within(view).getByRole("button", { name: "Merge" })).toBeInTheDocument();
  });

  it("offers Merge only to the task's creator and the project owner", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "p", handle: "alpha", owner: bob, createdAt: "2026-10-10T12:00:00.000Z" }),
      ),
      serveCompare(filesByHead),
      ...serveArena(task(1, { creator: bob }), [only()]),
    );
    await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Scorecard" });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("says when the attempt hasn't been scored yet", async () => {
    server.use(serveCompare(filesByHead), ...serveArena(task(1), [arenaAttempt(1, 1, { status: "queued" })]));
    await renderApp("/ada/alpha/tasks/t1");
    const scorecard = await screen.findByRole("region", { name: "Scorecard" });
    expect(scorecard).toHaveTextContent("Not scored yet: scoring is queued.");
  });
});

/** A passing or failing attempt reporting `coverage` and `bundle_kb`, with `files` files changed. */
const scored = (n: number, gate: "passed" | "failed", coverage: number, bundle: number, files = 1) =>
  arenaAttempt(1, n, {
    status: "done",
    result: result({
      gate,
      metrics: { coverage, bundle_kb: bundle },
      builtin: { filesChanged: files, additions: files * 10, deletions: 0, durationMs: 1 },
    }),
  });

/** Each metric row of a card, with the values marked best ending in `*`. */
function cardMetrics(ref: string): Record<string, string> {
  return Object.fromEntries(
    within(card(ref))
      .getAllByRole("term")
      .map((term) => {
        const value = term.nextElementSibling as HTMLElement;
        return [term.textContent, `${value.textContent}${value.querySelector("mark") === null ? "" : "*"}`];
      }),
  );
}

describe("the arena's rail", () => {
  it("shows every declared metric, files changed and lines added, marking the best among passing attempts", async () => {
    await openArena(
      [scored(1, "passed", 80, 120, 3), scored(2, "passed", 90, 140, 2), scored(3, "failed", 99, 100, 1)],
      METRICS,
    );
    expect(cardMetrics("t1a1")).toEqual({
      coverage: "80%",
      bundle_kb: "120 KB*",
      "Files changed": "3",
      "Lines added": "30",
    });
    expect(cardMetrics("t1a2")).toEqual({
      coverage: "90%*",
      bundle_kb: "140 KB",
      "Files changed": "2*",
      "Lines added": "20*",
    });
    // The failing attempt has the best raw value of each, and none is marked.
    expect(cardMetrics("t1a3")).toEqual({
      coverage: "99%",
      bundle_kb: "100 KB",
      "Files changed": "1",
      "Lines added": "10",
    });
  });

  it("tells a gate with no checks configured from one that passed, and shows scoring in progress", async () => {
    await openArena([
      arenaAttempt(1, 1, { status: "done", result: result({ config: { kind: "none" }, checks: [] }) }),
      passing(2),
      arenaAttempt(1, 3, { status: "running" }),
      arenaAttempt(1, 4, { needsUpdate: true, forkedFrom: "t1a1" }),
    ]);
    expect(card("t1a1")).toHaveTextContent("No checks configured");
    expect(card("t1a2")).toHaveTextContent("Gate passed");
    expect(card("t1a3")).toHaveTextContent("Not scored");
    expect(card("t1a3")).toHaveTextContent("Scoring…");
    expect(card("t1a4")).toHaveTextContent("Needs update");
    expect(card("t1a4")).toHaveTextContent("forked from t1a1");
    expect(card("t1a2")).not.toHaveTextContent("Needs update");
  });

  it("sorts by number, gate, or any metric best first", async () => {
    const { user } = await openArena(
      [
        scored(1, "failed", 99, 100, 1),
        scored(2, "passed", 80, 140, 3),
        arenaAttempt(1, 3),
        scored(4, "passed", 90, 120, 2),
      ],
      METRICS,
    );
    const sortBy = screen.getByRole("combobox", { name: "Sort by" });
    expect(railOrder()).toEqual(["t1a1", "t1a2", "t1a3", "t1a4"]);
    await user.selectOptions(sortBy, "Gate");
    expect(railOrder()).toEqual(["t1a2", "t1a4", "t1a1", "t1a3"]);
    await user.selectOptions(sortBy, "coverage");
    expect(railOrder()).toEqual(["t1a1", "t1a4", "t1a2", "t1a3"]);
    await user.selectOptions(sortBy, "bundle_kb");
    expect(railOrder()).toEqual(["t1a1", "t1a4", "t1a2", "t1a3"]);
    await user.selectOptions(sortBy, "Files changed");
    expect(railOrder()).toEqual(["t1a1", "t1a4", "t1a2", "t1a3"]);
    await user.selectOptions(sortBy, "Number");
    expect(railOrder()).toEqual(["t1a1", "t1a2", "t1a3", "t1a4"]);
  });

  it("polls the scores, but never asks for a lane's compare again", async () => {
    let calls = 0;
    const asked: string[] = [];
    server.use(
      http.get("*/api/projects/:owner/:project/tasks/t1/arena", () => {
        calls += 1;
        const t1a1 = calls === 1 ? arenaAttempt(1, 1, { status: "running" }) : passing(1);
        return HttpResponse.json({ task: "t1", metrics: [], attempts: [t1a1, passing(2)] });
      }),
      serveCompare(filesByHead, asked),
      ...serveArena(task(1), [passing(1), passing(2)]),
    );
    await renderApp("/ada/alpha/tasks/t1");
    expect(await screen.findByText("Scoring…")).toBeInTheDocument();
    await waitFor(() => expect(card("t1a1")).toHaveTextContent("Gate passed"), { timeout: 4500 });
    expect(asked).toHaveLength(2);
  }, 8000);

  it("collapses closed attempts into a group of their own", async () => {
    await openArena([passing(1), passing(2), arenaAttempt(1, 3, { state: "closed", base: null })]);
    expect(within(rail()).queryByRole("button", { name: "t1a3" })).toBeNull();
    expect(screen.getByText("Closed (1)").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("list", { name: "Closed attempts", hidden: true })).toHaveTextContent("t1a3");
  });
});
