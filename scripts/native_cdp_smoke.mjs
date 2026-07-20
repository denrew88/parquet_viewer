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
const separatorName =
  thousandsSeparator === "," ? "comma" : thousandsSeparator === " " ? "space" : "dot";
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
    boundaryNavigation: "pending",
    sort: "pending",
    filter: "pending",
    copySettings: "pending",
    thousandsSeparator: separatorName,
    artifacts: [artifact],
  };

  const grid = page.getByRole("grid", { name: "Data preview" });
  const cell = (row, column) =>
    page.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
  const assertActiveCellVisible = async (row, column) => {
    const target = cell(row, column);
    await target.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      ({ row, column }) => {
        const gridElement = document.querySelector('[role="grid"][aria-label="Data preview"]');
        const cellElement = document.querySelector(
          `[data-grid-row="${row}"][data-grid-column="${column}"]`,
        );
        if (!gridElement || !cellElement) return false;
        const gridRect = gridElement.getBoundingClientRect();
        const cellRect = cellElement.getBoundingClientRect();
        return (
          cellRect.top >= gridRect.top + 36 &&
          cellRect.bottom <= gridRect.bottom + 1 &&
          cellRect.left >= gridRect.left + 56 &&
          cellRect.right <= gridRect.right + 1 &&
          document.activeElement === gridElement
        );
      },
      { row, column },
      { timeout: 5_000 },
    );
    const geometry = await target.evaluate((element) => {
      const cellRect = element.getBoundingClientRect();
      const gridElement = element.closest('[role="grid"]');
      const gridRect = gridElement?.getBoundingClientRect();
      return {
        cellTop: cellRect.top,
        cellBottom: cellRect.bottom,
        gridTop: gridRect?.top,
        gridBottom: gridRect?.bottom,
        cellLeft: cellRect.left,
        cellRight: cellRect.right,
        gridLeft: gridRect?.left,
        gridRight: gridRect?.right,
        gridFocused: document.activeElement === gridElement,
      };
    });
    assert.ok(
      geometry.cellTop >= geometry.gridTop + 36 &&
        geometry.cellBottom <= geometry.gridBottom + 1 &&
        geometry.cellLeft >= geometry.gridLeft + 56 &&
        geometry.cellRight <= geometry.gridRight + 1,
      `Active cell ${row}:${column} is outside the native grid viewport: ${JSON.stringify(geometry)}`,
    );
    assert.equal(geometry.gridFocused, true, "The native grid lost keyboard focus.");
  };
  const waitForActiveCell = async (row, column) => {
    await page.waitForFunction(
      ({ row, column }) => {
        const gridElement = document.querySelector('[role="grid"][aria-label="Data preview"]');
        return (
          gridElement?.getAttribute("data-active-row") === String(row) &&
          gridElement?.getAttribute("data-active-column") === String(column)
        );
      },
      { row, column },
      { timeout: 30_000 },
    );
    await assertActiveCellVisible(row, column);
  };

  // column_002 is empty at zero-based rows 0, 101, 202, ... in small-csv.csv.
  await cell(0, 2).click();
  await page.keyboard.press("Control+ArrowDown");
  await waitForActiveCell(1, 2);
  await page.keyboard.press("Control+ArrowDown");
  await waitForActiveCell(100, 2);
  await page.keyboard.press("Control+ArrowDown");
  await waitForActiveCell(102, 2);
  await page.keyboard.press("Control+ArrowDown");
  await waitForActiveCell(201, 2);
  try {
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[role="grid"][aria-label="Data preview"]')
            ?.getAttribute("aria-rowcount"),
        ) > 200,
      undefined,
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = {
      ariaRowCount: await grid.getAttribute("aria-rowcount"),
      activeRow: await grid.getAttribute("data-active-row"),
      body: (await page.locator("body").innerText()).slice(0, 2_000),
    };
    process.stderr.write(`Boundary navigation diagnostics: ${JSON.stringify(diagnostics)}\n`);
    throw error;
  }
  const expectedSourceRowCount = 10_000;
  await page.keyboard.press("Control+Alt+ArrowDown");
  await waitForActiveCell(expectedSourceRowCount - 1, 2);
  const sourceRowCount = Number(await grid.getAttribute("aria-rowcount"));
  assert.equal(sourceRowCount, expectedSourceRowCount);
  const sourceLastRow = sourceRowCount - 1;
  await page.keyboard.press("Control+Alt+ArrowUp");
  await waitForActiveCell(0, 2);
  await page.keyboard.press("Control+Alt+ArrowRight");
  await waitForActiveCell(0, 19);
  await page.keyboard.press("Control+Alt+Shift+ArrowLeft");
  assert.equal(await grid.getAttribute("data-active-column"), "0");
  assert.equal(await grid.getAttribute("data-selection-left"), "0");
  assert.equal(await grid.getAttribute("data-selection-right"), "19");
  await page.keyboard.press("Control+Alt+Shift+ArrowDown");
  await waitForActiveCell(sourceLastRow, 0);
  assert.equal(await grid.getAttribute("data-selection-top"), "0");
  assert.equal(await grid.getAttribute("data-selection-bottom"), String(sourceLastRow));
  await page.keyboard.press("Control+Alt+ArrowUp");
  results.boundaryNavigation = "passed";
  results.sourceRowCount = sourceRowCount;

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

  await cell(1, 0)
    .filter({ hasText: formatInteger("10000019") })
    .waitFor({ timeout: 30_000 });
  results.csvProfile = "passed";

  const sortButton = page.getByRole("button", { name: /Sort column_000:/ });
  await sortButton.click();
  await sortButton.click();
  await cell(0, 0)
    .filter({ hasText: formatInteger("99990189981") })
    .waitFor({ timeout: 30_000 });
  results.sort = "passed";

  await page.getByRole("button", { name: "Filter column_000" }).click();
  const filterDialog = page.getByRole("dialog", { name: "Filter column_000" });
  await filterDialog.getByLabel("Filter operator").selectOption("greaterThan");
  await filterDialog.getByRole("textbox", { name: "Value", exact: true }).fill("50000000000");
  await filterDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await filterDialog.waitFor({ state: "detached" });
  await cell(0, 0)
    .filter({ hasText: formatInteger("99990189981") })
    .waitFor({ timeout: 30_000 });
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
      nodes.map((node) => [
        node.getAttribute("data-grid-row"),
        node.getAttribute("data-grid-column"),
      ]),
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
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="status"].copy-status')].some((element) => {
        const text = element.textContent ?? "";
        return (
          text !== "" && !text.startsWith("Copying") && !text.startsWith("Writing clipboard")
        );
      }),
    undefined,
    { timeout: 30_000 },
  );
  const copyStatuses = await page.locator('[role="status"].copy-status').allTextContents();
  assert.ok(copyStatuses.includes("Copied 1 rows."), `Native copy failed: ${copyStatuses.join(" | ")}`);
  const clipboardText = await page.evaluate(async () => navigator.clipboard.readText());
  assert.notEqual(clipboardText, "__native-smoke-sentinel__", "Copy did not write the clipboard.");
  const clipboardLines = clipboardText.trimEnd().split(/\r?\n/);
  assert.equal(clipboardLines.length, 2, `Unexpected clipboard row count: ${clipboardText}`);
  assert.ok(
    clipboardLines.every((line) => line.includes(";")),
    clipboardText,
  );
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
