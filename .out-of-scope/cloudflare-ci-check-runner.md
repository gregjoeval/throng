# @cloudflare/ci as the check runner

Throng does not use Cloudflare's `@cloudflare/ci` SDK to run attempt checks. Checks run on our own
Workflows and Sandbox Durable Object (`apps/platform/src/workflows.ts`, `apps/platform/src/sandbox.ts`),
built directly on Sandbox SDK 1.0.

## Why this is out of scope

`@cloudflare/ci` is a good fit for "run CI when a repo is pushed", but a Throng check does more than
run CI. It tests an attempt in its own fork, then rebases it onto the canonical repo's `main`,
re-tests, and pushes to `main`, or bounces it with the conflicting hunks. That flow clashes with
`@cloudflare/ci` 0.2.0 in four ways:

- **It pins `@cloudflare/sandbox` 0.12.1.** Sandbox 1.0 replaced the 0.x `Sandbox` class with a
  Durable Object that drives `ctx.container` directly, and we build on 1.0.
- **It strips `.git` from the checkout.** A rebase needs the history.
- **It puts git tokens inside the sandbox.** Checks run untrusted code (`npm test` executes any
  dependency), so our Worker adds credentials through an outbound HTTPS intercept and the container
  never holds a token. The same intercept scopes the Preview deploy token to one Worker.
- **It has no rebase or cross-repo push.** Landing means fetching two repos (fork and canonical) and
  pushing to the canonical one.

Bending it to fit would mean forking it. Our runner is a few hundred lines, and the spike proved it
end to end against real Cloudflare: test, preview, rebase, re-test, land, cancel superseded checks,
bounce conflicts.

We did borrow from it: the `triggers.events` Workflow trigger config, push-event parsing, and
deterministic per-push run ids for dedupe. Its snapshot dependency cache is still worth borrowing;
that belongs to the sandbox reuse decision (#46), not to the choice of runner.

## What would change this

A release that runs on Sandbox SDK 1.0, keeps credentials out of the sandbox, and supports
rebasing and pushing across repos. At that point, compare it with our runner on maintenance cost
rather than features.

## Prior requests

- #39: "Evaluate @cloudflare/ci as the check runner" (decided in #47)
