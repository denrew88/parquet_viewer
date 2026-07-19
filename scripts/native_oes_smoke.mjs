import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(
  process.argv[2] ?? path.join(root, "src-tauri", "target", "debug", "data-viewer.exe"),
);
const fixture = path.resolve(
  process.argv[3] ?? path.join(root, "fixtures", "phase-10", "oes-core-vlen-time.oes.h5"),
);
const artifact = path.resolve(
  process.argv[4] ?? path.join(root, "artifacts", "phase-10", "ui", "native-oes.png"),
);
const expectedFinalValue = process.argv[5] ?? "203";
const expectedFinalWavelength = process.argv[6] ?? "900.0000000001";
const usesCommittedFixture = process.argv[3] === undefined;
const expectedColumnCount = Number(process.argv[7] ?? (usesCommittedFixture ? 5 : 65));
const localAppData = path.join(path.dirname(artifact), "native-localappdata");

await mkdir(path.dirname(artifact), { recursive: true });
await mkdir(localAppData, { recursive: true });
const app = spawn(executable, ["--file", fixture], {
  cwd: root,
  env: { ...process.env, LOCALAPPDATA: localAppData },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let appOutput = "";
app.stdout.on("data", (chunk) => {
  appOutput += chunk.toString();
});
app.stderr.on("data", (chunk) => {
  appOutput += chunk.toString();
});

let browser;
try {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(
        `Data Viewer exited before CDP startup with code ${app.exitCode}: ${appOutput.trim()}`,
      );
    }
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!browser) throw new Error(`WebView2 CDP endpoint did not start: ${lastError}`);

  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .at(0);
  if (!page) throw new Error("WebView2 exposed no page through CDP.");

  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Current file summary").filter({ hasText: "OES HDF5" }).waitFor({
    timeout: 30_000,
  });
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.waitFor({ timeout: 30_000 });
  const columnCount = Number(await grid.getAttribute("aria-colcount"));
  const rowCount = Number(await grid.getAttribute("aria-rowcount"));
  assert.ok(Number.isSafeInteger(expectedColumnCount) && expectedColumnCount > 1);
  assert.equal(columnCount, expectedColumnCount);
  assert.ok(Number.isSafeInteger(rowCount) && rowCount > 0);
  assert.equal(await page.getByRole("searchbox", { name: "Search data" }).count(), 0);

  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await grid.getByRole("columnheader", { name: expectedFinalWavelength }).waitFor();
  const finalCell = grid.locator(
    `[data-grid-row="${rowCount - 1}"][data-grid-column="${columnCount - 1}"]`,
  );
  await finalCell.filter({ hasText: expectedFinalValue }).waitFor({ timeout: 30_000 });
  await finalCell.click();

  await page.evaluate(() => navigator.clipboard.writeText("__native_oes_sentinel__"));
  await page.getByRole("button", { name: "Copy selection" }).click();
  await page.locator(".copy-status").filter({ hasText: "Copied 1 rows." }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, expectedFinalValue);

  await grid.press("Control+A");
  assert.equal(await grid.getAttribute("data-selection-left"), "0");
  assert.equal(await grid.getAttribute("data-selection-right"), String(columnCount - 1));
  assert.equal(await grid.getAttribute("data-selection-top"), "0");
  assert.equal(await grid.getAttribute("data-selection-bottom"), String(rowCount - 1));
  await page.getByRole("button", { name: "Copy selection" }).click();
  await page
    .locator(".copy-status")
    .filter({ hasText: `Copied ${rowCount} rows.` })
    .waitFor();

  const fullClipboard = await page.evaluate(() => navigator.clipboard.readText());
  const copiedRows = fullClipboard.split(/\r?\n/).map((row) => row.split("\t"));
  assert.equal(copiedRows.length, rowCount);
  for (const [rowIndex, row] of copiedRows.entries()) {
    assert.equal(row.length, columnCount, `clipboard row ${rowIndex} column count`);
  }
  const lastRow = copiedRows.at(-1);
  assert.ok(lastRow);
  assert.equal(lastRow.at(-1), expectedFinalValue);
  if (columnCount === 65) {
    assert.equal(lastRow.slice(0, 64).length, 64);
    assert.equal(lastRow.slice(64).length, 1);
    assert.notEqual(lastRow[63], undefined);
    assert.equal(lastRow[64], expectedFinalValue);
  }

  await page.screenshot({ path: artifact, fullPage: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        title: await page.title(),
        fixture,
        format: "OES HDF5",
        rowCount,
        columnCount,
        finalWavelength: expectedFinalWavelength,
        finalValue: lastRow.at(-1),
        projectionBoundary: columnCount === 65 ? "64+1 verified" : "not applicable",
        artifact,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser?.close().catch(() => {});
  app.kill();
}
