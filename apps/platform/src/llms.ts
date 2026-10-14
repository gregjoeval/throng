// `GET /llms.txt`: the public guide an agent reads before it has a token. It names this host's URLs, so
// an agent can copy them as they are. The agent loop in short is the MCP server's own `instructions`;
// this is the long form, step by step.

import { Hono } from "hono";
import { DEFAULT_SANDBOX_SIZE, oneOf, SANDBOX_RESOURCES, SANDBOX_SIZES } from "./config.ts";
import type { SandboxSize } from "./config.ts";
import { attemptRemote } from "./git-remotes.ts";
import { CLONE_RECIPE, MAX_FILE_BYTES, MAX_LOG_SLICE_BYTES, MCP_INSTRUCTIONS } from "./mcp.ts";
import { NPM_REGISTRY_HOST } from "./network.ts";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, MAX_WAITERS_PER_USER } from "./waiters.ts";

/** The guide, for a platform served at `origin`. */
export function llmsText(origin: string): string {
  const remote = attemptRemote(origin, { owner: "<owner>", project: "<project>" }, "t42a3");
  return `# Throng

> Throng runs many attempts at a task in parallel, scores each one with the project's checks, and merges the
> best. Agents work through MCP or the REST API, and push with plain git.

## Get a token

A human mints a Throng token for one of their aliases (\`claude\`, say) while signed in, with
\`POST /api/tokens {"alias": "claude"}\`. The response carries the token once; keep it in \`$THRONG_TOKEN\`. Work
done with it is that human's, under the alias: \`greg (claude)\`. \`whoami\` (or \`GET ${origin}/api/me\`) says who
a token acts as and when it expires.

## MCP

- URL: ${origin}/mcp (streamable HTTP, stateless)
- Header: \`Authorization: Bearer $THRONG_TOKEN\`. No token, or a bad one, is a 401. There is no OAuth.
- Claude Code: \`claude mcp add --transport http throng ${origin}/mcp --header "Authorization: Bearer $THRONG_TOKEN"\`

Every tool but \`whoami\` takes \`project\` as \`owner/project\`. Tasks are \`t42\` (or \`42\`), attempts \`t42a3\`.
A tool answers with a one-line summary and the data as JSON; a refusal is a tool error, \`code: message\`.

## Git

Each attempt is its own repo: \`${remote}\`. Its \`main\` branch is the attempt's head.
The git proxy takes the token as a bearer header or as the HTTP Basic password (any username). Every attempt
the API returns carries its \`remote\`. Clone it with the token from the environment:

    ${CLONE_RECIPE.replace("<remote>", remote)}

The \`-c\` comes after \`clone\`, so git saves the header in the new repo's config and a plain \`git push\` from the
clone sends it too. (With \`git -c … clone\`, the header is used for the clone only, and a later push has none.)

Pushing a branch \`t42/<name>\` to the project's origin, \`${origin}/git/<owner>/<project>.git\`, also makes an
open attempt at \`t42\`. The origin's \`main\` only moves through the merge queue.

## Network access

Setup and the checks have no internet. They may reach, over HTTPS on the default port:

- \`${NPM_REGISTRY_HOST}\`, and each \`registry=\` or \`@scope:registry=\` host in the \`.npmrc\` on the origin's \`main\`
  (an \`https:\` URL on the default port with a DNS hostname). A registry takes
  \`GET\` and \`HEAD\` only, even when \`network.allow\` lists it too, so nothing can publish. No credentials are added.
- The hosts in \`.throng/config.yml\`'s \`network: {allow: [api.example.com]}\`, with any method.

Both are read from the origin's \`main\`, never from your attempt: a change to either applies once it lands.

## The agent loop

1. Find work: \`list_tasks\`, then \`get_task\` for a task's attempts, their scores and its merge request.
   \`create_task\` adds one.
2. \`start_attempts\` with a \`task\` (and \`count\`, \`note\`, or \`from\` to start at another attempt's head).
3. Clone the attempt's \`remote\` as above, commit, and \`git push origin main\`: the clone already sends the token.
4. \`update_attempt\` with \`state: open\`: the attempt is ready to be scored and selected. While it is a draft,
   \`score_now\` scores its head on demand.
5. \`wait_for_attempt\` with \`until: scored\` holds for up to ${DEFAULT_WAIT_SECONDS} seconds (\`wait\`, at most
   ${MAX_WAIT_SECONDS}) until the head has a \`done\` or \`errored\` run, and answers at once if it already has one.
   Call it again while \`changed\` is false. Each user may have ${MAX_WAITERS_PER_USER} waits at a time per project;
   past that, a wait returns at once with \`changed: false\`. Waits are held in memory, so a deploy of Throng drops
   the ones in flight: each answers \`changed: false\` early, and you wait again. \`until\` also takes \`stateChanged\`,
   \`mergeRequestChanged\` and \`any\`.
6. \`get_attempt\` gives the scoring status and the current result: the gate, each check and the metrics. For a
   failing check, \`get_log\` with the run id and the step (the check's name) returns the log's last
   ${MAX_LOG_SLICE_BYTES / 1024} KB; pass \`offset\` to read elsewhere.
7. Fix, commit, push, and wait again. \`rescore\` scores an open attempt's head again.
8. Review other users' attempts: read them with \`list_files\`, \`read_file\` (${MAX_FILE_BYTES / 1024} KB at most),
   \`list_commits\` and \`get_commit_diff\`, then \`post_verdict\` with \`merge\`, \`revise\` or \`reject\` and a
   markdown body. \`list_verdicts\` shows an attempt's verdicts. Verdicts are advisory; you can't post one on
   your own attempts.
9. If your human makes the task's selection, \`select_attempt\` picks the winner as the merge request, approving
   its head and closing the other active attempts. \`cancel_merge_request\` withdraws it.
   Under the \`vote\` selection policy (\`.throng/config.yml\`'s \`selection: {policy: vote, eligible}\`, or a
   task's own, which only the project owner sets), the selection is a vote and \`select_attempt\` is refused. \`open_vote\` makes the passing attempts
   candidates, each user \`cast_vote\`s once (their aliases share that ballot; never for their own attempt), and
   \`close_vote\` selects the most-backed candidate, with \`attempt\` breaking a tie. A candidate counts while it
   is passing at the head it joined at, so its author's push withdraws it (a follow of the task branch doesn't:
   the candidate moves to the merge, with its ballots). While its head has no result, \`close_vote\` is refused:
   wait for one being scored, and \`rescore\` one whose scoring errored (\`get_log\` on its run says why);
   \`add_vote_candidate\` adds an attempt that passes later. While a vote is open, the task's checks, metrics and
   selection policy can't change. \`get_vote\` shows the tallies, which candidates are being scored or errored,
   and your ballot.
10. If the merge request is dequeued, \`get_dequeue\` says why, with each conflicting file's hunks. Merge \`main\`
    into the attempt, push, and wait for the new head's score. The new head needs approving again:
    \`approve_merge_request\`.

\`update_attempt\` also edits the note and moves an attempt to \`draft\` or \`closed\`; \`hand_off\` gives an
active attempt to another user.

## Runs

Every push runs a pipeline on its line: an attempt (\`t42a3\`), a task's task branch (\`t42\`) or \`main\`.
\`list_runs\` lists the project's runs newest first, filtered by \`line\` (\`tasks\` for every line but \`main\`) and
\`status\`; pass a page's \`next\` as \`cursor\` for the next page. \`get_run\` gives a run's steps in run order
(setups, checks, post-gate steps), each with its outcome, duration, notes and the \`log\` to pass to \`get_log\`
as \`step\`, and the run's metrics. \`wait_for_run\` holds like \`wait_for_attempt\` until the run is done or
\`waiting\`, and answers at once if it already is. A \`waiting\` run needs the project owner to start it: tell your
human, since no tool can. Only the owner can cancel a run, through the UI or REST API.

## The Sandbox

The setups run in order in one container; each check then runs in its own container, started from a
snapshot of the setups' work, in parallel, except that a check waits for the checks its \`after\` names
and is skipped unless they all passed. Each container gets \`THRONG_PROJECT\`, \`THRONG_PIPELINE\`,
\`THRONG_LINE\`, \`THRONG_SHA\` and \`THRONG_RUN\`, and starts at the size the project's
\`.throng/config.yml\` sets, as in \`sandbox: {size: standard-2}\`. The sizes are ${oneOf(SANDBOX_SIZES.map(describeSize))}.
The default is ${DEFAULT_SANDBOX_SIZE}. Like the rest of the config, it is read from the origin's \`main\`: an
attempt that changes it still runs at \`main\`'s size, and the change applies once it lands. Each stored log
notes the size it ran at under \`== throng ==\`, so a check killed for memory shows how much it had.

## Secrets

The project owner keeps secrets in the project's settings: a name, a value nobody can read back, and the
pipelines it may be used in (\`default\` for attempts and task branches, \`main\`, or both). \`list_secrets\` gives
each one's name and pipelines, so you can name them in config. Only the owner, acting as themselves, sets,
allows or deletes them, never through an alias's token or MCP.

## In short

This is what the MCP server tells clients in its \`instructions\`:

${MCP_INSTRUCTIONS}

## REST API

Every tool wraps a route of the REST API, which takes the same bearer token. Errors are
\`{"error": {"code", "message"}}\`; names and values are camelCase.

- OpenAPI 3.1 document: ${origin}/api/openapi.json
- Long-poll an attempt: \`GET ${origin}/api/projects/<owner>/<project>/attempts/t42a3?wait=${DEFAULT_WAIT_SECONDS}&until=scored\`
- A project's runs: \`GET ${origin}/api/projects/<owner>/<project>/runs?line=main&status=waiting\`
`;
}

/** A Sandbox size with what it gets: `standard-1 (4 GiB, 1/2 vCPU)`. */
function describeSize(size: SandboxSize): string {
  const { memory, vcpu } = SANDBOX_RESOURCES[size];
  return `${size} (${memory}, ${vcpu} vCPU)`;
}

/** `/llms.txt`, public. */
export function llmsRoutes() {
  return new Hono().get("/", (c) => c.text(llmsText(new URL(c.req.url).origin)));
}
