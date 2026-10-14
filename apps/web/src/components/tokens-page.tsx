// The signed-in user's Throng tokens: a form to mint one for an alias, which shows its plaintext once
// with the setup an agent needs, ready to paste, and every token they have, each revocable. The
// plaintext lives only in this page's state, so leaving or reloading the page drops it for good.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { claudeMcpAdd, LLMS_PATH, mcpServersConfig } from "@throng/platform/mcp-setup";
import { DEFAULT_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS } from "@throng/platform/token-ttl";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { RelativeTime } from "@/components/commit-meta";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Th } from "@/components/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mintToken, revokeToken, tokensQuery } from "@/lib/api";
import type { MintedToken, Token } from "@/lib/api";
import { apiError } from "@/lib/errors";

const DAY_SECONDS = 24 * 60 * 60;
/** The platform's longest token lifetime, in days. */
const MAX_DAYS = MAX_TOKEN_TTL_SECONDS / DAY_SECONDS;

export function TokensPage() {
  const [minted, setMinted] = useState<MintedToken | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-xl font-semibold">Tokens</h1>
        <p className="text-sm text-muted-foreground">
          What your agents sign in to Throng with: its API, MCP server and git. Mint one for an alias, such as the
          agent's name, so what it does shows as yours under that alias.
        </p>
      </div>
      <MintForm onMinted={setMinted} />
      {minted === null ? null : <NewToken minted={minted} />}
      <TokenList />
    </div>
  );
}

/** Mints a token for an alias (empty: the user as themselves) that expires in 1 to `MAX_DAYS` days. */
function MintForm({ onMinted }: { onMinted: (minted: MintedToken) => void }) {
  const [alias, setAlias] = useState("claude");
  const [days, setDays] = useState(String(DEFAULT_TOKEN_TTL_SECONDS / DAY_SECONDS));
  const queryClient = useQueryClient();
  const mint = useMutation({
    mutationFn: () =>
      mintToken({ alias: alias.trim() === "" ? null : alias.trim(), expiresIn: Number(days) * DAY_SECONDS }),
    onSuccess: async (minted) => {
      onMinted(minted);
      await queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey });
    },
  });
  return (
    <form
      aria-label="New token"
      className="grid gap-4 rounded-xl border p-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        mint.mutate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="token-alias">Alias</Label>
        <Input
          id="token-alias"
          value={alias}
          autoComplete="off"
          placeholder="Empty for yourself"
          onChange={(event) => setAlias(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="token-days">Expires in (days)</Label>
        <Input
          id="token-days"
          type="number"
          min={1}
          max={MAX_DAYS}
          required
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={mint.isPending}>
        {mint.isPending ? "Minting…" : "Mint token"}
      </Button>
      {mint.isError && (
        <p role="alert" className="text-sm text-destructive sm:col-span-3">
          {apiError(mint.error).message}
        </p>
      )}
    </form>
  );
}

/** A just-minted token's plaintext, shown this once, and the setup that uses it. */
function NewToken({ minted }: { minted: MintedToken }) {
  return (
    <section aria-labelledby="new-token-heading" className="flex flex-col gap-3 rounded-xl border p-4">
      <div>
        <h2 id="new-token-heading" className="font-heading text-lg font-medium">
          Your new token
        </h2>
        <p className="text-sm text-amber-700 dark:text-amber-400">It won't be shown again: copy it now.</p>
      </div>
      <Snippet label="Token" text={minted.token} />
      <Snippet label="Claude Code" text={claudeMcpAdd(minted.url, minted.token)} />
      <Snippet label="Other MCP clients" text={JSON.stringify(mcpServersConfig(minted.url, minted.token), null, 2)} />
      <Snippet label="Point the agent at" text={`${minted.url}${LLMS_PATH}`} />
    </section>
  );
}

function TokenList() {
  const tokens = useQuery(tokensQuery);
  if (tokens.isPending) return <Loading />;
  if (tokens.isError) return <ErrorState error={tokens.error} />;
  if (tokens.data.tokens.length === 0) return <EmptyState title="No tokens yet" />;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-muted-foreground">
        <tr>
          <Th>Alias</Th>
          <Th>Created</Th>
          <Th>Expires</Th>
          <Th>Status</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {tokens.data.tokens.map((token) => (
          <TokenRow key={token.id} token={token} />
        ))}
      </tbody>
    </table>
  );
}

type TokenStatus = "active" | "expired" | "revoked";

const TOKEN_STATUS_LABELS: Record<TokenStatus, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };

/** Whether a token still works: `active`, or why it doesn't. */
function tokenStatus(token: Token): TokenStatus {
  if (token.revokedAt !== null) return "revoked";
  return Date.parse(token.expiresAt) <= Date.now() ? "expired" : "active";
}

function TokenRow({ token }: { token: Token }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeToken(token.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  });
  const status = tokenStatus(token);
  return (
    <tr>
      <td className="px-2 py-2">
        {token.alias === null ? <span className="text-muted-foreground">You</span> : token.alias}
      </td>
      <td className="px-2 py-2 text-muted-foreground">
        <RelativeTime date={token.createdAt} />
      </td>
      <td className="px-2 py-2 text-muted-foreground">
        <RelativeTime date={token.expiresAt} />
      </td>
      <td className={status === "active" ? "px-2 py-2" : "px-2 py-2 text-muted-foreground"}>
        {TOKEN_STATUS_LABELS[status]}
      </td>
      <td className="px-2 py-2">
        {status === "active" && (
          <ConfirmAction verb="Revoke" subject={`${token.alias ?? "your"} token ${token.id}`} action={revoke} />
        )}
      </td>
    </tr>
  );
}

/** Text to paste somewhere, with a button that copies it. */
function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">{text}</pre>
        <Button
          size="sm"
          variant="outline"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
