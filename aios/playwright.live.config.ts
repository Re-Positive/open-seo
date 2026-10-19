// AI OS (Re:Positive): tests tegen de echte installaties op Cloudflare, na een uitrol.
// Geen webServer: de installatie draait al.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "../test-results/aios-live",
  testDir: "./tests-live",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    navigationTimeout: 45_000,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    screenshot: "only-on-failure",
  },
});
