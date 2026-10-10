import { HeadContent, Outlet, ScriptOnce, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { themeScript } from "@/lib/theme";
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
  component: Outlet,
  // With `defaultSsr: false` the server renders this in place of the first client-only route.
  pendingComponent: () => null,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    // The theme script sets the `dark` class before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{themeScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
