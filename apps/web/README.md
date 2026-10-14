# throng-web

The Throng UI: TanStack Start on a Cloudflare Worker. It reaches the platform Worker through the `PLATFORM` service binding.

## Develop

```bash
CLOUDFLARE_ENV=ci THRONG_DEV_EMAIL=you@example.com pnpm --filter @throng/web dev
```

Run the platform's `vite dev` beside it with the same `CLOUDFLARE_ENV`, and the `PLATFORM` binding reaches it. Access never fronts localhost, so `THRONG_DEV_EMAIL` stands in for it: `src/server.ts` forwards every `/api` call as that email (`devAccessVerifier`). `vite.config.ts` sets it only under `vite dev`; a build always gets `null`, so no deployed Worker can skip Access. Without it, local `/api` calls are 401.

## Deploy

Deploy from `main`:

```bash
pnpm --filter @throng/web run deploy
```

If `THRONG_DEV_NAME` is set, this deploys a personal `throng-web-dev-<name>` Worker instead of `throng-web`.

Deploy the platform first. The `PLATFORM` binding targets the platform's `WebEntrypoint` entrypoint, which has to exist before `throng-web` can bind to it.

## Access

`throng-web` is only reachable after signing in through Cloudflare Access. Access sends a signed JWT to the Worker, which checks it against two values in its own `wrangler.jsonc`. The platform checks the same values, in `apps/platform/wrangler.jsonc`, for Access sessions that reach it directly:

- `ACCESS_TEAM_DOMAIN`: the account's Zero Trust team domain. Currently `gregjoeval.cloudflareaccess.com`.
- `ACCESS_AUD`: the Access application's audience (AUD) tag.

The platform Worker (`throng`) is **not** behind Access. Agents and git reach it with Throng bearer tokens.

### Calling the platform

The browser calls same-origin `/api/*`. `src/server.ts` verifies the Access JWT, drops the browser's credentials, and forwards the request over the `PLATFORM` service binding with the user's email in `X-Throng-Access-Email`. Requests without a valid JWT get a 401 and never reach the platform.

The platform trusts that header only on `WebEntrypoint`, a named entrypoint that only service bindings can reach. Its public hostname rejects any request carrying the header, so it can't be spoofed from outside.

In the browser, `src/lib/api.ts` has the typed `hc` client, built from the platform's `AppType`, and `apiQuery`, which turns a client call into TanStack Query options.

Over the binding, the forwarded user can call `/api/me`, `/api/tokens`, the project routes (`GET` and `POST /api/projects`, `GET /api/projects/{owner}/{project}`), and the task routes the task pages use: listing, creating and reading tasks, their transitions (`…/tasks/{t}/close`, `reopen`, `obsolete`, `restore`), listing a task's attempts, and the read-only scoring and merge request routes. On the public hostname these routes stay bearer-only.

Raw file URLs (`/:owner/:project/raw/:ref/*`) are forwarded the same way, to the platform's `/api/projects/:owner/:project/raw/:ref/*`.

### Signing out

The header's **Sign out** links to `/cdn-cgi/access/logout` on the app's own host. Access ends the session for every Access application, since it can't sign out of just one, and clears this app's cookie at once. The team-domain logout URL would also work, but it only clears the cookie on the team domain.

## Routes

`src/lib/paths.ts` builds and parses the project views' URLs. Use it for every link, so paths with spaces, `#` or unicode are encoded the same way everywhere:

- `/:owner/:project`: project home
- `/:owner/:project/tree/:ref/*`: a directory
- `/:owner/:project/blob/:ref/*`: a file
- `/:owner/:project/raw/:ref/*`: raw bytes, proxied to the platform
- `/:owner/:project/commits/:ref`: the commit log
- `/:owner/:project/commit/:sha`: one commit
- `/:owner/:project/tasks`: the task list, open by default (`?state=closed` or `?state=obsolete` for the other tabs)
- `/:owner/:project/tasks/:t`: one task, `t42`
- `/:owner/:project/runs`: every run on the project's lines, newest first (`?line=main`, `?line=tasks` or `?line=t42a3`, `?status=waiting`, and `?cursor=` for an older page)
- `/:owner/:project/runs/:run`: one run, with its steps, logs and metrics

A ref is `main`, an attempt (`t42a3`) or a full sha. A sha can carry `?attempt=t42a3`, naming the attempt fork to look it up in.

### Setting it up for a new account

1. **Zero Trust team.** Open Zero Trust in the Cloudflare dashboard and pick a team name. It's account-wide, so it doesn't need to be Throng-specific. Choose the Free plan.
2. **Policy.** Under **Access → Policies**, add a reusable policy:
   - Name: `throng-web users`
   - Action: Allow
   - Include: **Emails**, listing everyone who may sign in. Use **Emails ending in** for a whole domain. Never use **Everyone**, which lets any email address in with a PIN.
3. **Application.** Under **Access → Applications**, add a **Self-hosted** application:
   - Name: `throng-web`
   - Hostname: `throng-web.<subdomain>.workers.dev`, with no path, so every path is covered.
   - Policies: `throng-web users`
   - Login methods: One-time PIN
4. **Check.** In a private window, `throng-web` should redirect to the team's login page, send a code by email, and then load the app.
5. **Configure both Workers.** Copy the team domain and the application's AUD tag (on its overview page) into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in both `apps/platform/wrangler.jsonc` and `apps/web/wrangler.jsonc` (each repeats them under `env.ci`), run `pnpm types`, and redeploy the platform, then `throng-web`.

### Adding someone

Add their email to the `throng-web users` policy. No redeploy is needed.

### Changing the team name

The team domain signs every Access token. After renaming it under **Zero Trust → Settings**, update `ACCESS_TEAM_DOMAIN` in both Workers' configs and redeploy the platform, then `throng-web`. Everyone has to sign in again.
