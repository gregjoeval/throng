import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devAccessEmail } from "./src/server/dev-access.ts";

// `ci` is a Wrangler environment (select it with CLOUDFLARE_ENV=ci). Wrangler has no templated
// environments, so `dev-<name>` is built from THRONG_DEV_NAME instead: the Worker becomes
// `throng-web-dev-<name>` and binds to the platform's `throng-dev-<name>`.
const devName = process.env["THRONG_DEV_NAME"];

export default defineConfig(({ command }) => ({
  define: {
    // Local dev's stand-in for Access (src/server/dev-access.ts).
    THRONG_DEV_EMAIL: JSON.stringify(devAccessEmail(command, process.env["THRONG_DEV_EMAIL"])),
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
