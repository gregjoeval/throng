import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export interface RouterOptions {
  /** Tests pass a memory history and a query client without retries. */
  history?: RouterHistory;
  queryClient?: QueryClient;
}

export function getRouter({ history, queryClient = new QueryClient() }: RouterOptions = {}) {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    ...(history === undefined ? {} : { history }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page spans the whole window, not the capped column most pages read in. */
    wide?: boolean;
  }
}
