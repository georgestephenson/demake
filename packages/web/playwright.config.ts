import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the web app (doc 07 §Quality bar, doc 10 §Determinism).
 *
 * Tests run against the **built** app served by `vite preview`, not the dev
 * server, so what is tested is what Pages will serve. The base path is set to
 * `/` for the preview (production deploys under `/demake/`).
 *
 * Browsers: Chromium, Firefox and WebKit — the determinism suite's whole point
 * is that three independent engines produce identical bytes. Set
 * `DEMAKE_BROWSERS=chromium` to narrow it on a machine that only has one, and
 * `DEMAKE_CHROMIUM=/path/to/chrome` to use a browser that is already on the
 * machine instead of Playwright's pinned download (managed dev containers ship
 * one; CI runs `playwright install` and needs neither variable).
 */
const wanted = (process.env["DEMAKE_BROWSERS"] ?? "chromium,firefox,webkit").split(",");

const chromiumPath = process.env["DEMAKE_CHROMIUM"];

const ALL = [
  {
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
  },
  { name: "firefox", use: devices["Desktop Firefox"] },
  { name: "webkit", use: devices["Desktop Safari"] },
];

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "line" : "list",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: ALL.filter((p) => wanted.includes(p.name)),
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
    env: { DEMAKE_BASE: "/" },
  },
});
