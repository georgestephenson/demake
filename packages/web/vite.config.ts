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
    // Never inline an asset as a data URI. The example library's MIDIs are small
    // enough to fall under Vite's default threshold, and base64 in a JS chunk is
    // both a third larger than the file and counted against the JS budget — the
    // exact thing `lib/demo-audio.ts` keeps them out of the bundle to avoid.
    assetsInlineLimit: 0,
  },
  server: { port: 5173 },
});
