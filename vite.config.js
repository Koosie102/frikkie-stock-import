import { defineConfig } from "vite";
import { vitePlugin as remix } from "@remix-run/dev";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals?.();

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 3000),
    host: "0.0.0.0",
    allowedHosts: true,
  },
  plugins: [remix({ ignoredRouteFiles: ["**/.*"] }), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
});

function installGlobals() {}
