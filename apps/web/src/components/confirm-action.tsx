// A destructive row action that asks first: one click shows a confirm button and Cancel, and only the
// confirm runs it. The settings' secrets and the Tokens page's tokens share it.

import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { apiError } from "@/lib/errors";

/**
 * `verb` (`Delete`) on `subject` (`DEPLOY_TOKEN`): the buttons are labelled `Delete DEPLOY_TOKEN` and
 * `Confirm delete DEPLOY_TOKEN`. `children` show beside the first button, hidden while confirming.
 */
export function ConfirmAction({
  verb,
  subject,
  action,
  children,
}: {
  verb: string;
  subject: string;
  action: { mutate: () => void; isPending: boolean; isError: boolean; error: unknown };
  children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div className="flex justify-end gap-2">
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              aria-label={`Confirm ${verb.toLowerCase()} ${subject}`}
              disabled={action.isPending}
              onClick={() => action.mutate()}
            >
              {verb}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {children}
            <Button size="sm" variant="ghost" aria-label={`${verb} ${subject}`} onClick={() => setConfirming(true)}>
              {verb}
            </Button>
          </>
        )}
      </div>
      {action.isError && (
        <p role="alert" className="text-right text-sm text-destructive">
          {apiError(action.error).message}
        </p>
      )}
    </>
  );
}
