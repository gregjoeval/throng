import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon, LogOutIcon } from "lucide-react";
import { ProjectSwitcher } from "@/components/project-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { meQuery } from "@/lib/api";

/**
 * Access's logout on the app's own host. It ends the Access session (for every Access application,
 * Access can't sign out of just one) and clears this app's cookie at once, without needing the team
 * domain. See https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
 */
export const SIGN_OUT_URL = "/cdn-cgi/access/logout";

export function AppHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Link to="/" className="font-heading text-lg font-semibold">
          Throng
        </Link>
        <ProjectSwitcher />
        <div className="ml-auto flex items-center gap-1">
          <SignedInUser />
          <Link to="/tokens" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <KeyRoundIcon />
            Tokens
          </Link>
          <ThemeToggle />
          <a href={SIGN_OUT_URL} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <LogOutIcon />
            Sign out
          </a>
        </div>
      </div>
    </header>
  );
}

/** Who the platform says is signed in, read from `GET /api/me`. */
function SignedInUser() {
  const me = useQuery(meQuery);
  if (me.isPending) return null;
  if (me.isError) return <span className="px-2 text-sm text-destructive">Platform unreachable</span>;
  return (
    <span className="px-2 text-sm text-muted-foreground" title={me.data.user.email}>
      Signed in as <span className="font-medium text-foreground">{me.data.user.handle}</span>
    </span>
  );
}
