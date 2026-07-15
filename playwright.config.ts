import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:1420";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  expect: { timeout: 5_000 },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1420 --strictPort",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-wide",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop-compact",
      use: { browserName: "chromium", viewport: { width: 1024, height: 768 } },
    },
    {
      name: "desktop-minimum",
      use: { browserName: "chromium", viewport: { width: 800, height: 600 } },
    },
  ],
});
