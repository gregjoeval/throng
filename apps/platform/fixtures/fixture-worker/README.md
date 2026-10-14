# fixture-worker

The repo `pnpm e2e` imports into Artifacts. It has no dependencies, so `npm test` needs no install
inside the Sandbox. Attempts edit `src/greeting.js`.

Nothing deploys it: its `name` is a placeholder, and no Worker by that name needs to exist.
