import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getRouter } from "@/router";

/** Renders the whole app, router and all, at `path`. */
export async function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = getRouter({ history: createMemoryHistory({ initialEntries: [path] }), queryClient });
  // The root's shell renders <html>; mount at the document so it isn't nested in a <div>.
  render(<RouterProvider router={router} />, { container: document });
  await router.load();
  return { router, user: userEvent.setup(), path: () => router.state.location.href };
}
