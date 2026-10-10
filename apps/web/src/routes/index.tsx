import { createFileRoute } from "@tanstack/react-router";
import { PlatformStatus } from "@/components/platform-status";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-semibold">Throng</h1>
        <ThemeToggle />
      </header>
      <PlatformStatus />
    </main>
  );
}
