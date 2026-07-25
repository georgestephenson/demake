import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * Vite config for the demake web app (doc 07).
 *
 * `base` targets the GitHub Pages project site; override it with `DEMAKE_BASE`
 * for a custom domain or a local subdirectory preview. The engine runs in a Web
 * Worker, so the worker format is ESM (no classic-worker inlining) and
 * `@demake/core` is bundled into it from the workspace source build.
 */
export default defineConfig({
  base: process.env["DEMAKE_BASE"] ?? "/demake/",
  plugins: [preact()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // The budget in doc 07 is < 300 KB gzipped; warn well before that.
    chunkSizeWarningLimit: 700,
  },
  server: { port: 5173 },
});
