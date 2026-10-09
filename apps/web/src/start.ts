import { createStart } from "@tanstack/react-start";

// Every route renders on the client unless it opts in with `ssr: true` or `'data-only'`. The Worker
// still serves the root shell per request; SPA mode and prerendering are deliberately not used.
export const startInstance = createStart(() => ({ defaultSsr: false }));
