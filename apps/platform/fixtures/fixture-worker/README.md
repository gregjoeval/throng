# fixture-worker

The repo `pnpm e2e` imports into Artifacts. It has no dependencies, so `npm test` needs no install
inside the Sandbox. Attempts edit `src/greeting.js`.

Its `name` is a placeholder: each e2e project's Previews deploy under that project's own Worker,
`p<projectId>` (`wrangler preview --worker-name`), so no Worker by this name needs to exist.
