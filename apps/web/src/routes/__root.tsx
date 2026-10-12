import { createRootRoute, HeadContent, Outlet, ScriptOnce, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { ErrorState, NotFound } from "@/components/states";
import { THEME_SCRIPT } from "@/lib/theme";
import appCss from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Throng" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: Shell,
  component: Layout,
  notFoundComponent: NotFound,
  errorComponent: ({ error }) => <ErrorState error={error} />,
  pendingComponent: () => null,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{THEME_SCRIPT}</ScriptOnce>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** The app shell: the header, then the current view. */
export function Layout() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl p-4">
        <Outlet />
      </main>
    </>
  );
}
