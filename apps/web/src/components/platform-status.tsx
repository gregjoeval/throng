import { useQuery } from "@tanstack/react-query";
import { meQuery } from "@/lib/api";

/** Who the platform says is signed in, read from `GET /api/me`. */
export function PlatformStatus() {
  const me = useQuery(meQuery);

  if (me.isPending) return <p className="text-muted-foreground">Connecting to the platform…</p>;
  if (me.isError) return <p className="text-destructive">The platform is unreachable.</p>;
  return <p>Signed in as {me.data.user.handle}</p>;
}
