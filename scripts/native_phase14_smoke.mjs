import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");

function options(argv) {
  const value = {
    executable: path.join(root, "src-tauri", "target", "release", "data-viewer.exe"),
    fixture: path.join(root, ".tmp", "phase14-fixtures", "small", "csv-state-matrix.csv"),
    output: path.join(root, "artifacts", "phase-14", "native-results.json"),
    report: path.join(root, "artifacts", "phase-14", "ui", "native-smoke.md"),
    screenshot: path.join(root, "artifacts", "phase-14", "ui", "native-column-drag.png"),
    port: 9344,
    timeout: 120_000,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value for ${key}`);
    if (key === "--executable") value.executable = path.resolve(root, next);
    else if (key === "--fixture") value.fixture = path.resolve(root, next);
    else if (key === "--output") value.output = path.resolve(root, next);
    else if (key === "--report") value.report = path.resolve(root, next);
    else if (key === "--screenshot") value.screenshot = path.resolve(root, next);
    else if (key === "--cdp-port") value.port = Number(next);
    else if (key === "--timeout-ms") value.timeout = Number(next);
    else throw new Error(`Unknown option: ${key}`);
  }
  return value;
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

async function connect(port, app, timeout) {
  const deadline = Date.now() + Math.min(timeout, 60_000);
  let lastError;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Data Viewer exited early (${app.exitCode}).`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`WebView2 CDP did not start: ${String(lastError)}`);
}

async function chooseColumn(panel, index, column) {
  const control = panel.getByRole("combobox", {
    name: new RegExp(`Column.*priority ${index}`, "i"),
  });
  if (await control.isEditable()) await control.fill(column);
  else await control.click();
  await panel.getByRole("option", { name: new RegExp(`^${column}(?:\\s|$)`, "i") }).click();
}

function report(result) {
  const lines = [
    "# Phase 14 네이티브 스모크 결과",
    "",
    `- 판정: **${result.overall}**`,
    `- 실행 파일: \`${result.executable}\``,
    `- 입력 파일: \`${result.fixture}\``,
    "- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)",
    "",
    "| 항목 | 결과 | 근거 |",
    "| --- | --- | --- |",
    ...result.checks.map((item) => `| ${item.id} | ${item.status} | ${item.summary} |`),
  ];
  if (result.failure) lines.push("", "## 실패", "", "```text", result.failure, "```");
  return `${lines.join("\n")}\n`;
}

const config = options(process.argv.slice(2));
const result = {
  schemaVersion: 1,
  overall: "RUNNING",
  executable: relative(config.executable),
  fixture: relative(config.fixture),
  startedAtUtc: new Date().toISOString(),
  finishedAtUtc: null,
  checks: [],
  failure: null,
};
const pass = (id, summary, details = {}) =>
  result.checks.push({ id, status: "PASS", summary, details });

let app;
let browser;
let appOutput = "";
try {
  const dataRoot = path.join(root, ".tmp", `phase14-native-${process.pid}-${Date.now()}`);
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.dirname(config.output), { recursive: true });
  await mkdir(path.dirname(config.screenshot), { recursive: true });
  app = spawn(config.executable, ["--file", config.fixture], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_VIEWER_TEST_DATA_ROOT: dataRoot,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${config.port}`,
    },
  });
  app.stdout.on("data", (chunk) => (appOutput += chunk.toString()));
  app.stderr.on("data", (chunk) => (appOutput += chunk.toString()));
  browser = await connect(config.port, app, config.timeout);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  assert.ok(page, "WebView2 exposed no page.");
  await page.waitForLoadState("domcontentloaded");
  await page
    .getByRole("tab", { name: path.basename(config.fixture), exact: true })
    .waitFor({ timeout: config.timeout });
  assert.match(page.url(), /^(?:tauri:|https?:\/\/tauri\.localhost)/);
  assert.equal(await page.evaluate(() => typeof window.__TAURI_INTERNALS__?.invoke), "function");
  pass("NATIVE14-RUNTIME", "Tauri URL, Rust invoke와 WebView2 CDP를 확인했습니다.", {
    url: page.url(),
    devicePixelRatio: await page.evaluate(() => devicePixelRatio),
  });

  await page.waitForTimeout(2_000);
  await page
    .getByText("Preparing CSV for fast queries", { exact: true })
    .waitFor({ state: "hidden", timeout: config.timeout });

  await page.getByRole("button", { name: "Sorts (0)" }).click();
  const sortPanel = page.getByRole("dialog", { name: "Multi-column sort" });
  const add = sortPanel.getByRole("button", { name: /^(?:Add level|Add sort level)$/i });
  await add.click();
  assert.equal(
    await sortPanel.getByRole("button", { name: "Apply", exact: true }).isDisabled(),
    true,
  );
  await chooseColumn(sortPanel, 1, "row_id");
  await sortPanel
    .getByRole("button", { name: "Apply", exact: true })
    .evaluate((button) => button.click());
  await page.getByRole("button", { name: "Sorts (1)" }).waitFor({ timeout: config.timeout });
  pass("NATIVE14-SORT", "빈 level 추가 후 컬럼을 결정하고 명시적으로 Apply했습니다.");

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Application settings" });
  for (const name of ["Integer grouping", "Timestamp preset", "Duration preset"]) {
    await settings.getByRole("combobox", { name }).waitFor({ state: "visible" });
  }
  const timestamp = settings.getByRole("button", { name: /(?:Show|Hide) Timestamp details/i });
  const duration = settings.getByRole("button", { name: /(?:Show|Hide) Duration details/i });
  await timestamp.click();
  await settings.getByLabel("Timestamp details", { exact: true }).waitFor({ state: "visible" });
  await duration.click();
  assert.equal(await settings.getByLabel("Timestamp details", { exact: true }).count(), 0);
  await settings.getByLabel("Duration details", { exact: true }).waitFor({ state: "visible" });
  await settings.getByRole("button", { name: "Close settings" }).click();
  pass("NATIVE14-SETTINGS", "기본 표시 설정과 단일 인라인 상세 accordion을 확인했습니다.");

  const grid = page.getByRole("grid", { name: "Data preview" });
  const headers = grid.locator('.virtual-grid__column-header[role="columnheader"]');
  const source = headers.nth(1);
  const target = headers.nth(0);
  const sourceName = await source.getAttribute("aria-label");
  const targetName = await target.getAttribute("aria-label");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(
    sourceBox && targetBox && sourceName && targetName,
    "Native column geometry is missing.",
  );
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2);
  await page.mouse.move(targetBox.x + 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  const overlay = page.getByTestId("column-drag-overlay");
  await overlay.waitFor({ state: "visible" });
  assert.ok((await overlay.locator(".virtual-grid__cell").count()) > 0);
  assert.equal(await page.locator(".workspace--drop-active").count(), 0);
  const overlayGeometry = await overlay.locator(".virtual-grid__cell").evaluateAll((cells) =>
    cells.slice(0, 2).map((cell) => {
      const box = cell.getBoundingClientRect();
      return { top: box.top, height: box.height };
    }),
  );
  assert.ok(Math.abs((overlayGeometry[0]?.height ?? 0) - 48) <= 1);
  if (overlayGeometry.length > 1)
    assert.ok(Math.abs(overlayGeometry[1].top - overlayGeometry[0].top - 48) <= 1);
  await page.screenshot({ path: config.screenshot, fullPage: true });
  await page.mouse.up();
  assert.deepEqual(
    await headers.evaluateAll((items) =>
      items.slice(0, 2).map((item) => item.getAttribute("aria-label")),
    ),
    [sourceName, targetName],
  );
  const restore = page.getByRole("button", { name: "Restore source column order" });
  await restore.click();
  assert.deepEqual(
    await headers.evaluateAll((items) =>
      items.slice(0, 2).map((item) => item.getAttribute("aria-label")),
    ),
    [targetName, sourceName],
  );
  pass(
    "NATIVE14-COLUMN-DRAG",
    "헤더와 mounted 셀 strip, live reflow, 원본 순서 복원을 확인했습니다.",
    {
      overlayGeometry,
    },
  );
  result.overall = "PASS";
} catch (error) {
  result.overall = "FAIL";
  result.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  result.appOutput = appOutput.trim() || null;
} finally {
  await browser?.close().catch(() => undefined);
  if (app && app.exitCode === null) app.kill();
  result.finishedAtUtc = new Date().toISOString();
  await writeFile(config.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(config.report, report(result), "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.overall !== "PASS") process.exitCode = 1;
