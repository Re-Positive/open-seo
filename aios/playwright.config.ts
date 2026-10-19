// AI OS (Re:Positive): tests voor de aanpassingen in deze fork. Los van de tests van open-seo,
// zodat een merge van upstream hier niet botst.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3102;

export default defineConfig({
  outputDir: "../test-results/aios",
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    navigationTimeout: 45_000,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    screenshot: "only-on-failure",
  },
  webServer: {
    cwd: repoRoot,
    // Productiebuild, zoals de installatie hem draait: paden die alleen in een build misgaan, vallen hier op.
    command: `NODE_OPTIONS= AUTH_MODE=local_noauth OPENSEO_TELEMETRY_DISABLED=1 pnpm run db:migrate:local && NODE_OPTIONS= AIOS_BASISPAD=/seo AUTH_MODE=local_noauth OPENSEO_TELEMETRY_DISABLED=1 pnpm exec vite build && NODE_OPTIONS= CLOUDFLARE_INCLUDE_PROCESS_ENV=true AIOS_BASISPAD=/seo AUTH_MODE=local_noauth OPENSEO_TELEMETRY_DISABLED=1 pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
