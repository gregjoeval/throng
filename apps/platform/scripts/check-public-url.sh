#!/usr/bin/env bash
# Fails a deploy before it starts when the built config's `PUBLIC_URL` isn't the URL the Worker will get
# on this account's workers.dev subdomain, so a Worker never hands out another one's remotes or MCP URL.
# Usage: scripts/check-public-url.sh dist/throng/wrangler.json (needs CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail

config=$1
subdomain=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r .result.subdomain)
expected="https://$(jq -r .name "$config").$subdomain.workers.dev"
configured=$(jq -r '.vars.PUBLIC_URL // ""' "$config")
if [ "$configured" != "$expected" ]; then
  echo "::error::PUBLIC_URL is '$configured' but this Worker deploys to $expected; set it in apps/platform/wrangler.jsonc"
  exit 1
fi
