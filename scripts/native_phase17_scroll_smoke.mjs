import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(
  process.argv[2] ?? path.join(root, "src-tauri", "target", "debug", "data-viewer.exe"),
);
const fixture = path.resolve(
  process.argv[3] ?? path.join(root, "fixtures", "phase-15", "boundary-5850000-high.parquet"),
);
const artifactDirectory = path.join(root, "artifacts", "phase-17", "ui");
const output = path.join(artifactDirectory, "native-scroll-performance.json");
const screenshot = path.join(artifactDirectory, "native-desktop.png");
const expectedRows = 5_850_000;
const cycles = 20;

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function workingSetBytes(pid) {
  const value = Number(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: "utf8" },
    ).trim(),
  );
  assert.ok(Number.isSafeInteger(value) && value > 0, `Invalid working set: ${value}`);
  return value;
}

await mkdir(artifactDirectory, { recursive: true });
const localAppData = path.join(artifactDirectory, "native-phase17-localappdata");
await mkdir(localAppData, { recursive: true });
const app = spawn(executable, ["--file", fixture], {
  cwd: root,
  env: {
    ...process.env,
    LOCALAPPDATA: localAppData,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      "--remote-debugging-port=9333",
    ]
      .filter(Boolean)
      .join(" "),
  },
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
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!browser) {
    throw new Error(`WebView2 CDP endpoint did not start: ${lastError}\n${appOutput}`);
  }
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .at(0);
  if (!page) throw new Error("WebView2 exposed no page through CDP.");

  await page.waitForLoadState("domcontentloaded");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(
    (rows) =>
      document
        .querySelector('[role="grid"][aria-label="Data preview"]')
        ?.getAttribute("aria-rowcount") === String(rows),
    expectedRows,
    { timeout: 60_000 },
  );
  await page.locator('[data-grid-row="0"][data-grid-column="0"]').waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.evaluate(() => {
    globalThis.__DATA_VIEWER_IPC_TELEMETRY__ = { counts: {} };
  });

  const readCounts = async () =>
    page.evaluate(() => ({ ...globalThis.__DATA_VIEWER_IPC_TELEMETRY__.counts }));
  const resetCounts = async () =>
    page.evaluate(() => {
      globalThis.__DATA_VIEWER_IPC_TELEMETRY__.counts = {};
    });
  const scrubTo = async (targetRow) => {
    const expectedOffset = Math.floor(targetRow / 200) * 200;
    await resetCounts();
    const startedAt = performance.now();
    await grid.evaluate((element, row) => {
      const gridElement = element;
      const sequence = [Math.max(0, row - 1_200), Math.max(0, row - 600), row];
      for (const value of sequence) {
        gridElement.scrollTop = value * 48;
        gridElement.dispatchEvent(new Event("scroll"));
      }
      gridElement.dispatchEvent(new Event("scrollend"));
    }, targetRow);
    await page.waitForFunction(
      ({ row, offset }) => {
        const element = document.querySelector('[role="grid"][aria-label="Data preview"]');
        const cell = document.querySelector(
          `[data-grid-row="${row}"][data-grid-column="0"]`,
        );
        return (
          element?.getAttribute("data-visible-offset") === String(offset) &&
          cell !== null &&
          !cell.classList.contains("virtual-grid__cell--loading")
        );
      },
      { row: targetRow, offset: expectedOffset },
      { timeout: 30_000 },
    );
    return {
      targetRow,
      expectedOffset,
      elapsedMs: performance.now() - startedAt,
      commandCounts: await readCounts(),
    };
  };

  const rssBeforeBytes = workingSetBytes(app.pid);
  const measurements = [];
  for (let index = 0; index < cycles; index += 1) {
    measurements.push(await scrubTo(4_137 + index * 4_000));
  }
  const sourceP95Ms = percentile95(measurements.map((entry) => entry.elapsedMs));
  assert.ok(
    measurements.every((entry) => (entry.commandCounts.read_page ?? 0) <= 1),
    `A source scrub issued more than one page read: ${JSON.stringify(measurements)}`,
  );
  assert.ok(sourceP95Ms <= 1_500, `Source scrub p95 ${sourceP95Ms.toFixed(1)}ms exceeds 1500ms.`);

  const cachedTarget = measurements.at(-1).targetRow;
  await grid.evaluate((element, row) => {
    element.scrollTop = (row - 40) * 48;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(new Event("scrollend"));
  }, cachedTarget);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const cached = await scrubTo(cachedTarget);
  assert.equal(cached.commandCounts.read_page ?? 0, 0, "A warm cache hit invoked read_page.");

  await page.locator(`[data-grid-row="${cachedTarget}"][data-grid-column="0"]`).click();
  await resetCounts();
  await page.keyboard.press("Control+Alt+ArrowDown");
  await page.waitForFunction(
    (row) =>
      document
        .querySelector('[role="grid"][aria-label="Data preview"]')
        ?.getAttribute("data-active-row") === String(row),
    expectedRows - 1,
    { timeout: 30_000 },
  );
  const lastCell = page.locator(
    `[data-grid-row="${expectedRows - 1}"][data-grid-column="0"]`,
  );
  await lastCell.waitFor({ state: "visible", timeout: 30_000 });
  const lastRowGeometry = await lastCell.evaluate((cell) => {
    const gridElement = cell.closest('[role="grid"]');
    const cellRect = cell.getBoundingClientRect();
    const gridRect = gridElement.getBoundingClientRect();
    return {
      cellBottom: cellRect.bottom,
      cellHeight: cellRect.height,
      gridBottom: gridRect.top + gridElement.clientHeight,
      bottomClearance: Number(gridElement.dataset.bottomClearance),
      focused: document.activeElement === gridElement,
      scrollHeight: gridElement.scrollHeight,
    };
  });
  assert.equal(lastRowGeometry.cellHeight, 48);
  assert.ok(
    lastRowGeometry.cellBottom <=
      lastRowGeometry.gridBottom - lastRowGeometry.bottomClearance + 1,
    `The final row is clipped: ${JSON.stringify(lastRowGeometry)}`,
  );
  assert.equal(lastRowGeometry.focused, true, "The native grid lost focus at the final row.");
  assert.ok(lastRowGeometry.scrollHeight <= 9_600_054, "The physical scroll segment is too tall.");

  await page.screenshot({ path: screenshot, fullPage: true });
  const rssAfterBytes = workingSetBytes(app.pid);
  const result = {
    result: "PASS",
    fixture,
    expectedRows,
    cycles,
    measurements,
    sourceP95Ms,
    cached,
    finalNavigationCounts: await readCounts(),
    lastRowGeometry,
    rssBeforeBytes,
    rssAfterBytes,
    rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
    screenshot,
    measuredAt: new Date().toISOString(),
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  if (!app.killed) app.kill();
}
