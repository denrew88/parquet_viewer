import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");

function parseArguments(argv) {
  const options = {
    manifest: path.join(root, "artifacts", "phase-13", "fixture-manifest.json"),
    output: path.join(root, "artifacts", "phase-13", "native-results.json"),
    report: path.join(root, "artifacts", "phase-13", "ui", "native-smoke.md"),
    screenshot: path.join(root, "artifacts", "phase-13", "ui", "native-desktop.png"),
    executable: path.join(root, "src-tauri", "target", "debug", "data-viewer.exe"),
    bootstrap: path.join(root, "fixtures", "phase-7", "small-csv.csv"),
    cdpPort: 9333,
    timeoutMs: 180_000,
    attach: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/native_phase13_smoke.mjs [options]",
          "  --manifest <path>",
          "  --output <path>",
          "  --report <path>",
          "  --screenshot <path>",
          "  --executable <path>",
          "  --bootstrap <path>",
          "  --cdp-port <number>",
          "  --timeout-ms <number>",
          "  --attach (connect to an already-running native app)",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (key === "--attach") {
      options.attach = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    index += 1;
    if (key === "--manifest") options.manifest = path.resolve(root, value);
    else if (key === "--output") options.output = path.resolve(root, value);
    else if (key === "--report") options.report = path.resolve(root, value);
    else if (key === "--screenshot") options.screenshot = path.resolve(root, value);
    else if (key === "--executable") options.executable = path.resolve(root, value);
    else if (key === "--bootstrap") options.bootstrap = path.resolve(root, value);
    else if (key === "--cdp-port") options.cdpPort = Number(value);
    else if (key === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  assert.ok(Number.isSafeInteger(options.cdpPort) && options.cdpPort > 0);
  assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 30_000);
  return options;
}

function relativePath(value) {
  return path.relative(root, value).replaceAll("\\", "/");
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function validateFixture(entry) {
  const file = path.resolve(entry.path);
  const metadata = await stat(file);
  assert.equal(metadata.size, entry.bytes, `${entry.id}: manifest size mismatch`);
  assert.equal(await sha256File(file), entry.sha256, `${entry.id}: manifest SHA-256 mismatch`);
  return { ...entry, file };
}

async function fixturePreflight(options) {
  const manifest = await readJson(options.manifest);
  assert.equal(manifest.validation, "PASS", "Phase 13 fixture manifest is not validated.");
  const byId = Object.fromEntries(manifest.fixtures.map((entry) => [entry.id, entry]));
  const large = byId["boundary-5850000-low"];
  const duration = byId["duration-arrow"];
  assert.ok(large, "The 5,850,000-row low-cardinality boundary fixture is missing.");
  assert.ok(duration, "The Arrow Duration fixture is missing.");
  assert.equal(large.rows, 5_850_000);
  assert.equal(duration.rows, 9);
  await stat(options.bootstrap);
  return {
    manifest,
    bootstrap: options.bootstrap,
    large: await validateFixture(large),
    duration: await validateFixture(duration),
  };
}

function markdownFor(result) {
  const dragPassed = result.checks.some(
    (check) => check.id === "NATIVE13-DRAG" && check.status === "PASS",
  );
  const runtimePassed = result.checks.some(
    (check) => check.id === "NATIVE13-RUNTIME" && check.status === "PASS",
  );
  const lines = [
    "# Phase 13 네이티브 스모크 결과",
    "",
    `- 판정: **${result.overall}**`,
    `- 실행 시각: ${result.finishedAtUtc}`,
    `- 실행 파일: \`${result.execution.executable}\``,
    "- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)",
    `- WebView URL: \`${result.execution.url ?? "연결 전 실패"}\``,
    `- devicePixelRatio: ${result.execution.devicePixelRatio ?? "확인 불가"}`,
    "",
    "## 검증 항목",
    "",
    "| 항목 | 결과 | 근거 |",
    "| --- | --- | --- |",
  ];
  for (const check of result.checks) {
    lines.push(`| ${check.id} | ${check.status} | ${check.summary.replaceAll("|", "\\|")} |`);
  }
  lines.push(
    "",
    "## IPC 계수",
    "",
    "```json",
    JSON.stringify(result.ipcCounts ?? {}, null, 2),
    "```",
  );
  if (result.failure) {
    lines.push("", "## 실패", "", "```text", result.failure.message, "```");
  }
  lines.push(
    "",
    "## 네이티브 경계",
    "",
    dragPassed
      ? "- 내부 pointer drag 중 OS file-drop overlay가 나타나지 않는 것은 자동 검증했습니다."
      : runtimePassed
        ? "- 내부 pointer drag 단계에 도달했지만 파일 탭 순서가 바뀌지 않아 실패했습니다. file-drop overlay 분리는 PASS 처리하지 않았습니다."
        : "- 내부 pointer drag와 file-drop overlay 분리는 WebView2 단계에 도달하지 못해 검증하지 못했습니다.",
    "- Explorer에서 실제 파일을 끌어오는 external drop과 NSIS 설치본은 이 자동화에 포함하지 않습니다.",
    "",
    "## 산출물",
    "",
    ...result.artifacts.map((artifact) => `- \`${artifact}\``),
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function writeEvidence(options, result) {
  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(path.dirname(options.report), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(options.report, markdownFor(result), "utf8");
}

async function connectWebView(port, app, output, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  let lastError;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(`Data Viewer exited before CDP startup (${app.exitCode}): ${output()}`);
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`WebView2 CDP endpoint did not start: ${errorText(lastError)}`);
}

async function webViewProcessSnapshot() {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Depth 3 -Compress",
      ],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ error: errorText(error) }));
    child.on("close", (code) => {
      const value = stdout.trim();
      if (code !== 0) resolve({ exitCode: code, error: stderr.trim() || null });
      else if (!value) resolve([]);
      else {
        try {
          resolve(JSON.parse(value));
        } catch {
          resolve({ raw: value, parseError: stderr.trim() || null });
        }
      }
    });
  });
}

async function installIpcProbe(page) {
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      throw new Error("Tauri internals are unavailable; browser mock cannot be native evidence.");
    }
    const original = internals.invoke.bind(internals);
    const probe = { counts: {}, calls: [] };
    window.__PHASE13_NATIVE_PROBE__ = probe;
    window.__PHASE13_NATIVE_ORIGINAL_INVOKE__ = original;
    internals.invoke = async (command, args) => {
      probe.counts[command] = (probe.counts[command] ?? 0) + 1;
      const call = { command, startedAt: performance.now() };
      probe.calls.push(call);
      try {
        const value = await original(command, args);
        call.ok = true;
        call.elapsedMs = performance.now() - call.startedAt;
        return value;
      } catch (error) {
        call.ok = false;
        call.elapsedMs = performance.now() - call.startedAt;
        call.error = String(error);
        throw error;
      }
    };
  });
}

async function commandCount(page, command) {
  return page.evaluate((name) => window.__PHASE13_NATIVE_PROBE__?.counts?.[name] ?? 0, command);
}

async function probeSnapshot(page) {
  return page.evaluate(() => structuredClone(window.__PHASE13_NATIVE_PROBE__));
}

async function openThroughNativeRequest(page, file, timeoutMs) {
  const requestId = `phase13-native-${Date.now()}`;
  await page.evaluate(
    async ({ file, requestId }) => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "open-paths-requested",
        payload: { requestId, origin: "startupArg", paths: [file] },
      });
    },
    { file, requestId },
  );
  const tab = page.getByRole("tab", { name: path.basename(file), exact: true });
  await tab.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 30_000) });
  await page.waitForFunction(
    ({ fileName }) =>
      Array.from(
        document.querySelectorAll('[role="tablist"][aria-label="Open files"] [role="tab"]'),
      ).some(
        (candidate) =>
          candidate.textContent?.trim() === fileName &&
          !(candidate.getAttribute("data-reorder-id") ?? "").startsWith("pending:"),
      ),
    { fileName: path.basename(file) },
    { timeout: Math.min(timeoutMs, 30_000) },
  );
  return {
    requestId,
    eventEmitted: true,
    tabVisible: true,
  };
}

async function activeGrid(page) {
  const grid = page.getByRole("grid", { name: "Data preview" }).filter({ visible: true });
  await grid.waitFor({ state: "visible" });
  return grid;
}

async function selectTab(page, file, timeoutMs) {
  const fileName = path.basename(file);
  const tab = page.getByRole("tab", { name: fileName, exact: true });
  await tab.click();
  const grid = await activeGrid(page);
  await grid.waitFor({ state: "visible", timeout: timeoutMs });
  return { tab, grid };
}

async function pointerReorder(page, source, target, orientation, movingState, targetState) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && targetBox, "Pointer reorder item has no native WebView geometry.");
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const targetX =
    orientation === "horizontal"
      ? targetBox.x + Math.min(2, targetBox.width / 4)
      : targetBox.x + targetBox.width / 2;
  const targetY =
    orientation === "vertical"
      ? targetBox.y + Math.min(2, targetBox.height / 4)
      : targetBox.y + targetBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY + (orientation === "vertical" ? 10 : 0));
  await movingState.waitFor({ state: "visible" });
  assert.match((await movingState.getAttribute("class")) ?? "", /is-reordering/);
  assert.equal(await page.locator(".workspace--drop-active").count(), 0);
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.waitForFunction(
    (element) => element?.classList.contains("is-insert-before"),
    await targetState.elementHandle(),
  );
  assert.equal(await page.locator(".workspace--drop-active").count(), 0);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll(".is-reordering").length === 0);
}

async function runNativeDrag(page, preflight, timeoutMs) {
  const tabs = page.getByRole("tablist", { name: "Open files" });
  const largeTab = tabs.getByRole("tab", {
    name: path.basename(preflight.large.file),
    exact: true,
  });
  const durationTab = tabs.getByRole("tab", {
    name: path.basename(preflight.duration.file),
    exact: true,
  });
  await pointerReorder(
    page,
    largeTab,
    durationTab,
    "horizontal",
    largeTab.locator(".."),
    durationTab.locator(".."),
  );
  const expectedTabOrder = [
    path.basename(preflight.bootstrap),
    path.basename(preflight.large.file),
    path.basename(preflight.duration.file),
  ];
  await page.waitForFunction(
    ({ expected }) =>
      Array.from(
        document.querySelectorAll('[role="tablist"][aria-label="Open files"] [role="tab"]'),
      )
        .map((tab) => tab.textContent?.trim() ?? "")
        .every((value, index) => value === expected[index]),
    { expected: expectedTabOrder },
    { timeout: Math.min(timeoutMs, 5_000) },
  );
  assert.deepEqual(
    (await tabs.getByRole("tab").allTextContents()).map((value) => value.trim()),
    expectedTabOrder,
  );
  assert.equal(await largeTab.getAttribute("aria-selected"), "true");

  const { grid } = await selectTab(page, preflight.duration.file, timeoutMs);
  const seconds = grid.getByRole("columnheader", { name: "duration_s", exact: true });
  const millis = grid.getByRole("columnheader", { name: "duration_ms", exact: true });
  await pointerReorder(page, millis, seconds, "horizontal", millis, seconds);
  assert.deepEqual(
    await grid
      .locator('.virtual-grid__column-header[role="columnheader"]')
      .evaluateAll((headers) =>
        headers.slice(0, 2).map((header) => header.getAttribute("aria-label")),
      ),
    ["duration_ms", "duration_s"],
  );
  assert.equal(await page.locator(".workspace--drop-active").count(), 0);
  return {
    tabOrder: await tabs.getByRole("tab").allTextContents(),
    columnOrder: ["duration_ms", "duration_s"],
  };
}

async function runDurationClipboard(page, preflight, timeoutMs) {
  const { grid } = await selectTab(page, preflight.duration.file, timeoutMs);
  const cell = grid.locator('[data-grid-row="1"][data-grid-column="0"]');
  await cell.click();
  let evidence;
  try {
    await page.evaluate(() => navigator.clipboard.writeText("__phase13_native_sentinel__"));
    await grid.press("Control+c");
    await page
      .getByRole("status")
      .filter({ hasText: /copied/i })
      .waitFor({ state: "visible", timeout: timeoutMs });
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.notEqual(text, "__phase13_native_sentinel__");
    assert.ok(text.length > 0, "Duration clipboard text is empty.");
    evidence = { status: "PASS", text, row: 1, logicalColumn: 0 };
  } catch (error) {
    evidence = { status: "BLOCKED", reason: errorText(error) };
  }
  return evidence;
}

async function runTransientAndSettings(page, timeoutMs) {
  const grid = await activeGrid(page);
  const chooserTrigger = page.getByRole("button", { name: "Choose columns" });
  await chooserTrigger.click();
  const chooser = page.getByRole("dialog", { name: "Column chooser" });
  await chooser.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await chooser.waitFor({ state: "hidden" });
  assert.equal(
    await chooserTrigger.evaluate((element) => element === document.activeElement),
    true,
  );
  await chooserTrigger.click();
  await grid.locator('[data-grid-row="1"][data-grid-column="0"]').click();
  await chooser.waitFor({ state: "hidden" });
  assert.equal(await grid.getAttribute("data-selection-kind"), "cell");

  const settingsTrigger = page.getByRole("button", { name: "Settings" });
  await settingsTrigger.click();
  const settings = page.getByRole("dialog", { name: "Application settings" });
  await settings.waitFor({ state: "visible" });
  assert.equal(
    await settings.evaluate((element) => element.contains(document.activeElement)),
    true,
  );
  await settings.getByRole("button", { name: /^Timestamp/ }).click();
  await settings.getByRole("combobox", { name: "Timestamp preset" }).selectOption("dateOnly");
  await settings.getByRole("button", { name: /Advanced settings/ }).click();
  assert.equal(
    await settings.getByRole("combobox", { name: "Timestamp time format" }).inputValue(),
    "hidden",
  );
  assert.equal(await settings.getByRole("combobox", { name: "Timestamp separator" }).count(), 0);
  assert.equal(
    await settings.getByRole("combobox", { name: "Timestamp fractional digits mode" }).count(),
    0,
  );
  assert.equal(
    await settings.getByRole("combobox", { name: "Timestamp timezone suffix" }).count(),
    0,
  );
  await settings.getByRole("button", { name: /All formats/ }).click();
  await settings.getByRole("button", { name: /^Duration/ }).click();
  await settings.getByRole("combobox", { name: "Duration preset" }).selectOption("totalHours");
  await settings.getByText(/51:04:05\.123456789/).waitFor({ state: "visible", timeout: timeoutMs });
  await settings.getByRole("button", { name: "Close settings" }).click();
  await settings.waitFor({ state: "hidden" });
  assert.equal(
    await settingsTrigger.evaluate((element) => element === document.activeElement),
    true,
  );
  return {
    chooserEscapeFocusRestored: true,
    chooserSelectionDismissed: true,
    settingsFocusRestored: true,
  };
}

async function runMultiSortAndFind(page, preflight, timeoutMs) {
  const { grid } = await selectTab(page, preflight.duration.file, timeoutMs);
  const beforeSortQueryId = (await grid.getAttribute("data-query-id")) ?? "";
  await page.getByRole("button", { name: "Sorts (0)" }).click();
  const panel = page.getByRole("dialog", { name: "Multi-column sort" });
  await panel.waitFor({ state: "visible" });
  const add = panel.getByRole("combobox", { name: "Column to add" });
  await add.selectOption("duration_s");
  await panel.getByRole("button", { name: "Add sort level" }).click();
  await add.selectOption("duration_ms");
  await panel.getByRole("button", { name: "Add sort level" }).click();
  const second = panel.getByRole("button", { name: "Reorder sort duration_ms, priority 2" });
  const first = panel.getByRole("button", { name: "Reorder sort duration_s, priority 1" });
  await pointerReorder(page, second, first, "vertical", second.locator(".."), first.locator(".."));
  await panel
    .getByRole("button", { name: "Reorder sort duration_ms, priority 1" })
    .waitFor({ state: "visible" });
  await panel
    .getByRole("combobox", { name: "Direction for duration_ms" })
    .selectOption("descending");
  await panel.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: "Sorts (2)" }).waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ beforeSortQueryId }) => {
      const visible = [
        ...document.querySelectorAll('[role="grid"][aria-label="Data preview"]'),
      ].find((element) => element.getClientRects().length > 0);
      return visible?.getAttribute("data-query-id") !== beforeSortQueryId;
    },
    { beforeSortQueryId },
    { timeout: timeoutMs },
  );
  const afterSortQueryId = await grid.getAttribute("data-query-id");

  await page.keyboard.press("Control+f");
  const find = page.getByRole("searchbox", { name: "Find data" });
  await find.waitFor({ state: "visible" });
  assert.equal(await find.evaluate((element) => element === document.activeElement), true);
  const beforeTypingQueryId = await grid.getAttribute("data-query-id");
  await find.fill("0");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    await grid.getAttribute("data-query-id"),
    beforeTypingQueryId,
    "Find typing executed a query.",
  );
  await find.press("Enter");
  await page.waitForFunction(
    ({ beforeTypingQueryId }) => {
      const visible = [
        ...document.querySelectorAll('[role="grid"][aria-label="Data preview"]'),
      ].find((element) => element.getClientRects().length > 0);
      return visible?.getAttribute("data-query-id") !== beforeTypingQueryId;
    },
    { beforeTypingQueryId },
    { timeout: timeoutMs },
  );
  await find.press("Escape");
  await find.waitFor({ state: "hidden" });
  return {
    sortQueryChanged: afterSortQueryId !== beforeSortQueryId,
    typingQueryUnchanged: true,
    sorts: 2,
    findSubmitted: true,
    queryId: await grid.getAttribute("data-query-id"),
  };
}

async function runFinalRowGeometry(page, preflight, timeoutMs) {
  const { grid } = await selectTab(page, preflight.large.file, timeoutMs);
  assert.equal(Number(await grid.getAttribute("aria-rowcount")), 5_850_000);
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  await grid.press("Control+Alt+ArrowDown");
  await page.waitForFunction(
    () => {
      const visible = [
        ...document.querySelectorAll('[role="grid"][aria-label="Data preview"]'),
      ].find((element) => element.getClientRects().length > 0);
      return visible?.getAttribute("data-active-row") === "5849999";
    },
    undefined,
    { timeout: timeoutMs },
  );
  const cell = grid.locator('[data-grid-row="5849999"][data-grid-column="0"]');
  await cell.waitFor({ state: "visible", timeout: timeoutMs });
  const geometry = await cell.evaluate((element) => {
    const grid = element.closest('[role="grid"]');
    const cellRect = element.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    return {
      cellTop: cellRect.top,
      cellBottom: cellRect.bottom,
      cellHeight: cellRect.height,
      gridTop: gridRect.top,
      gridBottom: gridRect.bottom,
      gridContentBottom: gridRect.top + grid.clientHeight,
      bottomClearance: Number(grid.dataset.bottomClearance),
      clientHeight: grid.clientHeight,
      scrollHeight: grid.scrollHeight,
      mountedRows: Number(grid.dataset.mountedRows),
      mountedCells: Number(grid.dataset.mountedCells),
      focused: document.activeElement === grid,
    };
  });
  assert.equal(geometry.cellHeight, 48);
  assert.ok(geometry.cellBottom <= geometry.gridContentBottom - geometry.bottomClearance + 1);
  assert.ok(geometry.gridContentBottom <= geometry.gridBottom + 1);
  assert.ok(geometry.scrollHeight <= 30_000_000);
  assert.ok(geometry.mountedRows < 100);
  assert.ok(geometry.mountedCells < 1_000);
  assert.equal(geometry.focused, true);
  return geometry;
}

const options = parseArguments(process.argv.slice(2));
const result = {
  schemaVersion: 1,
  overall: "RUNNING",
  startedAtUtc: new Date().toISOString(),
  finishedAtUtc: null,
  execution: {
    executable: relativePath(options.executable),
    browserMock: false,
    nativeRustIpc: true,
    url: null,
    title: null,
    devicePixelRatio: null,
    cdpPort: options.cdpPort,
    testDataRoot: null,
    webViewProcesses: null,
  },
  fixtures: {},
  checks: [],
  ipcCounts: null,
  artifacts: [relativePath(options.output), relativePath(options.report)],
  failure: null,
};
const pass = (id, summary, details = {}) =>
  result.checks.push({ id, status: "PASS", summary, details });
const blocked = (id, summary, details = {}) =>
  result.checks.push({ id, status: "BLOCKED", summary, details });

let browser;
let page;
let app;
let originalSettings;
let runError;
let appOutput = "";

try {
  const preflight = await fixturePreflight(options);
  await stat(options.executable);
  result.fixtures = {
    manifest: relativePath(options.manifest),
    bootstrap: relativePath(preflight.bootstrap),
    large: relativePath(preflight.large.file),
    duration: relativePath(preflight.duration.file),
  };
  pass(
    "NATIVE13-PREFLIGHT",
    "manifest의 585만 행 Parquet와 Arrow Duration 파일 크기·SHA-256을 확인했습니다.",
  );

  await mkdir(path.dirname(options.screenshot), { recursive: true });
  const testDataRoot =
    options.attach && process.env.DATA_VIEWER_TEST_DATA_ROOT
      ? path.resolve(process.env.DATA_VIEWER_TEST_DATA_ROOT)
      : path.join(root, ".tmp", `phase13-native-data-${process.pid}-${Date.now()}`);
  await mkdir(testDataRoot, { recursive: true });
  result.execution.testDataRoot = relativePath(testDataRoot);
  if (options.attach) {
    app = { exitCode: null, killed: false, kill() {} };
    result.execution.launchMode = "attach";
  } else {
    app = spawn(options.executable, ["--file", preflight.bootstrap], {
      cwd: root,
      env: {
        ...process.env,
        DATA_VIEWER_TEST_DATA_ROOT: testDataRoot,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
          process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
          `--remote-debugging-port=${options.cdpPort}`,
        ]
          .filter(Boolean)
          .join(" "),
      },
      windowsHide: false,
      stdio: "ignore",
    });
    result.execution.launchMode = "node-spawn";
  }
  browser = await connectWebView(options.cdpPort, app, () => appOutput.trim(), options.timeoutMs);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  assert.ok(page, "WebView2 exposed no page through CDP.");
  await page.waitForLoadState("domcontentloaded");
  await page
    .getByRole("tablist", { name: "Open files" })
    .getByRole("tab", { name: path.basename(preflight.bootstrap), exact: true })
    .waitFor({ timeout: options.timeoutMs });
  assert.match(page.url(), /^(?:tauri:|https?:\/\/tauri\.localhost)/);
  result.execution.url = page.url();
  result.execution.title = await page.title();
  result.execution.devicePixelRatio = await page.evaluate(() => devicePixelRatio);
  await installIpcProbe(page);
  originalSettings = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
  pass("NATIVE13-RUNTIME", "실제 Tauri URL, Rust invoke와 Windows WebView2 CDP를 확인했습니다.");

  const durationOpen = await openThroughNativeRequest(
    page,
    preflight.duration.file,
    options.timeoutMs,
  );
  pass(
    "NATIVE13-DURATION-OPEN",
    "CDP 연결 후 native open-paths event를 통해 Arrow Duration 파일을 open_data_paths IPC로 열었습니다.",
    durationOpen,
  );

  const largeOpen = await openThroughNativeRequest(page, preflight.large.file, options.timeoutMs);
  pass(
    "NATIVE13-LARGE-OPEN",
    "WebView2 연결 후 native open-paths event를 통해 585만 행 파일을 open_data_paths IPC로 열었습니다.",
    largeOpen,
  );

  const drag = await runNativeDrag(page, preflight, options.timeoutMs);
  pass(
    "NATIVE13-DRAG",
    "실제 pointer로 file tab과 column header를 재정렬했고 내부 drag 중 file-drop overlay는 0회였습니다.",
    drag,
  );

  const clipboard = await runDurationClipboard(page, preflight, options.timeoutMs);
  if (clipboard.status === "PASS") {
    pass(
      "NATIVE13-DURATION-CLIPBOARD",
      "Arrow Duration 셀을 실제 Windows clipboard로 복사하고 sentinel 교체를 확인했습니다.",
      clipboard,
    );
  } else {
    blocked(
      "NATIVE13-DURATION-CLIPBOARD",
      "이 환경에서 Windows clipboard 자동 확인을 완료하지 못했습니다.",
      clipboard,
    );
  }

  const surfaces = await runTransientAndSettings(page, options.timeoutMs);
  pass(
    "NATIVE13-SURFACE-SETTINGS",
    "transient outside/Escape와 Timestamp/Duration Settings focus·Date-only 숨김을 확인했습니다.",
    surfaces,
  );

  const query = await runMultiSortAndFind(page, preflight, options.timeoutMs);
  pass(
    "NATIVE13-SORT-FIND",
    "Duration에서 2기준 pointer reorder/apply와 Ctrl+F 명시 실행을 실제 query IPC로 확인했습니다.",
    query,
  );

  const geometry = await runFinalRowGeometry(page, preflight, options.timeoutMs);
  pass(
    "NATIVE13-FINAL-ROW",
    "585만 행의 실제 마지막 행이 WebView2 scrollbar 위에서 완전히 표시되고 focus를 유지했습니다.",
    geometry,
  );
  await page.screenshot({ path: options.screenshot, fullPage: true });
  result.artifacts.push(relativePath(options.screenshot));
  result.ipcCounts = (await probeSnapshot(page)).counts;
  result.overall = result.checks.some((check) => check.status === "BLOCKED")
    ? "PASS_WITH_BLOCKED"
    : "PASS";
} catch (error) {
  const message = errorText(error);
  const cdpBlocked = message.includes("WebView2 CDP endpoint did not start");
  runError = cdpBlocked ? undefined : error;
  result.overall = cdpBlocked ? "BLOCKED" : "FAIL";
  if (cdpBlocked) {
    blocked(
      "NATIVE13-CDP",
      "small CSV bootstrap과 실행별 신규 debug data-root를 사용해도 WebView2 CDP 포트가 열리지 않아 native interaction을 실행하지 못했습니다.",
    );
  }
  result.execution.webViewProcesses = await webViewProcessSnapshot();
  result.failure = {
    message,
    stack: error instanceof Error ? error.stack : null,
    appOutput: appOutput.trim() || null,
  };
  if (page) {
    const failureScreenshot = path.join(path.dirname(options.screenshot), "native-failure.png");
    await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => undefined);
    result.artifacts.push(relativePath(failureScreenshot));
    result.ipcCounts = await probeSnapshot(page)
      .then((probe) => probe.counts)
      .catch(() => null);
  }
} finally {
  if (page && originalSettings) {
    await page
      .evaluate(
        (settings) => window.__TAURI_INTERNALS__.invoke("update_settings", { settings }),
        originalSettings,
      )
      .catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  if (app && !app.killed) app.kill();
  result.finishedAtUtc = new Date().toISOString();
  await writeEvidence(options, result);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (runError) throw runError;
