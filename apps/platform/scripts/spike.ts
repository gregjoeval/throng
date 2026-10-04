// End-to-end spike against a deployed throng Worker and real Artifacts.
//
//   THRONG_URL=https://throng.<subdomain>.workers.dev SPIKE_TOKEN=... pnpm spike [scenario...]
//
// Scenarios: happy (one attempt lands), coalesce (two quick pushes; only the newest sha is checked).

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FIXTURE = new URL("../fixtures/fixture-worker/", import.meta.url).pathname;
const POLL_MS = 1_000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1_000;

const baseUrl = requireEnv("THRONG_URL").replace(/\/$/, "");
const spikeToken = requireEnv("SPIKE_TOKEN");

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

const scenarios: Record<string, () => Promise<void>> = { happy, coalesce };

async function main(): Promise<void> {
  const names = process.argv.slice(2);
  const chosen = names.length > 0 ? names : Object.keys(scenarios);
  let failed = false;
  for (const name of chosen) {
    const scenario = scenarios[name];
    if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
    console.log(`\n== ${name}`);
    try {
      await scenario();
      console.log(`== ${name}: PASS`);
    } catch (cause) {
      failed = true;
      console.error(`== ${name}: FAIL`, cause);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

/** create repo → fork → push → event → check → rebase, re-test, land → main advanced, no new check. */
async function happy(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);

  const fork = await createAttempt(project, "a1", timeline);
  const sha = await commitAndPush(
    work,
    fork,
    "src/greeting.js",
    (s) => s.replace('"hello"', '"hello from a1"'),
    "a1: greet",
  );
  timeline.mark("attempt pushed");

  const finished = await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === sha);
  const outcome = finished.detail.outcome as { kind: string; mainSha?: string };
  assert(outcome.kind === "landed", `expected landed, got ${JSON.stringify(outcome)}`);
  const mainSha = outcome.mainSha!;
  await waitFor(project, (e) => e.kind === "main-advanced" && e.detail.sha === mainSha);

  const head = await api<{ sha: string }>("GET", `/spike/repos/${project}/head`);
  assert(head.sha === mainSha, `main is ${head.sha}, expected ${mainSha}`);
  const greeting = await gitShow(work, project, mainSha, "src/greeting.js");
  assert(greeting.includes("hello from a1"), "main does not contain the attempt's change");

  const journal = await settle(project);
  const checks = journal.filter((e) => e.kind === "check-started");
  assert(checks.length === 1, `expected one check, got ${checks.length}`);
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["a1"], work);
}

/** Two quick pushes to one attempt: the first check is cancelled (or never starts); only the newest sha lands. */
async function coalesce(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);

  const fork = await createAttempt(project, "a1", timeline);
  const first = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hi"'), "a1: first");
  timeline.mark("first push");
  // Wait until the first check is running, so the second push has something to cancel.
  await waitFor(project, (e) => e.kind === "check-started" && e.detail.sha === first);
  timeline.mark("first check started");
  const second = await commitAndPush(
    work,
    fork,
    "src/greeting.js",
    (s) => s.replace('"hi"', '"hi again"'),
    "a1: second",
  );
  timeline.mark("second push");

  const finished = await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === second);
  const outcome = finished.detail.outcome as { kind: string; mainSha?: string };
  assert(outcome.kind === "landed", `expected landed, got ${JSON.stringify(outcome)}`);
  await waitFor(project, (e) => e.kind === "main-advanced" && e.detail.sha === outcome.mainSha);

  const journal = await settle(project);
  const landedFirst = journal.some(
    (e) =>
      e.kind === "check-finished" && e.detail.sha === first && (e.detail.outcome as { kind: string }).kind === "landed",
  );
  assert(!landedFirst, "the superseded sha landed");
  assert(
    journal.some((e) => e.kind === "check-cancelled" && e.detail.sha === first),
    "the first check was not cancelled",
  );
  const greeting = await gitShow(work, project, outcome.mainSha!, "src/greeting.js");
  assert(greeting.includes('"hi again"'), "main does not contain the newest change");
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["a1"], work);
}

async function setUpProject(timeline: Timeline): Promise<{ project: string; work: string }> {
  const project = `spike-${Date.now().toString(36)}`;
  console.log(`project ${project}`);
  const work = await mkdtemp(join(tmpdir(), `${project}-`));
  await cp(FIXTURE, work, { recursive: true, filter: (src) => !src.includes("node_modules") });
  await git(work, "init", "-q", "-b", "main");
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "fixture");

  timeline.mark("create requested");
  const repo = await api<Grant & { createMs: number }>("POST", `/spike/projects/${project}`);
  timeline.mark("repo created");
  await git(work, ...auth(repo.token), "push", "-q", repo.remote, "main:refs/heads/main");
  timeline.mark("fixture pushed to main");
  await git(work, "remote", "add", "canonical", repo.remote);
  // The fixture push itself is a "main advanced" event; let it land in the journal before forking.
  await waitFor(project, (e) => e.kind === "main-advanced");
  timeline.mark("fixture main-advanced journaled");
  return { project, work };
}

async function createAttempt(project: string, attempt: string, timeline: Timeline): Promise<Grant> {
  timeline.mark(`fork ${attempt} requested`);
  const fork = await api<Grant & { forkMs: number; readyMs: number; polls: number }>(
    "POST",
    `/spike/projects/${project}/attempts/${attempt}`,
  );
  timeline.mark(`fork ${attempt} ready (fork() ${fork.forkMs} ms, ready ${fork.readyMs} ms, ${fork.polls} polls)`);
  return fork;
}

async function commitAndPush(
  work: string,
  fork: Grant,
  path: string,
  edit: (source: string) => string,
  message: string,
): Promise<string> {
  const file = join(work, path);
  await writeFile(file, edit(await readFile(file, "utf8")));
  await git(work, "commit", "-q", "-am", message);
  await git(work, ...auth(fork.token), "push", "-q", "--force", fork.remote, "HEAD:refs/heads/main");
  return (await git(work, "rev-parse", "HEAD")).trim();
}

async function gitShow(work: string, project: string, sha: string, path: string): Promise<string> {
  const { token } = await api<{ token: string }>("POST", `/spike/repos/${project}/read-token`);
  await git(work, ...auth(token), "fetch", "-q", "canonical", "main");
  return git(work, "show", `${sha}:${path}`);
}

function addCheckTimings(timeline: Timeline, journal: JournalEntry[]): void {
  for (const e of journal) {
    const sha = typeof e.detail.sha === "string" ? e.detail.sha.slice(0, 7) : "";
    if (e.kind === "attempt-pushed" || e.kind === "main-advanced") {
      const { emittedAt, ingestStartedAt } = e.detail as { emittedAt: number | null; ingestStartedAt: number };
      if (emittedAt !== null) timeline.mark(`${e.kind} ${sha}: event emitted`, emittedAt);
      timeline.mark(`${e.kind} ${sha}: ingest workflow started`, ingestStartedAt);
    }
    if (e.kind === "check-finished") {
      const t = e.detail.timings as Record<string, number>;
      timeline.mark(`check ${sha}: test sandbox start ${t.testStartMs} ms, run ${t.testRunMs} ms`, t.createdAt! + 1);
      timeline.mark(
        `check ${sha}: land sandbox start ${t.landStartMs ?? "-"} ms, run ${t.landRunMs ?? "-"} ms`,
        t.finishedAt! - 1,
      );
    }
    timeline.mark(`journal: ${e.kind} ${sha}`, e.at);
  }
}

function report(timeline: Timeline, journal: JournalEntry[]): void {
  console.log("timeline:");
  timeline.print();
  const duplicates = journal.filter((e) => e.kind === "duplicate");
  console.log(`duplicate deliveries: ${duplicates.length}`);
  for (const d of duplicates) console.log(`  ${JSON.stringify(d.detail)}`);
}

/** Waits a little after the last expected event so late duplicates and stray checks show up. */
async function settle(project: string, quietMs = 15_000): Promise<JournalEntry[]> {
  await new Promise((r) => setTimeout(r, quietMs));
  return api<JournalEntry[]>("GET", `/spike/projects/${project}/journal`);
}

async function waitFor(project: string, match: (e: JournalEntry) => boolean): Promise<JournalEntry> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let lastKinds = "";
  while (Date.now() < deadline) {
    const journal = await api<JournalEntry[]>("GET", `/spike/projects/${project}/journal`);
    const hit = journal.find(match);
    if (hit !== undefined) return hit;
    const kinds = journal.map((e) => e.kind).join(", ");
    if (kinds !== lastKinds) console.log(`  journal: ${kinds}`);
    lastKinds = kinds;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out waiting on ${project}'s journal`);
}

async function cleanUp(project: string, attempts: string[], work: string): Promise<void> {
  if (process.env.SPIKE_KEEP === "1") return;
  for (const name of [project, ...attempts.map((a) => `${project}--${a}`)]) {
    await api("DELETE", `/spike/repos/${name}`).catch((cause) => console.warn(`could not delete ${name}`, cause));
  }
  await rm(work, { recursive: true, force: true });
}

async function api<T>(method: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${spikeToken}` },
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
      GIT_AUTHOR_NAME: "spike",
      GIT_AUTHOR_EMAIL: "spike@localhost",
      GIT_COMMITTER_NAME: "spike",
      GIT_COMMITTER_EMAIL: "spike@localhost",
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
