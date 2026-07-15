import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(
  process.argv[2] ?? path.join(root, "src-tauri", "target", "debug", "data-viewer.exe"),
);
const fixture = path.resolve(
  process.argv[3] ?? path.join(root, "fixtures", "phase-7", "small-csv.csv"),
);
const artifact = path.resolve(
  process.argv[4] ?? path.join(root, "artifacts", "phase-9", "ui", "native-cdp-smoke.png"),
);
const artifactDirectory = path.dirname(artifact);
const thousandsSeparator = process.env.NATIVE_THOUSANDS_SEPARATOR ?? ".";
const separatorName = thousandsSeparator === "," ? "comma" : thousandsSeparator === " " ? "space" : "dot";
const formatInteger = (value) => value.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);

function artifactPath(name) {
  return path.join(artifactDirectory, name);
}

await mkdir(path.dirname(artifact), { recursive: true });
const app = spawn(executable, ["--file", fixture], {
  cwd: root,
  windowsHide: false,
  stdio: "ignore",
});

let browser;
let page;
let originalSettings;
try {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!browser) {
    throw new Error(`WebView2 CDP endpoint did not start: ${lastError}`);
  }

  const contexts = browser.contexts();
  page = contexts.flatMap((context) => context.pages())[0];
  if (!page) {
    throw new Error("WebView2 exposed no page through CDP.");
  }

  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: /CSV parsing profile/i }).waitFor({ timeout: 30_000 });
  originalSettings = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
  await page.screenshot({ path: artifact, fullPage: true });

  const results = {
    title: await page.title(),
    url: page.url(),
    fixture,
    csvProfile: "pending",
    sort: "pending",
    filter: "pending",
    copySettings: "pending",
    thousandsSeparator: separatorName,
    artifacts: [artifact],
  };

  await page.getByRole("button", { name: /CSV parsing profile/i }).click();
  const profileDialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });
  await profileDialog.waitFor();
  await profileDialog.getByRole("checkbox", { name: "Select column_000" }).click();
  await profileDialog.getByLabel("Type for selected columns").selectOption("UInt64");
  await profileDialog
    .getByLabel("Thousands separator for selected columns")
    .selectOption(thousandsSeparator);
  await profileDialog
    .getByTestId("csv-profile-preview-grid")
    .getByText(formatInteger("10000019"))
    .waitFor({ timeout: 30_000 });
  const profileArtifact = artifactPath(`native-csv-profile-${separatorName}.png`);
  await page.screenshot({ path: profileArtifact, fullPage: true });
  results.artifacts.push(profileArtifact);
  await profileDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await profileDialog.waitFor({ state: "detached", timeout: 30_000 });

  const cell = (row, column) =>
    page.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
  await cell(1, 0).filter({ hasText: formatInteger("10000019") }).waitFor({ timeout: 30_000 });
  results.csvProfile = "passed";

  const sortButton = page.getByRole("button", { name: /Sort column_000:/ });
  await sortButton.click();
  await sortButton.click();
  await cell(0, 0).filter({ hasText: formatInteger("99990189981") }).waitFor({ timeout: 30_000 });
  results.sort = "passed";

  await page.getByRole("button", { name: "Filter column_000" }).click();
  const filterDialog = page.getByRole("dialog", { name: "Filter column_000" });
  await filterDialog.getByLabel("Filter operator").selectOption("greaterThan");
  await filterDialog.getByRole("textbox", { name: "Value", exact: true }).fill("50000000000");
  await filterDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await filterDialog.waitFor({ state: "detached" });
  await cell(0, 0).filter({ hasText: formatInteger("99990189981") }).waitFor({ timeout: 30_000 });
  await page.getByText("Showing rows 1-200 of 5,000", { exact: true }).waitFor({ timeout: 30_000 });
  const visibleValues = await page
    .locator('[data-grid-column="0"][data-grid-row]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.ok(visibleValues.length > 0, "The filtered grid exposed no numeric values.");
  assert.ok(
    visibleValues.every(
      (value) => Number(value.replaceAll(thousandsSeparator, "")) > 50_000_000_000,
    ),
    `Filter returned an out-of-range value: ${visibleValues.join(", ")}`,
  );
  results.filter = "passed";

  await page.getByRole("button", { name: "Copy options" }).click();
  await page.getByRole("menuitem", { name: "Copy settings" }).click();
  const copyDialog = page.getByRole("dialog", { name: "Copy settings" });
  await copyDialog.getByRole("button", { name: "Custom" }).click();
  await copyDialog.getByLabel("Delimiter").selectOption("semicolon");
  const includeHeaders = copyDialog.getByRole("checkbox", { name: "Include column headers" });
  if (!(await includeHeaders.isChecked())) await includeHeaders.check();
  await copyDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await copyDialog.waitFor({ state: "detached", timeout: 30_000 });
  await cell(0, 0).click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.locator('[role="gridcell"][aria-selected="true"]').nth(1).waitFor();
  const selectedCoordinates = await page
    .locator('[role="gridcell"][aria-selected="true"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => [node.getAttribute("data-grid-row"), node.getAttribute("data-grid-column")]),
    );
  assert.equal(
    JSON.stringify(selectedCoordinates),
    JSON.stringify([
      ["0", "0"],
      ["0", "1"],
    ]),
    "Shift+ArrowRight did not extend the native grid selection.",
  );
  await page.evaluate(() => navigator.clipboard.writeText("__native-smoke-sentinel__"));
  await page.getByRole("button", { name: "Copy selection" }).click();
  let clipboardText = "__native-smoke-sentinel__";
  const clipboardDeadline = Date.now() + 30_000;
  while (clipboardText === "__native-smoke-sentinel__" && Date.now() < clipboardDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    clipboardText = await page.evaluate(async () => navigator.clipboard.readText());
  }
  assert.notEqual(clipboardText, "__native-smoke-sentinel__", "Copy did not write the clipboard.");
  const clipboardLines = clipboardText.trimEnd().split(/\r?\n/);
  assert.equal(clipboardLines.length, 2, `Unexpected clipboard row count: ${clipboardText}`);
  assert.ok(clipboardLines.every((line) => line.includes(";")), clipboardText);
  results.copySettings = "passed";

  const finalArtifact = artifactPath(`native-query-copy-${separatorName}-passed.png`);
  await page.screenshot({ path: finalArtifact, fullPage: true });
  results.artifacts.push(finalArtifact);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  if (page && originalSettings) {
    await page
      .evaluate(
        (settings) => window.__TAURI_INTERNALS__.invoke("update_settings", { settings }),
        originalSettings,
      )
      .catch(() => {});
  }
  await browser?.close().catch(() => {});
  app.kill();
}
