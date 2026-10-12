import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { RunDetail, Verdict } from "@/lib/api";
import type { ArenaAttempt, Metric } from "@/lib/arena";
import { renderApp } from "./app";
import { addedFile, arenaAttempt, me, result, serveArena, serveCompare, server, task } from "./server";

/** t1a1, passing, scored by run 7 with a required `test` and an optional `lint`, both logged. */
const scored = (fields: Partial<ArenaAttempt> = {}) =>
  arenaAttempt(1, 1, {
    status: "done",
    result: result({
      run: 7,
      checks: [
        { name: "test", required: true, outcome: "passed", durationMs: 1200, metrics: {}, notes: [] },
        { name: "lint", required: false, outcome: "failed", durationMs: 300, metrics: {}, notes: [] },
      ],
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
const run = (id: number, sha: string, fields: Partial<RunDetail> = {}): RunDetail => ({
  id,
  ref: "t1a1",
  sha,
  trigger: "push",
  status: "done",
  requestedBy: null,
  alias: null,
  createdAt: me.user.createdAt,
  startedAt: me.user.createdAt,
  finishedAt: me.user.createdAt,
  superseded: false,
  error: null,
  result: result(),
  ...fields,
});

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

/** Opens task t1 with `attempts`, then t1a1's details from its lane menu. */
async function openDetails(
  attempts: ArenaAttempt[],
  { metrics = [], runs = [], verdicts = [] }: { metrics?: Metric[]; runs?: RunDetail[]; verdicts?: Verdict[] } = {},
) {
  server.use(
    serveCompare((to) => [addedFile(`${to.slice(0, 2)}.txt`)]),
    ...serveArena(task(1), attempts, metrics),
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
    expect(within(checks).getByRole("row", { name: /test/u })).toHaveTextContent("testRequiredPassed1.2 s");
    expect(within(checks).getByRole("row", { name: /lint/u })).toHaveTextContent("lintOptionalFailed0.3 s");
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

  it("shows its metrics with their units, its preview, and its run history with superseded runs dimmed", async () => {
    const head = scored({
      result: result({ preview: { status: "ready", url: "https://t1a1.preview.test" }, metrics: { coverage: 81.5 } }),
    });
    const { sheet } = await openDetails([head, arenaAttempt(1, 2)], {
      metrics: [{ name: "coverage", unit: "%", order: "desc" }],
      runs: [
        run(9, String(head.sha), { trigger: "rescore", status: "running", finishedAt: null, result: null }),
        run(8, String(head.sha)),
        run(5, "0ld".padEnd(40, "0"), { superseded: true, result: result({ gate: "failed" }) }),
      ],
    });
    const metrics = within(sheet).getByRole("region", { name: "Metrics" });
    expect(metrics).toHaveTextContent("coverage81.5%");
    expect(metrics).toHaveTextContent("Files changed1");
    expect(within(sheet).getByRole("link", { name: "Open preview" })).toHaveAttribute(
      "href",
      "https://t1a1.preview.test",
    );
    const runs = await within(sheet).findByRole("list", { name: "Runs" });
    const items = within(runs).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Run 9", "Run 8", "Run 5"]);
    expect(items[0]).toHaveTextContent("Run 9RescoreRunning11ccccc");
    expect(items[1]).toHaveTextContent("Run 8PushDone11cccccGate passed");
    expect(items[2]).toHaveTextContent("Run 5PushDone0ld0000Gate failedSuperseded");
    expect(items[2]).toHaveAttribute("data-superseded", "true");
    expect(items[1]).toHaveAttribute("data-superseded", "false");
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
