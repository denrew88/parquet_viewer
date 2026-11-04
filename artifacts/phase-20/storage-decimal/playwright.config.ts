import { defineConfig } from "@playwright/test";
import base from "../../../playwright.config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL("../../../e2e", import.meta.url)),
  outputDir: fileURLToPath(new URL("../../../test-results", import.meta.url)),
  webServer: {
    ...base.webServer,
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1420 --strictPort",
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  },
});
