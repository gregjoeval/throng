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

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
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

/**
 * Follows the OS setting while the user hasn't picked a theme, calling `onChange` with each new one.
 * Returns the unsubscribe function.
 */
export function followSystemTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia("(prefers-color-scheme: dark)");
  const listener = (event: MediaQueryListEvent) => {
    if (hasSavedTheme()) return;
    const theme: Theme = event.matches ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme === "dark");
    onChange(theme);
  };
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
