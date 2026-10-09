// End-to-end spike against a deployed throng Worker and real Artifacts.
//
//   THRONG_URL=https://throng.<subdomain>.workers.dev SPIKE_TOKEN=... pnpm spike [scenario...]
//
// Scenarios: happy (one attempt lands), coalesce (two quick pushes; only the newest sha is checked),
// conflict (two attempts edit the same line; the second is bounced with its conflicting hunks),
// preview (an attempt gets a live Preview URL serving its change; its files are readable via the Worker),
// intrusion (an attempt's tests try to push to the canonical main and call the Cloudflare API; both fail),
// deps (an attempt adds an npm dependency; the check installs it from the registry, lands, and previews).

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { forkRepo, originRepo } from "../src/repos.ts";

const run = promisify(execFile);
const FIXTURE = new URL("../fixtures/fixture-worker/", import.meta.url).pathname;
const WRANGLER_CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;
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

const scenarios: Record<string, () => Promise<void>> = { happy, coalesce, conflict, preview, intrusion, deps };

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

  const fork = await createAttempt(project, "t1a1", timeline);
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

  const head = await api<{ sha: string }>("GET", `/spike/repos/${originRepo(project)}/head`);
  assert(head.sha === mainSha, `main is ${head.sha}, expected ${mainSha}`);
  const greeting = await gitShow(work, project, mainSha, "src/greeting.js");
  assert(greeting.includes("hello from a1"), "main does not contain the attempt's change");

  const journal = await settle(project);
  const checks = journal.filter((e) => e.kind === "check-started");
  assert(checks.length === 1, `expected one check, got ${checks.length}`);
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["t1a1"], work);
}

/** Two quick pushes to one attempt: the first check is cancelled (or never starts); only the newest sha lands. */
async function coalesce(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);

  const fork = await createAttempt(project, "t1a1", timeline);
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
  await cleanUp(project, ["t1a1"], work);
}

/** Two attempts forked from the same main edit the same line: the first lands, the second bounces. */
async function conflict(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);
  const base = (await git(work, "rev-parse", "HEAD")).trim();

  // Fork both before either lands, so both start from the same main.
  const a1 = await createAttempt(project, "t1a1", timeline);
  const a2 = await createAttempt(project, "t1a2", timeline);

  const first = await commitAndPush(work, a1, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("a1 pushed");
  const landed = await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === first);
  const landedOutcome = landed.detail.outcome as { kind: string; mainSha?: string };
  assert(landedOutcome.kind === "landed", `expected a1 to land, got ${JSON.stringify(landedOutcome)}`);
  const mainSha = landedOutcome.mainSha!;
  timeline.mark("a1 landed");

  await git(work, "checkout", "-q", "--detach", base);
  const second = await commitAndPush(work, a2, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a2"'), "a2");
  timeline.mark("a2 pushed");
  const finished = await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === second);
  const outcome = finished.detail.outcome as { kind: string; files?: string[]; diff?: string };
  assert(outcome.kind === "bounced", `expected a2 to bounce, got ${JSON.stringify(outcome)}`);
  assert(
    JSON.stringify(outcome.files) === JSON.stringify(["src/greeting.js"]),
    `unexpected conflict files ${JSON.stringify(outcome.files)}`,
  );
  assert(/hello from a1[\s\S]*hello from a2/.test(outcome.diff ?? ""), "the hunks do not show both sides");

  const journal = await settle(project);
  const head = await api<{ sha: string }>("GET", `/spike/repos/${originRepo(project)}/head`);
  assert(head.sha === mainSha, `main moved to ${head.sha} after the bounce; expected ${mainSha}`);
  assert(
    journal.filter((e) => e.kind === "main-advanced").length === 2,
    "expected only the fixture and a1 to advance main",
  );
  console.log(`bounced: ${outcome.files!.join(", ")}`);
  console.log(outcome.diff);
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["t1a1", "t1a2"], work);
}

/** An attempt's passing check deploys a Preview serving its change; its files are readable without a clone. */
async function preview(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);
  const fork = await createAttempt(project, "t1a1", timeline);
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("attempt pushed");
  const forkName = forkRepo(project, "t1a1");

  // File reads through the binding, against the fork.
  const began = Date.now();
  const file = await apiText("GET", `/spike/repos/${forkName}/file?ref=main&path=src/greeting.js`);
  assert(file.includes("hello from a1"), "file read does not show the attempt's change");
  const root = await api<{ commit: string; entries: { name: string; type: string }[] }>(
    "GET",
    `/spike/repos/${forkName}/tree?ref=main`,
  );
  assert(root.commit === sha, `tree is at ${root.commit}, expected ${sha}`);
  const names = root.entries.map((e) => e.name).toSorted();
  assert(
    ["package.json", "src", "test"].every((n) => names.includes(n)),
    `unexpected root ${names.join(", ")}`,
  );
  const src = await api<{ entries: { name: string }[] }>("GET", `/spike/repos/${forkName}/tree?ref=main&path=src`);
  assert(
    src.entries.some((e) => e.name === "greeting.js"),
    "src/ listing has no greeting.js",
  );
  const log = await api<{ hash: string; message: string }[]>("GET", `/spike/repos/${forkName}/log?ref=main&limit=5`);
  assert(log[0]?.hash === sha && log.length === 2, `unexpected log ${JSON.stringify(log.map((c) => c.message))}`);
  timeline.mark(`file, 2 trees and log read in ${Date.now() - began} ms`);

  const ready = await waitFor(
    project,
    (e) => (e.kind === "preview-ready" || e.kind === "preview-failed") && e.detail.sha === sha,
  );
  assert(ready.kind === "preview-ready", `preview failed: ${String(ready.detail.output)}`);
  const url = String(ready.detail.url);
  timeline.mark(`preview ready (wrangler preview ${String(ready.detail.runMs)} ms): ${url}`);
  const body = await fetchUntil(`${url}/?name=spike`, (b) => b === "hello from a1, spike");
  timeline.mark(`preview served the change: ${JSON.stringify(body)}`);

  await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === sha);
  const journal = await settle(project, 5_000);
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["t1a1"], work);
}

/** Polls a public URL until its body matches; new Preview hostnames can take a moment to resolve. */
async function fetchUntil(url: string, match: (body: string) => boolean, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      last = `${response.status} ${await response.text()}`;
      if (response.ok && match(last.slice(4))) return last.slice(4);
    } catch (cause) {
      last = String(cause);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`${url} never matched; last: ${last}`);
}

/**
 * The attempt's own test tries to push a forged commit to the canonical main and to reach the Cloudflare
 * API with the Preview grant. The test passes only if both are blocked, so a leak fails the check.
 */
async function intrusion(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);
  const canonical = (await git(work, "remote", "get-url", "canonical")).trim();
  const accountId = /"CF_ACCOUNT_ID":\s*"(\w+)"/.exec(await readFile(WRANGLER_CONFIG, "utf8"))?.[1];
  assert(accountId !== undefined, "CF_ACCOUNT_ID not found in wrangler.jsonc");
  const fork = await createAttempt(project, "t1a1", timeline);

  const probe = `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("cannot push to the canonical repo", () => {
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"]).toString().trim();
  const forged = execFileSync("git", ["commit-tree", tree, "-p", "HEAD", "-m", "intrusion"]).toString().trim();
  assert.throws(() =>
    execFileSync("git", ["push", ${JSON.stringify(canonical)}, \`\${forged}:refs/heads/main\`], { stdio: "pipe", timeout: 30_000 }),
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

  const finished = await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === sha);
  const outcome = finished.detail.outcome as { kind: string; mainSha?: string; output?: string };
  assert(outcome.kind === "landed", `expected the check to pass and land, got ${JSON.stringify(outcome)}`);
  const log = await api<{ message: string }[]>("GET", `/spike/repos/${originRepo(project)}/log?ref=main&limit=20`);
  assert(!log.some((c) => c.message === "intrusion"), "the forged commit reached main");
  const head = await api<{ sha: string }>("GET", `/spike/repos/${originRepo(project)}/head`);
  assert(head.sha === outcome.mainSha, `main is ${head.sha}, expected the landed ${outcome.mainSha}`);
  console.log(`main history: ${log.map((c) => c.message).join(" <- ")}`);

  const journal = await settle(project, 5_000);
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["t1a1"], work);
}

/** An attempt adds an npm dependency: the check installs it, passes, lands, and its Preview is built with it. */
async function deps(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);
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

  const finished = await waitFor(project, (e) => e.kind === "check-finished" && e.detail.sha === sha);
  const outcome = finished.detail.outcome as { kind: string; mainSha?: string };
  assert(outcome.kind === "landed", `expected landed, got ${JSON.stringify(outcome)}`);
  const lock = await apiText("GET", `/spike/repos/${originRepo(project)}/file?ref=main&path=package-lock.json`);
  assert(lock.includes('"is-number"'), "main has no lockfile with the dependency");

  const ready = await waitFor(
    project,
    (e) => (e.kind === "preview-ready" || e.kind === "preview-failed") && e.detail.sha === sha,
  );
  assert(ready.kind === "preview-ready", `preview failed: ${String(ready.detail.output)}`);
  const body = await fetchUntil(`${String(ready.detail.url)}/?name=spike`, (b) => b === "hello with deps, spike");
  timeline.mark(`preview served ${JSON.stringify(body)}`);

  const journal = await settle(project, 5_000);
  addCheckTimings(timeline, journal);
  report(timeline, journal);
  await cleanUp(project, ["t1a1"], work);
}

async function setUpProject(timeline: Timeline): Promise<{ project: string; work: string }> {
  // Project ids are lowercase alphanumeric; repo names take a `-main` or `-t1a1` suffix.
  const project = `spike${Date.now().toString(36)}`;
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
  const { token } = await api<{ token: string }>("POST", `/spike/repos/${originRepo(project)}/read-token`);
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
  for (const name of [originRepo(project), ...attempts.map((a) => forkRepo(project, a))]) {
    await api("DELETE", `/spike/repos/${name}`).catch((cause) => console.warn(`could not delete ${name}`, cause));
  }
  await rm(work, { recursive: true, force: true });
}

async function apiText(method: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${spikeToken}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${body}`);
  return body;
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
