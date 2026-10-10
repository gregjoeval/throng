import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Component and route tests run in jsdom without the Cloudflare and Start plugins; MSW fakes the
// platform API (see test/setup.ts). No live Cloudflare in unit tests.
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
