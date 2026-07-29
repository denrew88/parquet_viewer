import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.join(root, "src-tauri", "target", "debug", "data-viewer.exe");
const bootstrap = path.join(root, "fixtures", "phase-7", "small-csv.csv");
const fixture = path.join(root, "fixtures", "phase-15", "csv-5850000-high.csv");
const output = path.join(root, "artifacts", "phase-15", "native-csv-filter.json");
const screenshot = path.join(root, "artifacts", "phase-15", "ui", "native-csv-filter.png");
const port = 9341;
const timeoutMs = 15 * 60_000;

async function connect(app) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    assert.equal(app.exitCode, null, `Data Viewer exited before CDP startup (${app.exitCode})`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`WebView2 CDP endpoint did not start: ${String(lastError)}`);
}

async function clearTestCache(page) {
  const closeButtons = page.locator(
    '[role="tablist"][aria-label="Open files"] button[aria-label^="Close "]',
  );
  while ((await closeButtons.count()) > 0) {
    await closeButtons.first().click();
  }
  let cleanup;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    cleanup = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("clear_csv_cache"));
    if (cleanup.remainingCacheBytes === 0 && cleanup.skippedActiveEntries === 0) return cleanup;
    await page.waitForTimeout(500);
  }
  return cleanup;
}

const result = {
  startedAtUtc: new Date().toISOString(),
  executable: path.relative(root, executable).replaceAll("\\", "/"),
  bootstrap: path.relative(root, bootstrap).replaceAll("\\", "/"),
  fixture: path.relative(root, fixture).replaceAll("\\", "/"),
  status: "FAIL",
};
let app;
let browser;
let page;
let failure;
let appOutput = "";

try {
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.dirname(screenshot), { recursive: true });
  app = spawn(executable, ["--file", bootstrap], {
    cwd: root,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        `--remote-debugging-port=${port}`,
      ]
        .filter(Boolean)
        .join(" "),
    },
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => (appOutput += chunk.toString()));
  app.stderr.on("data", (chunk) => (appOutput += chunk.toString()));
  browser = await connect(app);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  assert.ok(page, "WebView2 exposed no page through CDP.");
  await page.waitForLoadState("domcontentloaded");
  await page
    .getByRole("tab", { name: path.basename(bootstrap), exact: true })
    .waitFor({ timeout: timeoutMs });
  const preflightCleanup = await clearTestCache(page);
  assert.deepEqual(preflightCleanup.cleanupFailures, []);
  assert.equal(preflightCleanup.remainingCacheBytes, 0);
  const requestId = `phase15-native-${Date.now()}`;
  await page.evaluate(
    async ({ file, requestId }) => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "open-paths-requested",
        payload: { requestId, origin: "startupArg", paths: [file] },
      });
    },
    { file: fixture, requestId },
  );
  await page
    .getByRole("tab", { name: path.basename(fixture), exact: true })
    .waitFor({ timeout: 120_000 });

  const progress = page.getByRole("progressbar", { name: "CSV preparation progress" });
  await progress.waitFor({ timeout: 120_000 });
  const initialProgress = Number(await progress.getAttribute("value"));
  const started = Date.now();

  await page.getByRole("button", { name: "Filter category", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter category" });
  await filter
    .getByRole("textbox", { name: "Value", exact: true })
    .fill("category-a6bd7b19eef3ead7");
  await filter.getByRole("button", { name: "Apply" }).click();
  await page
    .getByLabel("Active filters")
    .getByText("category contains category-a6bd7b19eef3ead7")
    .waitFor({ timeout: 30_000 });

  await page.waitForTimeout(2_000);
  assert.equal(app.exitCode, null, "Data Viewer exited while filter/query waited for preparation.");
  const laterProgress = Number(await progress.getAttribute("value"));
  assert.ok(
    laterProgress >= initialProgress,
    `CSV progress regressed while distinct/query waited (${initialProgress} -> ${laterProgress}).`,
  );

  await progress.waitFor({ state: "detached", timeout: timeoutMs });
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="grid"][aria-label="Data preview"]')
        ?.getAttribute("data-query-id")?.startsWith("frontend-query-") ?? false,
    undefined,
    { timeout: 5 * 60_000 },
  );
  const queryId = await grid.getAttribute("data-query-id");
  assert.match(queryId ?? "", /^frontend-query-/, "Filtered query did not commit to the grid.");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="grid"][aria-label="Data preview"]')
        ?.getAttribute("aria-rowcount") === "1",
    undefined,
    { timeout: 60_000 },
  );
  assert.equal(app.exitCode, null, "Data Viewer exited after the filtered query committed.");
  await page.screenshot({ path: screenshot });
  const cacheCleanup = await clearTestCache(page);
  assert.deepEqual(cacheCleanup.cleanupFailures, []);
  assert.equal(cacheCleanup.skippedActiveEntries, 0);
  assert.equal(cacheCleanup.remainingCacheBytes, 0);

  Object.assign(result, {
    status: "PASS",
    elapsedMs: Date.now() - started,
    initialProgress,
    laterProgress,
    queryId,
    rowCount: 1,
    cacheCleanup,
    screenshot: path.relative(root, screenshot).replaceAll("\\", "/"),
  });
} catch (error) {
  failure = error;
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  result.appOutput = appOutput.trim() || null;
  if (page) {
    await page.screenshot({ path: screenshot }).catch(() => undefined);
  }
} finally {
  result.finishedAtUtc = new Date().toISOString();
  if (page) {
    const finalCleanup = await clearTestCache(page).catch(() => null);
    if (finalCleanup) result.finalCleanup = finalCleanup;
  }
  await browser?.close().catch(() => undefined);
  if (app && !app.killed) app.kill();
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failure) throw failure;
