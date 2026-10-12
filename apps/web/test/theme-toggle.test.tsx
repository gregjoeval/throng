import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";

type Listener = (event: { matches: boolean }) => void;
let systemListeners: Listener[] = [];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  systemListeners = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: (_type: string, listener: Listener) => systemListeners.push(listener),
    removeEventListener: (_type: string, listener: Listener) => {
      systemListeners = systemListeners.filter((l) => l !== listener);
    },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("starts from the theme already applied to the document", () => {
  document.documentElement.classList.add("dark");
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
});

test("switches the theme and remembers the choice", () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("dark");
  expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
});

test("follows the system theme until the user picks one", () => {
  render(<ThemeToggle />);
  act(() => {
    for (const listener of systemListeners) listener({ matches: true });
  });
  expect(document.documentElement).toHaveClass("dark");
  expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
});

test("stops following the system once unmounted", () => {
  const { unmount } = render(<ThemeToggle />);
  unmount();
  expect(systemListeners).toHaveLength(0);
});

test("keeps following the system while another toggle is mounted", () => {
  const first = render(<ThemeToggle />);
  render(<ThemeToggle />);
  first.unmount();
  act(() => {
    for (const listener of systemListeners) listener({ matches: true });
  });
  expect(document.documentElement).toHaveClass("dark");
});
