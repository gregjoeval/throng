// Bash run inside a run's Sandbox. Each script is idempotent, so a retried Workflow step can rerun it
// on a fresh container. The last stdout line is the result: `THRONG_RESULT <json>`.

import { CONFIG_PATH, MAX_CONFIG_BYTES } from "./config.ts";
import { CONFLICT_CAPS, MERGE_LABELS } from "./conflicts.ts";
import type { ConflictCaps, Remerge } from "./conflicts.ts";
import { THRONG_COMMITTER } from "./landing.ts";
import { PREVIEW_LOG, setupLogName } from "./logs.ts";
import { MAX_METRICS_BYTES, SETUP_TIMEOUT_MS } from "./results.ts";
import type { ScorePlan } from "./results.ts";
import { parseAttemptRef, taskBranchRef } from "./task-refs.ts";

export const RESULT_PREFIX = "THRONG_RESULT ";

/** Where a script that runs repo code failed: installing dependencies, or running/building the repo. */
export type FailureStage = "install" | "test";

export type PreviewScriptResult =
  | { ok: true; url: string }
  | { ok: false; stage: "install" | "build" | "deploy"; output: string };

/** Longest `preview.command` may run; the spec gives it no timeout of its own, so a check's default. */
export const PREVIEW_BUILD_TIMEOUT_MS = SETUP_TIMEOUT_MS;

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
 * Scores attempt `attempt`'s (`t42a3`) head `sha`: fetches it from the fork, and from the origin its
 * task's task branch when there is one, else `main`. It records the attempt's base (the merge base
 * with that line, as `attemptBase` derives it) and the diff size against it, then runs the plan (see
 * `runPlan`). The result is a `RawScore`; `buildResult` turns it into the run's result.
 */
export function scoreScript(
  forkRemote: string,
  originRemote: string,
  { attempt, sha }: { attempt: string; sha: string },
  plan: ScorePlan,
): string {
  const parsed = parseAttemptRef(attempt);
  if (parsed === null) throw new Error(`not an attempt: ${attempt}`);
  const task = taskBranchRef(parsed.task);
  return `${PRELUDE}
rm -rf score logs out && mkdir logs out && out="$PWD/out" && git init -q score && cd score
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
task=$(git ls-remote ${quote(originRemote)} ${quote(task)}) || exit 12
line=${quote(task)} && [ -n "$task" ] || line=refs/heads/main
git fetch -q ${quote(originRemote)} "+$line:refs/remotes/origin/line" || exit 12
git checkout -q --detach ${quote(sha)} || exit 11
now() { date +%s%3N; }
t0=$(now)
base=$(git merge-base HEAD refs/remotes/origin/line 2>/dev/null) || base=""
shortstat=$(git diff --shortstat "\${base:-$(git hash-object -t tree /dev/null)}" HEAD) || exit 15
builtin_ms=$(( $(now) - t0 ))
${runPlan(plan)}
`;
}

/**
 * Bash that runs each `setup` command and then every check in order, in the checked-out tree, each
 * under `timeout` with `$THRONG_METRICS` pointing at an empty file. A failed setup command skips every
 * check; a failed check doesn't stop the next. Each step's output goes to `../logs/<name>.log`, named
 * by `logNames`. It ends with a `RawScore` result made from `$base`, `$shortstat` and `$builtin_ms`,
 * and needs `$out` and `now`.
 */
function runPlan(plan: ScorePlan): string {
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
  return `setup_failed=""
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
NODE`;
}

/**
 * Deploy the attempt's commit as a Worker Preview named `previewName`: install its dependencies, run
 * the config's `preview.command` (if any) as the build step, then `wrangler preview`. The API token
 * is a placeholder: the Worker's outbound intercept replaces it on requests it allows. However it
 * ends, the install's, build's and deploy's output is left in `logs/preview.deploy.log` for storing.
 */
export function previewScript(
  forkRemote: string,
  sha: string,
  preview: { accountId: string; workerName: string; previewName: string; command: string | null },
): string {
  const build =
    preview.command === null
      ? ""
      : `if ! timeout -k 10s ${seconds(PREVIEW_BUILD_TIMEOUT_MS)} bash -c ${quote(preview.command)} < /dev/null > ../build.log 2>&1; then
  result "{\\"ok\\":false,\\"stage\\":\\"build\\",\\"output\\":$(json < ../build.log)}"
fi`;
  return `${PRELUDE}
ws=$PWD
rm -rf preview logs install.log build.log preview.log preview.json && mkdir logs
trap 'cat "$ws/install.log" "$ws/build.log" "$ws/preview.log" > "$ws/logs/${PREVIEW_LOG}.log" 2> /dev/null' EXIT
git init -q preview && cd preview
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git checkout -q --detach ${quote(sha)} || exit 11
${install('"ok":false')}
${build}
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
 * The conflict check's result: `main`'s sha, the merge base (null with no shared history), the raw
 * `merge-tree` output for `parseMergeTree`, each content conflict's zdiff3 re-merge for
 * `conflictFiles`, and for a clean merge the merged tree's config (`parseConfig` it), null with none.
 */
export interface ConflictCheckResult {
  main: string;
  clean: boolean;
  base: string | null;
  output: string;
  remerges: Remerge[];
  /** The merged tree's `.throng/config.yml`, cut one byte past `MAX_CONFIG_BYTES` so an oversized one stays invalid. */
  config: string | null;
}

/** The merge the Landing Workflow lands: the approved head onto `main`, giving `tree`. */
export interface MergePlan {
  head: string;
  main: string;
  tree: string;
}

/**
 * Landing step 1, untrusted (read grants only): fetches the origin's `main` and the approved head
 * from the fork, then runs `git merge-tree --write-tree --messages -z` on them. It writes nothing;
 * `parseMergeTree` reads the merged tree, or the conflicting paths, from `output`.
 *
 * On a conflict, each path with all three sides is re-merged with `git merge-file -p --zdiff3`, its
 * lines outside the conflicts blanked so the output stays small but keeps its line numbers. A
 * re-merge whose conflicting lines are over twice the per-file cap, or that would take all of them
 * over twice the total cap, is `tooLarge`; `conflictFiles` applies the exact caps.
 *
 * On a clean merge it reads `.throng/config.yml` from the merged tree, before any repository code
 * runs: the retest runs under the config the merge would land, not `main`'s.
 */
export function conflictCheckScript(
  originRemote: string,
  forkRemote: string,
  head: string,
  caps: ConflictCaps = CONFLICT_CAPS,
): string {
  const [main, base, attempt] = MERGE_LABELS;
  return `${PRELUDE}
rm -rf merge merge-tree.out remerge remerge.list && git init -q merge && cd merge
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(originRemote)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
git cat-file -e ${quote(`${head}^{commit}`)} || exit 11
main=$(git rev-parse refs/remotes/origin/main) || exit 12
git merge-tree --write-tree --messages -z "$main" ${quote(head)} > ../merge-tree.out
code=$?
[ "$code" -le 1 ] || exit 13
clean=$([ "$code" = 0 ] && echo true || echo false)
base=$(git merge-base "$main" ${quote(head)}) && base="\\"$base\\"" || base=null
mkdir ../remerge && : > ../remerge.list
if [ "$code" = 1 ]; then
  # Each path with all three sides: its path, then its base, main and attempt blobs, NUL-separated.
  node -e '
const fields = require("fs").readFileSync(0, "utf8").split("\\0");
const sides = new Map();
for (let i = 1; i < fields.length && fields[i] !== ""; i++) {
  const tab = fields[i].indexOf("\\t");
  const [, oid, stage] = fields[i].slice(0, tab).split(" ");
  const path = fields[i].slice(tab + 1);
  if (!sides.has(path)) sides.set(path, {});
  sides.get(path)[stage] = oid;
}
for (const [path, s] of sides) if (s[1] && s[2] && s[3]) process.stdout.write([path, s[1], s[2], s[3], ""].join("\\0"));
' < ../merge-tree.out > ../remerge/three || exit 16
  n=0
  total=0
  while IFS= read -r -d '' path && IFS= read -r -d '' b && IFS= read -r -d '' m && IFS= read -r -d '' a; do
    n=$((n + 1))
    git merge-file -p --zdiff3 -L ${main} -L ${base} -L ${attempt} --object-id "$m" "$b" "$a" > ../remerge/raw 2> /dev/null
    if [ $? -gt 127 ]; then
      printf 'failed\\0%s\\0' "$path" >> ../remerge.list
      continue
    fi
    awk -v max=${2 * caps.fileBytes} '
      { l = $0; sub(/\\r$/, "", l) }
      !c && l == "<<<<<<< ${main}" { c = 1 }
      c { n += length($0) + 1; if (n > max) exit 3; print; if (l == ">>>>>>> ${attempt}") c = 0; next }
      { print "" }
    ' < ../remerge/raw > "../remerge/$n"
    status=$?
    size=$(wc -c < "../remerge/$n")
    if [ "$status" = 3 ] || [ $((total + size)) -gt ${2 * caps.totalBytes} ]; then
      printf 'tooLarge\\0%s\\0' "$path" >> ../remerge.list
      continue
    fi
    total=$((total + size))
    printf 'merged\\0%s\\0' "$path" >> ../remerge.list
  done < ../remerge/three
fi
output=$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")))' < ../merge-tree.out) || exit 16
remerges=$(node -e '
const fs = require("fs");
const list = fs.readFileSync("../remerge.list", "utf8").split("\\0");
const out = [];
for (let i = 0; i + 1 < list.length; i += 2) {
  const entry = { path: list[i + 1], status: list[i] };
  if (entry.status === "merged") entry.output = fs.readFileSync("../remerge/" + (i / 2 + 1), "utf8");
  out.push(entry);
}
process.stdout.write(JSON.stringify(out));
') || exit 16
config=null
if [ "$code" = 0 ]; then
  tree=$(head -z -n 1 ../merge-tree.out | tr -d '\\0')
  if [ "$(git cat-file -t "$tree:${CONFIG_PATH}" 2> /dev/null)" = blob ]; then
    git cat-file blob "$tree:${CONFIG_PATH}" > ../config.yml || exit 16
    config=$(head -c ${MAX_CONFIG_BYTES + 1} ../config.yml | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")))') || exit 16
  fi
fi
result "{\\"main\\":\\"$main\\",\\"clean\\":$clean,\\"base\\":$base,\\"output\\":$output,\\"remerges\\":$remerges,\\"config\\":$config}"
`;
}

/**
 * Landing step 2, untrusted (read grants only): reproduces the merged tree with
 * `git merge --no-ff --no-commit` of the approved head onto the recorded `main`, then runs the
 * plan (setup and the required checks) on it like scoring does, ending with a `RawScore`. A merge
 * that doesn't give the recorded tree is an infrastructure failure.
 */
export function retestScript(originRemote: string, forkRemote: string, merge: MergePlan, plan: ScorePlan): string {
  return `${PRELUDE}
rm -rf retest logs out && mkdir logs out && out="$PWD/out" && git init -q retest && cd retest
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(originRemote)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
git checkout -q --detach ${quote(merge.main)} || exit 11
git merge -q --no-ff --no-commit ${quote(merge.head)} > ../merge.log 2>&1 || exit 14
[ "$(git write-tree)" = ${quote(merge.tree)} ] || exit 14
now() { date +%s%3N; }
base=${quote(merge.main)}
shortstat=""
builtin_ms=0
${runPlan(plan)}
`;
}

export type LandResult = { kind: "landed"; sha: string } | { kind: "moved" } | { kind: "mismatch"; tree: string };

export interface LandPlan extends MergePlan {
  message: string;
  author: { name: string; email: string };
  /** The commit's author and committer time, in Unix seconds; fixed so a rerun makes the same commit. */
  committedAt: number;
}

/**
 * Landing step 3, trusted: holds origin write, so it runs no repository code (no npm or node, no
 * work tree, hooks off, no system, global or repo config). It merges the approved head onto the
 * recorded `main` with `git merge-tree`, checks the result is the tree the conflict check recorded,
 * commits it as a two-parent (`--no-ff`) merge, author the approver and committer Throng, and pushes
 * it with `--force-with-lease=main:<main>`, so a `main` that moved since is never overwritten. A
 * rerun after a push that landed reports the same landing.
 */
export function landScript(originRemote: string, forkRemote: string, land: LandPlan): string {
  const date = `@${land.committedAt} +0000`;
  return `
set -uo pipefail
result() { printf '${RESULT_PREFIX}%s\\n' "$1"; exit 0; }
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=${quote(land.author.name)} GIT_AUTHOR_EMAIL=${quote(land.author.email)} GIT_AUTHOR_DATE=${quote(date)}
export GIT_COMMITTER_NAME=${quote(THRONG_COMMITTER.name)} GIT_COMMITTER_EMAIL=${quote(THRONG_COMMITTER.email)} GIT_COMMITTER_DATE=${quote(date)}
rm -rf land message push.log && git init -q land && cd land
git config core.hooksPath /dev/null
printf '%s' ${quote(land.message)} > ../message
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(originRemote)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
git cat-file -e ${quote(`${land.head}^{commit}`)} || exit 11
git cat-file -e ${quote(`${land.main}^{commit}`)} 2> /dev/null || result '{"kind":"moved"}'
tree=$(git merge-tree --write-tree ${quote(land.main)} ${quote(land.head)} | head -n 1)
[ "$tree" = ${quote(land.tree)} ] || result "{\\"kind\\":\\"mismatch\\",\\"tree\\":\\"$tree\\"}"
commit=$(git commit-tree "$tree" -p ${quote(land.main)} -p ${quote(land.head)} -F ../message) || exit 13
if git push -q --force-with-lease=refs/heads/main:${quote(land.main)} ${quote(originRemote)} "$commit:refs/heads/main" 2> ../push.log; then
  result "{\\"kind\\":\\"landed\\",\\"sha\\":\\"$commit\\"}"
fi
now=$(git ls-remote ${quote(originRemote)} refs/heads/main | cut -f 1) || exit 12
[ "$now" = "$commit" ] && result "{\\"kind\\":\\"landed\\",\\"sha\\":\\"$commit\\"}"
[ "$now" = ${quote(land.main)} ] && exit 13
result '{"kind":"moved"}'
`;
}

/** How following the task branch went: see `followScript`. */
export type FollowResult =
  | { kind: "merged"; before: string; sha: string }
  | { kind: "current"; head: string }
  | { kind: "conflict"; head: string }
  | { kind: "moved" }
  | { kind: "stale" };

export interface FollowPlan {
  task: number;
  /** The task branch head to merge in. */
  taskHead: string;
  message: string;
  /** The merge commit's author and committer time, in Unix seconds; fixed so a rerun makes the same commit. */
  committedAt: number;
}

/**
 * Merges task head `taskHead` into an attempt's fork (ADR 0003), trusted: it holds fork write, so
 * like the land step it runs no repository code. It reads the fork's `main` and the origin's task
 * branch, which must still hold `taskHead` (else `stale`: the task branch was rewound, and a newer
 * follow has it). A head that already contains the task head is `current`; one the task head
 * contains is fast-forwarded to it; otherwise the two are merged with `git merge-tree`, a conflict
 * writing nothing. The merge commit is authored and committed by Throng, and pushed with a lease on
 * the head it read, so an author's push in between is never overwritten (`moved`). A rerun after
 * a push that landed reports `current`.
 */
export function followScript(originRemote: string, forkRemote: string, plan: FollowPlan): string {
  const date = `@${plan.committedAt} +0000`;
  const taskHead = quote(plan.taskHead);
  return `
set -uo pipefail
result() { printf '${RESULT_PREFIX}%s\\n' "$1"; exit 0; }
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=${quote(THRONG_COMMITTER.name)} GIT_AUTHOR_EMAIL=${quote(THRONG_COMMITTER.email)} GIT_AUTHOR_DATE=${quote(date)}
export GIT_COMMITTER_NAME=${quote(THRONG_COMMITTER.name)} GIT_COMMITTER_EMAIL=${quote(THRONG_COMMITTER.email)} GIT_COMMITTER_DATE=${quote(date)}
rm -rf follow message push.log && git init -q follow && cd follow
git config core.hooksPath /dev/null
printf '%s' ${quote(plan.message)} > ../message
git fetch -q ${quote(forkRemote)} '+refs/heads/main:refs/remotes/fork/main' || exit 10
git fetch -q ${quote(originRemote)} ${quote(`+${taskBranchRef(plan.task)}:refs/remotes/origin/task`)} || exit 12
head=$(git rev-parse refs/remotes/fork/main) || exit 10
git merge-base --is-ancestor ${taskHead} refs/remotes/origin/task 2> /dev/null || result '{"kind":"stale"}'
git merge-base --is-ancestor ${taskHead} "$head" && result "{\\"kind\\":\\"current\\",\\"head\\":\\"$head\\"}"
if git merge-base --is-ancestor "$head" ${taskHead}; then
  commit=${taskHead}
else
  tree=$(git merge-tree --write-tree "$head" ${taskHead} | head -n 1)
  code=\${PIPESTATUS[0]}
  [ "$code" = 1 ] && result "{\\"kind\\":\\"conflict\\",\\"head\\":\\"$head\\"}"
  [ "$code" = 0 ] || exit 13
  commit=$(git commit-tree "$tree" -p "$head" -p ${taskHead} -F ../message) || exit 13
fi
merged="{\\"kind\\":\\"merged\\",\\"before\\":\\"$head\\",\\"sha\\":\\"$commit\\"}"
git push -q --force-with-lease=refs/heads/main:"$head" ${quote(forkRemote)} "$commit:refs/heads/main" 2> ../push.log && result "$merged"
now=$(git ls-remote ${quote(forkRemote)} refs/heads/main | cut -f 1) || exit 10
[ "$now" = "$commit" ] && result "$merged"
[ "$now" = "$head" ] && exit 13
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
