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
  process.argv[3] ?? path.join(root, "fixtures", "phase-7", "large-csv.csv"),
);
const output = path.resolve(
  process.argv[4] ?? path.join(root, "artifacts", "phase-6", "boundary-perf.json"),
);
const expectedRows = Number(process.argv[5] ?? 250_000);
const columnIndex = Number(process.argv[6] ?? 0);
const expectedColumnName = process.argv[7] ?? "column_000";
const samples = 5;
assert.ok(Number.isSafeInteger(expectedRows) && expectedRows > 0, "Expected rows must be positive.");
assert.ok(Number.isSafeInteger(columnIndex) && columnIndex >= 0, "Column index must be non-negative.");

function workingSetBytes(pid) {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
    { encoding: "utf8" },
  ).trim();
  const value = Number(output);
  assert.ok(Number.isSafeInteger(value) && value > 0, `Invalid working set: ${output}`);
  return value;
}

const localAppData = path.join(path.dirname(output), "native-boundary-localappdata");
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
  stdio: "ignore",
});

let browser;
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
  if (!browser) throw new Error(`WebView2 CDP endpoint did not start: ${lastError}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .at(0);
  if (!page) throw new Error("WebView2 exposed no page through CDP.");

  await page.waitForLoadState("domcontentloaded");
  const grid = page.getByRole("grid", { name: "Data preview" });
  const cell = (row, column) =>
    page.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
  await cell(0, columnIndex).waitFor({ state: "visible", timeout: 30_000 });
  await cell(0, columnIndex).click();
  await page.evaluate(() => {
    globalThis.__DATA_VIEWER_IPC_TELEMETRY__ = { counts: {} };
  });

  const waitForRow = async (row) => {
    await page.waitForFunction(
      (target) =>
        document
          .querySelector('[role="grid"][aria-label="Data preview"]')
          ?.getAttribute("data-active-row") === String(target),
      row,
      { timeout: 60_000 },
    );
    await cell(row, columnIndex).waitFor({ state: "visible", timeout: 30_000 });
  };
  const moveToTop = async () => {
    await page.keyboard.press("Control+Alt+ArrowUp");
    await waitForRow(0);
  };
  const measureDown = async () => {
    await page.evaluate(() => {
      globalThis.__DATA_VIEWER_IPC_TELEMETRY__.counts = {};
    });
    const started = performance.now();
    await page.keyboard.press("Control+ArrowDown");
    await waitForRow(expectedRows - 1);
    const elapsedMs = performance.now() - started;
    const commandCounts = await page.evaluate(() => ({
      ...globalThis.__DATA_VIEWER_IPC_TELEMETRY__.counts,
    }));
    return { elapsedMs, commandCounts };
  };

  const rssBeforeBytes = workingSetBytes(app.pid);
  const warmup = await measureDown();
  const measurements = [];
  for (let index = 0; index < samples; index += 1) {
    await moveToTop();
    measurements.push(await measureDown());
  }
  const rssAfterBytes = workingSetBytes(app.pid);
  const timingsMs = measurements.map((measurement) => measurement.elapsedMs);
  const sorted = [...timingsMs].sort((left, right) => left - right);
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const navigationIpcPerMove = Math.max(
    ...measurements.map((measurement) => measurement.commandCounts.find_data_boundary ?? 0),
  );
  const readPageIpcPerMoveMax = Math.max(
    ...measurements.map((measurement) => measurement.commandCounts.read_page ?? 0),
  );
  const result = {
    fixture,
    rows: expectedRows,
    column: expectedColumnName,
    columnIndex,
    warmupMs: warmup.elapsedMs,
    warmupCommandCounts: warmup.commandCounts,
    timingsMs,
    measurements,
    p95Ms,
    navigationIpcPerMove,
    readPageIpcPerMoveMax,
    rssBeforeBytes,
    rssAfterBytes,
    rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
    measuredAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  assert.ok(p95Ms <= 2_000, `Ctrl+Down p95 ${p95Ms.toFixed(1)} ms exceeds 2000 ms.`);
  assert.ok(
    measurements.every((measurement) => measurement.commandCounts.find_data_boundary === 1),
    "Every Ctrl+Down sample must invoke exactly one boundary resolver.",
  );
  assert.ok(readPageIpcPerMoveMax <= 1, "Ctrl+Down must read at most the resolved target page.");
  assert.equal(await grid.getAttribute("data-active-column"), String(columnIndex));
} finally {
  await browser?.close().catch(() => undefined);
  if (!app.killed) app.kill();
}
