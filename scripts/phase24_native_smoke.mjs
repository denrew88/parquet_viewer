import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { operateOwnedSaveDialog } from "./native_owned_save_dialog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.resolve(
  root,
  process.env.P24_BINARY ?? "src-tauri/target/release/candidates/phase-24-native/data-viewer.exe",
);
const requireProduct = process.env.P24_REQUIRE_PRODUCT === "1";
const commerceOnly = process.env.P24_COMMERCE_ONLY === "1";
const chartFollowup = process.env.P24_CHART_FOLLOWUP === "1";
const chartSourceOnly = process.env.P24_CHART_SOURCE_ONLY === "1";
const chartOptions = process.env.P24_CHART_OPTIONS === "1";
const chartAnalysis = process.env.P24_CHART_ANALYSIS === "1";
const cteCompletion = process.env.P24_CTE_COMPLETION === "1";
const sqlGridNavigation = process.env.P24_SQL_GRID_NAVIGATION === "1";
const chartImageExport = process.env.P24_CHART_IMAGE_EXPORT === "1";
const chartTransactionOnly = process.argv.includes("--chart-transaction-only");
const launchOnly = process.env.P24_LAUNCH_ONLY === "1";
const directProduct = binary === path.join(root, "src-tauri/target/release/data-viewer.exe");
const rebuiltProduct = binary === path.join(root, "src-tauri/target/chart-image-rebuild/release/data-viewer.exe");
const imageSmoke = directProduct ? "direct-native" : rebuiltProduct ? "rebuild-native" : requireProduct ? "product-native" : "native";
const scratch = path.join(root, ".tmp", sqlGridNavigation ? "sql-grid-navigation/native" : launchOnly ? "chart-image-export/baseline-native" : chartImageExport ? `chart-image-export/${imageSmoke}${chartTransactionOnly ? "-transaction" : ""}` : cteCompletion ? "sql-cte-completion" : chartAnalysis ? "phase24-chart-analysis" : requireProduct
  ? "phase24-product-smoke" : commerceOnly ? "phase24-native-commerce"
    : chartFollowup ? "phase24-chart-followup" : chartSourceOnly ? "phase24-chart-source"
      : chartOptions ? "phase24-chart-options" : "phase24-native");
const fixtureDir = path.join(root, ".tmp", "phase24-fixtures");
const orderItems = path.join(root, "fixtures/phase-22/commerce/order_items.parquet");
const runFile = promisify(execFile);
const port = sqlGridNavigation ? 9520 : chartImageExport ? 9519 : cteCompletion ? 9518 : chartAnalysis ? 9517 : chartOptions ? 9516 : chartFollowup || chartSourceOnly ? 9515 : 9514;
const appVersion = process.env.P24_EXPECT_VERSION ?? "0.24.0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = expect.configure({ timeout: 20_000 });
const report = { state: "running", binary, version: appVersion, checks: [], consoleErrors: [] };
let owned;
let browser;
let page;

async function powershell(script, env = {}) {
  const setup = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$ErrorActionPreference='Stop'\n";
  const { stdout } = await runFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", setup + script], {
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return stdout.trim();
}

async function poll(read, done, timeout = 45_000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const value = await read();
    if (done(value)) return value;
    await sleep(75);
  }
  throw new Error("Timed out waiting for the Phase 24 native candidate.");
}

async function invoke(command, args = {}) {
  const result = await page.evaluate(async ({ command, args }) => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
    } catch (error) {
      return { ok: false, error };
    }
  }, { command, args });
  if (!result.ok) throw new Error(`${command}: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function launch(paths) {
  owned = JSON.parse(await powershell(`
$arguments=@((ConvertFrom-Json $env:P24_FIXTURES) | ForEach-Object { '"'+$_+'"' })
$p=Start-Process -FilePath $env:P24_BINARY -WorkingDirectory $env:P24_ROOT -ArgumentList $arguments -WindowStyle Hidden -PassThru
[pscustomobject]@{pid=$p.Id;path=$p.Path;ticks=$p.StartTime.Ticks.ToString()} | ConvertTo-Json -Compress
`, {
    P24_BINARY: binary,
    P24_FIXTURES: JSON.stringify(paths),
    P24_ROOT: root,
    WEBVIEW2_USER_DATA_FOLDER: path.join(scratch, `webview-${process.pid}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  }));
  browser = await poll(async () => {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_500 });
    } catch {
      return null;
    }
  }, Boolean);
  page = await poll(() => browser.contexts().flatMap((context) => context.pages())
    .find((item) => item.url().includes("tauri.localhost")), Boolean);
  page.on("pageerror", (error) => report.consoleErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === "function");
  report.identifier = await invoke("plugin:app|identifier");
  const health = await invoke("health_check");
  assert.equal(health.appVersion, appVersion);
  const metadata = JSON.parse(await powershell(
    "(Get-Item -LiteralPath $env:P24_BINARY).VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress",
    { P24_BINARY: binary },
  ));
  report.windowsVersion = metadata;
  if (requireProduct) {
    assert.equal(report.identifier, "com.denrew88.data-viewer");
    assert.ok(
      [metadata.FileVersion, metadata.ProductVersion].includes(appVersion),
      `Unexpected Windows resource version: ${JSON.stringify(metadata)}`,
    );
  }
  for (const file of paths) {
    await check(page.getByRole("button", { name: `Close ${path.basename(file)}`, exact: true })).toBeVisible();
  }
}

async function stop() {
  await browser?.close().catch(() => {});
  if (!owned) return;
  await powershell(`
$p=Get-Process -Id ([int]$env:P24_PID) -ErrorAction SilentlyContinue
if($p) {
  if(-not [string]::Equals([IO.Path]::GetFullPath($p.Path),[IO.Path]::GetFullPath($env:P24_BINARY),[StringComparison]::OrdinalIgnoreCase)) { throw 'Unowned PID path' }
  if($p.StartTime.Ticks.ToString() -ne $env:P24_TICKS) { throw 'Reused PID' }
  Stop-Process -Id $p.Id
  if(-not $p.WaitForExit(3000)) { throw 'Owned process did not stop' }
}
`, { P24_PID: String(owned.pid), P24_BINARY: binary, P24_TICKS: owned.ticks });
}

async function record(testId, verify) {
  const start = performance.now();
  const result = { testId, state: "pass" };
  try {
    Object.assign(result, await verify());
  } catch (error) {
    result.state = "fail";
    result.error = error.stack ?? String(error);
  }
  result.elapsedMs = Math.round(performance.now() - start);
  report.checks.push(result);
  console.log(JSON.stringify(result));
  if (result.state === "fail") throw new Error(`Failed ${testId}`);
}

const sql = () => page.getByRole("region", { name: "SQL workspace", exact: true });
const charts = () => page.getByRole("region", { name: "Charts workspace", exact: true });
const editor = () => sql().getByRole("textbox", { name: "SQL editor", exact: true });
const tab = (name) => page.getByRole("tablist", { name: "SQL tabs", exact: true }).getByRole("tab", { name, exact: true });
const sqlGrid = () => sql().getByRole("tabpanel", { name: "Results", exact: true })
  .getByRole("grid", { name: "Data preview", exact: true });
const card = (name) => charts().getByRole("article", { name, exact: true });
const combo = (owner, name) => owner.getByRole("combobox", { name, exact: true });
const cell = (grid, row, column) =>
  grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
const categoriesSql = (month) =>
  `SELECT category, amount, ordinal FROM orders WHERE month = '2026-${month}' ORDER BY ordinal`;
const revenueSql = "SELECT CAST(ordered_at AS DATE) AS day, SUM(amount) AS revenue FROM orders WHERE month = '2026-01' GROUP BY day ORDER BY day";

async function openWorkspace(name) {
  await page.getByRole("button", { name: `${name} workspace`, exact: true }).click();
}

async function run(statement, expectedRows) {
  await editor().fill(statement);
  const button = sql().getByRole("button", { name: "Run", exact: true });
  await button.click();
  await check(button).toBeEnabled();
  await check(sqlGrid()).toHaveAttribute("aria-rowcount", String(expectedRows));
}

async function sqlEditorFeatures() {
  await openWorkspace("SQL");
  await check(sql().getByRole("button", { name: "orders", exact: true })).toBeVisible();
  const withClause = 'WITH one_order AS (SELECT category AS "상품 분류" FROM orders LIMIT 1)';
  const field = editor();
  const suggestions = page.locator(".cm-tooltip-autocomplete");

  await field.fill(`${withClause}\nSELECT * FROM`);
  await field.press("Control+End");
  await page.keyboard.type(" one");
  await check(suggestions.getByRole("option", { name: /^one_order/ })).toBeVisible();
  await field.press("Tab");
  await check(field.locator(".cm-line").last()).toHaveText("SELECT * FROM one_order");

  await field.fill(`${withClause}\nSELECT q\nFROM one_order q`);
  await field.press("Control+End");
  await field.press("ArrowUp");
  await field.press("End");
  await page.keyboard.type(".");
  await check(suggestions.getByRole("option", { name: /^상품 분류/ })).toBeVisible();
  await page.screenshot({ path: path.join(scratch, "cte-output-suggestions.png") });
  await field.press("Tab");
  await check(field.locator(".cm-line").nth(1)).toHaveText('SELECT q."상품 분류"');
  await field.press("Control+Enter");
  await check(sqlGrid()).toHaveAttribute("aria-rowcount", "1");

  await page.getByRole("button", { name: "Rename tab", exact: true }).click();
  const name = page.getByRole("textbox", { name: "SQL tab name", exact: true });
  await name.fill("주문 분류");
  await page.screenshot({ path: path.join(scratch, "sql-tab-rename.png") });
  await name.press("Enter");
  await check(tab("주문 분류")).toBeFocused();
  await check(field.locator(".cm-line").nth(1)).toHaveText('SELECT q."상품 분류"');
  await check(sqlGrid()).toHaveAttribute("aria-rowcount", "1");
  return { resultRows: 1, name: "주문 분류" };
}

async function sqlGridKeyboard() {
  await openWorkspace("SQL");
  const orders = sql().getByRole("button", { name: "orders", exact: true });
  const tooltip = page.getByRole("tooltip");
  await check(orders).not.toContainText("orders.parquet");
  await orders.hover();
  await check(tooltip).toHaveText(/phase24-fixtures[\\/]orders\.parquet$/i);
  await page.screenshot({ path: path.join(scratch, "table-path.png") });
  await editor().hover();
  await check(tooltip).toHaveCount(0);

  const lastRow = 200_000;
  await run(`SELECT i AS ordinal,
    CASE WHEN i IN (0, ${lastRow}) THEN 'value' WHEN i=1 THEN ' ' WHEN i % 2=0 THEN NULL ELSE '' END AS vertical,
    'left' AS h0, ' ' AS h1, NULL::VARCHAR AS h2, '' AS h3, 'right' AS h4
    FROM range(${lastRow + 1}) t(i) ORDER BY i`, lastRow + 1);
  const grid = sqlGrid();
  const activeRow = (row) => check(grid).toHaveAttribute("data-active-row", String(row));
  const activeColumn = (column) => check(grid).toHaveAttribute("data-active-column", String(column));
  await cell(grid, 0, 1).click();
  await check(grid).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await activeRow(1);
  await check(grid).toHaveAttribute("data-selection-top", "0");
  await check(grid).toHaveAttribute("data-selection-bottom", "1");
  await page.keyboard.press("Shift+ArrowUp");
  await activeRow(0);
  await check(grid).toHaveAttribute("data-selection-bottom", "0");
  await page.keyboard.press("Control+ArrowDown");
  await activeRow(1);
  await page.keyboard.press("Control+Shift+ArrowDown");
  await activeRow(lastRow);
  await check(grid).toHaveAttribute("data-selection-top", "1");
  await check(grid).toHaveAttribute("data-selection-bottom", String(lastRow));
  await check(cell(grid, lastRow, 1)).toHaveText("value");
  await page.keyboard.press("Control+ArrowUp");
  await activeRow(1);
  await cell(grid, 1, 2).click();
  await page.keyboard.press("Control+ArrowRight");
  await activeColumn(3);
  await page.keyboard.press("Control+Shift+ArrowRight");
  await activeColumn(6);
  await check(grid).toHaveAttribute("data-selection-left", "3");
  await check(grid).toHaveAttribute("data-selection-right", "6");
  await page.keyboard.press("Control+ArrowLeft");
  await activeColumn(3);

  const filterButton = grid.getByRole("button", { name: "Filter ordinal", exact: true });
  await filterButton.scrollIntoViewIfNeeded();
  await filterButton.click();
  const filter = page.getByRole("dialog", { name: "Filter ordinal", exact: true });
  await filter.getByRole("combobox", { name: "Filter operator" }).selectOption("greaterThanOrEqual");
  await filter.getByRole("textbox", { name: "Value", exact: true }).fill(String(lastRow - 4));
  await filter.getByRole("button", { name: "Apply", exact: true }).click();
  await check(grid).toHaveAttribute("aria-rowcount", "5");
  await grid.getByRole("button", { name: "Sort ordinal: not sorted", exact: true }).click();
  await grid.getByRole("button", { name: "Sort ordinal: ascending, priority 1" }).click();
  await check(cell(grid, 0, 0)).toHaveText(String(lastRow));
  await cell(grid, 0, 1).click();
  await page.keyboard.press("Control+Shift+ArrowDown");
  await activeRow(4);
  await check(grid).toHaveAttribute("data-selection-top", "0");
  await check(grid).toHaveAttribute("data-selection-bottom", "4");
  await check(cell(grid, 4, 0)).toHaveText(String(lastRow - 4));
  await page.screenshot({ path: path.join(scratch, "sql-result-keyboard.png") });
  return { baseRows: lastRow + 1, selectedViewRows: 5 };
}

async function pick(select, name) {
  const option = select.locator("option").filter({ hasText: name });
  await check(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  assert.notEqual(value, null);
  await select.selectOption(value);
}

async function typeChart(title, type, axes, source) {
  if (source) {
    await charts().getByRole("button", { name: "Add chart", exact: true }).click();
    await pick(combo(charts(), "Data source"), source);
  }
  await combo(charts(), "Chart type").selectOption({ label: type });
  for (const [name, label] of Object.entries(axes)) {
    await pick(combo(charts(), name), new RegExp(`^${label}$`));
  }
  const field = charts().getByRole("textbox", { name: "Chart title", exact: true });
  await field.fill(title);
  await field.blur();
  const chart = card(title);
  await chart.scrollIntoViewIfNeeded();
  await check(chart).toHaveAttribute("data-state", "ready");
  await check(chart.locator("canvas").first()).toBeVisible();
  return chart;
}

async function chartFollowupScenario() {
  const grid = page.getByRole("grid", { name: "Data preview", exact: true });
  await check(grid).toHaveAttribute("aria-rowcount", "3999997");
  const header = grid.locator('[role="columnheader"][data-column-index="4"]');
  await check(header).toContainText("category");
  await header.getByText("category", { exact: true }).click();
  await check(grid).toHaveAttribute("data-selection-bottom", "3999996");
  await cell(grid, 0, 4).click({ button: "right" });
  const started = performance.now();
  await page.getByRole("menuitem", { name: "Create chart from selection" }).click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet" });
  await check(destination).toContainText("3,999,997 rows · 1 column");
  const destinationMs = Math.round(performance.now() - started);
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  const draft = card("New chart");
  await check(draft).toHaveAttribute("data-state", "blocked");
  await check(draft.locator("canvas")).toHaveCount(0);
  await check(combo(charts(), "Chart type")).toHaveValue("");
  const plotStarted = performance.now();
  await combo(charts(), "Chart type").selectOption({ label: "Bar" });
  const bar = card("Bar chart");
  await expect(bar).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await check(bar).toContainText("3,999,997 valid rows");
  await check(bar.locator("canvas").first()).toBeVisible();
  const chartMs = Math.round(performance.now() - plotStarted);
  await check(combo(charts(), "Group")).toHaveValue("category");
  const handle = bar.getByRole("separator", { name: "Resize Bar chart" });
  const box = await handle.boundingBox();
  const startWidth = (await bar.boundingBox()).width;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 21, y, { steps: 4 });
  await expect.poll(async () => (await bar.boundingBox()).width).toBeGreaterThan(startWidth + 18);
  await page.mouse.move(x + 43, y, { steps: 4 });
  await expect.poll(async () => (await bar.boundingBox()).width).toBeGreaterThan(startWidth + 40);
  await page.mouse.up();
  await page.screenshot({ path: path.join(scratch, "native-desktop.png") });
  return { rows: 3_999_997, destinationMs, chartMs, startWidth, endWidth: (await bar.boundingBox()).width };
}

async function currentId(chart) {
  const id = await chart.getAttribute("data-result-id");
  assert.ok(id);
  return id;
}

async function sortDesc(grid, name) {
  await grid.getByRole("button", { name: `Sort ${name}: not sorted`, exact: true }).click();
  await grid.getByRole("button", { name: `Sort ${name}: ascending, priority 1`, exact: true }).click();
  await check(grid.getByRole("button", { name: `Sort ${name}: descending, priority 1`, exact: true })).toBeVisible();
}

async function filterOrdinal(golden) {
  const grid = sqlGrid();
  await grid.getByRole("button", { name: "Filter ordinal", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Filter ordinal", exact: true });
  await dialog.getByRole("combobox", { name: "Filter operator" }).selectOption("greaterThanOrEqual");
  await dialog.getByRole("textbox", { name: "Value", exact: true }).fill(String(golden.minOrdinal));
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await check(grid).toHaveAttribute("aria-rowcount", String(golden.filteredRows));
  await sortDesc(grid, "ordinal");
  await check(cell(grid, 0, 2)).toHaveText(String(golden.firstOrdinal));
  return grid;
}

async function sendSqlBlock(golden) {
  const grid = await filterOrdinal(golden);
  await cell(grid, 0, 0).click();
  await page.keyboard.down("Shift");
  try {
    await page.keyboard.press("ArrowRight");
    for (let offset = 1; offset < golden.selectedRows; offset++) {
      await page.keyboard.press("ArrowDown");
      // CDP can deliver a repeat burst faster than a hardware key. Allow the
      // virtual grid to present the next frame between repeated key events.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
  } finally {
    await page.keyboard.up("Shift");
  }
  await check(grid).toHaveAttribute("data-selection-bottom", String(golden.selectedRows - 1));
  await check(grid).toHaveAttribute("data-selection-right", "1");
  await check(cell(grid, golden.selectedRows - 1, 2)).toHaveText(String(golden.lastOrdinal));
  await grid.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Create chart from selection", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await dialog.getByRole("button", { name: "Add chart", exact: true }).click();
  return typeChart("January filtered selection", "Box plot", { Group: "category", Value: "amount" });
}

async function exercise(golden) {
  const file = () => card("Unit price vs quantity");
  const following = () => card("Order amount by category");
  const frozen = () => card("January filtered selection");
  const daily = () => card("Daily revenue");
  let firstId;
  let dailyId;
  let frozenText;

  await record("T-P24-001", async () => {
    await openWorkspace("SQL");
    await run(categoriesSql("01"), golden.orders.monthRows);
    await page.getByRole("button", { name: "New SQL tab", exact: true }).click();
    await run(revenueSql, golden.orders.dailyRows);
    await tab("Query 1").click();
    await check(editor()).toHaveText(categoriesSql("01"));
    await check(sqlGrid()).toHaveAttribute("aria-rowcount", String(golden.orders.monthRows));
    await tab("Query 2").click();
    await check(editor()).toHaveText(revenueSql);
    await check(sqlGrid()).toHaveAttribute("aria-rowcount", String(golden.orders.dailyRows));
    return { query1Rows: golden.orders.monthRows, query2Rows: golden.orders.dailyRows };
  });

  await record("T-P24-003/007 canvas", async () => {
    await openWorkspace("Charts");
    const scatter = await typeChart("Unit price vs quantity", "Scatter", { "X axis": "unit_price", "Y axis": "quantity" }, /orders\.parquet/);
    await check(scatter).toContainText(/640 valid rows/);
    const violin = await typeChart("Order amount by category", "Violin", { Group: "category", Value: "amount" }, /Query 1/);
    firstId = await currentId(violin);
    const line = await typeChart("Daily revenue", "Line", { "X axis": "day", "Y axis": "revenue" }, /Query 2/);
    dailyId = await currentId(line);
    assert.notEqual(firstId, dailyId);
    return { firstId, dailyId };
  });

  await record("T-P24-004 cross-page SQL selection", async () => {
    await openWorkspace("SQL");
    await tab("Query 1").click();
    const box = await sendSqlBlock(golden.sqlSelection);
    await check(box).toContainText(`${golden.sqlSelection.selectedRows} valid rows`);
    frozenText = await box.innerText();
    return { ...golden.sqlSelection };
  });

  await record("T-P24-007 update isolation", async () => {
    await openWorkspace("SQL");
    await run(categoriesSql("02"), golden.orders.monthRows);
    await openWorkspace("Charts");
    await following().scrollIntoViewIfNeeded();
    await check(following()).not.toHaveAttribute("data-result-id", firstId);
    await check(following()).toHaveAttribute("data-state", "ready");
    await check(file()).toHaveAttribute("data-state", "ready");
    await check(daily()).toHaveAttribute("data-result-id", dailyId);
    assert.equal(await frozen().innerText(), frozenText);
    await check(charts().getByRole("article")).toHaveCount(4);
    const refreshedId = await currentId(following());
    await page.screenshot({ path: path.join(scratch, "native-desktop.png") });
    await openWorkspace("SQL");
    await tab("Query 2").click();
    await editor().fill("SELECT CAST('not an integer' AS INTEGER) AS broken");
    const button = sql().getByRole("button", { name: "Run", exact: true });
    await button.click();
    await check(button).toBeEnabled();
    await check(sql().getByText(/could not convert|conversion error|failed/i).first()).toBeVisible();
    await openWorkspace("Charts");
    await check(daily()).toHaveAttribute("data-result-id", dailyId);
    await check(following()).toHaveAttribute("data-result-id", refreshedId);
    assert.equal(await frozen().innerText(), frozenText);
    return { refreshedId, dailyId, previousBlockPreserved: true };
  });

  await record("T-P24-002 incompatible schema preserves the old chart", async () => {
    const previous = await currentId(following());
    await openWorkspace("SQL");
    await tab("Query 1").click();
    await run("SELECT category, CAST(amount AS VARCHAR) AS amount, ordinal FROM orders WHERE month = '2026-02' ORDER BY ordinal", golden.orders.monthRows);
    await openWorkspace("Charts");
    await following().scrollIntoViewIfNeeded();
    await check(following()).toHaveAttribute("data-state", "blocked");
    await check(following()).toHaveAttribute("data-result-id", previous);
    await check(daily()).toHaveAttribute("data-result-id", dailyId);
    assert.equal(await frozen().innerText(), frozenText);
    return { previous, blocked: true };
  });
}

async function sampleProcess() {
  return JSON.parse(await powershell(`
$p=Get-Process -Id ([int]$env:P24_PID)
[pscustomobject]@{workingSet=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;handles=$p.HandleCount} | ConvertTo-Json -Compress
`, { P24_PID: String(owned.pid) }));
}

async function openSources(paths) {
  const response = await invoke("open_data_paths", {
    request: { requestId: `p24-open-${randomUUID()}`, origin: "startupArg", paths },
  });
  assert.deepEqual(response.failures, []);
  return response.opened.map(({ documentId, sessionId }) => ({ documentId, sessionId }));
}

async function runIpc(statement, tables) {
  const runId = `p24-sql-${randomUUID()}`;
  await invoke("start_sql_query", {
    request: { runId, action: "execute", sql: statement, tables },
  });
  const status = await poll(() => invoke("get_sql_query_status", { runId }),
    (value) => ["complete", "cancelled", "failed"].includes(value.state), 120_000);
  assert.equal(status.state, "complete", JSON.stringify(status));
  return { runId, resultId: status.resultId };
}

function compute(source, kind, x, y, requestId = `p24-chart-${randomUUID()}`) {
  return invoke("compute_chart", { request: { requestId, source, kind, x, y } });
}

async function wholeCategoryCounts() {
  const [identity] = await openSources([orderItems]);
  const result = await compute({ kind: "file", ...identity }, "bar", "category");
  assert.equal(result.validRows, 3_999_997);
  assert.equal(result.excludedRows, 0);
  assert.deepEqual(
    Object.fromEntries(result.groups.map(({ label, count, value }) => {
      assert.equal(value, count);
      return [label, count];
    })),
    { "뷰티": 499964, "의류": 501711, "식품": 499565, "반려동물": 500733,
      "생활용품": 500526, "스포츠": 499237, "문구": 499056, "가전": 499205 },
  );
  return { rows: result.validRows, categories: result.groups.length };
}

async function chartOptionsIpc() {
  const [orders] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const { runId, resultId } = await runIpc(
    "SELECT CAST(i AS DOUBLE) AS amount, CAST(i * 10 AS DOUBLE) AS measure, 'Group' AS category, CASE WHEN i >= 0 THEN CAST(i AS DOUBLE) END AS nonnegative FROM range(-1,5) t(i) ORDER BY i",
    [{ ...orders, alias: "orders", columnMode: "name" }],
  );
  const source = { kind: "sql", runId, resultId };
  const request = (options) => invoke("compute_chart", {
    request: { requestId: `p24-options-${randomUUID()}`, source, ...options },
  });
  try {
    const bins = [{ start: 0, end: 2, count: 2 }, { start: 2, end: 4, count: 3 }];
    for (const histogram of [{ mode: "count", count: 2 }, { mode: "width", width: 2 }]) {
      const result = await request({ kind: "histogram", x: "r3", histogram });
      assert.deepEqual(result.bins, bins);
      assert.equal(result.excludedRows, 1);
      const logResult = await request({ kind: "histogram", x: "r0", xScale: "log1p", histogram });
      assert.equal(logResult.validRows, 5);
      assert.equal(logResult.scaleExcludedRows, 1);
    }
    await assert.rejects(request({ kind: "histogram", x: "r0", histogram: { mode: "count", count: 49 } }), /48/);
    const logs = await request({ kind: "scatter", x: "r0", y: "r1", xScale: "log", yScale: "log10" });
    assert.equal(logs.scaleExcludedRows, 2);
    assert.equal(logs.validRows, 4);
    assert.ok(logs.points.some(([x, y]) => x === 0 && y === 1));
    const plusOne = await request({ kind: "scatter", x: "r0", y: "r1", xScale: "log1p" });
    assert.equal(plusOne.scaleExcludedRows, 1);
    assert.ok(plusOne.points.some(([x, y]) => x === 0 && y === 0));
    const small = await request({ kind: "violin", x: "r2", y: "r0", violinBandwidth: 0.25 });
    const large = await request({ kind: "violin", x: "r2", y: "r0", violinBandwidth: 4 });
    assert.deepEqual(small.groups[0].summary, large.groups[0].summary);
    assert.notDeepEqual(small.groups[0].density, large.groups[0].density);
    return { logExcludedRows: logs.scaleExcludedRows, log1pExcludedRows: plusOne.scaleExcludedRows };
  } finally {
    await invoke("release_sql_result", { runId, resultId });
  }
}

async function chartOptionsUi() {
  await openWorkspace("SQL");
  await tab("Query 1").click();
  await run(
    "SELECT CAST(i AS DOUBLE) AS amount, CAST(i * 10 AS DOUBLE) AS measure FROM range(-1,5) t(i) ORDER BY i",
    6,
  );
  await openWorkspace("Charts");
  const plot = await typeChart("Axis options", "Scatter", { "X axis": "amount", "Y axis": "measure" }, /Query 1/);
  const xScale = combo(charts(), "X scale");
  await xScale.selectOption("log");
  await check(plot).toContainText("4 valid rows");
  await check(plot).toHaveAttribute("data-x-scale", "log");
  await xScale.selectOption("log10");
  await check(plot).toHaveAttribute("data-x-scale", "log10");
  await xScale.selectOption("log1p");
  await check(plot).toContainText("5 valid rows");
  await check(plot).toHaveAttribute("data-x-scale", "log1p");
  await combo(charts(), "Chart type").selectOption({ label: "Histogram" });
  await combo(charts(), "X scale").selectOption("linear");
  await combo(charts(), "Histogram bins").selectOption("count");
  await charts().getByRole("spinbutton", { name: "Bin count", exact: true }).fill("2");
  await charts().getByRole("button", { name: "Apply histogram bins", exact: true }).click();
  await check(plot).toContainText("6 valid rows");
  await check(plot).toContainText("2 bins");
  await check(plot.locator("canvas").first()).toBeVisible();
  await page.screenshot({ path: path.join(scratch, "chart-options-desktop.png") });
}

async function verifyImageClipboard(expected, copy) {
  const token = randomUUID();
  const ready = path.join(scratch, `clipboard-ready-${token}`);
  const done = path.join(scratch, `clipboard-done-${token}`);
  const probe = powershell(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DataViewerClipboardProbe {
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    public static uint OwnerProcess() {
        uint process;
        GetWindowThreadProcessId(GetClipboardOwner(), out process);
        return process;
    }
}
'@
$clipboard = [System.Windows.Forms.Clipboard]
$sequence = [DataViewerClipboardProbe]::GetClipboardSequenceNumber()
$original = $clipboard::GetDataObject()
$backup = [System.Windows.Forms.DataObject]::new()
if ($original) {
    foreach ($format in $original.GetFormats($false)) {
        $value = $original.GetData($format, $false)
        if ($value -is [System.Drawing.Image]) { $value = $value.Clone() }
        elseif ($value -is [IO.MemoryStream]) { $value = [IO.MemoryStream]::new($value.ToArray()) }
        elseif ($value -isnot [string] -and $value -isnot [byte[]] -and $value -isnot [string[]]) {
            throw "Cannot safely preserve clipboard format: $format"
        }
        $backup.SetData($format, $false, $value)
    }
}
if ([DataViewerClipboardProbe]::GetClipboardSequenceNumber() -ne $sequence) {
    throw 'Clipboard changed while its previous contents were being backed up.'
}
[IO.File]::WriteAllText($env:P24_CLIP_READY, "ready")
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$restore = $false
try {
    while (!(Test-Path -LiteralPath $env:P24_CLIP_DONE)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for image copy.' }
        Start-Sleep -Milliseconds 50
    }
    $copiedSequence = [DataViewerClipboardProbe]::GetClipboardSequenceNumber()
    if ($copiedSequence -eq $sequence) { throw 'Windows clipboard did not receive a new image.' }
    $restore = [DataViewerClipboardProbe]::OwnerProcess() -eq [uint32]$env:P24_CLIP_OWNER
    $image = $clipboard::GetImage()
    if (!$image) { throw 'Windows clipboard did not contain an image.' }
    try {
        if ($image.Width -ne [int]$env:P24_CLIP_WIDTH -or $image.Height -ne [int]$env:P24_CLIP_HEIGHT) {
            throw 'Windows clipboard did not contain the expected chart image size.'
        }
        $restore = $true
        if ((Get-Content -LiteralPath $env:P24_CLIP_DONE -Raw) -ne 'copied') { throw 'Image copy action failed.' }
        @{width=$image.Width; height=$image.Height} | ConvertTo-Json -Compress
    } finally { $image.Dispose() }
} finally {
    if ($restore -and [DataViewerClipboardProbe]::GetClipboardSequenceNumber() -eq $copiedSequence) {
        if ($backup.GetFormats($false).Length) { $clipboard::SetDataObject($backup, $true, 10, 50) }
        else { $clipboard::Clear() }
    }
}
`, {
    P24_CLIP_READY: ready,
    P24_CLIP_DONE: done,
    P24_CLIP_OWNER: String(owned.pid),
    P24_CLIP_WIDTH: String(expected.width),
    P24_CLIP_HEIGHT: String(expected.height),
  });
  // Surface a backup failure immediately rather than invoking copy without a restore point.
  const observed = probe.then(JSON.parse);
  observed.catch(() => {});
  await Promise.race([poll(() => fs.access(ready).then(() => true, () => false), Boolean, 10_000), observed]);
  let copied = false;
  try {
    await copy();
    copied = true;
  } finally {
    await fs.writeFile(done, copied ? "copied" : "failed");
    if (!copied) await observed.catch(() => {});
  }
  return observed;
}

async function chartImageExportUi() {
  const title = "주문 산점도 & <보고서>";
  const statement = `SELECT CAST(i % 256 + 1 AS DOUBLE) AS x,
    CAST(i // 256 + 1 AS DOUBLE) AS y,
    CASE WHEN (i % 256) % 2 = 0 THEN 'Keep' ELSE 'Other' END AS category
    FROM range(65536) t(i)`;
  await openWorkspace("SQL");
  await run(statement, 65536);
  await openWorkspace("Charts");
  const scatter = await typeChart(title, "Scatter", { "X axis": "x", "Y axis": "y" }, /Query 1/);
  await pick(combo(charts(), "Filter column"), /^category$/);
  await charts().getByRole("textbox", { name: "Filter value", exact: true }).fill("Keep");
  await charts().getByRole("button", { name: "Apply filter", exact: true }).click();
  await combo(charts(), "X scale").selectOption("log10");
  await check(scatter).toHaveAttribute("data-x-scale", "log10");
  await check(scatter).toContainText("32,768 valid rows");
  await check(scatter).toContainText("20,000");
  const exportButton = scatter.getByRole("button", { name: "Export chart image", exact: true });
  const menu = page.getByRole("dialog", { name: "Export chart image", exact: true });
  const svgOptions = page.getByRole("dialog", { name: "Save chart as SVG", exact: true });
  const outputDir = await fs.mkdtemp(path.join(scratch, "images-"));

  await exportButton.click();
  await check(menu).toBeVisible();
  await page.screenshot({ path: path.join(scratch, "image-menu.png") });

  const pngPath = path.join(outputDir, "scatter.png");
  async function saveNative(action, format, destination, overwrite) {
    const [dialog] = await Promise.all([
      operateOwnedSaveDialog(powershell, {
        pid: owned.pid, title: `Save chart as ${format}`, destination, overwrite,
      }),
      action.click(),
    ]);
    assert.equal(dialog.saved, Boolean(destination));
    if (destination) {
      await poll(() => fs.stat(destination).then(() => true, () => false), Boolean, 45_000);
      await check(scatter).toContainText("Chart image saved.");
    }
  }

  await saveNative(menu.getByRole("button", { name: "Save PNG", exact: true }), "PNG", pngPath);
  const png = await fs.readFile(pngPath);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const pngSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  const plot = scatter.getByRole("img", { name: `${title} plot`, exact: true });
  const size = await plot.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  assert.equal(pngSize.width, size.width * 2);
  assert.ok(pngSize.height > size.height * 2);
  await exportButton.click();
  await saveNative(menu.getByRole("button", { name: "Save PNG", exact: true }), "PNG", "");
  assert.deepEqual(await fs.readFile(pngPath), png);
  await fs.writeFile(pngPath, "previous image");
  await exportButton.click();
  await saveNative(menu.getByRole("button", { name: "Save PNG", exact: true }), "PNG", pngPath, "accept");
  assert.equal((await fs.readFile(pngPath)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  async function saveSvg(filename, pointRange, viewRange) {
    const destination = path.join(outputDir, filename);
    await exportButton.click();
    await menu.getByRole("button", { name: "Save SVG", exact: true }).click();
    await check(svgOptions).toBeVisible();
    if (pointRange) {
      await svgOptions.getByRole("radio", { name: pointRange, exact: true }).check();
    } else {
      await check(svgOptions.getByRole("radio", { name: "All valid points", exact: true })).toHaveCount(0);
    }
    await svgOptions.getByRole("radio", { name: viewRange, exact: true }).check();
    if (pointRange === "All valid points" && viewRange === "Current zoom") {
      await page.screenshot({ path: path.join(scratch, "svg-options.png") });
    }
    await saveNative(svgOptions.getByRole("button", { name: "Save SVG", exact: true }), "SVG", destination);
    const svg = await fs.readFile(destination, "utf8");
    const parsed = await page.evaluate((text) => {
      const document = new DOMParser().parseFromString(text, "image/svg+xml");
      return {
        valid: !document.querySelector("parsererror") && document.documentElement.localName === "svg",
        title: document.documentElement.textContent,
        vectors: document.querySelectorAll("path, circle, ellipse, line, rect").length,
        all: document.querySelectorAll('g[data-chart-points="all"] circle').length,
        active: document.querySelectorAll("script, image, foreignObject, style").length,
      };
    }, svg);
    assert.equal(parsed.valid, true);
    assert.ok(parsed.title.includes(title));
    assert.ok(parsed.vectors > 0);
    assert.equal(parsed.active, 0);
    return { bytes: Buffer.byteLength(svg), ...parsed };
  }

  const shown = await saveSvg("displayed.svg", "Displayed points", "Entire chart");
  assert.equal(shown.all, 0);
  assert.ok(shown.vectors >= 20_000 && shown.vectors < 21_000);
  const full = await saveSvg("all.svg", "All valid points", "Entire chart");
  assert.equal(full.all, 32_768);
  await scatter.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoom = await saveSvg("zoom.svg", "All valid points", "Current zoom");
  assert.ok(zoom.all > 0 && zoom.all < full.all);
  await exportButton.click();
  const clipboard = await verifyImageClipboard(pngSize, async () => {
    await menu.getByRole("button", { name: "Copy image", exact: true }).click();
    await check(scatter).toContainText("Chart image copied.");
  });
  assert.deepEqual(pngSize, clipboard);
  await combo(charts(), "Chart type").selectOption({ label: "Histogram" });
  await check(scatter).toContainText(/\d+ bins/);
  const histogram = await saveSvg("histogram.svg", null, "Entire chart");
  assert.equal(histogram.all, 0);
  return {
    clipboard,
    pngBytes: png.length,
    displayedVectorElements: shown.vectors,
    allPoints: full.all,
    zoomPoints: zoom.all,
    allSvgBytes: full.bytes,
    histogramVectorElements: histogram.vectors,
  };
}

async function chartImageNativeTransaction() {
  const rowCount = 500_000;
  const [orders] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const result = await runIpc(
    `SELECT CAST(i AS DOUBLE) AS x, CAST(i AS DOUBLE) AS y FROM range(${rowCount}) t(i)`,
    [{ ...orders, alias: "orders", columnMode: "name" }],
  );
  const directory = await fs.mkdtemp(path.join(scratch, "cancelled-"));
  const destination = path.join(directory, "existing.svg");
  const original = '<svg xmlns="http://www.w3.org/2000/svg"><title>Previous export</title></svg>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"></svg>';
  const requestId = `p24-svg-cancel-${randomUUID()}`;
  await fs.writeFile(destination, original);

  async function saveThroughChannel(request, cancelId) {
    return page.evaluate(async ({ request, cancelId }) => {
      const tauri = window.__TAURI_INTERNALS__;
      const observed = [];
      let cancelled;
      const id = tauri.transformCallback(({ message }) => {
        if (!message) return;
        observed.push(message);
        if (cancelId && !cancelled && message.scannedRows >= 2048) {
          cancelled = tauri.invoke("cancel_chart", { requestId: cancelId });
        }
      });
      try {
        const saved = await tauri.invoke("save_chart_image", { request, progress: `__CHANNEL__:${id}` });
        return { saved, observed };
      } catch (error) {
        await cancelled;
        return { error, observed };
      } finally {
        tauri.unregisterCallback(id);
      }
    }, { request, cancelId });
  }

  try {
    const unsafe = await saveThroughChannel({
      title: "unsafe",
      image: { kind: "svg", data: svg.replace("</svg>", '<script>throw Error()</script></svg>') },
    });
    assert.equal(unsafe.error?.code, "InvalidRequest", JSON.stringify(unsafe));

    const [dialog, completed] = await Promise.all([
      operateOwnedSaveDialog(powershell, {
        pid: owned.pid, title: "Save chart as SVG", destination, overwrite: "accept",
      }),
      saveThroughChannel({
        title: "cancel",
        image: {
          kind: "svg",
          data: svg,
          scatter: {
            chart: { requestId, source: { kind: "sql", ...result }, kind: "scatter", x: "r0", y: "r1" },
            frame: {
              xMin: 0, xMax: rowCount - 1, yMin: 0, yMax: rowCount - 1,
              left: 20, top: 20, width: 360, height: 200, radius: 2,
            },
          },
        },
      }, requestId),
    ]);
    assert.equal(dialog.saved, true);
    assert.equal(completed.error?.code, "TaskCancelled", JSON.stringify(completed));
    const { scannedRows, writtenPoints } = completed.observed.at(-1);
    assert.ok(scannedRows >= 2048 && scannedRows < rowCount);
    assert.equal(writtenPoints, scannedRows);
    assert.equal(await fs.readFile(destination, "utf8"), original);
    assert.deepEqual(await fs.readdir(directory), ["existing.svg"]);
    return { scannedRows, writtenPoints, priorFilePreserved: true };
  } finally {
    await invoke("release_sql_result", result);
  }
}

const analyticalSql =
  "SELECT CAST(i // 2 AS DOUBLE) AS step, CAST(CASE WHEN i = 19 THEN 100 ELSE 10 END AS DOUBLE) AS amount, 'Group' AS category, 'id-' || i AS item_id FROM range(20) t(i) ORDER BY i";

async function chartAnalysisIpc() {
  const [orders] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const tables = [{ ...orders, alias: "orders", columnMode: "name" }];
  async function usingResult(statement, checkResult) {
    const ids = await runIpc(statement, tables);
    try {
      return await checkResult((options) => invoke("compute_chart", {
        request: { requestId: `p24-analysis-${randomUUID()}`, source: { kind: "sql", ...ids }, ...options },
      }));
    } finally {
      await invoke("release_sql_result", ids);
    }
  }

  const details = await usingResult(analyticalSql, async (request) => {
    const scatter = await request({ kind: "scatter", x: "r0", y: "r1", scatterLabel: "r3" });
    assert.equal(scatter.pointDetails.length, 20);
    assert.equal(scatter.pointDetails[19].label, "id-19");
    assert.equal(scatter.pointDetails[19].row, 20);
    assert.equal(Number(scatter.pointDetails[19].y), 100);
    const line = await request({ kind: "line", x: "r0", y: "r1", line: { aggregate: "mean" } });
    assert.equal(line.points.length, 10);
    assert.deepEqual(line.points.at(-1), [9, 55]);
    const histogram = await request({
      kind: "histogram", x: "r1", histogram: { mode: "count", count: 2 }, histogramRange: { min: 0, max: 20 },
    });
    assert.deepEqual(histogram.histogramOutside, { below: 0, above: 1 });
    assert.deepEqual(histogram.bins, [{ start: 0, end: 10, count: 0 }, { start: 10, end: 20, count: 19 }]);
    for (const kind of ["box", "violin"]) {
      const distribution = await request({ kind, x: "r2", y: "r1", ...(kind === "box" ? { whiskers: "iqr" } : {}) });
      const [group] = distribution.groups;
      assert.deepEqual(group.summary, [10, 10, 10, 10, 100]);
      assert.deepEqual(group.whiskers, [10, 10]);
      assert.equal(group.sampleCount, 20);
      assert.equal(group.outlierCount, 1);
      assert.deepEqual(group.outliers, [100]);
    }
    return { pointDetails: scatter.pointDetails.length, lineBuckets: line.points.length };
  });

  const bar = await usingResult(
    "SELECT CASE WHEN i >= 40 THEN 'Winner' ELSE 'Early-' || i END AS category, CASE WHEN i >= 40 THEN 20 ELSE 1 END AS amount FROM range(45) t(i) ORDER BY i",
    (request) => request({ kind: "bar", x: "r0", y: "r1", bar: { aggregate: "sum", sort: "desc", limit: 1 } }),
  );
  assert.equal(bar.groupCount, 41);
  assert.equal(bar.barTotal, 140);
  assert.equal(bar.groups[0].label, "Winner");
  assert.equal(bar.groups[0].value, 100);
  return { ...details, groups: bar.groupCount };
}

async function chartAnalysisUi() {
  await openWorkspace("SQL");
  await run(analyticalSql, 20);
  await openWorkspace("Charts");
  const scatter = await typeChart("Analytical scatter", "Scatter", { "X axis": "step", "Y axis": "amount" }, /Query 1/);
  const plot = scatter.getByRole("img", { name: "Analytical scatter plot" });
  const bounds = await plot.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.62, { steps: 8 });
  await check(scatter.locator("[data-zoom-selection]")).toBeVisible();
  await page.screenshot({ path: path.join(scratch, "rectangle-desktop.png") });
  await page.mouse.up();
  await check(scatter.locator("[data-zoom-selection]")).toHaveCount(0);
  const reset = scatter.getByRole("button", { name: "Reset zoom", exact: true });
  await check(reset).toBeEnabled();
  await check(scatter).toContainText("20 valid rows");
  await reset.click();
  await check(reset).toBeDisabled();
  const violin = await typeChart("Unit price distribution", "Violin", { Group: "category", Value: "amount" }, /Query 1/);
  await check(violin).toContainText("20 valid rows");
  await page.screenshot({ path: path.join(scratch, "native-desktop.png") });
}

async function analyticalScatterScale(rowCount) {
  const fileName = `scale-${rowCount}.parquet`;
  const [identity] = await openSources([path.join(fixtureDir, fileName)]);
  const before = await sampleProcess();
  const started = performance.now();
  const data = await invoke("compute_chart", {
    request: {
      requestId: `p24-analysis-scale-${randomUUID()}`, source: { kind: "file", ...identity },
      kind: "scatter", x: "unit_price", y: "quantity", scatterLabel: "category",
    },
  });
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(data.validRows, rowCount);
  assert.equal(data.points.length, 20_000);
  assert.equal(data.pointDetails.length, 20_000);
  assert.equal(data.sampled, true);
  const bytes = Buffer.byteLength(JSON.stringify(data));
  assert.ok(bytes < 4 * 1024 * 1024);
  const after = await sampleProcess();
  let render;
  let cancelledMs;
  if (rowCount === 1_000_000) {
    const requestId = `p24-analysis-cancel-${randomUUID()}`;
    const cancelStarted = performance.now();
    const cancelled = assert.rejects(
      compute({ kind: "file", ...identity }, "scatter", "unit_price", "quantity", requestId),
      /cancel/i,
    );
    await invoke("cancel_chart", { requestId });
    await cancelled;
    cancelledMs = Math.round(performance.now() - cancelStarted);
    await openWorkspace("Charts");
    const renderStarted = performance.now();
    const scatter = await typeChart("Million-row scatter", "Scatter", {
      "X axis": "unit_price", "Y axis": "quantity",
    }, fileName);
    await check(scatter).toContainText("1,000,000 valid rows");
    await check(scatter).toContainText("20,000 points displayed");
    const configureToCanvasMs = Math.round(performance.now() - renderStarted);
    const zoomStarted = performance.now();
    await scatter.getByRole("button", { name: "Zoom in", exact: true }).click();
    await check(scatter.getByRole("button", { name: "Reset zoom", exact: true })).toBeEnabled();
    render = { configureToCanvasMs, zoomInteractionMs: Math.round(performance.now() - zoomStarted) };
  }
  return { rows: rowCount, points: data.points.length, elapsedMs, bytes, before, after, render, cancelledMs };
}

async function pinAndSnapshot(golden) {
  const [orders] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const result = await runIpc(categoriesSql("01"), [{ ...orders, alias: "orders", columnMode: "name" }]);
  const ids = { ...result, viewId: `p24-view-${randomUUID()}` };
  const projection = ["r0", "r1", "r2"];
  const plan = {
    projection,
    filters: [{ id: "filter:r2", columnId: "r2", scalarType: "number", operator: "greaterThanOrEqual", values: [String(golden.minOrdinal)] }],
    search: null,
    sort: [{ columnId: "r2", direction: "descending", nullsLast: true }],
  };
  await invoke("start_sql_result_view", { ...ids, plan });
  const view = await poll(() => invoke("get_sql_result_view_status", ids),
    (status) => ["complete", "cancelled", "failed"].includes(status.state));
  assert.equal(view.state, "complete", JSON.stringify(view));
  assert.equal(view.progress.resultRows, golden.filteredRows);

  const blockId = `p24-block-${randomUUID()}`;
  const source = { kind: "sql", ...ids };
  const selection = { rowStart: 0, rowEndExclusive: golden.selectedRows, columnIds: ["r2", "r1", "r0"] };
  await assert.rejects(invoke("capture_chart_selection", {
    request: { requestId: blockId, source, selection: { ...selection, rowEndExclusive: 100_001, columnIds: ["r2"] } },
  }), /100.000 cells/);
  await invoke("capture_chart_selection", { request: { requestId: blockId, source, selection } });
  await invoke("release_sql_result_view", ids);
  const staleBlockId = `p24-stale-block-${randomUUID()}`;
  await assert.rejects(invoke("capture_chart_selection", {
    request: { requestId: staleBlockId, source, selection },
  }));
  await assert.rejects(compute({ kind: "block", blockId: staleBlockId }, "box", "r0", "r1"));
  await invoke("retain_chart_sql_result", result);
  await invoke("release_sql_result", result);
  const held = await compute({ kind: "sql", ...result }, "box", "r0", "r1");
  assert.equal(held.validRows, 320);
  await invoke("release_chart_sql_result", result);
  await assert.rejects(compute({ kind: "sql", ...result }, "box", "r0", "r1"));
  const blockSource = { kind: "block", blockId };
  const ordered = await compute(blockSource, "scatter", "r2", "r1");
  assert.deepEqual(ordered.points.map(([x]) => x),
    Array.from({ length: golden.selectedRows }, (_, i) => golden.firstOrdinal - i));
  const chart = await compute(blockSource, "box", "r0", "r1");
  assert.equal(chart.totalRows, golden.selectedRows);
  assert.equal(chart.validRows, golden.selectedRows);
  assert.equal(chart.groups.length, Object.keys(golden.groups).length);
  for (const group of chart.groups) {
    const expected = golden.groups[group.label];
    assert.ok(expected);
    assert.equal(group.count, expected.count);
    assert.ok(Math.abs(group.summary[2] * 100 - expected.medianCents) < 1e-6);
  }
  await invoke("release_chart_block", { blockId });
  await assert.rejects(compute(blockSource, "box", "r0", "r1"));
  return { groups: chart.groups, selectedRows: chart.validRows, released: true, retainedSqlRows: held.validRows };
}

async function fileViewSnapshot(golden) {
  const [orders] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const ids = { ...orders, queryId: `p24-file-view-${randomUUID()}`, taskId: `p24-file-task-${randomUUID()}` };
  const request = {
    ...ids,
    plan: {
      filters: [
        { id: "filter:month", columnId: "month", scalarType: "text", operator: "equals", values: [golden.month] },
        { id: "filter:ordinal", columnId: "ordinal", scalarType: "number", operator: "greaterThanOrEqual", values: [String(golden.minOrdinal)] },
      ],
      search: null,
      sort: [{ columnId: "ordinal", direction: "descending", nullsLast: true }],
      projection: ["amount", "ordinal"],
    },
  };
  await invoke("execute_query", { request });
  const view = await poll(() => invoke("get_query_status", ids),
    (status) => ["complete", "cancelled", "failed"].includes(status.state));
  assert.equal(view.state, "complete", JSON.stringify(view));
  assert.equal(view.progress.resultRows, golden.filteredRows);
  const blockId = `p24-file-block-${randomUUID()}`;
  await invoke("capture_chart_selection", {
    request: {
      requestId: blockId,
      source: { kind: "file", ...orders, queryId: ids.queryId },
      selection: { rowStart: 0, rowEndExclusive: golden.selectedRows, columnIds: ["amount", "ordinal"] },
    },
  });
  try {
    const chart = await compute({ kind: "block", blockId }, "scatter", "ordinal", "amount");
    assert.deepEqual(chart.points.map(([x]) => x),
      Array.from({ length: golden.selectedRows }, (_, i) => golden.firstOrdinal - i));
    return { selectedRows: chart.validRows, first: chart.points[0], last: chart.points.at(-1) };
  } finally {
    await invoke("release_chart_block", { blockId });
  }
}

async function typedCoordinates(golden) {
  const [identity] = await openSources([path.join(fixtureDir, "precision.parquet")]);
  const source = { kind: "file", ...identity };
  const integer = await compute(source, "scatter", "sequence", "amount");
  assert.equal(integer.validRows, golden.rows);
  assert.equal(integer.xOrigin, golden.sequenceOrigin);
  assert.equal(integer.yOrigin, golden.decimalOrigin);
  assert.equal(integer.points.length, golden.rows);
  for (const [index, [x, y]] of integer.points.entries()) {
    assert.equal(x, index);
    assert.ok(Math.abs(y - index / 1e6) < 1e-15);
  }
  const nanos = await compute(source, "scatter", "at", "measure");
  assert.equal(nanos.validRows, golden.finiteMeasures);
  assert.equal(nanos.excludedRows, golden.rows - golden.finiteMeasures);
  assert.equal(nanos.xUnit, "ns");
  assert.deepEqual(nanos.points, [[0, 0], [1, 1], [2, -1]]);
  return { integer, nanos };
}

async function distributionTotals(golden) {
  const [identity] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const source = { kind: "file", ...identity };
  const histogram = await compute(source, "histogram", "amount");
  assert.equal(histogram.validRows, 2 * golden.monthRows);
  assert.equal(histogram.bins.reduce((sum, bin) => sum + bin.count, 0), histogram.validRows);
  assert.ok(Math.abs(histogram.bins[0].start * 100 - golden.minCents) < 1e-6);
  assert.ok(Math.abs(histogram.bins.at(-1).end * 100 - golden.maxCents) < 1e-6);
  const bars = await compute(source, "bar", "category", "amount");
  assert.equal(bars.groups.length, Object.keys(golden.groups).length);
  for (const group of bars.groups) {
    const expected = golden.groups[group.label];
    assert.ok(expected);
    assert.equal(group.count, expected.count);
    assert.ok(Math.abs(group.value * 100 - expected.sumCents) < 1e-5);
  }
  return { histogramBins: histogram.bins.length, groups: bars.groups };
}

async function distributionEdges() {
  const [orders] = await openSources([path.join(fixtureDir, "orders.parquet")]);
  const ids = await runIpc(
    "SELECT i AS x, 3 AS y, CAST(i % 40 AS VARCHAR) AS category FROM range(20001) t(i) ORDER BY i",
    [{ ...orders, alias: "orders", columnMode: "name" }],
  );
  const source = { kind: "sql", ...ids };
  try {
    const sample = await compute(source, "scatter", "r0", "r1");
    const again = await compute(source, "scatter", "r0", "r1");
    assert.equal(sample.validRows, 20_001);
    assert.equal(sample.points.length, 20_000);
    assert.equal(sample.sampled, true);
    assert.deepEqual(sample.points, again.points);
    const groups = await compute(source, "violin", "r2", "r1");
    assert.equal(groups.validRows, 16_001);
    assert.equal(groups.excludedRows, 4_000);
    assert.equal(groups.groupsTruncated, true);
    assert.equal(groups.groups.length, 32);
    for (const group of groups.groups) {
      assert.deepEqual(group.summary, [3, 3, 3, 3, 3]);
      assert.equal(group.density, undefined);
    }
    const empty = await invoke("compute_chart", {
      request: {
        requestId: `p24-empty-${randomUUID()}`, source, kind: "scatter",
        x: "r0", y: "r1", filter: { columnId: "r2", equals: "unmatched" },
      },
    });
    assert.equal(empty.validRows, 0);
    assert.equal(empty.filteredRows, 20_001);
    assert.deepEqual(empty.points, []);
    return { deterministicPoints: sample.points.length, constantGroups: groups.groups.length,
      excludedGroupsRows: groups.excludedRows, emptyRows: empty.validRows };
  } finally {
    await invoke("release_sql_result", ids);
  }
}

async function commerceJoin() {
  const directory = path.join(root, "fixtures/phase-22/commerce");
  const inputs = [["orders.csv", "orders"], ["customers.parquet", "customers"], ["order_items.parquet", "order_items"]];
  const documents = await openSources(inputs.map(([filename]) => path.join(directory, filename)));
  const csv = await poll(() => invoke("get_csv_preparation_status", documents[0]),
    (status) => ["ready", "cancelled", "failed"].includes(status?.state), 300_000);
  assert.equal(csv.state, "ready", JSON.stringify(csv));
  const tables = documents.map((document, i) => ({ ...document, alias: inputs[i][1], columnMode: "name" }));
  const result = await runIpc(
    `SELECT i.category, i.line_total_krw
     FROM orders o JOIN customers c ON c.customer_id = o.customer_id
     JOIN order_items i ON i.order_id = o.order_id
     WHERE i.category IN ('식품', '스포츠') AND i.quantity > 1`,
    tables,
  );
  try {
    const start = performance.now();
    const data = await compute({ kind: "sql", ...result }, "violin", "r0", "r1");
    assert.ok(data.validRows >= 100_000, "The commerce data must exercise a large materialized result.");
    assert.equal(data.groups.length, 2);
    return { elapsedMs: Math.round(performance.now() - start), validRows: data.validRows,
      payloadBytes: Buffer.byteLength(JSON.stringify(data)), groups: data.groups.length, sampled: data.sampled };
  } finally {
    await invoke("release_sql_result", result);
  }
}

async function fileScale(rowCount) {
  const key = `scale-${rowCount}.parquet`;
  const title = `Scale ${rowCount}`;
  const file = new RegExp(`${key.replace(".", "\\.")}$`);
  const before = await sampleProcess();
  const started = performance.now();
  const chart = await typeChart(title, "Scatter", { "X axis": "unit_price", "Y axis": "quantity" }, file);
  const configureToCanvasMs = Math.round(performance.now() - started);
  const status = await chart.innerText();
  assert.match(status, new RegExp(rowCount.toLocaleString("en-US") + " valid"));
  const after = await sampleProcess();
  const [identity] = await openSources([path.join(fixtureDir, key)]);
  const source = { kind: "file", ...identity };
  const computeStart = performance.now();
  const result = await compute(source, "scatter", "unit_price", "quantity");
  const ipcComputeMs = Math.round(performance.now() - computeStart);
  assert.equal(result.validRows, rowCount);
  assert.equal(result.points.length, Math.min(rowCount, 20_000));
  let cancelledMs;
  if (rowCount === 1_000_000) {
    const requestId = `p24-cancel-${randomUUID()}`;
    const begin = performance.now();
    const job = assert.rejects(compute(source, "scatter", "unit_price", "quantity", requestId), /cancel/i);
    await invoke("cancel_chart", { requestId });
    await job;
    cancelledMs = Math.round(performance.now() - begin);
  }
  return { rows: rowCount, configureToCanvasMs, ipcComputeMs, before, after, status, points: result.points.length,
    sampled: result.sampled, payloadBytes: Buffer.byteLength(JSON.stringify(result)), cancelledMs };
}

try {
  await fs.mkdir(scratch, { recursive: true });
  const golden = JSON.parse(await fs.readFile(path.join(fixtureDir, "golden.json"), "utf8"));
  const fileNames = ["orders.parquet", "precision.parquet"];
  if (process.env.P24_SCALE === "1") {
    fileNames.push("scale-10000.parquet", "scale-100000.parquet", "scale-1000000.parquet");
  } else if (chartAnalysis) {
    fileNames.push("scale-100000.parquet", "scale-1000000.parquet");
  }
  const files = fileNames.map((name) => path.join(fixtureDir, name));
  for (const file of files) {
    const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    assert.equal(hash, golden.files[path.basename(file)].sha256, `Fixture changed: ${file}`);
  }
  await launch(chartFollowup || chartSourceOnly ? [orderItems] : files);
  const bytes = await fs.readFile(binary);
  report.executable = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (sqlGridNavigation) {
    await record("T-P24-030 SQL result keyboard and Tables tooltip in WebView2", sqlGridKeyboard);
  } else if (chartImageExport) {
    if (!chartTransactionOnly) {
      await record("T-P24-023/024 Windows chart image copy and save", chartImageExportUi);
    }
    await record("T-P24-025/026 Windows cancellation and image destination safety", chartImageNativeTransaction);
  } else if (cteCompletion) {
    await record("SQL CTE completion and tab naming in WebView2", sqlEditorFeatures);
  } else if (chartAnalysis) {
    await record("T-P24-017/018/019/020 analytical chart IPC", chartAnalysisIpc);
    await record("T-P24-016/021 rectangle zoom in WebView2", chartAnalysisUi);
    for (const rows of [100_000, 1_000_000]) {
      await record(`T-P24-021 bounded scatter on ${rows} rows`, () => analyticalScatterScale(rows));
    }
  } else if (chartFollowup) {
    await record("Phase 24 chart follow-up", chartFollowupScenario);
  } else if (chartSourceOnly) {
    await record("Phase 24 whole category counts on the unchanged native backend", wholeCategoryCounts);
  } else if (chartOptions) {
    await record("T-P24-010/011/012 chart options through native IPC", chartOptionsIpc);
    await record("T-P24-015 chart options in WebView2", chartOptionsUi);
  } else if (!commerceOnly && !launchOnly) {
    await exercise(golden);
    await record("T-P24-002/004 pin, exact groups, cleanup", () => pinAndSnapshot(golden.sqlSelection));
    await record("T-P24-004 exact filtered file block", () => fileViewSnapshot(golden.sqlSelection));
    await record("T-P24-005 typed precision", () => typedCoordinates(golden.precision));
    await record("T-P24-005 histogram and bar totals", () => distributionTotals(golden.orders));
    if (requireProduct) {
      await record("T-P24-005 sampled, constant and empty results", distributionEdges);
      await record("T-P24-010/011/012 chart options through native IPC", chartOptionsIpc);
      await record("T-P24-015 chart options in WebView2", chartOptionsUi);
    }
    if (process.env.P24_SCALE === "1") {
      for (const rows of [10_000, 100_000, 1_000_000]) await record(`T-P24-008 ${rows} rows`, () => fileScale(rows));
    }
  }
  if (commerceOnly || process.env.P24_SCALE === "1") {
    await record("T-P24-008 commerce JOIN", commerceJoin);
  }
  await record("T-P24-007 WebView2 diagnostics", async () => {
    assert.deepEqual(report.consoleErrors, []);
    return { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })) };
  });
  report.state = "pass";
} catch (error) {
  report.state = "fail";
  report.error = error.stack ?? String(error);
  if (page) await page.screenshot({ path: path.join(scratch, "failure.png") }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try {
    await stop();
  } catch (error) {
    report.state = "fail";
    report.cleanupError = error.stack ?? String(error);
    process.exitCode = 1;
  }
  await fs.writeFile(path.join(scratch, "results.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
}
