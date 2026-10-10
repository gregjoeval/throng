import { useEffect, useState } from "react";

type Status = { state: "loading" } | { state: "ok"; name: string } | { state: "error" };

/**
 * Placeholder that reads the signed-in user from the platform API over same-origin `/api/*`.
 * Stands in until TanStack Query and the typed `hc` client land; it exists so the scaffold has a
 * component exercising the MSW-backed test setup.
 */
export function PlatformStatus() {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { name: string };
        setStatus({ state: "ok", name: body.name });
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ state: "error" });
      });
    return () => controller.abort();
  }, []);

  if (status.state === "loading") return <p className="text-muted-foreground">Connecting to the platform…</p>;
  if (status.state === "error") return <p className="text-destructive">The platform is unreachable.</p>;
  return <p>Signed in as {status.name}</p>;
}
