// Bash run inside a check's Sandbox. Each script is idempotent, so a retried Workflow step can rerun it
// on a fresh container. The last stdout line is the result: `THRONG_RESULT <json>`.

export const RESULT_PREFIX = "THRONG_RESULT ";

/** Where a script that runs repo code failed: installing dependencies, or running/building the repo. */
export type FailureStage = "install" | "test";

export type TestResult = { ok: true } | { ok: false; stage: FailureStage; output: string };

export type PreviewResult = { ok: true; url: string } | { ok: false; stage: "install" | "deploy"; output: string };

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

/** Check out the attempt's commit, install its dependencies, and run its tests. */
export function testScript(forkRemote: string, sha: string): string {
  return `${PRELUDE}
rm -rf attempt && git init -q attempt && cd attempt
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git checkout -q --detach ${quote(sha)} || exit 11
${install('"ok":false')}
if npm test > ../test.log 2>&1; then result '{"ok":true}'; fi
result "{\\"ok\\":false,\\"stage\\":\\"test\\",\\"output\\":$(json < ../test.log)}"
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
 * Untrusted: rebase the attempt onto the canonical repo's current main and re-run the tests. Reports
 * the main it rebased onto and the tree it tested, for the trusted land step to check against.
 */
export function retestScript(canonicalRemote: string, forkRemote: string, sha: string): string {
  return `${PRELUDE}
rm -rf retest && git init -q retest && cd retest
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git fetch -q ${quote(canonicalRemote)} '+refs/heads/main:refs/remotes/canonical/main' || exit 12
git checkout -q -B attempt ${quote(sha)} || exit 11
base=$(git rev-parse canonical/main)
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
 * Trusted: holds canonical write, so it runs no repository code (no npm or node, no hooks, no config
 * from the repo). It redoes the same rebase onto the pinned main and pushes only if the result is the
 * exact tree the retest step tested, so an untrusted step can't hand over other content.
 */
export function landScript(
  canonicalRemote: string,
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
git fetch -q ${quote(canonicalRemote)} '+refs/heads/main:refs/remotes/canonical/main' || exit 12
[ "$(git rev-parse canonical/main)" = ${quote(tested.base)} ] || result '{"kind":"moved"}'
git checkout -q -B attempt ${quote(sha)} || exit 11
git rebase -q ${quote(tested.base)} > /dev/null 2>&1 || exit 14
tree=$(git rev-parse 'HEAD^{tree}')
[ "$tree" = ${quote(tested.tree)} ] || result "{\\"kind\\":\\"mismatch\\",\\"tree\\":\\"$tree\\"}"
if git push -q ${quote(canonicalRemote)} HEAD:refs/heads/main; then
  result "{\\"kind\\":\\"landed\\",\\"mainSha\\":\\"$(git rev-parse HEAD)\\"}"
fi
result '{"kind":"moved"}'
`;
}

/** Pulls the result line out of a script's stdout. */
export function parseResult<T>(stdout: string): T | null {
  const line = stdout
    .split("\n")
    .toReversed()
    .find((l) => l.startsWith(RESULT_PREFIX));
  return line === undefined ? null : (JSON.parse(line.slice(RESULT_PREFIX.length)) as T);
}
