// Bash run inside a run's Sandbox. Each script is idempotent, so a retried Workflow step can rerun it
// on a fresh container. The last stdout line is the result: `THRONG_RESULT <json>`.

import { setupLogName } from "./logs.ts";
import { MAX_METRICS_BYTES, SETUP_TIMEOUT_MS, type ScorePlan } from "./results.ts";

export const RESULT_PREFIX = "THRONG_RESULT ";

/** Where a script that runs repo code failed: installing dependencies, or running/building the repo. */
export type FailureStage = "install" | "test";

export type PreviewScriptResult =
  | { ok: true; url: string }
  | { ok: false; stage: "install" | "deploy"; output: string };

export type RetestResult =
  | { kind: "tested"; base: string; tree: string }
  | { kind: "failed"; stage: FailureStage; output: string }
  | { kind: "bounced"; files: string[]; diff: string };

export type LandResult = { kind: "landed"; mainSha: string } | { kind: "moved" } | { kind: "mismatch"; tree: string };

const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

const PRELUDE = `
set -uo pipefail
result() { printf '${RESULT_PREFIX}%s\\n' "$1"; exit 0; }
json() { node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8").slice(-8000)))'; }
`;

/**
 * Install the repo's npm dependencies from its lockfile, if it has one. Install scripts never run:
 * the binaries common packages need ship as ordinary platform-specific packages. If the install fails,
 * the script ends with a result made of `fields` (the caller's JSON fields, e.g. `"ok":false`) plus
 * `"stage":"install"` and the install log as `output`.
 */
function install(fields: string): string {
  return `if [ -f package-lock.json ] && ! npm ci --ignore-scripts --no-audit --no-fund > ../install.log 2>&1; then
  result "{${fields.replaceAll('"', '\\"')},\\"stage\\":\\"install\\",\\"output\\":$(json < ../install.log)}"
fi`;
}

/**
 * Scores the attempt's head `sha`: fetches it from the fork and `main` from the origin, records the
 * merge base and the diff size against it, runs each `setup` command and then every check in order,
 * each under `timeout` with `$THRONG_METRICS` pointing at an empty file. A failed setup command skips
 * every check; a failed check doesn't stop the next. Each step's output goes to `../logs/<name>.log`,
 * named by `logNames`. The result is a `RawScore`; `buildResult` turns it into the run's result.
 */
export function scoreScript(forkRemote: string, originRemote: string, sha: string, plan: ScorePlan): string {
  const setup = plan.setup
    .map(
      (
        command,
        i,
      ) => `if [ -z "$setup_failed" ] && ! timeout -k 10s ${seconds(SETUP_TIMEOUT_MS)} bash -c ${quote(command)} < /dev/null > ../logs/${setupLogName(i + 1)}.log 2>&1; then
  setup_failed=${i + 1}
fi`,
    )
    .join("\n");
  const checks = plan.checks
    .map(
      (check, i) => `if [ -z "$setup_failed" ]; then
  : > "$out/${i}.metrics"
  t0=$(now)
  THRONG_METRICS="$out/${i}.metrics" timeout -k 10s ${seconds(check.timeoutMs)} bash -c ${quote(check.command)} < /dev/null > ../logs/${check.name}.log 2>&1
  code=$?
  printf '%s %s\\n' "$code" "$(( $(now) - t0 ))" > "$out/${i}.status"
fi`,
    )
    .join("\n");
  return `${PRELUDE}
rm -rf score logs out && mkdir logs out && out="$PWD/out" && git init -q score && cd score
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(originRemote)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
git checkout -q --detach ${quote(sha)} || exit 11
now() { date +%s%3N; }
t0=$(now)
base=$(git merge-base HEAD refs/remotes/origin/main 2>/dev/null) || base=""
shortstat=$(git diff --shortstat "\${base:-$(git hash-object -t tree /dev/null)}" HEAD) || exit 15
builtin_ms=$(( $(now) - t0 ))
setup_failed=""
${setup}
${checks}
node - "$out" ${plan.checks.length} ${MAX_METRICS_BYTES} "$base" "$shortstat" "$builtin_ms" "$setup_failed" <<'NODE' || exit 16
const fs = require("fs");
const [out, count, max, base, shortstat, builtinMs, setupFailed] = process.argv.slice(2);
const read = (path) => {
  const fd = fs.openSync(path, "r");
  const buffer = Buffer.alloc(Number(max));
  const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);
  return buffer.subarray(0, length).toString("utf8");
};
const checks = [];
for (let i = 0; i < Number(count); i++) {
  if (!fs.existsSync(out + "/" + i + ".status")) {
    checks.push({ exit: null, durationMs: 0, metrics: null });
    continue;
  }
  const [exit, durationMs] = fs.readFileSync(out + "/" + i + ".status", "utf8").trim().split(" ").map(Number);
  checks.push({ exit, durationMs, metrics: fs.existsSync(out + "/" + i + ".metrics") ? read(out + "/" + i + ".metrics") : null });
}
const result = {
  base: base || null,
  shortstat,
  builtinMs: Number(builtinMs),
  setupFailed: setupFailed === "" ? null : Number(setupFailed),
  checks,
};
process.stdout.write("${RESULT_PREFIX}" + JSON.stringify(result) + "\\n");
NODE
`;
}

/**
 * Deploy the attempt's commit as a Worker Preview named `previewName`. The API token is a placeholder:
 * the Worker's outbound intercept replaces it on requests it allows.
 */
export function previewScript(
  forkRemote: string,
  sha: string,
  preview: { accountId: string; workerName: string; previewName: string },
): string {
  return `${PRELUDE}
rm -rf preview && git init -q preview && cd preview
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git checkout -q --detach ${quote(sha)} || exit 11
${install('"ok":false')}
export CLOUDFLARE_API_TOKEN=added-by-worker CLOUDFLARE_ACCOUNT_ID=${quote(preview.accountId)}
export WRANGLER_SEND_METRICS=false CI=1
if wrangler preview --worker-name ${quote(preview.workerName)} --name ${quote(preview.previewName)} --json > ../preview.json 2> ../preview.log; then
  url=$(node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(p.preview.urls[0]))' < ../preview.json) || exit 13
  result "{\\"ok\\":true,\\"url\\":$url}"
fi
cat ../preview.json >> ../preview.log
result "{\\"ok\\":false,\\"stage\\":\\"deploy\\",\\"output\\":$(json < ../preview.log)}"
`;
}

/**
 * Untrusted: rebase the attempt onto the origin's current main and re-run the tests. Reports
 * the main it rebased onto and the tree it tested, for the trusted land step to check against.
 */
export function retestScript(originRemote: string, forkRemote: string, sha: string): string {
  return `${PRELUDE}
rm -rf retest && git init -q retest && cd retest
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(originRemote)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
git checkout -q -B attempt ${quote(sha)} || exit 11
base=$(git rev-parse origin/main)
if ! git rebase -q "$base" > ../rebase.log 2>&1; then
  files=$(git diff --name-only --diff-filter=U | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8").split("\\n").filter(Boolean)))')
  diff=$(git diff | json)
  git rebase --abort
  result "{\\"kind\\":\\"bounced\\",\\"files\\":$files,\\"diff\\":$diff}"
fi
${install('"kind":"failed"')}
if ! npm test > ../test.log 2>&1; then
  result "{\\"kind\\":\\"failed\\",\\"stage\\":\\"test\\",\\"output\\":$(json < ../test.log)}"
fi
result "{\\"kind\\":\\"tested\\",\\"base\\":\\"$base\\",\\"tree\\":\\"$(git rev-parse 'HEAD^{tree}')\\"}"
`;
}

/**
 * Trusted: holds origin write, so it runs no repository code (no npm or node, no hooks, no config
 * from the repo). It redoes the same rebase onto the pinned main and pushes only if the result is the
 * exact tree the retest step tested, so an untrusted step can't hand over other content.
 */
export function landScript(
  originRemote: string,
  forkRemote: string,
  sha: string,
  tested: { base: string; tree: string },
): string {
  return `
set -uo pipefail
result() { printf '${RESULT_PREFIX}%s\\n' "$1"; exit 0; }
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
rm -rf land && git init -q land && cd land
git config core.hooksPath /dev/null
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(originRemote)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
[ "$(git rev-parse origin/main)" = ${quote(tested.base)} ] || result '{"kind":"moved"}'
git checkout -q -B attempt ${quote(sha)} || exit 11
git rebase -q ${quote(tested.base)} > /dev/null 2>&1 || exit 14
tree=$(git rev-parse 'HEAD^{tree}')
[ "$tree" = ${quote(tested.tree)} ] || result "{\\"kind\\":\\"mismatch\\",\\"tree\\":\\"$tree\\"}"
if git push -q ${quote(originRemote)} HEAD:refs/heads/main; then
  result "{\\"kind\\":\\"landed\\",\\"mainSha\\":\\"$(git rev-parse HEAD)\\"}"
fi
result '{"kind":"moved"}'
`;
}

/** A duration for `timeout(1)`, in whole seconds. */
function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

/** Pulls the result line out of a script's stdout. */
export function parseResult<T>(stdout: string): T | null {
  const line = stdout
    .split("\n")
    .toReversed()
    .find((l) => l.startsWith(RESULT_PREFIX));
  return line === undefined ? null : (JSON.parse(line.slice(RESULT_PREFIX.length)) as T);
}
