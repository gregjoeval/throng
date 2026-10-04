// Bash run inside a check's Sandbox. Each script is idempotent, so a retried Workflow step can rerun it
// on a fresh container. The last stdout line is the result: `THRONG_RESULT <json>`.

export const RESULT_PREFIX = "THRONG_RESULT ";

export type TestResult = { ok: true } | { ok: false; output: string };

export type LandResult =
  | { kind: "landed"; mainSha: string; attempts: number }
  | { kind: "failed"; output: string }
  | { kind: "bounced"; files: string[]; diff: string }
  | { kind: "gave-up"; attempts: number };

const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

const PRELUDE = `
set -uo pipefail
result() { printf '${RESULT_PREFIX}%s\\n' "$1"; exit 0; }
json() { node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8").slice(-8000)))'; }
`;

/** Check out the attempt's commit and run its tests. */
export function testScript(forkRemote: string, sha: string): string {
  return `${PRELUDE}
rm -rf attempt && git init -q attempt && cd attempt
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git checkout -q --detach ${quote(sha)} || exit 11
if npm test > ../test.log 2>&1; then result '{"ok":true}'; fi
result "{\\"ok\\":false,\\"output\\":$(json < ../test.log)}"
`;
}

/**
 * Rebase the attempt onto the canonical repo's main, re-run the tests, and push to main. A push
 * rejected because main moved meanwhile is retried from a fresh fetch.
 */
export function landScript(canonicalRemote: string, forkRemote: string, sha: string, maxAttempts = 3): string {
  return `${PRELUDE}
rm -rf land && git init -q land && cd land
git fetch -q ${quote(forkRemote)} '+refs/heads/*:refs/remotes/fork/*' || exit 10
git checkout -q -B attempt ${quote(sha)} || exit 11
for n in $(seq 1 ${maxAttempts}); do
  git fetch -q ${quote(canonicalRemote)} '+refs/heads/main:refs/remotes/canonical/main' || exit 12
  if ! git rebase -q canonical/main > ../rebase.log 2>&1; then
    files=$(git diff --name-only --diff-filter=U | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8").split("\\n").filter(Boolean)))')
    diff=$(git diff | json)
    git rebase --abort
    result "{\\"kind\\":\\"bounced\\",\\"files\\":$files,\\"diff\\":$diff}"
  fi
  if ! npm test > ../test.log 2>&1; then
    result "{\\"kind\\":\\"failed\\",\\"output\\":$(json < ../test.log)}"
  fi
  if git push -q ${quote(canonicalRemote)} HEAD:refs/heads/main 2> ../push.log; then
    result "{\\"kind\\":\\"landed\\",\\"mainSha\\":\\"$(git rev-parse HEAD)\\",\\"attempts\\":$n}"
  fi
  cat ../push.log >&2
done
result '{"kind":"gave-up","attempts":${maxAttempts}}'
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
