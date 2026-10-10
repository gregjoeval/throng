// The loading, empty and error states every view shares.

import { CircleAlertIcon, FileQuestionIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { apiError } from "@/lib/errors";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="py-8 text-center text-sm text-muted-foreground">
      {label}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="font-heading font-medium">{title}</p>
      {children === undefined ? null : <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

const TITLES: Record<string, { title: string; icon: typeof CircleAlertIcon }> = {
  not_found: { title: "Not found", icon: FileQuestionIcon },
  forbidden: { title: "Forbidden", icon: LockIcon },
  unauthorized: { title: "Signed out", icon: LockIcon },
};

/** A failed platform call, or a route that doesn't exist (`code: "not_found"`). */
export function ErrorState({ error }: { error: unknown }) {
  const { code, message } = apiError(error);
  const { title, icon: Icon } = TITLES[code] ?? { title: "Something went wrong", icon: CircleAlertIcon };
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-xl border px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <p className="font-heading font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/** What the router shows for a URL no route matches. */
export function NotFound() {
  return <ErrorState error={{ code: "not_found", message: "There's nothing at this address." }} />;
}
