import { MoonIcon, SunIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { type Theme, currentTheme, setTheme, subscribeTheme } from "@/lib/theme";

/** The server renders the light theme; the client reads the theme the head script applied. */
function serverTheme(): Theme {
  return "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, serverTheme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button variant="ghost" size="icon" aria-label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
