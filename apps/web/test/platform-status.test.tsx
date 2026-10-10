import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { PlatformStatus } from "@/components/platform-status";
import { server } from "./server";

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

test("shows the signed-in user from the platform API", async () => {
  renderWithQuery(<PlatformStatus />);
  expect(await screen.findByText("Signed in as ada")).toBeInTheDocument();
});

test("says so when the platform API fails", async () => {
  server.use(http.get("*/api/me", () => new HttpResponse(null, { status: 502 })));
  renderWithQuery(<PlatformStatus />);
  expect(await screen.findByText("The platform is unreachable.")).toBeInTheDocument();
});
