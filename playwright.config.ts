import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 3,
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  outputDir: "artifacts/e2e-results",
  reporter: [["list"], ["html", { outputFolder: "artifacts/e2e-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:1421",
    channel: "msedge",
    headless: true,
    viewport: { width: 1280, height: 840 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 1421",
    url: "http://127.0.0.1:1421",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
