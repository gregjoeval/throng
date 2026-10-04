import { defineConfig } from "vitest/config";

// Unit tests run in Node: Artifacts has no local simulator and Containers aren't covered by the
// Workers test pool, so platform behaviour is proven by `pnpm spike` against real Cloudflare.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
