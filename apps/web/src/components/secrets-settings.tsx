// The project's secrets in its settings: each one's name, pipelines and last change, never its value,
// with forms to add one, replace its value or change its pipelines, and to delete it. Only the owner
// sees this page; the platform refuses anyone else, and anyone under an alias. It shows where main's config
// names each secret, and flags names with no value or not allowed in a pipeline that runs them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PIPELINES } from "@throng/platform/pipelines";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteSecret, putSecret, secretsQuery } from "@/lib/api";
import type { Pipeline, ProjectRef, Secret, SecretUse } from "@/lib/api";
import { relativeDate } from "@/lib/commits";
import { apiError } from "@/lib/errors";

/** Shown while a change allows a secret in `default` that wasn't before. */
const DEFAULT_WARNING =
  "Runs of code you or your agents push will hold this. Prefer a token scoped to a separate preview account.";

/** What the form is open for: a new secret, or editing one by name. */
type Editing = { kind: "new" } | { kind: "edit"; name: string } | null;

export function SecretsSettings({ projectRef }: { projectRef: ProjectRef }) {
  const secrets = useQuery(secretsQuery(projectRef));
  const [editing, setEditing] = useState<Editing>(null);
  const close = () => setEditing(null);

  return (
    <section aria-labelledby="secrets-heading" className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-2 border-b pb-2">
        <div>
          <h2 id="secrets-heading" className="font-heading text-lg font-medium">
            Secrets
          </h2>
          <p className="text-sm text-muted-foreground">
            Values your pipelines' steps can use. Once saved, a value can be replaced but never read back.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ kind: "new" })}>
          <PlusIcon />
          New secret
        </Button>
      </div>
      {editing?.kind === "new" && <SecretForm projectRef={projectRef} onDone={close} />}
      {secrets.isPending && <Loading />}
      {secrets.isError && <ErrorState error={secrets.error} />}
      {secrets.isSuccess && <Unset uses={secrets.data.uses.filter((use) => !use.hasValue)} />}
      {secrets.isSuccess &&
        (secrets.data.secrets.length === 0 ? (
          <EmptyState title="No secrets yet" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <Th>Name</Th>
                <Th>Pipelines</Th>
                <Th>Last changed</Th>
                <Th>Named in main's config</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {secrets.data.secrets.map((secret) => (
                <SecretRow
                  key={secret.name}
                  projectRef={projectRef}
                  secret={secret}
                  use={secrets.data.uses.find((use) => use.name === secret.name)}
                  onEdit={() => setEditing({ kind: "edit", name: secret.name })}
                />
              ))}
            </tbody>
          </table>
        ))}
      {editing?.kind === "edit" && secrets.isSuccess && (
        <SecretForm
          key={editing.name}
          projectRef={projectRef}
          secret={secrets.data.secrets.find((s) => s.name === editing.name)}
          onDone={close}
        />
      )}
    </section>
  );
}

/** The setups and checks naming a secret: `setup deps, check test`. */
const steps = (use: SecretUse) => use.steps.join(", ");

/** The secrets `main`'s config names that have no value: every run naming one fails before it starts. */
function Unset({ uses }: { uses: SecretUse[] }) {
  if (uses.length === 0) return null;
  return (
    <div role="alert" className="rounded-xl border border-destructive/50 p-3 text-sm">
      <p className="font-medium">main's config names secrets with no value. Runs naming them fail.</p>
      <ul className="mt-1 list-disc pl-5">
        {uses.map((use) => (
          <li key={use.name}>
            <span className="font-mono">{use.name}</span>, named by <span className="font-mono">{steps(use)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SecretRow({
  projectRef,
  secret,
  use,
  onEdit,
}: {
  projectRef: ProjectRef;
  secret: Secret;
  use: SecretUse | undefined;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteSecret(projectRef, secret.name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: secretsQuery(projectRef).queryKey }),
  });
  return (
    <tr>
      <td className="px-2 py-2 font-mono">{secret.name}</td>
      <td className="px-2 py-2">
        {secret.pipelines.length === 0 ? (
          <span className="text-muted-foreground">No pipeline</span>
        ) : (
          secret.pipelines.join(", ")
        )}
      </td>
      <td className="px-2 py-2 text-muted-foreground">
        <time dateTime={secret.changedAt} title={secret.changedAt}>
          {relativeDate(secret.changedAt)}
        </time>
      </td>
      <td className="px-2 py-2">
        {use === undefined ? (
          <span className="text-muted-foreground">Not named</span>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="font-mono">{steps(use)}</span>
            {use.notAllowedIn.length > 0 && (
              <span className="text-amber-700 dark:text-amber-400">
                Not allowed in {use.notAllowedIn.join(" or ")}: runs there fail
              </span>
            )}
          </div>
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex justify-end gap-2">
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                aria-label={`Confirm delete ${secret.name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" aria-label={`Edit ${secret.name}`} onClick={onEdit}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${secret.name}`}
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            </>
          )}
        </div>
        {remove.isError && (
          <p role="alert" className="text-right text-sm text-destructive">
            {apiError(remove.error).message}
          </p>
        )}
      </td>
    </tr>
  );
}

/**
 * Adds a secret, or edits `secret`: a new value (left blank, the value is kept) and the pipelines it
 * may be used in. The pipelines are always sent, as the form shows them.
 */
function SecretForm({
  projectRef,
  secret,
  onDone,
}: {
  projectRef: ProjectRef;
  secret?: Secret | undefined;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pipelines, setPipelines] = useState<Pipeline[]>(secret?.pipelines ?? []);
  const queryClient = useQueryClient();
  const title = secret === undefined ? "New secret" : `Edit ${secret.name}`;
  const save = useMutation({
    mutationFn: () =>
      putSecret(projectRef, secret?.name ?? name.trim(), { ...(value === "" ? {} : { value }), pipelines }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: secretsQuery(projectRef).queryKey });
      onDone();
    },
  });
  const error = save.isError ? apiError(save.error).message : null;
  const newlyInDefault = pipelines.includes("default") && !(secret?.pipelines.includes("default") ?? false);
  const toggle = (pipeline: Pipeline, on: boolean) =>
    setPipelines((current) => PIPELINES.filter((p) => (p === pipeline ? on : current.includes(p))));
  const ready = secret === undefined ? name.trim() !== "" && value !== "" : true;

  return (
    <form
      aria-label={title}
      className="grid gap-4 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-heading font-medium">{title}</h3>
      {secret === undefined && (
        <div className="grid gap-2">
          <Label htmlFor="secret-name">Name</Label>
          <Input
            id="secret-name"
            value={name}
            autoComplete="off"
            placeholder="CLOUDFLARE_TOKEN"
            className="font-mono"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="secret-value">{secret === undefined ? "Value" : "New value"}</Label>
        <Input
          id="secret-value"
          type="password"
          value={value}
          autoComplete="new-password"
          placeholder={secret === undefined ? "At least 8 characters" : "Leave blank to keep the current value"}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">May be used in</legend>
        <div className="flex gap-4 text-sm">
          {PIPELINES.map((pipeline) => (
            <label key={pipeline} className="flex items-center gap-2 font-mono">
              <input
                type="checkbox"
                checked={pipelines.includes(pipeline)}
                onChange={(event) => toggle(pipeline, event.target.checked)}
              />
              {pipeline}
            </label>
          ))}
        </div>
        {newlyInDefault && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
            {DEFAULT_WARNING}
          </p>
        )}
      </fieldset>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-2 py-2 font-medium">{children}</th>;
}
