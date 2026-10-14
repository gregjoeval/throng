import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({
      // `wrangler.jsonc`'s `PUBLIC_URL`, resolved for `CLOUDFLARE_ENV`, names a deployed Worker. A local platform never hands that out:
      // without `.dev.vars` setting its own, it names the origin each request came in on.
      config: (config) => {
        if (command !== "serve") return;
        delete config.vars["PUBLIC_URL"];
      },
    }),
  ],
}));
