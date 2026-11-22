import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };
const rawVersion = (process.env.APP_VERSION || pkg.version || "0.0.1").trim().replace(/^v/, "");

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rawVersion),
  },
  plugins: [
    cloudflare({
      persistState: { path: ".cloudflare/state" },
      remoteBindings: false,
      inspectorPort: false,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: 5188 },
});
