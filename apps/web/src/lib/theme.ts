export type Theme = "light" | "dark";

const storageKey = "theme";

/** Runs in the document head before hydration: applies the saved theme, else the OS preference. */
export const themeScript = `(() => {
  try {
    const saved = localStorage.getItem(${JSON.stringify(storageKey)});
    const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
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
    localStorage.setItem(storageKey, theme);
  } catch {
    // Storage can be unavailable (private mode); the class still applies for this page.
  }
}

function hasSavedTheme(): boolean {
  try {
    return localStorage.getItem(storageKey) !== null;
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
  return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
}

/**
 * Calls `onChange` whenever the theme changes, by `setTheme` or by following the OS setting, which
 * it follows while anyone is subscribed. Returns the unsubscribe function. Shaped for
 * `useSyncExternalStore` with `currentTheme`.
 */
export function subscribeTheme(onChange: () => void): () => void {
  if (listeners.size === 0) systemQuery()?.addEventListener("change", followSystem);
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) systemQuery()?.removeEventListener("change", followSystem);
  };
}
