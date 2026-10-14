import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `ci` is a Wrangler environment (select it with CLOUDFLARE_ENV=ci). Wrangler has no templated
// environments, so `dev-<name>` is built from THRONG_DEV_NAME instead: the Worker becomes
// `throng-web-dev-<name>` and binds to the platform's `throng-dev-<name>`.
const devName = process.env["THRONG_DEV_NAME"];

// `vite dev` signs every `/api` call in as THRONG_DEV_EMAIL, standing in for Access, which never
// fronts localhost. A build always gets null, so no deployed Worker can skip Access.
export default defineConfig(({ command }) => ({
  define: {
    THRONG_DEV_EMAIL: JSON.stringify(command === "serve" ? (process.env["THRONG_DEV_EMAIL"] ?? null) : null),
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: (config) => {
        if (!devName) return;
        // Mutated in place: a returned partial would be merged, appending to `services`.
        config.name = `throng-web-dev-${devName}`;
        config.services = [{ binding: "PLATFORM", service: `throng-dev-${devName}`, entrypoint: "WebEntrypoint" }];
      },
    }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
}));
