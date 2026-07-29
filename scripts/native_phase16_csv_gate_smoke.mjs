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
const output = path.join(root, "artifacts", "phase-16", "native-cold-warm.json");
const screenshot = path.join(root, "artifacts", "phase-16", "ui", "native-desktop.png");
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

async function closeAllDocuments(page) {
  const buttons = page.locator(
    '[role="tablist"][aria-label="Open files"] button[aria-label^="Close "]',
  );
  while ((await buttons.count()) > 0) await buttons.first().click();
}

async function clearTestCache(page) {
  await closeAllDocuments(page);
  let cleanup;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    cleanup = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("clear_csv_cache"));
    if (cleanup.remainingCacheBytes === 0 && cleanup.skippedActiveEntries === 0) return cleanup;
    await page.waitForTimeout(500);
  }
  return cleanup;
}

async function openPath(page, file, suffix) {
  const requestId = `phase16-native-${suffix}-${Date.now()}`;
  await page.evaluate(
    async ({ requestedPath, requestId }) => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "open-paths-requested",
        payload: { requestId, origin: "startupArg", paths: [requestedPath] },
      });
    },
    { requestedPath: file, requestId },
  );
  await page.getByRole("tab", { name: path.basename(file), exact: true }).waitFor({
    timeout: 120_000,
  });
}

async function installWarmFrameProbe(page) {
  await page.evaluate(() => {
    const state = { blockerFrames: 0, progressFrames: 0, cancelFrames: 0, samples: 0 };
    Reflect.set(window, "__phase16WarmFrames", state);
    let active = true;
    const sample = () => {
      if (!active) return;
      state.samples += 1;
      if (document.querySelector('[data-testid="csv-preparation-blocker"]')) {
        state.blockerFrames += 1;
      }
      if (document.querySelector('[aria-label="CSV preparation progress"]')) {
        state.progressFrames += 1;
      }
      if (
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Cancel",
        )
      ) {
        state.cancelFrames += 1;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    Reflect.set(window, "__phase16StopWarmFrames", () => {
      active = false;
      return structuredClone(state);
    });
  });
}

const result = {
  startedAtUtc: new Date().toISOString(),
  executable: path.relative(root, executable).replaceAll("\\", "/"),
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
  await page.getByRole("tab", { name: path.basename(bootstrap), exact: true }).waitFor();

  const preflightCleanup = await clearTestCache(page);
  assert.deepEqual(preflightCleanup.cleanupFailures, []);
  assert.equal(preflightCleanup.remainingCacheBytes, 0);

  await openPath(page, fixture, "cold");
  const progress = page.getByRole("progressbar", { name: "CSV preparation progress" });
  const blocker = page.getByTestId("csv-preparation-blocker");
  const surface = page.getByTestId("csv-data-interaction-surface");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await progress.waitFor({ timeout: 120_000 });
  await blocker.waitFor({ timeout: 30_000 });
  assert.equal(await surface.getAttribute("inert"), "");
  const coldStarted = Date.now();
  const initialProgress = Number(await progress.getAttribute("value"));
  const initialRow = await grid.getAttribute("data-active-row");
  const hitTest = await blocker.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 80);
    return {
      covered: target !== null && element.contains(target),
      width: bounds.width,
      height: bounds.height,
    };
  });
  assert.equal(hitTest.covered, true, `Blocker hit-test failed: ${JSON.stringify(hitTest)}`);

  await page.evaluate(() => {
    document
      .querySelector('[aria-label="Filter category"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector('[role="grid"][aria-label="Data preview"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true }),
      );
  });
  assert.equal(await page.getByRole("dialog", { name: "Filter category" }).count(), 0);
  assert.equal(await grid.getAttribute("data-active-row"), initialRow);
  assert.equal(await grid.getAttribute("data-query-id"), "");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Application settings" }).waitFor();
  await page
    .getByRole("dialog", { name: "Application settings" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await page.getByRole("tab", { name: "Schema", exact: true }).click();
  await page.getByRole("heading", { name: "Schema" }).waitFor();
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.screenshot({ path: screenshot });

  await progress.waitFor({ state: "detached", timeout: timeoutMs });
  await blocker.waitFor({ state: "detached", timeout: 30_000 });
  assert.notEqual(await surface.getAttribute("inert"), "");
  const coldElapsedMs = Date.now() - coldStarted;
  const finalGrid = page.getByRole("grid", { name: "Data preview" });
  await finalGrid.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await finalGrid.getAttribute("data-active-row"), "1");

  await closeAllDocuments(page);
  await installWarmFrameProbe(page);
  const warmStarted = Date.now();
  await openPath(page, fixture, "warm");
  await page.getByRole("grid", { name: "Data preview" }).waitFor({ timeout: 60_000 });
  const warmInteractiveMs = Date.now() - warmStarted;
  await page.waitForTimeout(1_000);
  const warmFrames = await page.evaluate(() => Reflect.get(window, "__phase16StopWarmFrames")());
  const warmObservationMs = Date.now() - warmStarted;
  assert.equal(warmFrames.blockerFrames, 0, JSON.stringify(warmFrames));
  assert.equal(warmFrames.progressFrames, 0, JSON.stringify(warmFrames));
  assert.equal(warmFrames.cancelFrames, 0, JSON.stringify(warmFrames));

  await closeAllDocuments(page);
  const coldCleanup = await clearTestCache(page);
  assert.deepEqual(coldCleanup.cleanupFailures, []);
  assert.equal(coldCleanup.remainingCacheBytes, 0);
  await openPath(page, fixture, "cancel");
  await page.getByRole("progressbar", { name: "CSV preparation progress" }).waitFor({
    timeout: 120_000,
  });
  const cancelStarted = Date.now();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("CSV preparation cancelled").waitFor({ timeout: 30_000 });
  const cancelElapsedMs = Date.now() - cancelStarted;
  assert.equal(await page.getByTestId("csv-preparation-blocker").count(), 0);
  assert.notEqual(await page.getByTestId("csv-data-interaction-surface").getAttribute("inert"), "");
  await page.getByRole("button", { name: "Filter category", exact: true }).click();
  await page.getByRole("dialog", { name: "Filter category" }).waitFor();

  const finalCleanup = await clearTestCache(page);
  assert.deepEqual(finalCleanup.cleanupFailures, []);
  assert.equal(finalCleanup.remainingCacheBytes, 0);
  Object.assign(result, {
    status: "PASS",
    initialProgress,
    coldElapsedMs,
    warmInteractiveMs,
    warmObservationMs,
    warmFrames,
    cancelElapsedMs,
    hitTest,
    preflightCleanup,
    coldCleanup,
    finalCleanup,
    screenshot: path.relative(root, screenshot).replaceAll("\\", "/"),
  });
} catch (error) {
  failure = error;
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  result.appOutput = appOutput.trim() || null;
  if (page) await page.screenshot({ path: screenshot }).catch(() => undefined);
} finally {
  result.finishedAtUtc = new Date().toISOString();
  if (page) result.cleanupAfterFailure = await clearTestCache(page).catch(() => null);
  await browser?.close().catch(() => undefined);
  if (app && !app.killed) app.kill();
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failure) throw failure;
