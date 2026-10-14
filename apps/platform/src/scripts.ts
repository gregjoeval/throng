// Bash run inside a run's Sandbox. Each script is idempotent, so a retried Workflow step can rerun it
// on the same container or a fresh one. The last stdout line is the result: `THRONG_RESULT <json>`.

import { CONFIG_PATH, MAX_CONFIG_BYTES } from "./config.ts";
import type { SetupConfig, StepConfig } from "./config.ts";
import { CONFLICT_CAPS, MERGE_LABELS } from "./conflicts.ts";
import type { ConflictCaps, Remerge } from "./conflicts.ts";
import { THRONG_COMMITTER } from "./landing.ts";
import { setupLogName, stepLogName } from "./logs.ts";
import { METRIC_VALUES_SOURCE, metricValue, parseFrom } from "./metric-values.ts";
import type { MetricValue } from "./metric-values.ts";
import type { TreeEntry } from "./repos.ts";
import { MAX_OUTPUT_BYTES, SETUP_TIMEOUT_MS } from "./results.ts";
import type { PlannedCheck, PlannedMetric } from "./results.ts";
import { quote } from "./shell.ts";
import { taskBranchRef } from "./task-refs.ts";

export const RESULT_PREFIX = "THRONG_RESULT ";

/** Where a script that runs repo code failed: installing dependencies, or running/building the repo. */
export type FailureStage = "install" | "test";

const PRELUDE = `
set -uo pipefail
result() { printf '${RESULT_PREFIX}%s\\n' "$1"; exit 0; }
`;

/** The file a setup container leaves once every setup passed, so a container restored from its snapshot skips them. */
const SETUP_DONE = "setup.done";

/** The file a post-gate step's container leaves once it is ready for the step's command. */
const STEP_READY = "step.ready";

/** Exit code: a setup that passed in the setup container failed when re-run in a check's or step's container. */
export const RERUN_SETUP_FAILED_EXIT = 17;

/** Exit code: a post-gate step's container wasn't readied for its command (`stepReadyScript`). */
export const STEP_NOT_READY_EXIT = 18;

/**
 * What a pipeline run's containers check out: a line's head `sha`, fetched from the line's repo, or
 * for a landing the merge of its approved head onto `main` (`merge`), fetched from the origin and
 * the attempt's fork.
 */
export type Checkout =
  | { kind: "line"; remote: string; sha: string }
  | { kind: "merge"; origin: string; fork: string; merge: MergeCheckout };

/**
 * The merge a landing's containers make again before it lands: its plan, committed by Throng at
 * `committedAt` (Unix seconds) with a fixed message, so every container makes the same commit, whose
 * sha `mergeCheckoutSha` gives. It's never pushed.
 */
export interface MergeCheckout extends MergePlan {
  committedAt: number;
}

/** The message of the merge commit a landing's containers make. */
const MERGE_CHECKOUT_MESSAGE = "Merge for the landing";

/** The sha of the merge commit a landing's containers make for `merge` (see `checkoutTree`). */
export async function mergeCheckoutSha(merge: MergeCheckout): Promise<string> {
  const { name, email } = THRONG_COMMITTER;
  const who = `${name} <${email}> ${merge.committedAt} +0000`;
  const body = new TextEncoder().encode(
    `tree ${merge.tree}\nparent ${merge.main}\nparent ${merge.head}\nauthor ${who}\ncommitter ${who}\n\n${MERGE_CHECKOUT_MESSAGE}\n`,
  );
  const header = new TextEncoder().encode(`commit ${body.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + body.byteLength);
  object.set(header);
  object.set(body, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", object);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Bash that checks `checkout` out into `tree`, in a clean `/workspace` with `logs` and `out` beside
 * it. A line's head is fetched with the repo's branches and its task branches (`refs/tasks/*`), as a
 * task branch's head is only under the latter. A landing's merge is made again from `main` and the
 * approved head, which must give the tree its `merge` step recorded, and committed here only (never
 * pushed), so `HEAD` holds the merged tree with `main` and the head as its parents. That commit is
 * the same in every container, at `mergeCheckoutSha`. Needs `PRELUDE`.
 */
function checkoutTree(checkout: Checkout): string {
  const fresh = `rm -rf tree logs out ${SETUP_DONE} ${STEP_READY} && mkdir logs out && git init -q tree && cd tree`;
  if (checkout.kind === "line") {
    return `${fresh}
git fetch -q ${quote(checkout.remote)} '+refs/heads/*:refs/remotes/line/*' '+refs/tasks/*:refs/remotes/tasks/*' || exit 10
git checkout -q --detach ${quote(checkout.sha)} || exit 11`;
  }
  const { head, main, tree, committedAt } = checkout.merge;
  const { name, email } = THRONG_COMMITTER;
  const date = quote(`@${committedAt} +0000`);
  const who = `GIT_AUTHOR_NAME=${quote(name)} GIT_AUTHOR_EMAIL=${quote(email)} GIT_AUTHOR_DATE=${date} GIT_COMMITTER_NAME=${quote(name)} GIT_COMMITTER_EMAIL=${quote(email)} GIT_COMMITTER_DATE=${date}`;
  return `${fresh}
git fetch -q ${quote(checkout.fork)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(checkout.origin)} '+refs/heads/main:refs/remotes/origin/main' || exit 12
git cat-file -e ${quote(`${head}^{commit}`)} && git cat-file -e ${quote(`${main}^{commit}`)} || exit 11
[ "$(git merge-tree --write-tree ${quote(main)} ${quote(head)} | head -n 1)" = ${quote(tree)} ] || exit 14
merged=$(${who} git commit-tree ${quote(tree)} -p ${quote(main)} -p ${quote(head)} -m ${quote(MERGE_CHECKOUT_MESSAGE)}) || exit 14
git checkout -q --detach "$merged" || exit 11`;
}

/**
 * Bash that runs every setup again in the checked-out tree, its output appended to `log` under a
 * header each, for a container that couldn't start from the setups' snapshot. A setup that fails
 * here passed in the setup container, so it's an infrastructure failure.
 */
function rerunSetups(setups: readonly SetupConfig[], log: string): string {
  return setups
    .map(
      ({ name, command }) => `printf '== throng: setup %s ==\\n' ${quote(name)} >> ${log}
timeout -k 10s ${seconds(SETUP_TIMEOUT_MS)} bash -c ${quote(command)} < /dev/null >> ${log} 2>&1 || exit ${RERUN_SETUP_FAILED_EXIT}`,
    )
    .join("\n");
}

/** What the setup container reports: the diff from the base, and how each setup went. */
export interface SetupResult {
  base: string | null;
  /** `git diff --shortstat` from the base (or the empty tree) to the head. */
  shortstat: string;
  /** How long finding the base and diffing took. */
  builtinMs: number;
  /** One per setup, in order; `exit` is null for a setup that didn't run because an earlier one failed. */
  setups: { exit: number | null; durationMs: number }[];
}

/**
 * A pipeline run's setup container: checks `checkout` out and records the diff size from `base`
 * (the line's base as `lineBase` derived it, an ancestor of the head so the repo has it; `main` for
 * a landing), or from the empty tree when it has none. Then it runs each setup in order under
 * `timeout`, each logging to `logs/<setup.n>.log`, and stops at the first that fails. When every one
 * passed it leaves `setup.done`, so the snapshot taken of it next carries both the setups' work and
 * the mark.
 */
export function setupScript(checkout: Checkout, base: string | null, setups: readonly SetupConfig[]): string {
  const steps = setups
    .map(
      ({ command }, i) => `t0=$(now)
timeout -k 10s ${seconds(SETUP_TIMEOUT_MS)} bash -c ${quote(command)} < /dev/null > ../logs/${setupLogName(i + 1)}.log 2>&1
code=$?
printf '%s %s\\n' "$code" "$(( $(now) - t0 ))" > ../out/${setupLogName(i + 1)}.status
[ "$code" = 0 ] || setup_failed=1`,
    )
    .map((step) => `if [ -z "$setup_failed" ]; then\n${step}\nfi`)
    .join("\n");
  return `${PRELUDE}
${checkoutTree(checkout)}
now() { date +%s%3N; }
t0=$(now)
base=${quote(base ?? "")}
shortstat=$(git diff --shortstat "\${base:-$(git hash-object -t tree /dev/null)}" HEAD) || exit 15
builtin_ms=$(( $(now) - t0 ))
setup_failed=""
${steps}
[ -z "$setup_failed" ] && touch ../${SETUP_DONE}
node - "$base" "$shortstat" "$builtin_ms" ${setups.length} <<'NODE' || exit 16
const fs = require("fs");
const [base, shortstat, builtinMs, count] = process.argv.slice(2);
const setups = [];
for (let i = 1; i <= Number(count); i++) {
  const path = "../out/setup." + i + ".status";
  if (!fs.existsSync(path)) {
    setups.push({ exit: null, durationMs: 0 });
    continue;
  }
  const [exit, durationMs] = fs.readFileSync(path, "utf8").trim().split(" ").map(Number);
  setups.push({ exit, durationMs });
}
process.stdout.write("${RESULT_PREFIX}" + JSON.stringify({ base: base || null, shortstat, builtinMs: Number(builtinMs), setups }) + "\\n");
NODE
`;
}

/** What a check's container reports: the check's run, as `RawScore` holds it, and whether it re-ran the setups. */
export interface CheckRun {
  exit: number;
  durationMs: number;
  metrics: Record<string, MetricValue>;
  /** True when the container didn't hold the setups' work (no snapshot, or it couldn't be restored) and ran them itself. */
  setupsRerun: boolean;
}

/**
 * A pipeline run's container for one check. Restored from the setup container's snapshot it finds
 * `setup.done` and goes straight to the check; otherwise (no snapshot, or one that couldn't be
 * restored) it checks `checkout` out and runs the setups itself first, their output at the top of
 * the check's log. A setup that fails here passed in the setup container, so it's an infrastructure
 * failure (`RERUN_SETUP_FAILED_EXIT`). The check runs under `timeout` with `$THRONG_OUTPUT` pointing
 * at an empty directory of its own, logging to `logs/<name>.log`, and as soon as it exits, whatever
 * its outcome, `readValues` reads its metrics from that directory.
 */
export function checkScript(
  checkout: Checkout,
  setups: readonly SetupConfig[],
  check: Pick<PlannedCheck, "name" | "command" | "timeoutMs" | "metrics">,
): string {
  const log = `../logs/${check.name}.log`;
  const output = `"$PWD/../out/${check.name}"`;
  return `${PRELUDE}
now() { date +%s%3N; }
setups_rerun=false
if [ ! -f ${SETUP_DONE} ]; then
  setups_rerun=true
  ${checkoutTree(checkout).replaceAll("\n", "\n  ")}
${rerunSetups(setups, log)}
  touch ../${SETUP_DONE}
else
  rm -rf out/${check.name} logs/${check.name}.log && cd tree
fi
rm -rf ${output} && mkdir -p ${output}
t0=$(now)
THRONG_OUTPUT=${output} timeout -k 10s ${seconds(check.timeoutMs)} bash -c ${quote(check.command)} < /dev/null >> ${log} 2>&1
code=$?
duration=$(( $(now) - t0 ))
${check.metrics.length === 0 ? "printf '{}' > ../out/values.json" : readValues(output, check.metrics, "../out/values.json")}
result "{\\"exit\\":$code,\\"durationMs\\":$duration,\\"setupsRerun\\":$setups_rerun,\\"metrics\\":$(cat ../out/values.json)}"
`;
}

/** What a post-gate step's container reports once it is ready: whether it re-ran the setups. */
export interface StepReady {
  setupsRerun: boolean;
}

/**
 * Readies a pipeline run's container for one post-gate step, without starting the step's command:
 * restored from the setups' snapshot it finds `setup.done`; otherwise it fetches the head `sha` and
 * runs the setups itself, their output at the top of the step's log. A landing's snapshot holds the
 * merged tree under a commit of its own, so a container restored from it then checks out the landed
 * commit `sha`, whose tree is the same: what the setups made stays as it is. Then it leaves
 * `step.ready` for `stepScript`. Safe to retry: the step's command hasn't started.
 */
export function stepReadyScript(remote: string, sha: string, setups: readonly SetupConfig[], step: StepConfig): string {
  const log = `../logs/${stepLogName(step.name)}.log`;
  return `${PRELUDE}
setups_rerun=false
if [ ! -f ${SETUP_DONE} ]; then
  setups_rerun=true
  ${checkoutTree({ kind: "line", remote, sha }).replaceAll("\n", "\n  ")}
${rerunSetups(setups, log)}
  touch ../${SETUP_DONE}
  cd ..
elif [ "$(git -C tree rev-parse HEAD)" != ${quote(sha)} ]; then
  git -C tree fetch -q ${quote(remote)} '+refs/heads/*:refs/remotes/line/*' || exit 10
  git -C tree checkout -q --detach ${quote(sha)} || exit 11
fi
touch ${STEP_READY}
result "{\\"setupsRerun\\":$setups_rerun}"
`;
}

/** What a post-gate step's container reports once its command ran. */
export interface StepRun {
  exit: number;
  durationMs: number;
}

/**
 * Runs one post-gate step's command, once, in the container `stepReadyScript` readied, under
 * `timeout`, logging to `logs/step.<name>.log`. It takes the `step.ready` mark before starting the
 * command, so a container that isn't ready (it was lost, say), or one whose command already started,
 * is an infrastructure failure (`STEP_NOT_READY_EXIT`), and the command never starts (again).
 */
export function stepScript(step: StepConfig, timeoutMs: number): string {
  return `${PRELUDE}
now() { date +%s%3N; }
rm ${STEP_READY} 2> /dev/null || exit ${STEP_NOT_READY_EXIT}
cd tree
t0=$(now)
timeout -k 10s ${seconds(timeoutMs)} bash -c ${quote(step.command)} < /dev/null >> ../logs/${stepLogName(step.name)}.log 2>&1
code=$?
result "{\\"exit\\":$code,\\"durationMs\\":$(( $(now) - t0 ))}"
`;
}

/**
 * Bash that reads `metrics` from the JSON files a check wrote into `dir` and writes their values, by
 * name, as JSON to `to`. Each file is parsed once, and not at all over `MAX_OUTPUT_BYTES`; the path
 * into it and the type check are `metricValue`'s, the same code the Worker runs.
 */
function readValues(dir: string, metrics: PlannedMetric[], to: string): string {
  return `node - ${dir} ${quote(JSON.stringify(metrics))} ${MAX_OUTPUT_BYTES} > ${to} <<'NODE' || exit 16
const fs = require("fs");
${METRIC_VALUES_SOURCE}
const [dir, metrics, max] = process.argv.slice(2);
const files = () => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
};
const load = (name) => {
  const path = dir + "/" + name + ".json";
  let stat;
  try {
    stat = fs.statSync(path);
  } catch {
    return { kind: "missing", files: files() };
  }
  if (!stat.isFile()) return { kind: "missing", files: files() };
  if (stat.size > Number(max)) return { kind: "tooLarge", limit: Number(max) };
  try {
    return { kind: "parsed", json: JSON.parse(fs.readFileSync(path, "utf8")) };
  } catch {
    return { kind: "invalid" };
  }
};
const loaded = new Map();
const values = {};
for (const { name, from, rule } of JSON.parse(metrics)) {
  const { file } = ${parseFrom.name}(from);
  if (!loaded.has(file)) loaded.set(file, load(file));
  values[name] = ${metricValue.name}(from, rule, loaded.get(file));
}
process.stdout.write(JSON.stringify(values));
NODE`;
}

/**
 * The `merge` step's result: `main`'s sha, the merge base (null with no shared history), the raw
 * `merge-tree` output for `parseMergeTree`, each content conflict's zdiff3 re-merge for
 * `conflictFiles`, and for a clean merge the merged tree's config (`parseConfig` it), null with none.
 */
export interface MergeResult {
  main: string;
  clean: boolean;
  base: string | null;
  output: string;
  remerges: Remerge[];
  /** The merged tree's `.throng/config.yml`, cut one byte past `MAX_CONFIG_BYTES` so an oversized one stays invalid. */
  config: string | null;
  /**
   * For a clean merge: each tree the merge made, by its hash, with its entries. They're in no repo,
   * so a cache key read from the merged tree reads them here; every other tree in it is `main`'s or
   * the head's. Absent from a result of a script that didn't give them.
   */
  trees?: Record<string, TreeEntry[]>;
}

/** The merge a landing lands: the approved head onto `main`, giving `tree`. */
export interface MergePlan {
  head: string;
  main: string;
  tree: string;
}

/**
 * A landing's `merge` step, untrusted (read grants only): fetches the origin's `main` and the approved head
 * from the fork, then runs `git merge-tree --write-tree --messages -z` on them. It writes nothing;
 * `parseMergeTree` reads the merged tree, or the conflicting paths, from `output`.
 *
 * On a conflict, each path with all three sides is re-merged with `git merge-file -p --zdiff3`, its
 * lines outside the conflicts blanked so the output stays small but keeps its line numbers. A
 * re-merge whose conflicting lines are over twice the per-file cap, or that would take all of them
 * over twice the total cap, is `tooLarge`; `conflictFiles` applies the exact caps.
 *
 * On a clean merge it reads `.throng/config.yml` from the merged tree, before any repository code
 * runs: the landing's setups and checks run under the config the merge would land, not `main`'s.
 */
export function mergeScript(
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
trees='{}'
if [ "$code" = 0 ]; then
  tree=$(head -z -n 1 ../merge-tree.out | tr -d '\\0')
  if [ "$(git cat-file -t "$tree:${CONFIG_PATH}" 2> /dev/null)" = blob ]; then
    git cat-file blob "$tree:${CONFIG_PATH}" > ../config.yml || exit 16
    config=$(head -c ${MAX_CONFIG_BYTES + 1} ../config.yml | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")))') || exit 16
  fi
  # The trees the merge made, which neither main nor the head has: what a cache key needs besides theirs.
  trees=$(node - "$tree" "$main" ${quote(head)} <<'NODE'
const { execFileSync } = require("child_process");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
const ls = (...args) =>
  git("ls-tree", "-z", ...args)
    .split("\\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\\t");
      const [mode, type, hash] = line.slice(0, tab).split(" ");
      return { name: line.slice(tab + 1), mode, type, hash };
    });
const [merged, ...sides] = process.argv.slice(2);
const known = new Set();
for (const side of sides) {
  known.add(git("rev-parse", side + "^{tree}").trim());
  for (const entry of ls("-r", "-t", side)) if (entry.type === "tree") known.add(entry.hash);
}
const made = [merged, ...ls("-r", "-t", merged).filter((e) => e.type === "tree").map((e) => e.hash)];
const trees = {};
for (const hash of made) if (!known.has(hash)) trees[hash] = ls(hash);
process.stdout.write(JSON.stringify(trees));
NODE
) || exit 16
fi
result "{\\"main\\":\\"$main\\",\\"clean\\":$clean,\\"base\\":$base,\\"output\\":$output,\\"remerges\\":$remerges,\\"config\\":$config,\\"trees\\":$trees}"
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
 * A landing's `land` step, trusted: holds origin write, so it runs no repository code (no npm or node, no
 * work tree, hooks off, no system, global or repo config). It merges the approved head onto the
 * recorded `main` with `git merge-tree`, checks the result is the tree the `merge` step recorded,
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
  | { kind: "merged"; before: string; head: string }
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
merged="{\\"kind\\":\\"merged\\",\\"before\\":\\"$head\\",\\"head\\":\\"$commit\\"}"
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
