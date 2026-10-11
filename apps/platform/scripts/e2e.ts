// End-to-end suite against a deployed throng Worker and real Artifacts.
//
//   THRONG_URL=https://throng.<subdomain>.workers.dev SPIKE_TOKEN=... pnpm e2e [scenario...]
//
// Scenarios: zeroconfig (no config: the gate passes with no checks, built-in metrics recorded, and
// the spike's landing puts the head on main), conflict (two attempts edit the same line; the second
// passes its gate but bounces when landing),
// metrics (a passing project whose checks report metrics), failing (a required check fails the gate),
// invalid (an invalid config fails the gate with a config entry), coalesce (two quick pushes; the first
// run is cancelled and only the newest sha is scored), intrusion (an attempt's checks try to push to
// the origin and call the Cloudflare API; both fail), deps (setup installs an npm dependency from the
// registry), refs (attempt archive refs: pushable, listed, kept across pushes to main, and copied by
// the Worker).
//
// Every project id starts with E2E_PROJECT_PREFIX (default `e2e`; lowercase alphanumeric).
// `pnpm e2e cleanup` deletes every repo whose name starts with an explicitly set E2E_PROJECT_PREFIX,
// including those a failed or cancelled run left behind.

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ARCHIVE_REF_PREFIX, archiveRef } from "../src/archive.ts";
import { forkRepo, originRepo } from "../src/repos.ts";

const run = promisify(execFile);
const FIXTURE = new URL("../fixtures/fixture-worker/", import.meta.url).pathname;
const WRANGLER_CONFIG = new URL("../wrangler.jsonc", import.meta.url).pathname;
const POLL_MS = 1_000;
/** The fixture's own tests, as a check. */
const TEST_CHECK = `checks:
  - name: test
    command: npm test
`;
const CHECK_TIMEOUT_MS = 10 * 60 * 1_000;

const baseUrl = requireEnv("THRONG_URL").replace(/\/$/, "");
const spikeToken = requireEnv("SPIKE_TOKEN");
const projectPrefix = process.env.E2E_PROJECT_PREFIX || "e2e";
assert(/^[a-z0-9]+$/.test(projectPrefix), `E2E_PROJECT_PREFIX must be lowercase alphanumeric: ${projectPrefix}`);

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

/** What a run reports, as far as the scenarios read it (see `src/results.ts`). */
interface Run {
  id: number;
  sha: string;
  status: string;
  result: {
    base: string | null;
    config: { kind: string; error?: string };
    gate: "passed" | "failed";
    checks: { name: string; required: boolean; outcome: string; metrics: Record<string, number>; notes: string[] }[];
    builtin: { filesChanged: number; additions: number; deletions: number; durationMs: number };
    logs: string[];
  } | null;
  error: string | null;
}

const scenarios: Record<string, () => Promise<void>> = {
  zeroconfig,
  conflict,
  metrics,
  failing,
  invalid,
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

/** Deletes every repo under E2E_PROJECT_PREFIX. It must be set explicitly, so the default never sweeps. */
async function deleteRun(): Promise<void> {
  requireEnv("E2E_PROJECT_PREFIX");
  const names = await api<string[]>("GET", `/spike/repos?prefix=${projectPrefix}`);
  console.log(`deleting ${names.length} repo(s) starting with ${projectPrefix}`);
  for (const name of names) {
    await api("DELETE", `/spike/repos/${name}`);
    console.log(`  deleted ${name}`);
  }
}

/** No `.throng/config.yml`: the gate passes with no checks, and the diff size is still recorded. */
async function zeroconfig(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline);
  const fork = await createAttempt(project, "t1a1", timeline);
  const sha = await commitAndPush(work, fork, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a1"'), "a1");
  timeline.mark("attempt pushed");

  const result = (await scored(project, sha)).result!;
  assert(result.config.kind === "none", `expected no config, got ${JSON.stringify(result.config)}`);
  assert(result.gate === "passed" && result.checks.length === 0, `expected a passing gate with no checks`);
  assert(result.base !== null, "no merge base recorded");
  const { filesChanged, additions, deletions } = result.builtin;
  assert(
    filesChanged === 1 && additions === 1 && deletions === 1,
    `unexpected diff size ${JSON.stringify(result.builtin)}`,
  );

  const mainSha = await landed(project, sha);
  const head = await api<{ sha: string }>("GET", `/spike/repos/${originRepo(project)}/head`);
  assert(head.sha === mainSha, `main is ${head.sha}, expected the landed ${mainSha}`);
  const greeting = await gitShow(work, project, mainSha, "src/greeting.js");
  assert(greeting.includes("hello from a1"), "main does not contain the attempt's change");
  await finish(project, ["t1a1"], work, timeline);
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
  const mainSha = await landed(project, first);
  timeline.mark("a1 landed");

  await git(work, "checkout", "-q", "--detach", base);
  const second = await commitAndPush(work, a2, "src/greeting.js", (s) => s.replace('"hello"', '"hello from a2"'), "a2");
  timeline.mark("a2 pushed");
  const failed = await landing(project, second);
  const outcome = failed.detail.landed as { kind: string; files?: string[]; diff?: string } | undefined;
  assert(outcome?.kind === "bounced", `expected a2 to bounce, got ${JSON.stringify(failed.detail)}`);
  assert(
    JSON.stringify(outcome.files) === JSON.stringify(["src/greeting.js"]),
    `unexpected conflict files ${JSON.stringify(outcome.files)}`,
  );
  assert(/hello from a1[\s\S]*hello from a2/.test(outcome.diff ?? ""), "the hunks do not show both sides");

  const journal = await settle(project);
  const head = await api<{ sha: string }>("GET", `/spike/repos/${originRepo(project)}/head`);
  assert(head.sha === mainSha, `main moved to ${head.sha} after the bounce; expected ${mainSha}`);
  assert(journal.filter((e) => e.kind === "main_advanced").length === 1, "expected only a1 to advance main");
  report(timeline, journal);
  await cleanUp(project, ["t1a1", "t1a2"], work);
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

  const result = (await scored(project, sha)).result!;
  assert(result.gate === "passed", `expected the gate to pass: ${JSON.stringify(result.checks)}`);
  const [test, coverage] = result.checks;
  assert(
    test?.outcome === "passed" && coverage?.outcome === "passed",
    `unexpected outcomes ${JSON.stringify(result.checks)}`,
  );
  assert(coverage.metrics.coverage === 87.5, `coverage not recorded: ${JSON.stringify(coverage.metrics)}`);
  assert(
    coverage.notes.some((n) => n.includes("stray")),
    "the undeclared metric was not noted",
  );
  assert(
    JSON.stringify(result.logs) === JSON.stringify(["test", "coverage"]),
    `expected both checks' logs stored: ${JSON.stringify(result.logs)}`,
  );
  await finish(project, ["t1a1"], work, timeline);
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

  const result = (await scored(project, sha)).result!;
  assert(result.gate === "failed", "expected the gate to fail");
  assert(
    result.checks.map((c) => c.outcome).join() === "failed,passed",
    `expected failed then passed, got ${JSON.stringify(result.checks)}`,
  );
  await finish(project, ["t1a1"], work, timeline);
}

/** An invalid config fails the gate with a single `config` entry, and runs no checks. */
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

  const result = (await scored(project, sha)).result!;
  assert(result.config.kind === "invalid" && result.gate === "failed", `expected an invalid config to fail the gate`);
  assert(
    result.checks.length === 1 && result.checks[0]!.name === "config",
    `expected one config entry, got ${JSON.stringify(result.checks)}`,
  );
  assert(result.builtin.filesChanged === 1, "the built-in metrics were not recorded");
  await finish(project, ["t1a1"], work, timeline);
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
  await waitFor(project, (e) => e.kind === "scoring_started" && e.detail.sha === first);
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
  assert(!journal.some((e) => e.kind === "main_advanced" && e.detail.head === first), "the superseded sha landed");
  assert(
    journal.some((e) => e.kind === "scoring_cancelled" && e.detail.sha === first),
    "the first run was not cancelled",
  );
  report(timeline, journal);
  await cleanUp(project, ["t1a1"], work);
}

/**
 * The attempt's own test tries to push a forged commit to the origin's main and to reach the
 * Cloudflare API. The test passes only if both are blocked, so a leak fails the gate.
 */
async function intrusion(): Promise<void> {
  const timeline = new Timeline();
  const { project, work } = await setUpProject(timeline, { ".throng/config.yml": TEST_CHECK });
  const origin = (await git(work, "remote", "get-url", "origin")).trim();
  const accountId = /"CF_ACCOUNT_ID":\s*"(\w+)"/.exec(await readFile(WRANGLER_CONFIG, "utf8"))?.[1];
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

  const result = (await scored(project, sha)).result!;
  assert(result.gate === "passed", `expected the probes to be blocked and pass, got ${JSON.stringify(result.checks)}`);
  const log = await api<{ message: string }[]>("GET", `/spike/repos/${originRepo(project)}/log?ref=main&limit=20`);
  assert(!log.some((c) => c.message === "intrusion"), "the forged commit reached main");
  await finish(project, ["t1a1"], work, timeline);
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

  const result = (await scored(project, sha)).result!;
  assert(
    result.gate === "passed",
    `expected the dependency to install and the tests to pass: ${JSON.stringify(result.checks)}`,
  );
  await finish(project, ["t1a1"], work, timeline);
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
    `/spike/repos/${originRepo(b.project)}/copy-ref?from_ref=refs/heads/main&to=${originRepo(a.project)}&to_ref=${archiveRef("t1a1")}`,
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
    `/spike/repos/${originRepo(a.project)}/copy-ref?from_ref=${raw}&to=${originRepo(b.project)}&to_ref=${archiveRef("t9a9")}`,
  );
  timeline.mark("worker restored a's archive into b");
  assert(restored.sha === archived, `copy-ref returned ${restored.sha}, expected ${archived}`);
  assert((await lsRemote(b.work, b.origin, archiveRef("t9a9"))) === archived, "the restored ref is not listed");

  // Archive pushes are internal: neither project queued any scoring.
  for (const project of [a.project, b.project]) {
    const kinds = new Set((await settle(project, 5_000)).map((e) => e.kind));
    assert(!kinds.has("scoring_queued"), `${project} queued scoring on an archive push`);
  }
  timeline.print();
  await cleanUp(a.project, [], a.work);
  await cleanUp(b.project, [], b.work);
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
  const repo = await api<Grant & { createMs: number }>("POST", `/spike/projects/${project}`);
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
    `/spike/projects/${project}/attempts/${attempt}`,
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
  await api("POST", `/spike/projects/${fork.project}/attempts/${fork.attempt}/score?sha=${sha}`);
  return sha;
}

function report(timeline: Timeline, journal: JournalEntry[]): void {
  console.log("timeline:");
  timeline.print();
  const cancelled = journal.filter((e) => e.kind === "scoring_cancelled");
  console.log(`cancelled runs: ${cancelled.length}`);
  for (const d of cancelled) console.log(`  ${JSON.stringify(d.detail)}`);
}

/** Waits for `sha`'s run to finish and reads it back; an errored run fails the scenario. */
async function scored(project: string, sha: string): Promise<Run> {
  const event = await waitFor(
    project,
    (e) => (e.kind === "scored" || e.kind === "scoring_errored") && e.detail.sha === sha,
  );
  const found = await api<Run>("GET", `/spike/projects/${project}/runs/${String(event.detail.run)}`);
  const { result } = found;
  assert(found.status === "done" && result !== null, `run ${found.id} ended ${found.status}: ${found.error ?? ""}`);
  console.log(`  gate ${result.gate}: ${JSON.stringify(result.checks.map((c) => [c.name, c.outcome]))}`);
  return found;
}

/** Waits for the spike's landing of `sha` to end, either advancing main or failing. */
async function landing(project: string, sha: string): Promise<JournalEntry> {
  return waitFor(project, (e) => (e.kind === "main_advanced" || e.kind === "land_failed") && e.detail.head === sha);
}

/** Waits for `sha` to land and returns main's new commit; a failed landing fails the scenario. */
async function landed(project: string, sha: string): Promise<string> {
  const event = await landing(project, sha);
  assert(event.kind === "main_advanced", `expected ${sha} to land, got ${JSON.stringify(event.detail)}`);
  return String(event.detail.sha);
}

async function gitShow(work: string, project: string, sha: string, path: string): Promise<string> {
  const { token } = await api<{ token: string }>("POST", `/spike/repos/${originRepo(project)}/read-token`);
  await git(work, ...auth(token), "fetch", "-q", "origin", "main");
  return git(work, "show", `${sha}:${path}`);
}

/** Reports a scenario's journal and deletes what it made. */
async function finish(project: string, attempts: string[], work: string, timeline: Timeline): Promise<void> {
  report(timeline, await settle(project, 5_000));
  await cleanUp(project, attempts, work);
}

/** Waits a little after the last expected event so stray runs show up. */
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
  if (process.env.E2E_KEEP === "1") return;
  for (const name of [originRepo(project), ...attempts.map((a) => forkRepo(project, a))]) {
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
