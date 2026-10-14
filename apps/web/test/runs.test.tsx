import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Run, RunWithOutcome } from "@/lib/api";
import { renderApp } from "./app";
import {
  addedFile,
  bob,
  me,
  notFound,
  project,
  result,
  runDetail,
  serveCompare,
  serveConflictDiffs,
  server,
  step,
} from "./server";

const views = () => screen.getByRole("navigation", { name: "Project views" });

/** A run page's stage, by its title. */
const section = async (name: string) => screen.findByRole("region", { name });

/** The steps a run page's stage lists, by name; a step's notes are a list of their own. */
const names = async (name: string) =>
  within(await section(name))
    .getAllByRole("listitem")
    .filter((li) => li.parentElement?.getAttribute("aria-label") === null)
    .map((li) => li.getAttribute("aria-label"));

/** A run page's step, by its name. */
const item = (name: string) => screen.getByRole("listitem", { name });

const SHA = "a1b2c3d".padEnd(40, "0");

/** A run as the list gives it: `runDetail`'s, without the outcome. */
function listed(id: number, fields: Partial<RunWithOutcome> = {}): Run {
  const { error: _error, outcome: _outcome, result: _result, ...run } = runDetail(id, SHA, fields);
  return run;
}

/** How many runs a page of the waiting list serves in these tests. */
const PAGE = 2;

/** What the owner's Waiting for you list asks the runs list for. */
const WAITING = "?status=waiting";

/**
 * Serves `runs` as the list's one page, recording each query it was asked with in `asked`. The
 * owner's Waiting for you list, which asks for every waiting run on any line, gets none.
 */
function serveRuns(runs: Run[], next: number | null = null, asked: string[] = []) {
  return http.get("*/api/projects/:owner/:project/runs", ({ request }) => {
    const { search } = new URL(request.url);
    asked.push(search);
    return HttpResponse.json(search === WAITING ? { runs: [], next: null } : { runs, next });
  });
}

/** Serves run `run.id` as its page reads it. */
const serveRun = (run: RunWithOutcome) =>
  http.get(`*/api/projects/:owner/:project/runs/${run.id}`, () => HttpResponse.json(run));

describe("the runs tab", () => {
  it("sits between Tasks and Settings, and is current on the runs list and a run's page", async () => {
    server.use(serveRuns([]), serveRun(runDetail(3, SHA)));
    const { user, path } = await renderApp("/ada/alpha");
    await within(views()).findByRole("link", { name: "Settings" });
    const tabs = within(views())
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(tabs).toEqual(["Code", "Commits", "Tasks", "Runs", "Settings"]);
    await user.click(within(views()).getByRole("link", { name: "Runs" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/runs"));
    expect(within(views()).getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("No runs")).toBeInTheDocument();
  });
});

describe("the runs list", () => {
  it("shows each run's line (linked), pipeline, trigger, short sha, status, gate, duration and who triggered it", async () => {
    server.use(
      serveRuns([
        listed(9, { line: "main", pipeline: "main", status: "running", gate: null, finishedAt: null }),
        listed(8, { line: "t2", status: "waiting", startedAt: null, finishedAt: null, gate: null, trusted: false }),
        listed(7, { trigger: "open", alias: "claude" }),
        listed(5, { status: "errored", gate: null, requestedBy: null }),
      ]),
    );
    await renderApp("/ada/alpha/runs");
    const table = await screen.findByRole("table", { name: "Runs" });
    const row = (id: number) => within(table).getByRole("row", { name: `Run ${id}` });
    expect(row(7)).toHaveTextContent("7t1a1defaultOpena1b2c3dDonePassed1m 05sada (claude)");
    expect(row(8)).toHaveTextContent("8t2defaultPusha1b2c3dWaiting for the owner——ada");
    expect(row(5)).toHaveTextContent("Errored—1m 05sThrong");
    expect(row(9)).toHaveTextContent("9mainmainPusha1b2c3dRunning");
    expect(within(row(7)).getByRole("link", { name: "7" })).toHaveAttribute("href", "/ada/alpha/runs/7");
    expect(within(row(7)).getByRole("link", { name: "t1a1" })).toHaveAttribute("href", "/ada/alpha/tasks/t1");
    expect(within(row(8)).getByRole("link", { name: "t2" })).toHaveAttribute("href", "/ada/alpha/tasks/t2");
    expect(within(row(9)).getByRole("link", { name: "main" })).toHaveAttribute("href", `/ada/alpha/commit/${SHA}`);
  });

  it("lists a merge request's landing as a `main` run by its trigger, with no head until it lands", async () => {
    server.use(
      serveRuns([
        listed(11, { line: "main", pipeline: "main", trigger: "merge", sha: null, status: "running", gate: null }),
        listed(10, { line: "main", pipeline: "main", trigger: "merge" }),
      ]),
    );
    await renderApp("/ada/alpha/runs");
    const table = await screen.findByRole("table", { name: "Runs" });
    const row = (id: number) => within(table).getByRole("row", { name: `Run ${id}` });
    expect(row(11)).toHaveTextContent("11mainmainMerge—Running");
    expect(within(row(11)).getByRole("link", { name: "main" })).toHaveAttribute("href", "/ada/alpha/commits/main");
    expect(row(10)).toHaveTextContent("10mainmainMergea1b2c3dDone");
    expect(within(row(10)).getByRole("link", { name: "main" })).toHaveAttribute("href", `/ada/alpha/commit/${SHA}`);
  });

  it("filters by line and status through the URL, starting each filter from the newest run", async () => {
    const asked: string[] = [];
    server.use(serveRuns([listed(4)], null, asked));
    const { user, path } = await renderApp("/ada/alpha/runs?cursor=10");
    await screen.findByRole("table", { name: "Runs" });
    const lines = screen.getByRole("navigation", { name: "Line" });
    expect(within(lines).getByRole("link", { name: "All lines" })).toHaveAttribute("aria-current", "page");
    await user.click(within(lines).getByRole("link", { name: "main" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/runs?line=main"));
    await user.click(
      within(screen.getByRole("navigation", { name: "Status" })).getByRole("link", { name: "Waiting for the owner" }),
    );
    await waitFor(() => expect(path()).toBe("/ada/alpha/runs?line=main&status=waiting"));
    await user.click(within(screen.getByRole("navigation", { name: "Line" })).getByRole("link", { name: "Tasks" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/runs?line=tasks&status=waiting"));
    await waitFor(() => expect(asked).toContain("?line=tasks&status=waiting"));
    // Besides the list's pages, the owner's Waiting for you asks once for every waiting run.
    expect(asked.filter((query) => query !== WAITING)).toEqual([
      "?cursor=10",
      "?line=main",
      "?line=main&status=waiting",
      "?line=tasks&status=waiting",
    ]);
  });

  it("pages older by the cursor the platform gives, and back to the newest", async () => {
    const asked: string[] = [];
    server.use(serveRuns([listed(6), listed(5)], 5, asked));
    const { user, path } = await renderApp("/ada/alpha/runs?status=done");
    const pages = await screen.findByRole("navigation", { name: "Pages" });
    expect(within(pages).queryByRole("link", { name: "Newest" })).toBeNull();
    await user.click(within(pages).getByRole("link", { name: "Older" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/runs?status=done&cursor=5"));
    await user.click(within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Newest" }));
    await waitFor(() => expect(path()).toBe("/ada/alpha/runs?status=done"));
    expect(asked.filter((query) => query !== WAITING).slice(0, 2)).toEqual(["?status=done", "?status=done&cursor=5"]);
  });
});

describe("a run's page", () => {
  const landing = runDetail(12, SHA, {
    line: "main",
    pipeline: "main",
    outcome: {
      ...result(),
      steps: [
        step("_diff", { source: "platform", log: null, durationMs: 100 }),
        step("merge", { source: "platform", kind: "step", log: null }),
        step("setup.1", { kind: "setup", durationMs: 30_000 }),
        step("typecheck", { group: "verify" }),
        step("test", { group: "verify", notes: ["2 retried"] }),
        step("preview", { after: ["typecheck", "test"] }),
        step("land", { source: "platform", kind: "step", log: null }),
        step("migrate", { kind: "step", outcome: "failed" }),
        step("deploy", { kind: "step", outcome: "skipped", log: null, notes: ["skipped: migrate failed"] }),
      ],
      metrics: {
        coverage: { source: "project", type: "number", value: 81.5, order: "desc", unit: "%" },
        preview_url: { source: "project", type: "string", format: "url", value: "https://p.example.test/" },
        broken: { source: "project", type: "string", format: "url", value: "javascript:alert(1)" },
      },
    },
  });

  it("has a header with the run's line, head, pipeline, trigger, trust, status and gate", async () => {
    server.use(serveRun(landing));
    await renderApp("/ada/alpha/runs/12");
    expect(await screen.findByRole("heading", { name: "Run 12" })).toBeInTheDocument();
    const header = screen.getByLabelText("Run");
    expect(header).toHaveTextContent(
      "LinemainHeada1b2c3dPipelinemainTriggerPushStatusDoneGatePassedSecretsTrustedDuration1m 05sTriggered byada",
    );
    expect(within(header).getByRole("link", { name: "main" })).toHaveAttribute("href", `/ada/alpha/commit/${SHA}`);
    expect(within(views()).getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  });

  it("shows setups, checks by group with `after`, the landing and post-gate steps, each with outcome, duration and notes", async () => {
    server.use(serveRun(landing));
    await renderApp("/ada/alpha/runs/12");
    expect(await names("Setups")).toEqual(["setup.1"]);
    expect(await names("Checks")).toEqual(["_diff", "preview"]);
    expect(await names("Checks: verify")).toEqual(["typecheck", "test"]);
    expect(await names("Landing")).toEqual(["merge", "land"]);
    expect(await names("Steps")).toEqual(["migrate", "deploy"]);
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["Setups", "Checks", "Checks: verify", "Landing", "Steps", "Metrics"]);

    expect(item("setup.1")).toHaveTextContent("setup.1Passed30.0 s");
    expect(item("preview")).toHaveTextContent("previewPassed0.9 safter typecheck, test");
    expect(item("test")).toHaveTextContent("2 retried");
    expect(item("migrate")).toHaveTextContent("migrateFailed");
    expect(item("deploy")).toHaveTextContent("deploySkipped0.9 sskipped: migrate failed");
    expect(within(item("deploy")).queryByRole("button")).toBeNull();
  });

  it("says a landing that hasn't landed has no head yet", async () => {
    server.use(serveRun(runDetail(14, SHA, { line: "main", pipeline: "main", trigger: "merge", sha: null })));
    await renderApp("/ada/alpha/runs/14");
    const header = await screen.findByLabelText("Run");
    expect(header).toHaveTextContent("HeadNot landedPipelinemainTriggerMerge");
  });

  it("expands a step's log", async () => {
    server.use(
      serveRun(landing),
      http.get("*/api/projects/:owner/:project/runs/12/logs/:step", ({ params }) =>
        params["step"] === "migrate" ? new HttpResponse("relation exists\n") : notFound("no such log"),
      ),
    );
    const { user } = await renderApp("/ada/alpha/runs/12");
    const migrate = await screen.findByRole("listitem", { name: "migrate" });
    await user.click(within(migrate).getByRole("button", { name: "migrate log" }));
    expect(await within(migrate).findByRole("log", { name: "migrate" })).toHaveTextContent("relation exists");
    await user.click(within(migrate).getByRole("button", { name: "migrate log" }));
    expect(within(migrate).queryByRole("log")).toBeNull();
  });

  it("shows its metrics as a table, with `url` metrics as links", async () => {
    server.use(serveRun(landing));
    await renderApp("/ada/alpha/runs/12");
    const table = await screen.findByRole("table", { name: "Metrics" });
    expect(within(table).getByRole("row", { name: "coverage" })).toHaveTextContent("coverage81.5%");
    expect(within(table).getByRole("link", { name: "https://p.example.test/" })).toHaveAttribute(
      "href",
      "https://p.example.test/",
    );
    expect(within(table).getByRole("row", { name: "broken" })).toHaveTextContent("javascript:alert(1)");
    expect(within(table).queryByRole("link", { name: /javascript/u })).toBeNull();
  });

  it("shows a run that hasn't finished, or errored, without steps", async () => {
    server.use(
      serveRun(
        runDetail(13, SHA, { status: "errored", gate: null, outcome: null, result: null, error: "sandbox lost" }),
      ),
    );
    await renderApp("/ada/alpha/runs/13");
    expect(await screen.findByRole("alert")).toHaveTextContent("sandbox lost");
    expect(screen.queryByRole("region", { name: "Checks" })).toBeNull();
  });

  it("lets the owner cancel a run that can be cancelled", async () => {
    let status: Run["status"] = "running";
    const cancelled: number[] = [];
    server.use(
      http.get("*/api/projects/:owner/:project/runs/14", () =>
        HttpResponse.json(
          runDetail(14, SHA, { status, cancellable: status === "running", gate: null, outcome: null, result: null }),
        ),
      ),
      http.post("*/api/projects/:owner/:project/runs/14/cancel", () => {
        cancelled.push(14);
        status = "cancelled";
        return HttpResponse.json(runDetail(14, SHA, { status, outcome: null, result: null }));
      }),
    );
    const { user } = await renderApp("/ada/alpha/runs/14");
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(screen.getByLabelText("Run")).toHaveTextContent("StatusCancelled"));
    expect(cancelled).toEqual([14]);
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("offers no Cancel to anyone but the owner", async () => {
    server.use(
      http.get("*/api/projects/bob/gamma", () => HttpResponse.json(project("gamma", { ...me.user, ...bob }))),
      serveRun(runDetail(15, SHA, { status: "queued", cancellable: true, outcome: null, result: null })),
    );
    await renderApp("/bob/gamma/runs/15");
    expect(await screen.findByRole("heading", { name: "Run 15" })).toBeInTheDocument();
    await within(views()).findByRole("link", { name: "Runs" });
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("is not found for an id that isn't a run's, or too long to be one", async () => {
    for (const id of ["abc", "9".repeat(16)]) {
      await renderApp(`/ada/alpha/runs/${id}`);
      expect(await screen.findByRole("alert"), id).toHaveTextContent("Not found");
    }
  });

  it("shows the conflict a landing's merge hit, with each file's diff to both sides", async () => {
    const asked: string[] = [];
    const conflicted = runDetail(16, SHA, {
      line: "main",
      pipeline: "main",
      trigger: "merge",
      sha: null,
      gate: "failed",
      outcome: {
        ...result(),
        gate: "failed",
        steps: [
          step("merge", { source: "platform", kind: "step", outcome: "failed", log: null }),
          step("land", { source: "platform", kind: "step", outcome: "skipped", log: null }),
        ],
        metrics: {},
        landed: {
          kind: "conflict",
          details: {
            attempt: "t1a1",
            head: "c".repeat(40),
            main: "e".repeat(40),
            base: "d".repeat(40),
            files: [
              {
                path: "big.json",
                type: "content",
                blobs: { base: "1".repeat(40), main: "2".repeat(40), attempt: "3".repeat(40) },
                modes: { base: "100644", main: "100644", attempt: "100644" },
                truncated: true,
              },
            ],
          },
        },
      },
    });
    server.use(serveRun(conflicted), serveConflictDiffs("runs/16/conflict", asked));
    await renderApp("/ada/alpha/runs/16");
    expect(await screen.findByLabelText("Run")).toHaveTextContent("HeadNot landed: the merge conflicted");
    const conflict = await section("Conflict");
    expect(conflict).toHaveTextContent("Merging t1a1 at ccccccc into main at eeeeeee conflicted.");
    const file = within(conflict).getByRole("region", { name: "Conflict in big.json" });
    expect(within(file).getByRole("note")).toHaveTextContent("Its hunks were left out");
    const toMain = within(file).getByRole("region", { name: "Base → main" });
    expect(await within(toMain).findByRole("listitem", { name: "big.json" })).toHaveTextContent("+1");
    const toAttempt = within(file).getByRole("region", { name: "Base → t1a1" });
    expect(await within(toAttempt).findByRole("listitem", { name: "big.json" })).toHaveTextContent("+2");
    expect(asked.toSorted()).toEqual(["big.json?side=attempt", "big.json?side=main"]);
  });
});

/** Where `t2a1`'s head meets `main`: what its waiting run's diff starts from. */
const BASE = "ba5e".padEnd(40, "1");

/** Run `id` waiting for the owner on `t2a1` at `SHA`, naming DEPLOY and PREVIEW, as the runs list gives it. */
function waitingRun(id: number, fields: Partial<RunWithOutcome> = {}): Run {
  return listed(id, {
    line: "t2a1",
    status: "waiting",
    trusted: false,
    startedAt: null,
    finishedAt: null,
    gate: null,
    cancellable: true,
    waiting: { head: SHA, attempt: "t2a1", base: BASE, secrets: ["DEPLOY", "PREVIEW"] },
    ...fields,
  });
}

/**
 * Serves `runs` to `?status=waiting`, a page of `PAGE` at a time, and starts a run at the sha posted,
 * recording each; any sha but `SHA` is stale.
 */
function serveWaiting(runs: Run[], started: { id: number; sha: string }[] = []) {
  return [
    http.get("*/api/projects/:owner/:project/runs", ({ request }) => {
      const query = new URL(request.url).searchParams;
      if (query.get("status") !== "waiting") return HttpResponse.json({ runs: [], next: null });
      const cursor = query.get("cursor");
      const from = cursor === null ? 0 : runs.findIndex((run) => run.id < Number(cursor));
      const page = runs.slice(from, from + PAGE);
      const last = page.at(-1);
      return HttpResponse.json({ runs: page, next: from + PAGE < runs.length && last ? last.id : null });
    }),
    http.post("*/api/projects/:owner/:project/runs/:id/start", async ({ params, request }) => {
      const { sha } = (await request.json()) as { sha: string };
      const id = Number(params["id"]);
      started.push({ id, sha });
      if (sha !== SHA) {
        const message = `t2a1 moved on since run ${id} began to wait`;
        return HttpResponse.json({ error: { code: "invalidState", message } }, { status: 409 });
      }
      return HttpResponse.json(runDetail(id, SHA, { status: "queued", trigger: "start" }));
    }),
  ];
}

describe("runs waiting for you", () => {
  it("lists them on the runs tab, each with its line, head, a diff from its base, its secrets and Start", async () => {
    const started: { id: number; sha: string }[] = [];
    server.use(...serveWaiting([waitingRun(8)], started));
    const { user } = await renderApp("/ada/alpha/runs");
    const waiting = within(await section("Waiting for you")).getByRole("listitem", { name: "Run 8" });
    expect(waiting).toHaveTextContent("Run 8t2a1a1b2c3dDiffSecrets: DEPLOY, PREVIEW");
    expect(within(waiting).getByRole("link", { name: "Run 8" })).toHaveAttribute("href", "/ada/alpha/runs/8");
    // Every commit Start would run, not just the head's last: a change can't hide in an earlier one.
    expect(within(waiting).getByRole("link", { name: "Diff" })).toHaveAttribute(
      "href",
      `/ada/alpha/compare/${BASE}...${SHA}?attempt=t2a1`,
    );
    await user.click(within(waiting).getByRole("button", { name: "Start run 8" }));
    await waitFor(() => expect(started).toEqual([{ id: 8, sha: SHA }]));
  });

  it("lists them on the project home too, a held landing's approved head diffed from main", async () => {
    const landing = waitingRun(9, {
      line: "main",
      pipeline: "main",
      trigger: "merge",
      sha: null,
      waiting: { head: SHA, attempt: "t2a1", base: null, secrets: ["DEPLOY"] },
    });
    server.use(...serveWaiting([landing]));
    await renderApp("/ada/alpha");
    const waiting = within(await section("Waiting for you")).getByRole("listitem", { name: "Run 9" });
    expect(waiting).toHaveTextContent("Run 9maina1b2c3d");
    expect(within(waiting).getByRole("link", { name: "Diff" })).toHaveAttribute(
      "href",
      `/ada/alpha/compare/main...${SHA}?attempt=t2a1`,
    );
    expect(within(waiting).getByRole("button", { name: "Start run 9" })).toBeInTheDocument();
  });

  it("lists every one waiting, past the first page", async () => {
    server.use(...serveWaiting([waitingRun(8), waitingRun(7), waitingRun(6), waitingRun(5), waitingRun(4)]));
    await renderApp("/ada/alpha/runs");
    const list = await section("Waiting for you");
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((li) => li.getAttribute("aria-label")),
      ).toEqual(["Run 8", "Run 7", "Run 6", "Run 5", "Run 4"]),
    );
  });

  it("opens the diff from the run's base to its head, every file Start would run", async () => {
    const asked: string[] = [];
    server.use(
      ...serveWaiting([waitingRun(8)]),
      serveCompare((to, from) => [addedFile(`${from.slice(0, 4)}-${to.slice(0, 4)}.ts`)], asked),
    );
    const { user, path } = await renderApp("/ada/alpha/runs");
    const waiting = within(await section("Waiting for you")).getByRole("listitem", { name: "Run 8" });
    await user.click(within(waiting).getByRole("link", { name: "Diff" }));
    await waitFor(() => expect(path()).toBe(`/ada/alpha/compare/${BASE}...${SHA}?attempt=t2a1`));
    expect(await screen.findByRole("heading", { name: "Changes from ba5e111 to a1b2c3d" })).toBeInTheDocument();
    expect(await screen.findByRole("listitem", { name: "ba5e-a1b2.ts" })).toBeInTheDocument();
    expect(asked).toEqual([`${BASE}...${SHA}?attempt=t2a1`]);
    expect(within(views()).getByRole("link", { name: "Commits" })).toHaveAttribute("aria-current", "page");
  });

  it("shows why Start was refused", async () => {
    const stale = waitingRun(8, {
      waiting: { head: "b".repeat(40), attempt: "t2a1", base: BASE, secrets: ["DEPLOY"] },
    });
    server.use(...serveWaiting([stale]));
    const { user } = await renderApp("/ada/alpha/runs");
    await user.click(await screen.findByRole("button", { name: "Start run 8" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("t2a1 moved on since run 8 began to wait");
  });

  it("shows no Waiting for you, and no Start, to anyone but the owner", async () => {
    server.use(
      http.get("*/api/projects/bob/gamma", () => HttpResponse.json(project("gamma", { ...me.user, ...bob }))),
      ...serveWaiting([waitingRun(8)]),
      serveRun({ ...runDetail(8, SHA, { outcome: null, result: null }), ...waitingRun(8) }),
    );
    await renderApp("/bob/gamma/runs/8");
    expect(await screen.findByLabelText("Run")).toHaveTextContent("Would holdDEPLOY, PREVIEW");
    await within(views()).findByRole("link", { name: "Runs" });
    expect(screen.queryByRole("button", { name: /Start/u })).toBeNull();
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  });

  it("offers Start on a waiting run's page, with the secrets it would hold", async () => {
    const started: { id: number; sha: string }[] = [];
    server.use(
      ...serveWaiting([], started),
      serveRun({ ...runDetail(8, SHA, { outcome: null, result: null }), ...waitingRun(8) }),
    );
    const { user } = await renderApp("/ada/alpha/runs/8");
    expect(await screen.findByLabelText("Run")).toHaveTextContent("Would holdDEPLOY, PREVIEW");
    await user.click(await screen.findByRole("button", { name: "Start run 8" }));
    await waitFor(() => expect(started).toEqual([{ id: 8, sha: SHA }]));
  });
});
