// End-to-end suite against a deployed throng Worker and real Artifacts.
//
//   THRONG_URL=https://throng.<subdomain>.workers.dev SPIKE_TOKEN=... pnpm e2e [scenario...]
//
// Merge queue scenarios, through the product API (`/api`) and the git proxy (`/git`) as the e2e user:
// zeroconfig (no config: the gate passes with no checks; selecting an attempt closes its sibling, and
// the merge request lands as a two-parent merge commit with the Throng trailers; both attempts are
// archived under `refs/attempts/`), conflict (two tasks' attempts edit the same line: the first
// lands, the second is dequeued with reason `conflict` and the expected hunk; its author merges main
// and pushes, which moves it to `needsReview`; approved again, it lands), needsreview (a push to a
// queued or landing merge request's source dequeues it with `newPush` to `needsReview`, and it
// doesn't requeue on its own once the new head passes).
//
// The arena scenario, arena, drives throng-web in Playwright's Chromium (THRONG_WEB_URL; see
// `e2e-browser.ts`): two scored attempts load as lanes against their base, by file lines up their
// files, and selecting one there lands its merge request and closes the task.
//
// Scoring scenarios, through the e2e routes (`/e2e/*`): metrics (a passing project whose checks report metrics), failing (a required check fails the gate),
// invalid (an invalid config fails the gate with a config entry), preview (a passing gate deploys a
// Worker Preview built with `preview.command`, and its URL serves it), coalesce (two quick pushes; the first
// run is cancelled and only the newest sha is scored), intrusion (an attempt's checks try to push to
// the origin and call the Cloudflare API; both fail), deps (setup installs an npm dependency from the
// registry), refs (attempt archive refs: pushable, listed, kept across pushes to main, and copied by
// the Worker).
//
// Every project id starts with E2E_PROJECT_PREFIX (default `e2e`; lowercase alphanumeric, starting
// with `e2e`, which the Worker's e2e routes insist on). Each scenario deletes what its projects made
// (D1 rows, Durable Object storage, logs and repos), and the run revokes its token when it ends.
// `pnpm e2e cleanup` deletes every project under an explicitly set E2E_PROJECT_PREFIX, including those
// a failed or cancelled run left behind.

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ARCHIVE_REF_PREFIX, archiveRef } from "../src/archive.ts";
import { originRepo } from "../src/repos.ts";
import { openBrowser } from "./e2e-browser.ts";
import type { BrowserSession } from "./e2e-browser.ts";
import { basicAuthHeader, parseCommit } from "./e2e-git.ts";
import type { Commit } from "./e2e-git.ts";

const run = promisify(execFile);
const FIXTURE = new URL("../fixtures/fixture-worker/", import.meta.url).pathname;
const WRANGLER_CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;
const POLL_MS = 1000;
/** The fixture's own tests, as a check. */
const TEST_CHECK = `checks:
  - name: test
    command: npm test
`;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

const baseUrl = requireEnv("THRONG_URL").replace(/\/$/u, "");
const e2eSecret = requireEnv("SPIKE_TOKEN");
const projectPrefix = process.env.E2E_PROJECT_PREFIX || "e2e";
assert(
  /^e2e[a-z0-9]*$/u.test(projectPrefix),
  `E2E_PROJECT_PREFIX must be lowercase alphanumeric and start with e2e: ${projectPrefix}`,
);

interface JournalEntry {
  id: number;
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

interface Grant {
  remote: string;
  token: string;
}

/** An attempt's fork: its grant, and the project and attempt that scoring requests name. */
interface Fork extends Grant {
  project: string;
  attempt: string;
}

class Timeline {
  readonly #start = Date.now();
  readonly #rows: [string, number][] = [];

  mark(label: string, at = Date.now()): void {
    this.#rows.push([label, at]);
  }

  print(): void {
    let previous = this.#start;
    for (const [label, at] of this.#rows.toSorted((a, b) => a[1] - b[1])) {
      console.log(`  ${String(at - this.#start).padStart(7)} ms  (+${String(at - previous).padStart(6)})  ${label}`);
      previous = at;
    }
  }
}

/** A check in a run's result: Throng's own (`_diff`, `_preview`) are `platform`, the config's `project`. */
interface Check {
  name: string;
  source: "platform" | "project" | "task";
  required: boolean;
  outcome: string;
  durationMs: number;
  notes: string[];
}

/** One metric in a run's result, as far as the scenarios read it. */
interface Metric {
  source: "platform" | "project" | "task";
  type: "number" | "string" | "enum";
  value: number | string | null;
  note?: string;
}

/** What a run reports, as far as the scenarios read it (see `src/results.ts`). */
interface Run {
  id: number;
  sha: string;
  status: string;
  result: {
    base: string | null;
    config: { kind: string; error?: string };
    gate: "passed" | "failed";
    checks: Check[];
    metrics: Record<string, Metric>;
    logs: string[];
  } | null;
  error: string | null;
}

/** The checks a project's config defined, without Throng's own. */
const configChecks = (result: { checks: Check[] }) => result.checks.filter((c) => c.source !== "platform");

/** `_diff`'s files changed, lines added and lines deleted. */
const diffSize = (result: { metrics: Record<string, Metric> }) =>
  ["filesChanged", "additions", "deletions"].map((key) => result.metrics[`_diff.${key}`]?.value ?? null);

/** A project driven through the product API as the e2e user (see `setUpRealProject`). */
interface RealProject {
  project: string;
  owner: string;
  work: string;
  origin: Grant;
  /** The e2e user's Throng token, for `/api` and the git proxy. */
  token: string;
  user: { id: string; handle: string };
}

/** What the scenarios read of the API's attempt, merge request, dequeue and scoring shapes (`src/api.ts`). */
interface Attempt {
  ref: string;
  state: string;
  archivedSha: string | null;
  mergeRequest: { state: string; lastDequeue: { reason: string } | null } | null;
}

interface MergeRequest {
  task: string;
  attempt: string;
  state: "pending" | "queued" | "landing" | "needsReview" | "merged" | "cancelled";
  approvedHead: string;
  lastDequeue: { reason: string; at: string } | null;
  mergeSha: string | null;
}

interface ConflictHunk {
  startLine: number;
  base: string[];
  main: string[];
  attempt: string[];
}

interface Dequeue {
  reason: string;
  at: string;
  details: {
    attempt: string;
    head: string;
    main: string;
    base: string;
    files: { path: string; type: string; truncated: boolean; hunks?: ConflictHunk[] }[];
  } | null;
}

interface ApiResult {
  config: { kind: string };
  gate: "passed" | "failed";
  checks: Check[];
  metrics: Record<string, Metric>;
}

interface ScoringStatus {
  status: "none" | "queued" | "running" | "done" | "errored";
  sha: string | null;
  result?: ApiResult;
}

const scenarios: Record<string, () => Promise<void>> = {
  zeroconfig,
  conflict,
  needsreview,
  arena,
  metrics,
  failing,
  invalid,
  preview,
  coalesce,
  intrusion,
  deps,
  refs,
};

async function main(): Promise<void> {
  const names = process.argv.slice(2);
  if (names[0] === "cleanup") return deleteRun();
  const chosen = names.length > 0 ? names : Object.keys(scenarios);
  let failed = false;
  try {
    for (const name of chosen) {
      const scenario = scenarios[name];
      if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
      console.log(`\n== ${name}`);
      try {
        await scenario();
        console.log(`== ${name}: PASS`);
      } catch (error) {
        failed = true;
        console.error(`== ${name}: FAIL`, error);
      }
    }
  } finally {
    await revokeE2eToken();
  }
  process.exitCode = failed ? 1 : 0;
}

/**
 * Deletes everything every project under E2E_PROJECT_PREFIX made. It must be set explicitly, so the
 * default never sweeps.
 */
async function deleteRun(): Promise<void> {
  requireEnv("E2E_PROJECT_PREFIX");
  const { deleted } = await api<{ deleted: string[] }>("DELETE", `/e2e/projects?prefix=${projectPrefix}`);
  console.log(`deleted ${deleted.length} project(s) starting with ${projectPrefix}`);
  for (const project of deleted) console.log(`  deleted ${project}`);
}

/**
 * No `.throng/config.yml`: the gate passes with no checks. Selecting t1a1 closes its sibling t1a2,
 * and the merge request lands as a merge commit of main and the approved head, with the trailers.
 * Both attempts' forks are archived under `refs/attempts/` in the origin.
 */
async function zeroconfig(): Promise<void> {
  const timeline = new Timeline();
  const p = await setUpRealProject(timeline);
  const fixture = (await git(p.work, "rev-parse", "HEAD")).trim();
  const [t1, a1, a2] = ["t1", "t1a1", "t1a2"];
  await createTask(p, t1, "Greet from a1");
  await createAttempts(p, t1, [a1, a2], timeline);

  const head = await editAndPush(p, a1, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  await throng(p, "POST", `/attempts/${a1}/open`);
  timeline.mark("t1a1 pushed and opened");
  const scoring = await scoredHead(p, a1, head);
  const { result } = scoring;
  assert(result.config.kind === "none", `expected no config, got ${JSON.stringify(result.config)}`);
  assert(result.gate === "passed" && configChecks(result).length === 0, "expected a passing gate with no checks");
  assert(
    JSON.stringify(result.checks.map((c) => [c.name, c.outcome])) === '[["_diff","passed"],["_preview","skipped"]]',
    `expected only Throng's own checks, _preview skipped: ${JSON.stringify(result.checks)}`,
  );
  assert(diffSize(result).join() === "1,1,1", `unexpected diff size ${JSON.stringify(diffSize(result))}`);

  const selected = await throng<MergeRequest>(p, "POST", `/tasks/${t1}/selection`, { attempt: a1 });
  timeline.mark("t1a1 selected");
  assert(selected.approvedHead === head, `approved ${selected.approvedHead}, expected ${head}`);
  const sibling = await throng<Attempt>(p, "GET", `/attempts/${a2}`);
  assert(sibling.state === "closed", `selecting ${a1} left ${a2} ${sibling.state}`);

  const mainSha = await mergedSha(p, t1);
  timeline.mark("t1 merged");
  const onMain = await api<{ sha: string }>("GET", `/e2e/repos/${originRepo(p.project)}/head`);
  assert(onMain.sha === mainSha, `main is ${onMain.sha}, expected the merge commit ${mainSha}`);

  const commit = await readCommit(p, mainSha);
  assert(
    JSON.stringify(commit.parents) === JSON.stringify([fixture, head]),
    `expected parents [main, approved head], got ${JSON.stringify(commit.parents)}`,
  );
  assert(commit.subject === `Merge ${a1}: Greet from a1`, `unexpected subject ${commit.subject}`);
  const trailers = {
    "Throng-Task": [t1],
    "Throng-Attempt": [a1],
    "Throng-Merge-Request": [t1],
    "Approved-by": [`${p.user.handle} <${p.user.id}+${p.user.handle}@users.noreply.throng>`],
  };
  assert(
    JSON.stringify(commit.trailers) === JSON.stringify(trailers),
    `unexpected trailers ${JSON.stringify(commit.trailers)}`,
  );
  const greeting = await git(p.work, "show", `${mainSha}:src/greeting.js`);
  assert(greeting.includes("hello from a1"), "main does not contain the attempt's change");

  // Custom refs: the merged attempt and the sibling the selection closed are both archived.
  const task = await throng<{ state: string }>(p, "GET", `/tasks/${t1}`);
  assert(task.state === "closed", `landing left ${t1} ${task.state}`);
  await assertArchived(p, a1, head);
  await assertArchived(p, a2, fixture);
  await finish(p.project, p.work, timeline);
}

/**
 * Two tasks' attempts, forked from the same main, edit the same line. t1a1 lands; t2a1 is dequeued
 * with reason `conflict` and the expected hunk. Its author merges main and pushes, which moves it to
 * `needsReview`; approved again, it lands.
 */
async function conflict(): Promise<void> {
  const timeline = new Timeline();
  const p = await setUpRealProject(timeline);
  const fixture = (await git(p.work, "rev-parse", "HEAD")).trim();
  const [t1, a1, t2, a2] = ["t1", "t1a1", "t2", "t2a1"];
  await createTask(p, t1, "Greet from a1");
  await createTask(p, t2, "Greet from a2");
  // Fork both before either lands, so both start from the same main.
  await createAttempts(p, t1, [a1], timeline);
  await createAttempts(p, t2, [a2], timeline);

  const first = await editAndPush(p, a1, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  await throng(p, "POST", `/attempts/${a1}/open`);
  await git(p.work, "checkout", "-q", "--detach", fixture);
  const second = await editAndPush(p, a2, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a2"'), "a2");
  await throng(p, "POST", `/attempts/${a2}/open`);
  timeline.mark("both pushed and opened");

  await throng(p, "POST", `/tasks/${t1}/selection`, { attempt: a1 });
  const mainSha = await mergedSha(p, t1);
  timeline.mark("t1 merged");

  await throng(p, "POST", `/tasks/${t2}/selection`, { attempt: a2 });
  timeline.mark("t2a1 selected");
  const dequeued = await mergeRequestUntil(p, t2, (mr) => mr.lastDequeue !== null);
  timeline.mark("t2 dequeued");
  assert(
    dequeued.lastDequeue?.reason === "conflict" && dequeued.state === "pending",
    `expected a conflict dequeue to pending, got ${dequeued.state} ${JSON.stringify(dequeued.lastDequeue)}`,
  );
  const attempt = await throng<Attempt>(p, "GET", `/attempts/${a2}`);
  assert(attempt.mergeRequest?.lastDequeue?.reason === "conflict", "the attempt doesn't show the conflict");

  const { reason, details } = await throng<Dequeue>(p, "GET", `/tasks/${t2}/merge-request/dequeue`);
  assert(reason === "conflict" && details !== null, `unexpected dequeue ${reason}`);
  assert(
    details.attempt === a2 && details.head === second && details.main === mainSha && details.base === fixture,
    `unexpected conflict commits ${JSON.stringify({ ...details, files: undefined })}`,
  );
  const expectedFiles = [
    {
      path: "src/greeting.js",
      type: "content",
      truncated: false,
      hunks: [
        {
          // The fixture's line 2: line 1 is a comment.
          startLine: 2,
          base: ['export const GREETING = "hello";'],
          main: ['export const GREETING = "hello from a1";'],
          attempt: ['export const GREETING = "hello from a2";'],
        },
      ],
    },
  ];
  const files = details.files.map(({ path, type, truncated, hunks }) => ({ path, type, truncated, hunks }));
  assert(
    JSON.stringify(files) === JSON.stringify(expectedFiles),
    `unexpected conflict files ${JSON.stringify(details.files)}`,
  );
  const patch = await throngText(p, `/tasks/${t2}/merge-request/dequeue/files/src/greeting.js/diff?side=main`);
  assert(patch.includes('+export const GREETING = "hello from a1";'), `unexpected main-side diff:\n${patch}`);

  // The author merges main into the attempt and pushes; the approved head no longer matches.
  await fetchMain(p);
  const merge = await git(p.work, "merge", "--no-edit", "FETCH_HEAD").then(
    () => "clean",
    () => "conflicted",
  );
  assert(merge === "conflicted", "expected merging main into t2a1 to conflict locally too");
  const resolved = await editAndPush(
    p,
    a2,
    "src/greeting.js",
    (s) => s.replace(/<<<<<<<[\s\S]*>>>>>>> [^\n]*\n/u, 'export const GREETING = "hello from a1 and a2";\n'),
    "a2: merge main",
  );
  timeline.mark("t2a1 merged main and pushed");
  const review = await mergeRequestUntil(p, t2, (mr) => mr.state !== "pending");
  assert(review.state === "needsReview", `expected needsReview after the push, got ${review.state}`);

  const approved = await throng<MergeRequest>(p, "POST", `/tasks/${t2}/merge-request/approve`);
  assert(approved.approvedHead === resolved, `approved ${approved.approvedHead}, expected ${resolved}`);
  timeline.mark("t2 approved");
  const newMainSha = await mergedSha(p, t2);
  timeline.mark("t2 merged");
  const commit = await readCommit(p, newMainSha);
  assert(
    JSON.stringify(commit.parents) === JSON.stringify([mainSha, resolved]),
    `expected parents [t1's merge, t2a1's head], got ${JSON.stringify(commit.parents)}`,
  );
  const greeting = await git(p.work, "show", `${newMainSha}:src/greeting.js`);
  assert(greeting.includes("hello from a1 and a2"), "main does not contain the resolution");

  const journal = await settle(p.project);
  assert(journal.filter((e) => e.kind === "mainAdvanced").length === 2, "expected exactly two landings");
  await assertArchived(p, a1, first);
  await assertArchived(p, a2, resolved);
  report(timeline, journal);
  await cleanUp(p.project, p.work);
}

/**
 * A push to a queued or landing merge request's source dequeues it with `newPush` to
 * `needsReview`, and it stays there once the new head passes: only an approval requeues it. A slow
 * required check keeps the landing in its retest long enough to push.
 */
async function needsreview(): Promise<void> {
  const timeline = new Timeline();
  const p = await setUpRealProject(timeline, {
    ".throng/config.yml": `checks:
  - name: slow
    command: sleep 90
`,
  });
  const fixture = (await git(p.work, "rev-parse", "HEAD")).trim();
  const [t1, a1] = ["t1", "t1a1"];
  await createTask(p, t1, "Greet slowly");
  await createAttempts(p, t1, [a1], timeline);
  const head = await editAndPush(p, a1, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  await throng(p, "POST", `/attempts/${a1}/open`);
  const scoring = await scoredHead(p, a1, head);
  assert(scoring.result.gate === "passed", `expected the gate to pass: ${JSON.stringify(scoring.result.checks)}`);
  timeline.mark("t1a1 scored");

  await throng(p, "POST", `/tasks/${t1}/selection`, { attempt: a1 });
  const inQueue = await mergeRequestUntil(p, t1, (mr) => mr.state === "queued" || mr.state === "landing");
  timeline.mark(`t1 ${inQueue.state}`);
  const next = await editAndPush(p, a1, "src/greeting.js", (s) => s.replace("from a1", "from a1, again"), "a1: again");
  timeline.mark("pushed while in the queue");

  const dequeued = await mergeRequestUntil(p, t1, (mr) => mr.lastDequeue !== null);
  assert(
    dequeued.lastDequeue?.reason === "newPush" && dequeued.state === "needsReview",
    `expected a newPush dequeue to needsReview, got ${dequeued.state} ${JSON.stringify(dequeued.lastDequeue)}`,
  );
  assert(dequeued.approvedHead === head, "the push changed the approved head");
  const { details } = await throng<Dequeue>(p, "GET", `/tasks/${t1}/merge-request/dequeue`);
  assert(details === null, `a newPush dequeue has no details, got ${JSON.stringify(details)}`);

  // The new head passes too, and still nothing requeues it.
  const rescored = await scoredHead(p, a1, next);
  assert(rescored.result.gate === "passed", "expected the new head's gate to pass");
  timeline.mark("new head scored");
  const journal = await settle(p.project);
  const after = await throng<MergeRequest>(p, "GET", `/tasks/${t1}/merge-request`);
  assert(after.state === "needsReview", `the merge request requeued on its own: ${after.state}`);
  const queue = await throng<{ queue: unknown[] }>(p, "GET", "/merge-queue");
  assert(queue.queue.length === 0, `the merge queue isn't empty: ${JSON.stringify(queue.queue)}`);
  const onMain = await api<{ sha: string }>("GET", `/e2e/repos/${originRepo(p.project)}/head`);
  assert(onMain.sha === fixture, `main moved to ${onMain.sha}`);
  assert(!journal.some((e) => e.kind === "mainAdvanced"), "something landed");
  report(timeline, journal);
  await cleanUp(p.project, p.work);
}

/**
 * The arena in a browser, as the e2e user (the task's creator and the project's owner). t1a1 edits
 * src/greeting.js; t1a2 edits it and src/index.js. With both scored, the task page shows both lanes,
 * each compared against its base (main, as the task has no branch). By file lines up the two files,
 * and t1a1 left src/index.js alone. Selecting t1a1 in its lane lands the merge request, and the page
 * turns into the closed task's summary naming the merge commit.
 */
async function arena(): Promise<void> {
  const web = requireEnv("THRONG_WEB_URL").replace(/\/$/u, "");
  const timeline = new Timeline();
  const p = await setUpRealProject(timeline);
  const fixture = (await git(p.work, "rev-parse", "HEAD")).trim();
  const [t1, a1, a2] = ["t1", "t1a1", "t1a2"];
  await createTask(p, t1, "Greet from the arena");
  await createAttempts(p, t1, [a1, a2], timeline);

  const head1 = await editAndPush(p, a1, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  await git(p.work, "checkout", "-q", "--detach", fixture);
  const index = join(p.work, "src/index.js");
  await writeFile(index, (await readFile(index, "utf8")).replace('?? "world"', '?? "arena"'));
  const head2 = await editAndPush(p, a2, "src/greeting.js", (s) => s.replace('"hello"', '"hi from a2"'), "a2");
  const heads = { [a1]: head1, [a2]: head2 };
  for (const attempt of [a1, a2]) await throng(p, "POST", `/attempts/${attempt}/open`);
  timeline.mark("both pushed and opened");
  for (const [attempt, head] of Object.entries(heads)) {
    const { result } = await scoredHead(p, attempt, head);
    assert(result.gate === "passed", `expected ${attempt}'s gate to pass: ${JSON.stringify(result.checks)}`);
  }
  timeline.mark("both scored");

  const session = await openBrowser({ web, platform: baseUrl, token: p.token });
  try {
    const { page } = session;
    page.setDefaultTimeout(60_000);
    const response = await page.goto(`${web}/${p.owner}/${p.project}/tasks/${t1}`);
    assert(
      new URL(page.url()).origin === new URL(web).origin && response?.ok() === true,
      `the task page answered ${response?.status() ?? "nothing"} at ${page.url()}; is throng-web behind Access?`,
    );

    // Both lanes, each with its own files, compared against its base.
    const lanes = page.getByRole("region", { name: "Lanes" });
    const changed = { [a1]: ["src/greeting.js"], [a2]: ["src/greeting.js", "src/index.js"] };
    for (const [attempt, files] of Object.entries(changed)) {
      const lane = lanes.getByRole("region", { name: `Lane ${attempt}` });
      for (const file of files) await lane.getByRole("region", { name: file, exact: true }).waitFor();
    }
    timeline.mark("arena loaded both lanes");
    for (const [attempt, head] of Object.entries(heads)) {
      const compare = `/api/projects/${p.owner}/${p.project}/compare/${fixture}...${head}?attempt=${attempt}`;
      const compares = session.apiRequests.filter((r) => r.includes("/compare/"));
      assert(compares.includes(compare), `${attempt}'s lane wasn't compared against its base: ${compares.join(", ")}`);
    }

    // By file: one row per file, by path, each saying how many lanes changed it.
    await page.getByText("By file", { exact: true }).click();
    const greetingRow = lanes.getByRole("region", { name: "File src/greeting.js" });
    const indexRow = lanes.getByRole("region", { name: "File src/index.js" });
    await greetingRow.getByText("changed by 2 of 2").waitFor();
    await indexRow.getByText("changed by 1 of 2").waitFor();
    await indexRow.getByRole("group", { name: a1 }).getByText(`${a1} left this file alone.`).waitFor();
    const rows = await lanes
      .getByRole("region", { name: /^File /u })
      .evaluateAll((sections) => sections.map((s) => s.getAttribute("aria-label")));
    assert(
      JSON.stringify(rows) === JSON.stringify(["File src/greeting.js", "File src/index.js"]),
      `unexpected by-file rows ${JSON.stringify(rows)}`,
    );
    timeline.mark("by file lined up");

    // Select t1a1 from its lane, and confirm.
    await lanes
      .getByRole("region", { name: `Lane ${a1}` })
      .getByRole("button", { name: "Select", exact: true })
      .click();
    const confirm = page.getByRole("group", { name: "Confirm selection" });
    await confirm.getByText(`Select ${a1}? The other 1 attempt will be closed and archived.`).waitFor();
    await confirm.getByRole("button", { name: `Select ${a1}`, exact: true }).click();
    await page.getByTestId("merge-request-view").waitFor();
    timeline.mark("t1a1 selected in the arena");

    // Landing closes the task, and the page polls its way to the closed summary.
    const summary = page.getByText(new RegExp(`^${a1} was merged in [0-9a-f]{7}\\.$`, "u"));
    await summary.waitFor({ timeout: CHECK_TIMEOUT_MS });
    timeline.mark("page shows t1 closed");
    const mainSha = await mergedSha(p, t1);
    const shown = await summary.getByRole("link").textContent();
    assert(shown === mainSha.slice(0, 7), `the page names merge commit ${shown}, expected ${mainSha.slice(0, 7)}`);
    const state = await page.locator('[data-slot="task-state"]').textContent();
    assert(state === "Closed", `the page shows ${t1} as ${state}`);
  } catch (error) {
    await describePage(session);
    throw error;
  } finally {
    await session.close();
  }

  const sibling = await throng<Attempt>(p, "GET", `/attempts/${a2}`);
  assert(sibling.state === "closed", `selecting ${a1} left ${a2} ${sibling.state}`);
  await finish(p.project, p.work, timeline);
}

/** Prints where a failed browser scenario's page was and what it said. */
async function describePage({ page }: BrowserSession): Promise<void> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 5000 })
    .catch((error: unknown) => `(unreadable: ${String(error)})`);
  console.error(`page at ${page.url()}:\n${text}`);
}

/** A passing project whose checks report metrics: declared ones are kept, the rest noted. */
async function metrics(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, {
    // The fixture is an ES module package, so no `require`.
    "scripts/metrics.js": `import { writeFileSync } from "node:fs";
writeFileSync(process.env.THRONG_METRICS, JSON.stringify({ coverage: 87.5, stray: 1 }));
`,
    ".throng/config.yml": `checks:
  - name: test
    command: npm test
  - name: coverage
    command: node scripts/metrics.js
    required: false
    metrics:
      - { name: coverage, unit: "%", order: desc }
`,
  });
  const fork = await createAttempt(project, "t1a1", timeline);
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("attempt pushed");

  const result = await scored(project, sha);
  assert(result.gate === "passed", `expected the gate to pass: ${JSON.stringify(result.checks)}`);
  const [test, coverage] = configChecks(result);
  assert(
    test?.outcome === "passed" && coverage?.outcome === "passed",
    `unexpected outcomes ${JSON.stringify(result.checks)}`,
  );
  const reported = result.metrics["coverage"];
  assert(
    reported?.source === "project" && reported.type === "number" && reported.value === 87.5,
    `coverage not recorded as a project number: ${JSON.stringify(reported)}`,
  );
  assert(
    result.metrics["test"]?.type === "enum" && result.metrics["test"].value === "passed",
    `expected test's outcome metric: ${JSON.stringify(result.metrics["test"])}`,
  );
  assert(
    coverage.notes.some((n) => n.includes("stray")),
    "the undeclared metric was not noted",
  );
  assert(
    JSON.stringify(result.logs) === JSON.stringify(["test", "coverage"]),
    `expected both checks' logs stored: ${JSON.stringify(result.logs)}`,
  );
  await finish(project, work, timeline);
}

/** A required check that fails fails the gate; an optional one that passes doesn't save it. */
async function failing(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, {
    ".throng/config.yml": `checks:
  - name: greets
    command: grep -q hello src/greeting.js
  - name: test
    command: npm test
    required: false
`,
  });
  const fork = await createAttempt(project, "t1a1", timeline);
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hi"'), "a1: hi");
  timeline.mark("attempt pushed");

  const result = await scored(project, sha);
  assert(result.gate === "failed", "expected the gate to fail");
  assert(
    configChecks(result)
      .map((c) => c.outcome)
      .join() === "failed,passed",
    `expected failed then passed, got ${JSON.stringify(result.checks)}`,
  );
  await finish(project, work, timeline);
}

/** An invalid config fails the gate with its error on `config`, and runs only Throng's `_diff`. */
async function invalid(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, {
    ".throng/config.yml": `checks:
  - name: Not A Valid Name
    command: npm test
`,
  });
  const fork = await createAttempt(project, "t1a1", timeline);
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("attempt pushed");

  const result = await scored(project, sha);
  assert(result.config.kind === "invalid" && result.gate === "failed", `expected an invalid config to fail the gate`);
  assert(
    result.config.error?.includes("checks[0].name") === true,
    `expected the config's error, got ${JSON.stringify(result.config)}`,
  );
  assert(configChecks(result).length === 0, `expected no config checks, got ${JSON.stringify(result.checks)}`);
  assert(
    result.checks.find((c) => c.name === "_preview")?.notes.join() === "skipped: the config is invalid",
    `expected _preview skipped for the invalid config: ${JSON.stringify(result.checks)}`,
  );
  assert(diffSize(result)[0] === 1, `_diff was not recorded: ${JSON.stringify(result.metrics)}`);
  await finish(project, work, timeline);
}

/**
 * A project with `preview` configured: once the gate passes, the head is built with
 * `preview.command` and deployed as a Worker Preview named `<forkName>-p<projectId>`, whose URL serves
 * the built attempt.
 */
async function preview(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, {
    ".throng/config.yml": `${TEST_CHECK}preview:
  command: sed -i 's/hello from a1/hello from a1, built/' src/greeting.js
`,
  });
  const fork = await createAttempt(project, "t1a1", timeline);
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("attempt pushed");

  const result = await scored(project, sha);
  timeline.mark("scored");
  assert(result.gate === "passed", `expected the gate to pass: ${JSON.stringify(result.checks)}`);
  const check = result.checks.find((c) => c.name === "_preview");
  assert(
    check?.source === "platform" && check.outcome === "passed" && result.metrics["_preview"]?.value === "passed",
    `expected _preview to pass, got ${JSON.stringify(check)}`,
  );
  const deployed = result.metrics["_preview.url"];
  assert(
    deployed?.type === "string" && typeof deployed.value === "string",
    `expected _preview.url, got ${JSON.stringify(deployed)}`,
  );
  const previewUrl = deployed.value;
  assert(
    new URL(previewUrl).hostname.startsWith(`t1a1-p${project}-`),
    `the Preview is not named after the fork and project: ${previewUrl}`,
  );
  assert(result.logs.includes("preview.deploy"), `expected the Preview's log stored: ${JSON.stringify(result.logs)}`);

  // A new Preview's hostname can take a moment to answer.
  const url = `${previewUrl}?name=e2e`;
  const deadline = Date.now() + 2 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const response = await fetch(url).catch((error: unknown) => error);
    last = response instanceof Response ? `${response.status} ${await response.text()}` : String(response);
    if (last === "200 hello from a1, built, e2e") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  timeline.mark("preview answered");
  assert(last === "200 hello from a1, built, e2e", `the Preview at ${url} answered ${last}`);
  await finish(project, work, timeline);
}

/** Two quick pushes to one attempt: the first run is cancelled; only the newest sha is scored. */
async function coalesce(): Promise<void> {
  const timeline = new Timeline();
  // A check slow enough that the second push lands while the first run is still going.
  const { project, work } = await setUpProject(timeline, {
    ".throng/config.yml": `checks:
  - name: slow
    command: sleep 60
`,
  });

  const fork = await createAttempt(project, "t1a1", timeline);
  const first = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hi"'), "a1: first");
  timeline.mark("first push");
  // Wait until the first check is running, so the second push has something to cancel.
  await waitFor(project, (e) => e.kind === "scoringStarted" && e.detail.sha === first);
  timeline.mark("first check started");
  const second = await commitAndPush(
    work,
    fork,
    "src/greeting.js",
    (s) => s.replace('"hi"', '"hi again"'),
    "a1: second",
  );
  timeline.mark("second push");

  await scored(project, second);
  const journal = await settle(project);
  assert(!journal.some((e) => e.kind === "scored" && e.detail.sha === first), "the superseded sha was scored");
  assert(!journal.some((e) => e.kind === "mainAdvanced" && e.detail.head === first), "the superseded sha landed");
  assert(
    journal.some((e) => e.kind === "scoringCancelled" && e.detail.sha === first),
    "the first run was not cancelled",
  );
  report(timeline, journal);
  await cleanUp(project, work);
}

/**
 * The attempt's own test tries to push a forged commit to the origin's main and to reach the
 * Cloudflare API. The test passes only if both are blocked, so a leak fails the gate.
 */
async function intrusion(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, { ".throng/config.yml": TEST_CHECK });
  const origin = (await git(work, "remote", "get-url", "origin")).trim();
  const accountId = /"CF_ACCOUNT_ID":\s*"(\w+)"/u.exec(await readFile(WRANGLER_CONFIG, "utf8"))?.[1];
  assert(accountId !== undefined, "CF_ACCOUNT_ID not found in wrangler.jsonc");
  const fork = await createAttempt(project, "t1a1", timeline);

  const probe = `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("cannot push to the origin", () => {
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"]).toString().trim();
  const forged = execFileSync("git", ["commit-tree", tree, "-p", "HEAD", "-m", "intrusion"]).toString().trim();
  assert.throws(() =>
    execFileSync("git", ["push", ${JSON.stringify(origin)}, \`\${forged}:refs/heads/main\`], { stdio: "pipe", timeout: 30_000 }),
  );
});

test("cannot reach the Cloudflare API", async () => {
  const url = "https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/throng-fixture-worker";
  const status = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status, () => "blocked");
  assert.notEqual(status, 200);
});
`;
  await writeFile(join(work, "test/intrusion.test.js"), probe);
  await git(work, "add", "test/intrusion.test.js");
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("attempt pushed");

  const result = await scored(project, sha);
  assert(result.gate === "passed", `expected the probes to be blocked and pass, got ${JSON.stringify(result.checks)}`);
  const log = await api<{ message: string }[]>("GET", `/e2e/repos/${originRepo(project)}/log?ref=main&limit=20`);
  assert(!log.some((c) => c.message === "intrusion"), "the forged commit reached main");
  await finish(project, work, timeline);
}

/** An attempt adds an npm dependency: setup installs it from the registry and the checks use it. */
async function deps(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, {
    ".throng/config.yml": `setup:
  - npm ci --ignore-scripts --no-audit --no-fund
${TEST_CHECK}`,
  });
  const fork = await createAttempt(project, "t1a1", timeline);

  const pkg = JSON.parse(await readFile(join(work, "package.json"), "utf8")) as Record<string, unknown>;
  await writeFile(
    join(work, "package.json"),
    `${JSON.stringify({ ...pkg, dependencies: { "is-number": "7.0.0" } }, null, 2)}\n`,
  );
  await run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work });
  await writeFile(
    join(work, "test/deps.test.js"),
    `import assert from "node:assert/strict";
import { test } from "node:test";
import isNumber from "is-number";

test("the dependency is installed", () => {
  assert.equal(isNumber(7), true);
});
`,
  );
  await git(work, "add", "package.json", "package-lock.json", "test/deps.test.js");
  const sha = await commitAndPush(
    work,
    fork,
    "src/greeting.js",
    (s) => `import isNumber from "is-number";\n${s.replace('"hello"', 'isNumber(1) ? "hello with deps" : "no deps"')}`,
    "a1: add is-number",
  );
  timeline.mark("attempt pushed");

  const result = await scored(project, sha);
  assert(
    result.gate === "passed",
    `expected the dependency to install and the tests to pass: ${JSON.stringify(result.checks)}`,
  );
  await finish(project, work, timeline);
}

/**
 * Attempt archives: a custom ref under ARCHIVE_REF_PREFIX can be pushed to an origin, is listed by
 * ls-remote, survives a later push to main, and queues no scoring. Then the Worker's own git client
 * (what closing and reopening an attempt use) copies a ref into an origin's archive namespace and
 * back out of it, across two unrelated repos so a real pack has to move.
 */
async function refs(): Promise<void> {
  const timeline = new Timeline();
  const a = await setUpProject(timeline);
  const b = await setUpProject(timeline);
  const raw = `${ARCHIVE_REF_PREFIX}raw`;

  // A plain git push of a commit main doesn't have, straight to the custom ref.
  await writeFile(join(a.work, "archived.txt"), "archived\n");
  await git(a.work, "add", "-A");
  await git(a.work, "commit", "-q", "-m", "archived");
  const archived = (await git(a.work, "rev-parse", "HEAD")).trim();
  await git(a.work, ...auth(a.origin.token), "push", "-q", a.origin.remote, `HEAD:${raw}`);
  timeline.mark(`pushed ${raw}`);
  assert((await lsRemote(a.work, a.origin, raw)) === archived, `${raw} is not listed at ${archived}`);

  // The Worker copies b's main into a's archive namespace, as closing an attempt does.
  const bMain = (await git(b.work, "rev-parse", "HEAD")).trim();
  const copied = await api<{ sha: string | null }>(
    "POST",
    `/e2e/repos/${originRepo(b.project)}/copy-ref?fromRef=refs/heads/main&to=${originRepo(a.project)}&toRef=${archiveRef("t1a1")}`,
  );
  timeline.mark("worker archived b's main into a");
  assert(copied.sha === bMain, `copy-ref returned ${copied.sha}, expected ${bMain}`);
  assert((await lsRemote(a.work, a.origin, archiveRef("t1a1"))) === bMain, "the archive ref is not listed");

  // main moves on; both archive refs stay where they were.
  await git(a.work, "checkout", "-q", "-b", "next", "HEAD~1");
  await writeFile(join(a.work, "later.txt"), "later\n");
  await git(a.work, "add", "-A");
  await git(a.work, "commit", "-q", "-m", "later");
  await git(a.work, ...auth(a.origin.token), "push", "-q", a.origin.remote, "HEAD:refs/heads/main");
  timeline.mark("a's main advanced");
  assert((await lsRemote(a.work, a.origin, raw)) === archived, `${raw} moved or vanished after a push to main`);
  assert((await lsRemote(a.work, a.origin, archiveRef("t1a1"))) === bMain, "the archive ref moved or vanished");

  // And back out of an archive ref into another repo, as reopening an attempt does.
  const restored = await api<{ sha: string | null }>(
    "POST",
    `/e2e/repos/${originRepo(a.project)}/copy-ref?fromRef=${raw}&to=${originRepo(b.project)}&toRef=${archiveRef("t9a9")}`,
  );
  timeline.mark("worker restored a's archive into b");
  assert(restored.sha === archived, `copy-ref returned ${restored.sha}, expected ${archived}`);
  assert((await lsRemote(b.work, b.origin, archiveRef("t9a9"))) === archived, "the restored ref is not listed");

  // Archive pushes are internal: neither project queued any scoring.
  for (const project of [a.project, b.project]) {
    const kinds = new Set((await settle(project, 5000)).map((e) => e.kind));
    assert(!kinds.has("scoringQueued"), `${project} queued scoring on an archive push`);
  }
  timeline.print();
  await cleanUp(a.project, a.work);
  await cleanUp(b.project, b.work);
}

/** The sha `ref` points at in a remote, through `git ls-remote`; null if it isn't listed. */
async function lsRemote(work: string, remote: Grant, ref: string): Promise<string | null> {
  const listed = await git(work, ...auth(remote.token), "ls-remote", remote.remote, ref);
  const line = listed.split("\n").find((l) => l.endsWith(`\t${ref}`));
  return line?.split("\t")[0] ?? null;
}

/** A new project whose origin's `main` is the fixture plus `files` (a config, helper scripts). */
async function setUpProject(
  timeline: Timeline,
  files: Record<string, string> = {},
): Promise<{ project: string; work: string; origin: Grant }> {
  // Project ids are lowercase alphanumeric; repo names take a `-main` or `-t1a1` suffix.
  const project = `${projectPrefix}${Date.now().toString(36)}`;
  console.log(`project ${project}`);
  const work = await mkdtemp(join(tmpdir(), `${project}-`));
  await cp(FIXTURE, work, { recursive: true, filter: (src) => !src.includes("node_modules") });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, "init", "-q", "-b", "main");
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "fixture");

  timeline.mark("create requested");
  const repo = await api<Grant & { createMs: number }>("POST", `/e2e/projects/${project}`);
  timeline.mark("repo created");
  await git(work, ...auth(repo.token), "push", "-q", repo.remote, "main:refs/heads/main");
  timeline.mark("fixture pushed to main");
  await git(work, "remote", "add", "origin", repo.remote);
  return { project, work, origin: repo };
}

async function createAttempt(project: string, attempt: string, timeline: Timeline): Promise<Fork> {
  timeline.mark(`fork ${attempt} requested`);
  const fork = await api<Grant & { forkMs: number; readyMs: number; polls: number }>(
    "POST",
    `/e2e/projects/${project}/attempts/${attempt}`,
  );
  timeline.mark(`fork ${attempt} ready (fork() ${fork.forkMs} ms, ready ${fork.readyMs} ms, ${fork.polls} polls)`);
  return { ...fork, project, attempt };
}

async function commitAndPush(
  work: string,
  fork: Fork,
  path: string,
  edit: (source: string) => string,
  message: string,
): Promise<string> {
  const file = join(work, path);
  await writeFile(file, edit(await readFile(file, "utf8")));
  await git(work, "commit", "-q", "-am", message);
  await git(work, ...auth(fork.token), "push", "-q", "--force", fork.remote, "HEAD:refs/heads/main");
  const sha = (await git(work, "rev-parse", "HEAD")).trim();
  // The push went straight to Artifacts, around the git proxy that would queue scoring, so ask for it.
  await api("POST", `/e2e/projects/${fork.project}/attempts/${fork.attempt}/score?sha=${sha}`);
  return sha;
}

function report(timeline: Timeline, journal: JournalEntry[]): void {
  console.log("timeline:");
  timeline.print();
  const cancelled = journal.filter((e) => e.kind === "scoringCancelled");
  console.log(`cancelled runs: ${cancelled.length}`);
  for (const d of cancelled) console.log(`  ${JSON.stringify(d.detail)}`);
}

/** Waits for `sha`'s run to finish and returns its result; an errored run fails the scenario. */
async function scored(project: string, sha: string): Promise<NonNullable<Run["result"]>> {
  const event = await waitFor(
    project,
    (e) => (e.kind === "scored" || e.kind === "scoringErrored") && e.detail.sha === sha,
  );
  const found = await api<Run>("GET", `/e2e/projects/${project}/runs/${String(event.detail.run)}`);
  const { result } = found;
  assert(found.status === "done" && result !== null, `run ${found.id} ended ${found.status}: ${found.error ?? ""}`);
  console.log(`  gate ${result.gate}: ${JSON.stringify(result.checks.map((c) => [c.name, c.outcome]))}`);
  return result;
}

/**
 * A project with task rows, for the merge queue scenarios: made through the e2e routes (so its id
 * carries E2E_PROJECT_PREFIX and cleanup finds it) and then driven only through `/api` and
 * the git proxy as the e2e user. Only the fixture is pushed around the proxy, which refuses pushes
 * to the origin's `main`.
 */
async function setUpRealProject(timeline: Timeline, files: Record<string, string> = {}): Promise<RealProject> {
  const { project, work, origin } = await setUpProject(timeline, files);
  const { token, user } = await e2eUser();
  return { project, owner: user.handle, work, origin, token, user };
}

let e2eUserToken: Promise<{ token: string; id: string; user: { id: string; handle: string } }> | null = null;

/** The e2e user's Throng token, minted once per run. */
function e2eUser(): Promise<{ token: string; id: string; user: { id: string; handle: string } }> {
  e2eUserToken ??= api("POST", "/e2e/token");
  return e2eUserToken;
}

/** Revokes the run's token, if it minted one. */
async function revokeE2eToken(): Promise<void> {
  if (e2eUserToken === null || process.env.E2E_KEEP === "1") return;
  const { id } = await e2eUserToken;
  await api("DELETE", `/e2e/tokens/${id}`).catch((error) => console.warn("could not revoke the run's token", error));
}

/** Creates the task the scenario expects to be `expected` (numbers are per project, from 1). */
async function createTask(p: RealProject, expected: string, title: string): Promise<void> {
  const { ref } = await throng<{ ref: string }>(p, "POST", "/tasks", { title });
  assert(ref === expected, `created ${ref}, expected ${expected}`);
}

/** Fans `task` out to draft attempts, each with its own fork, which must be numbered `expected`. */
async function createAttempts(p: RealProject, task: string, expected: string[], timeline: Timeline): Promise<void> {
  const { attempts } = await throng<{ attempts: Attempt[] }>(p, "POST", `/tasks/${task}/attempts`, {
    count: expected.length,
  });
  const made = attempts.map((a) => a.ref);
  assert(made.join() === expected.join(), `created ${made.join(", ")}, expected ${expected.join(", ")}`);
  timeline.mark(`created ${made.join(", ")}`);
}

/**
 * Edits `path` in the work tree, commits everything tracked (finishing a merge, if one is in
 * progress) and pushes it to the attempt's fork through the git proxy, which records the push and
 * queues scoring for an open attempt. A new fork can take a moment to accept pushes, so it retries.
 */
async function editAndPush(
  p: RealProject,
  attempt: string,
  path: string,
  edit: (source: string) => string,
  message: string,
): Promise<string> {
  const file = join(p.work, path);
  await writeFile(file, edit(await readFile(file, "utf8")));
  await git(p.work, "commit", "-q", "-am", message);
  const remote = `${baseUrl}/git/${p.owner}/${p.project}/${attempt}.git`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await git(p.work, ...proxyAuth(p), "push", "-q", remote, "HEAD:refs/heads/main");
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return (await git(p.work, "rev-parse", "HEAD")).trim();
}

/** Fetches the origin's `main` through the git proxy into FETCH_HEAD. */
async function fetchMain(p: RealProject): Promise<void> {
  await git(p.work, ...proxyAuth(p), "fetch", "-q", `${baseUrl}/git/${p.owner}/${p.project}.git`, "main");
}

/** A commit on the origin's `main`, parsed. */
async function readCommit(p: RealProject, sha: string): Promise<Commit> {
  await fetchMain(p);
  return parseCommit(await git(p.work, "cat-file", "-p", sha));
}

/** Waits for the attempt's head to be `sha` and scored; an errored run fails the scenario. */
async function scoredHead(
  p: RealProject,
  attempt: string,
  sha: string,
): Promise<ScoringStatus & { result: ApiResult }> {
  const status = await poll(`${attempt}'s scoring of ${sha.slice(0, 7)}`, async () => {
    const s = await throng<ScoringStatus>(p, "GET", `/attempts/${attempt}/scoring`);
    return s.sha === sha && (s.status === "done" || s.status === "errored") ? s : null;
  });
  const { result } = status;
  assert(status.status === "done" && result !== undefined, `${attempt}'s run ended ${status.status}`);
  console.log(`  ${attempt} gate ${result.gate}: ${JSON.stringify(result.checks.map((c) => [c.name, c.outcome]))}`);
  return { ...status, result };
}

/**
 * Polls the task's merge request until `done` holds. One that has ended (merged or cancelled)
 * without `done` holding fails the scenario at once rather than at the timeout.
 */
async function mergeRequestUntil(
  p: RealProject,
  task: string,
  done: (mr: MergeRequest) => boolean,
): Promise<MergeRequest> {
  let last = "";
  return poll(`${task}'s merge request`, async () => {
    const mr = await throng<MergeRequest>(p, "GET", `/tasks/${task}/merge-request`);
    const seen = `${mr.state} ${JSON.stringify(mr.lastDequeue)}`;
    if (seen !== last) console.log(`  ${task}: ${seen}`);
    last = seen;
    if (done(mr)) return mr;
    assert(mr.state !== "merged" && mr.state !== "cancelled", `${task}'s merge request ended ${seen}`);
    return null;
  });
}

/** Waits for the task's merge request to merge, and returns its merge commit. */
async function mergedSha(p: RealProject, task: string): Promise<string> {
  const merged = await mergeRequestUntil(p, task, (mr) => mr.state === "merged");
  assert(merged.mergeSha !== null, "a merged merge request has no mergeSha");
  return merged.mergeSha;
}

/**
 * The attempt's fork was archived at `sha`: the attempt records it, and the origin lists it at
 * `refs/attempts/<attempt>` through the git proxy.
 */
async function assertArchived(p: RealProject, attempt: string, sha: string): Promise<void> {
  const archived = await poll(`${attempt}'s archive`, async () => {
    const a = await throng<Attempt>(p, "GET", `/attempts/${attempt}`);
    return a.archivedSha;
  });
  assert(archived === sha, `${attempt} archived ${archived}, expected ${sha}`);
  const ref = archiveRef(attempt);
  const origin = `${baseUrl}/git/${p.owner}/${p.project}.git`;
  const listed = await git(p.work, ...proxyAuth(p), "ls-remote", origin, ref);
  const line = listed.split("\n").find((l) => l.endsWith(`\t${ref}`));
  assert(line?.split("\t")[0] === sha, `the origin lists ${ref} as ${line ?? "nothing"}, expected ${sha}`);
}

/** Calls the product API for the project as the e2e user. */
async function throng<T>(p: RealProject, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/projects/${p.owner}/${p.project}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${p.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

/** A product API route that answers a bare diff. */
async function throngText(p: RealProject, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/projects/${p.owner}/${p.project}${path}`, {
    headers: { Authorization: `Bearer ${p.token}`, Accept: "text/x-diff" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${text}`);
  return text;
}

/** Calls `read` every POLL_MS until it returns something other than null. */
async function poll<T>(what: string, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out waiting on ${what}`);
}

function proxyAuth(p: RealProject): string[] {
  return ["-c", `http.extraHeader=${basicAuthHeader(p.token)}`];
}

/** Reports a scenario's journal and deletes what it made. */
async function finish(project: string, work: string, timeline: Timeline): Promise<void> {
  report(timeline, await settle(project, 5000));
  await cleanUp(project, work);
}

/** Waits a little after the last expected event so stray runs show up. */
async function settle(project: string, quietMs = 15_000): Promise<JournalEntry[]> {
  await new Promise((r) => setTimeout(r, quietMs));
  return api<JournalEntry[]>("GET", `/e2e/projects/${project}/journal`);
}

async function waitFor(project: string, match: (e: JournalEntry) => boolean): Promise<JournalEntry> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let lastKinds = "";
  while (Date.now() < deadline) {
    const journal = await api<JournalEntry[]>("GET", `/e2e/projects/${project}/journal`);
    const hit = journal.find(match);
    if (hit !== undefined) return hit;
    const kinds = journal.map((e) => e.kind).join(", ");
    if (kinds !== lastKinds) console.log(`  journal: ${kinds}`);
    lastKinds = kinds;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out waiting on ${project}'s journal`);
}

/** Deletes everything the project made: its rows, its Durable Object's storage, its logs and its repos. */
async function cleanUp(project: string, work: string): Promise<void> {
  if (process.env.E2E_KEEP === "1") return;
  await api("DELETE", `/e2e/projects/${project}`).catch((error) => console.warn(`could not delete ${project}`, error));
  await rm(work, { recursive: true, force: true });
}

async function api<T>(method: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${e2eSecret}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${body}`);
  return JSON.parse(body) as T;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@localhost",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@localhost",
    },
  });
  return stdout;
}

function auth(token: string): string[] {
  return ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

await main();
