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
