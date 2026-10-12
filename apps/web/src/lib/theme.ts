export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Runs in the document head before hydration: applies the saved theme, else the OS preference. */
export const THEME_SCRIPT = `(() => {
  try {
    const saved = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    const dark = saved ? saved === "dark" : matchMedia(${JSON.stringify(DARK_QUERY)}).matches;
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const listeners = new Set<() => void>();

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the class still applies for this page.
  }
}

function hasSavedTheme(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Applies an OS theme change while the user hasn't picked a theme. */
function followSystem(event: MediaQueryListEvent) {
  if (hasSavedTheme()) return;
  applyTheme(event.matches ? "dark" : "light");
}

function systemQuery(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
}

/** The query `followSystem` listens on while anyone is subscribed. */
let followedQuery: MediaQueryList | null = null;

/**
 * Calls `onChange` whenever the theme changes, by `setTheme` or by following the OS setting, which
 * it follows while anyone is subscribed. Returns the unsubscribe function. Shaped for
 * `useSyncExternalStore` with `currentTheme`.
 */
export function subscribeTheme(onChange: () => void): () => void {
  if (listeners.size === 0) {
    // Each `matchMedia` call returns a new list, so keep this one to remove the listener from.
    followedQuery = systemQuery();
    followedQuery?.addEventListener("change", followSystem);
  }
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      followedQuery?.removeEventListener("change", followSystem);
      followedQuery = null;
    }
  };
}
