import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { RunDetail, Verdict } from "@/lib/api";
import type { ArenaAttempt, Metric } from "@/lib/arena";
import type { RunStep } from "@/lib/runs";
import { renderApp } from "./app";
import {
  addedFile,
  arenaAttempt,
  check,
  me,
  NO_VOTE,
  result,
  runDetail,
  scoredMetrics,
  serveArena,
  serveCompare,
  server,
  step,
  task,
} from "./server";

/** t1a1, passing, scored by run 7 with `test` and `lint`, both logged. */
const scored = (fields: Partial<ArenaAttempt> = {}) =>
  arenaAttempt(1, 1, {
    status: "done",
    result: result({
      run: 7,
      checks: [check("test", "passed", 1200), check("lint", "passed", 300)],
      logs: ["setup.1", "test", "lint"],
    }),
    ...fields,
  });

/** A log body that arrives in `chunks`, one at a time. */
function streamed(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Serves every log of run 7 as `logs` gives it by name. */
const serveLogs = (logs: Record<string, string[]>) =>
  http.get("*/api/projects/:owner/:project/runs/7/logs/:name", ({ params }) => {
    const chunks = logs[String(params["name"])];
    return chunks === undefined
      ? HttpResponse.json({ error: { code: "notFound", message: "no such log" } }, { status: 404 })
      : new HttpResponse(streamed(chunks), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  });

/** Run `id` of t1a1 at `sha`, done with a passing result, as the runs list gives it. */
const run = (id: number, sha: string, fields: Partial<RunDetail> = {}): RunDetail =>
  runDetail(id, sha, { requestedBy: null, finishedAt: me.user.createdAt, ...fields });

/** A verdict on t1a1 by `reviewer` at `head`, on the current head unless `superseded`. */
const verdict = (head: string, fields: Partial<Verdict> = {}): Verdict => ({
  reviewer: { id: me.user.id, handle: me.user.handle },
  alias: null,
  head,
  recommendation: "merge",
  body: "Looks good.",
  at: me.user.createdAt,
  superseded: false,
  ...fields,
});

/**
 * Opens task t1 with `attempts`, then t1a1's details from its lane menu. Run 7, which scored the
 * current result, has `steps` (just `test` unless given others).
 */
async function openDetails(
  attempts: ArenaAttempt[],
  {
    metrics = [],
    runs = [],
    verdicts = [],
    steps = [step("test")],
  }: { metrics?: Metric[]; runs?: RunDetail[]; verdicts?: Verdict[]; steps?: RunStep[] } = {},
) {
  const current = runDetail(7, "11".padEnd(40, "c"));
  server.use(
    serveCompare((to) => [addedFile(`${to.slice(0, 2)}.txt`)]),
    ...serveArena(task(1), attempts, metrics),
    http.get("*/api/projects/:owner/:project/runs/7", () =>
      HttpResponse.json({ ...current, outcome: current.outcome === null ? null : { ...current.outcome, steps } }),
    ),
    http.get("*/api/projects/:owner/:project/attempts/t1a1/runs", () => HttpResponse.json({ runs })),
    http.get("*/api/projects/:owner/:project/attempts/t1a1/verdicts", () => HttpResponse.json({ verdicts })),
  );
  const rendered = await renderApp("/ada/alpha/tasks/t1");
  const lane = await screen.findByRole("region", { name: "Lane t1a1" });
  await rendered.user.click(within(lane).getByRole("button", { name: "t1a1 actions" }));
  await rendered.user.click(await screen.findByRole("menuitem", { name: "Checks, logs and verdicts" }));
  return { ...rendered, sheet: await screen.findByRole("dialog", { name: "t1a1" }) };
}

describe("an attempt's details", () => {
  it("lists its checks, and streams a check's log", async () => {
    server.use(serveLogs({ test: ["running 3 tests\n", "ok 3\n"] }));
    const { user, sheet } = await openDetails([scored(), arenaAttempt(1, 2)]);
    const checks = within(sheet).getByRole("table", { name: "Checks" });
    expect(within(checks).getByRole("row", { name: /test/u })).toHaveTextContent("testPassed1.2 s");
    expect(within(checks).getByRole("row", { name: /lint/u })).toHaveTextContent("lintPassed0.3 s");
    await user.click(within(sheet).getByRole("button", { name: "test log" }));
    const log = await within(sheet).findByRole("log", { name: "test" });
    expect(await within(sheet).findByText(/ok 3/u)).toBe(log);
    expect(log).toHaveTextContent("running 3 tests ok 3");
  });

  it("says when a large log was truncated in the middle", async () => {
    server.use(serveLogs({ lint: ["head of it\n[throng: truncated 1048576 of 6291456 bytes]\n", "tail of it\n"] }));
    const { user, sheet } = await openDetails([scored(), arenaAttempt(1, 2)]);
    await user.click(within(sheet).getByRole("button", { name: "lint log" }));
    expect(await within(sheet).findByRole("note")).toHaveTextContent(
      "This log was too large to keep whole: 1048576 of its 6291456 bytes were left out of the middle.",
    );
    expect(within(sheet).getByRole("log", { name: "lint" })).toHaveTextContent("tail of it");
  });

  it("shows its metrics with their units, its url metrics as links, and its run history with superseded runs dimmed", async () => {
    const head = scored({
      result: result({
        metrics: scoredMetrics({
          values: { coverage: 81.5 },
          urls: { preview_url: "https://t1a1.preview.test/" },
        }),
      }),
    });
    const { sheet } = await openDetails([head, arenaAttempt(1, 2)], {
      metrics: [
        { name: "coverage", from: "test.coverage.pct", type: "number", unit: "%", order: "desc", source: "project" },
        { name: "preview_url", from: "preview.out.url", type: "string", format: "url", source: "project" },
      ],
      runs: [
        run(9, String(head.sha), { trigger: "rescore", status: "running", finishedAt: null, gate: null }),
        run(8, String(head.sha)),
        run(5, "0ld".padEnd(40, "0"), { superseded: true, gate: "failed" }),
      ],
    });
    const section = within(sheet).getByRole("region", { name: "Metrics" });
    expect(section).toHaveTextContent("coverage81.5%");
    expect(section).toHaveTextContent("Files changed1");
    expect(within(section).getByRole("link", { name: "https://t1a1.preview.test/" })).toHaveAttribute(
      "href",
      "https://t1a1.preview.test/",
    );
    expect(within(sheet).queryByRole("link", { name: "Open preview" })).toBeNull();
    const runs = await within(sheet).findByRole("list", { name: "Runs" });
    const items = within(runs).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Run 9", "Run 8", "Run 5"]);
    expect(items[0]).toHaveTextContent("Run 9RescoreRunning11ccccc");
    expect(items[1]).toHaveTextContent("Run 8PushDone11cccccGate passed");
    expect(items[2]).toHaveTextContent("Run 5PushDone0ld0000Gate failedSuperseded");
    expect(items[2]).toHaveAttribute("data-superseded", "true");
    expect(items[1]).toHaveAttribute("data-superseded", "false");
    expect(within(items[1] as HTMLElement).getByRole("link", { name: "Run 8" })).toHaveAttribute(
      "href",
      "/ada/alpha/runs/8",
    );
  });

  it("shows no Steps section and no setup failure for a run with only setups and checks", async () => {
    const { sheet } = await openDetails([scored(), arenaAttempt(1, 2)], {
      steps: [step("setup.1", { kind: "setup" }), step("test"), step("lint")],
    });
    await within(sheet).findByRole("table", { name: "Checks" });
    expect(within(sheet).queryByRole("region", { name: "Steps" })).toBeNull();
    expect(within(sheet).queryByText(/Setup failed/u)).toBeNull();
  });

  it("says which setup failed when one did", async () => {
    const failed = scored({ result: result({ run: 7, gate: "failed", checks: [], logs: ["setup.1", "setup.2"] }) });
    const { sheet } = await openDetails([failed, arenaAttempt(1, 2)], {
      steps: [step("setup.1", { kind: "setup" }), step("setup.2", { kind: "setup", outcome: "failed" })],
    });
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Setup failed: setup.2");
  });

  it("adds a Steps section with each post-gate step's outcome and log when the run had them", async () => {
    server.use(serveLogs({ deploy: ["deployed\n"] }));
    const { user, sheet } = await openDetails([scored(), arenaAttempt(1, 2)], {
      steps: [
        step("test"),
        step("migrate", { kind: "step", durationMs: 2000 }),
        step("deploy", { kind: "step", outcome: "failed", durationMs: 65_000 }),
      ],
    });
    const section = await within(sheet).findByRole("region", { name: "Steps" });
    const table = within(section).getByRole("table", { name: "Steps" });
    expect(within(table).getByRole("row", { name: "migrate" })).toHaveTextContent("migratePassed2.0 s");
    expect(within(table).getByRole("row", { name: "deploy" })).toHaveTextContent("deployFailed1m 05s");
    await user.click(within(section).getByRole("button", { name: "deploy log" }));
    expect(await within(section).findByRole("log", { name: "deploy" })).toHaveTextContent("deployed");
  });

  it("lists its verdicts as markdown, dimming those on an earlier head", async () => {
    const head = scored();
    const { sheet } = await openDetails([head, arenaAttempt(1, 2)], {
      verdicts: [
        verdict("0ld".padEnd(40, "0"), {
          reviewer: { id: "u3", handle: "cy" },
          recommendation: "reject",
          body: "Breaks **login**.",
          superseded: true,
        }),
        verdict(String(head.sha), { reviewer: { id: "u3", handle: "cy" }, alias: "reviewer-bot", body: "Fixed." }),
      ],
    });
    const list = await within(sheet).findByRole("list", { name: "Verdicts" });
    const [old, current] = within(list).getAllByRole("listitem");
    expect(old).toHaveTextContent("cyRejecton 0ld0000Superseded");
    expect(old).toHaveAttribute("data-superseded", "true");
    expect((await within(old as HTMLElement).findByText("login")).tagName).toBe("STRONG");
    expect(current).toHaveTextContent("cy (reviewer-bot)Mergeon 11cccccFixed.");
    expect(current).toHaveAttribute("data-superseded", "false");
  });

  it("doesn't offer its author the verdict form", async () => {
    const { sheet } = await openDetails([
      scored({ author: { id: me.user.id, handle: me.user.handle } }),
      arenaAttempt(1, 2),
    ]);
    await within(sheet).findByText("No verdicts yet.");
    expect(within(sheet).queryByRole("form", { name: "Post verdict" })).toBeNull();
  });

  it("posts a verdict, then shows it and the new counts on the rail", async () => {
    const head = scored();
    let posted: Verdict | null = null;
    const sent: unknown[] = [];
    const { user, sheet } = await openDetails([head, arenaAttempt(1, 2)]);
    server.use(
      http.post("*/api/projects/:owner/:project/attempts/t1a1/verdicts", async ({ request }) => {
        const body = (await request.json()) as Pick<Verdict, "recommendation" | "body">;
        sent.push(body);
        posted = verdict(String(head.sha), body);
        return HttpResponse.json(posted, { status: 201 });
      }),
      http.get("*/api/projects/:owner/:project/attempts/t1a1/verdicts", () =>
        HttpResponse.json({ verdicts: posted === null ? [] : [posted] }),
      ),
      http.get("*/api/projects/:owner/:project/tasks/:t/arena", () => {
        const counts = { head: head.sha, merge: 0, revise: posted === null ? 0 : 1, reject: 0 };
        return HttpResponse.json({
          ...NO_VOTE,
          task: "t1",
          metrics: [],
          attempts: [{ ...head, verdicts: counts }, arenaAttempt(1, 2)],
        });
      }),
    );
    const form = within(sheet).getByRole("form", { name: "Post verdict" });
    await user.click(within(form).getByRole("radio", { name: "Revise" }));
    await user.type(within(form).getByRole("textbox", { name: "Explanation" }), "Needs a test for *empty* input.");
    await user.click(within(form).getByRole("button", { name: "Post verdict" }));
    const list = await within(sheet).findByRole("list", { name: "Verdicts" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("adaReviseon 11ccccc");
    expect(sent).toEqual([{ recommendation: "revise", body: "Needs a test for *empty* input." }]);
    expect(within(form).getByRole("textbox", { name: "Explanation" })).toHaveValue("");
    await user.keyboard("{Escape}");
    const card = within(screen.getByRole("list", { name: "Attempts" })).getByRole("button", { name: "t1a1" });
    expect(within(card).getByLabelText("Verdicts")).toHaveTextContent("0 merge1 revise0 reject");
  });
});
