// Phase 23 acceptance runs only against the isolated candidate and fixture.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { operateOwnedSaveDialog } from "./native_owned_save_dialog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const exportOverwrite = process.argv.includes("--export-overwrite");
const productSmoke = process.argv.includes("--product-smoke");
const precisionFollowup = process.argv.includes("--timestamp-precision");
const storageDraft = process.argv.includes("--storage-draft");
const storageBaseline = process.argv.includes("--storage-baseline");
const timestampFollowup = process.argv.includes("--timestamp-followup") || storageDraft || storageBaseline;
const scratch = path.join(root, exportOverwrite ? ".tmp/phase23-export-overwrite"
  : productSmoke ? ".tmp/phase23-product-smoke"
  : storageDraft ? (precisionFollowup ? ".tmp/phase23-storage-precision" : ".tmp/phase23-storage-draft")
  : storageBaseline ? ".tmp/phase23-storage-baseline"
  : precisionFollowup ? ".tmp/phase23-timestamp-precision-check"
  : timestampFollowup ? ".tmp/phase23-timestamp-native" : ".tmp/phase23/native");
const binary = path.join(root, "src-tauri/target/release/candidates",
  exportOverwrite ? "phase-23-export-overwrite" : productSmoke ? "phase-23" : storageDraft ? "phase-23-storage-draft"
  : storageBaseline ? "phase-23-timestamp-precision"
  : precisionFollowup ? "phase-23-timestamp-precision" : "phase-23-native", "data-viewer.exe");
const identifier = productSmoke ? "com.denrew88.data-viewer" : "com.denrew88.data-viewer-phase23-acceptance";
const fixture = (name) => path.join(root, "fixtures/phase-23", name);
const inputCsv = exportOverwrite ? path.join(scratch, "input.csv") : fixture("input.csv");
const commerceFiles = ["customers.parquet", "orders.csv", "order_items.parquet"];
const precisionCsv = path.join(scratch, "timestamp-nanos.csv");
const startupFiles = productSmoke ? [] : precisionFollowup ? [precisionCsv] : timestampFollowup
  ? commerceFiles.map((name) => path.join(root, "fixtures/phase-22/commerce", name))
  : [inputCsv];
const webviewPort = 9513;
const runFile = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (status) => ["complete", "cancelled", "failed"].includes(status.state);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const report = { status: "RUNNING", startedAt: new Date().toISOString(), binary, identifier, checks: [] };
const sql = await fs.readFile(fixture("results.sql"), "utf8");
const golden = JSON.parse(await fs.readFile(fixture("golden.json"), "utf8"));
const keyBase = 9007199254740992n;
const columns = ["r0", "r1", "r2", "r3", "r4", "r5", "r6"];
const initialPlan = {
  filters: [{
    id: "filter:r1", columnId: "r1", scalarType: "text", operator: "equals",
    values: [golden.filter.value],
  }],
  search: null,
  sort: golden.sort,
  projection: columns,
};
let owned, browser, page, originalClipboard, document, sqlResult;

async function powershell(script, env = {}) {
  const prelude = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$ErrorActionPreference='Stop'\n";
  const { stdout } = await runFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", prelude + script], {
    windowsHide: true, timeout: 30_000, env: { ...process.env, ...env },
  });
  return stdout.trim();
}

async function poll(read, ready, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (ready(result)) return result;
    await sleep(50);
  }
  throw new Error("Native SQL Results acceptance timed out.");
}

async function invoke(command, args = {}) {
  const response = await page.evaluate(async ({ command, args }) => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
    } catch (error) {
      return { ok: false, error };
    }
  }, { command, args });
  if (!response.ok) throw new Error(`${command}: ${JSON.stringify(response.error)}`);
  return response.value;
}

function readClipboard() {
  return powershell("ConvertTo-Json -InputObject (Get-Clipboard -Raw) -Compress").then(JSON.parse);
}

async function launch() {
  owned = JSON.parse(await powershell(`
$arguments=@((ConvertFrom-Json $env:P23_FIXTURES) | ForEach-Object { '"'+$_+'"' })
$launch=@{FilePath=$env:P23_BINARY;WorkingDirectory=$env:P23_ROOT;WindowStyle='Hidden';PassThru=$true}
if($arguments.Count -gt 0){$launch.ArgumentList=$arguments}
$p=Start-Process @launch
[pscustomobject]@{pid=$p.Id;path=$p.Path;ticks=$p.StartTime.Ticks.ToString()} | ConvertTo-Json -Compress
`, {
    P23_BINARY: binary,
    P23_FIXTURES: JSON.stringify(startupFiles),
    P23_ROOT: root,
    WEBVIEW2_USER_DATA_FOLDER: path.join(scratch, `webview-${process.pid}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${webviewPort}`,
  }));
  report.process = owned;
  browser = await poll(async () => {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${webviewPort}`, { timeout: 1500 });
    } catch {
      return null;
    }
  }, Boolean, 45_000);
  page = await poll(
    () => browser.contexts().flatMap((context) => context.pages())
      .find((entry) => entry.url().includes("tauri.localhost")),
    Boolean,
    15_000,
  );
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === "function");
  assert.equal(await invoke("plugin:app|identifier"), identifier);
  report.health = await invoke("health_check");
  assert.equal(report.health.appVersion, "0.23.0");
  if (!productSmoke) assert.ok((await invoke("get_query_temp_usage")).csvCachePath.includes(identifier));
  for (const file of startupFiles) {
    const name = path.basename(file);
    await page.getByRole("button", { name: `Close ${name}`, exact: true }).waitFor();
  }
}

async function stop() {
  await browser?.close().catch(() => {});
  if (!owned) return;
  await powershell(`
$p=Get-Process -Id ([int]$env:P23_PID) -ErrorAction SilentlyContinue
if($p) {
  if(-not [string]::Equals([IO.Path]::GetFullPath($p.Path),[IO.Path]::GetFullPath($env:P23_BINARY),[StringComparison]::OrdinalIgnoreCase)) { throw 'Unowned PID path' }
  if($p.StartTime.Ticks.ToString() -ne $env:P23_TICKS) { throw 'Reused PID' }
  Stop-Process -Id $p.Id
  if(-not $p.WaitForExit(3000)) { throw 'Owned process did not stop' }
}
`, { P23_PID: String(owned.pid), P23_BINARY: binary, P23_TICKS: owned.ticks });
}

async function check(name, verify) {
  const start = Date.now();
  try {
    const details = await verify();
    report.checks.push({ name, status: "PASS", elapsedMs: Date.now() - start, ...details });
  } catch (error) {
    report.checks.push({ name, status: "FAIL", elapsedMs: Date.now() - start, error: error.stack ?? String(error) });
  }
  console.log(JSON.stringify(report.checks.at(-1)));
}

function raw(value) {
  return value.rawDisplay ?? value.sourceDisplay ?? value.display;
}

const sourceOffset = (rowKey) => Number(BigInt(rowKey) - keyBase);

async function readView(ids, offset, limit, projection = columns) {
  const { runId, resultId, viewId } = ids;
  return invoke("read_sql_query_page", {
    request: { runId, resultId, offset, limit, columns: projection },
    ...(viewId && { viewId }),
  });
}

async function startView(result, plan) {
  const ids = { ...result, viewId: `p23-view-${randomUUID()}` };
  await invoke("start_sql_result_view", { ...ids, plan });
  const status = await poll(() => invoke("get_sql_result_view_status", ids), terminal);
  assert.equal(status.state, "complete", JSON.stringify(status));
  assert.equal(status.sessionId, result.resultId);
  assert.equal(status.queryId, ids.viewId);
  assert.equal(status.progress.resultRows, golden.filteredRows);
  return { ids, status };
}

async function runTypedResult() {
  const opened = await invoke("open_data_paths", {
    request: { requestId: `p23-open-${randomUUID()}`, origin: "startupArg", paths: [inputCsv] },
  });
  assert.deepEqual(opened.failures, []);
  const { documentId, sessionId } = opened.opened[0];
  document = { documentId, sessionId };
  const runId = `p23-run-${randomUUID()}`;
  await invoke("start_sql_query", {
    request: {
      runId, sql, action: "execute",
      tables: [{ ...document, alias: "input", columnMode: "name" }],
    },
  });
  const status = await poll(() => invoke("get_sql_query_status", { runId }), terminal);
  assert.equal(status.state, "complete", JSON.stringify(status));
  assert.equal(status.rowCount, golden.sqlRows);
  assert.deepEqual(status.columns.map(({ id }) => id), columns);
  return { runId, resultId: status.resultId };
}

async function checkTypedView(result) {
  const { ids, status } = await startView(result, initialPlan);
  try {
    const original = await readView(result, 0, 1, ["r0"]);
    assert.equal(sourceOffset(raw(original.rows[0][0])), 0);
    const first = await readView(ids, 0, 200, ["r0"]);
    const last = await readView(ids, 200, 200, ["r0"]);
    assert.equal(first.totalRows, golden.filteredRows);
    assert.equal(first.rows.length, 200);
    assert.equal(last.rows.length, 30);
    assert.equal(last.hasMore, false);
    const offsets = [...first.rows, ...last.rows].map(([key]) => sourceOffset(raw(key)));
    assert.deepEqual(offsets, golden.filteredSortedSourceOffsets);
    const position = offsets.indexOf(golden.rawSample.sourceOffset);
    const sample = (await readView(ids, position, 1, ["r0", "r3", "r4", "r6"])).rows[0].map(raw);
    assert.deepEqual(sample, [
      golden.rawSample.rowKey, golden.rawSample.amount,
      golden.rawSample.eventTimeRaw, golden.rawSample.detail,
    ]);
    await assert.rejects(readView({ ...ids, viewId: "p23-missing-view" }, 0, 1, ["r0"]));
    return { scanned: status.progress.rowsScanned, rows: offsets.length, last: offsets.at(-1), rawSample: sample };
  } finally {
    await invoke("release_sql_result_view", ids);
    await assert.rejects(readView(ids, 0, 1, ["r0"]));
  }
}

async function checkFind(result) {
  const observed = [];
  for (const caseSensitive of [false, true]) {
    const expected = caseSensitive ? golden.find.caseSensitivePositions : golden.find.caseInsensitivePositions;
    const { ids, status } = await startView(result, {
      ...initialPlan,
      search: {
        mode: "find", text: golden.find.text, caseSensitive, exact: true,
        targetColumnIds: [golden.find.columnId],
      },
    });
    try {
      assert.equal(status.findMatchCount, expected.length);
      const find = (direction, fromResultOffset, fromMatchIndex) => invoke("find_sql_result_view_match", {
        ...ids,
        request: {
          documentId: "sql-workspace", sessionId: ids.resultId, queryId: ids.viewId,
          direction, fromResultOffset, fromMatchIndex, wrap: true,
        },
      });
      let response = await find("next", 0, null);
      const positions = [];
      for (let index = 0; index < expected.length; index++) {
        const hit = response.match;
        assert.equal(hit.columnId, golden.find.columnId);
        positions.push(hit.rowOffset);
        response = await find("next", hit.rowOffset, hit.matchIndex);
      }
      assert.deepEqual(positions, expected);
      assert.equal(response.match.rowOffset, expected[0]);
      assert.equal(response.match.wrapped, true);
      const previous = await find("previous", response.match.rowOffset, response.match.matchIndex);
      assert.equal(previous.match.rowOffset, expected.at(-1));
      observed.push({ caseSensitive, positions });
    } finally {
      await invoke("release_sql_result_view", ids);
    }
  }
  return { observed };
}

async function checkClipboard(result) {
  const { ids } = await startView(result, initialPlan);
  try {
    const { copyLimits } = await invoke("get_settings");
    originalClipboard = await readClipboard();
    await invoke("plugin:clipboard-manager|write_text", { text: "Phase 23 clipboard probe" });
    const operationId = `p23-copy-${randomUUID()}`;
    const request = {
      operationId, documentId: "sql-workspace", sessionId: ids.resultId, queryId: ids.viewId,
      selection: { rowStart: 0, rowEndExclusive: golden.filteredRows, columnIds: columns },
      options: {
        delimiter: "\t", includeHeaders: true, quoteMode: "minimal", quoteCharacter: '"',
        escapeMode: "double", lineEnding: "crlf", nullRepresentation: "",
        emptyStringRepresentation: "empty", booleanRepresentation: "lowercase",
        dateTimeRepresentation: { mode: "display" }, representation: "rawCanonical",
      },
      maxCells: copyLimits.maxCells, maxBytes: copyLimits.maxBytes,
    };
    await invoke("start_sql_copy", { ...ids, request });
    const copy = await poll(() => invoke("get_copy_status", {
      request: { operationId, documentId: request.documentId, sessionId: request.sessionId },
    }), terminal);
    assert.equal(copy.state, "complete", JSON.stringify(copy));
    const text = await readClipboard();
    const lines = text.split(/\r?\n/);
    assert.equal(lines.shift(), "row_key\tgroup_name\tscore\tamount\tevent_time\tactive\tdetail");
    assert.deepEqual(lines.map((line) => sourceOffset(line.split("\t", 1)[0])), golden.filteredSortedSourceOffsets);
    const sample = lines.find((line) => line.startsWith(golden.rawSample.rowKey + "\t"));
    assert.ok(sample.includes(golden.rawSample.eventTimeRaw));
    return { rows: lines.length, sha256: hash(text) };
  } finally {
    await invoke("release_sql_result_view", ids);
  }
}

async function checkFileExports(result) {
  const { ids } = await startView(result, initialPlan);
  const saveDirectory = await fs.mkdtemp(path.join(scratch, "exports-"));
  const save = async (scope, format, label, destination, overwrite = "") => {
    const [saved, dialog] = await Promise.all([
      invoke("export_sql_result", { request: { ...scope, format } }),
      operateOwnedSaveDialog(powershell, {
        pid: owned.pid, title: `Export SQL result as ${label}`, destination, overwrite,
      }),
    ]);
    assert.equal(saved, Boolean(destination) && overwrite !== "decline");
    assert.equal(dialog.saved, saved);
  };
  const verifyText = async (file, delimiter, expected) => {
    const bytes = await fs.readFile(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString("utf8").split("\r\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.shift(), ["row_key", "group_name", "score", "amount", "event_time", "active", "detail"].join(delimiter));
    assert.deepEqual(lines.map((line) => sourceOffset(line.split(delimiter, 1)[0])), expected);
    const sample = lines.find((line) => line.startsWith(golden.rawSample.rowKey + delimiter));
    assert.ok(sample?.includes(golden.rawSample.eventTimeRaw));
    return { rows: lines.length, sha256: hash(bytes) };
  };
  try {
    await save(ids, "csv", "CSV", "");
    assert.equal((await readView(ids, 0, 1)).totalRows, golden.filteredRows);
    const files = {};
    for (const [format, delimiter] of [["csv", ","], ["tsv", "\t"]]) {
      const destination = path.join(saveDirectory, `view.${format}`);
      if (exportOverwrite) await fs.writeFile(destination, "prior export");
      await save(ids, format, format.toUpperCase(), destination, exportOverwrite ? "accept" : "");
      files[format] = await verifyText(destination, delimiter, golden.filteredSortedSourceOffsets);
    }
    const whole = path.join(saveDirectory, "whole.csv");
    if (exportOverwrite) {
      const fresh = path.join(saveDirectory, "fresh.csv");
      await save(result, "csv", "CSV", fresh);
      files.fresh = await verifyText(fresh, ",", Array.from({ length: golden.sqlRows }, (_, index) => index));
      await fs.writeFile(whole, "prior whole export");
      await save(result, "csv", "CSV", whole, "decline");
      assert.equal(await fs.readFile(whole, "utf8"), "prior whole export");
    }
    await save(result, "csv", "CSV", whole, exportOverwrite ? "accept" : "");
    files.whole = await verifyText(whole, ",", Array.from({ length: golden.sqlRows }, (_, index) => index));

    const parquet = path.join(saveDirectory, "view.parquet");
    if (exportOverwrite) await fs.writeFile(parquet, "prior parquet export");
    await save(ids, "parquet", "Parquet", parquet, exportOverwrite ? "accept" : "");
    const opened = await invoke("open_data_paths", {
      request: { requestId: `p23-parquet-${randomUUID()}`, origin: "startupArg", paths: [parquet] },
    });
    assert.deepEqual(opened.failures, []);
    const { documentId, sessionId, summary } = opened.opened[0];
    const parquetIdentity = { documentId, sessionId };
    try {
      assert.equal(summary.rowCount, golden.filteredRows);
      const names = summary.columns.map(({ name }) => name);
      assert.deepEqual(names, ["row_key", "group_name", "score", "amount", "event_time", "active", "detail"]);
      const read = (offset, limit, projection) => invoke("read_page", {
        request: { ...parquetIdentity, offset, limit, columns: projection },
      }).then(({ page }) => page);
      const first = await read(0, 200, ["row_key"]);
      const rest = await read(200, 200, ["row_key"]);
      const offsets = [...first.rows, ...rest.rows].map(([key]) => sourceOffset(raw(key)));
      assert.deepEqual(offsets, golden.filteredSortedSourceOffsets);
      const position = offsets.indexOf(golden.rawSample.sourceOffset);
      const sample = await read(position, 1, ["amount", "event_time"]);
      assert.deepEqual(sample.rows[0].map(raw), [golden.rawSample.amount, golden.rawSample.eventTimeRaw]);
      files.parquet = { rows: offsets.length, sha256: hash(await fs.readFile(parquet)) };
    } finally {
      await invoke("close_document", parquetIdentity);
    }
    assert.ok((await fs.readdir(saveDirectory)).every((name) => !name.startsWith(".data-viewer-export-")));
    return { saved: files, cancelled: true };
  } finally {
    await invoke("release_sql_result_view", ids);
  }
}

async function checkWorkspace() {
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  const results = workspace.getByRole("tabpanel", { name: "Results", exact: true });
  const editor = workspace.getByRole("textbox", { name: "SQL editor", exact: true });
  const grid = results.getByRole("grid", { name: "Data preview", exact: true });
  await editor.fill(sql);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await grid.waitFor({ timeout: 120_000 });
  assert.equal(await grid.getAttribute("aria-rowcount"), String(golden.sqlRows));
  const split = workspace.getByRole("separator", { name: "Resize query and output", exact: true });
  await split.focus();
  await split.press("Home");
  const query = workspace.locator(".sql-editing");
  const before = await query.boundingBox();
  const handle = await split.boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 5 });
  await page.mouse.up();
  const after = await query.boundingBox();
  const splitAfter = await split.boundingBox();
  const tabs = await workspace.getByRole("tablist", { name: "SQL output", exact: true }).boundingBox();
  assert.ok(after.height > before.height);
  assert.ok(after.y + after.height <= splitAfter.y + 1 && splitAfter.y + splitAfter.height <= tabs.y + 1);
  await results.getByRole("button", { name: "Filter group_name", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter group_name", exact: true });
  await filter.getByRole("combobox", { name: "Filter operator" }).selectOption("equals");
  await filter.getByRole("textbox", { name: "Value", exact: true }).fill(golden.filter.value);
  await filter.getByRole("button", { name: "Apply", exact: true }).click();
  await poll(() => grid.getAttribute("aria-rowcount"), (count) => count === String(golden.filteredRows));
  const nextPage = results.getByRole("button", { name: "Next page", exact: true });
  const previousPage = results.getByRole("button", { name: "Previous page", exact: true });
  await nextPage.click();
  await results.getByText("Showing rows 101-200 of 230", { exact: true }).waitFor();
  await nextPage.click();
  await results.getByText("Showing rows 201-230 of 230", { exact: true }).waitFor();
  await previousPage.click();
  await results.getByText("Showing rows 101-200 of 230", { exact: true }).waitFor();
  await previousPage.click();
  await results.getByText("Showing rows 1-100 of 230", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(scratch, "native-results.png") });
  await results.getByRole("button", { name: "Clear result", exact: true }).click();
  await grid.waitFor({ state: "detached" });
  return { queryHeight: { before: before.height, after: after.height }, rows: golden.filteredRows, pageNavigation: true };
}

async function checkCommerceTimestamp() {
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  const results = workspace.getByRole("tabpanel", { name: "Results", exact: true });
  const grid = results.getByRole("grid", { name: "Data preview", exact: true });
  const editor = workspace.getByRole("textbox", { name: "SQL editor", exact: true });
  const run = workspace.getByRole("button", { name: "Run", exact: true });
  await workspace.getByText("3 files", { exact: true }).waitFor();
  await editor.fill(`
    SELECT c.customer_id, c.customer_name, o.order_id, o.ordered_at,
           i.product_name, i.product_id, i.category, i.quantity
    FROM customers c
    JOIN orders o ON c.customer_id = o.customer_id
    JOIN order_items i ON o.order_id = i.order_id
    WHERE i.category = '식품' AND i.quantity > 1;
  `);
  const started = Date.now();
  await run.click();
  const execution = workspace.getByRole("tablist", { name: "SQL output", exact: true }).getByRole("status");
  await poll(async () => {
    const state = await execution.textContent();
    assert.ok(!state?.startsWith("failed") && !state?.startsWith("cancelled"), state ?? "");
    return grid.isVisible();
  }, Boolean, 300_000);
  const materializedMs = Date.now() - started;
  assert.equal(await grid.getAttribute("aria-rowcount"), "124769");
  let storage;
  if (storageDraft) {
    const { csvCachePath } = await invoke("get_query_temp_usage");
    const temp = path.join(path.dirname(csvCachePath), "query-temp");
    const [processDirectory] = (await fs.readdir(temp)).filter((name) => name.startsWith(`${owned.pid}-`));
    assert.ok(processDirectory);
    const entries = await fs.readdir(path.join(temp, processDirectory), { recursive: true, withFileTypes: true });
    const [manifest] = entries.filter(({ name }) => name === "output.json");
    assert.ok(manifest);
    const output = JSON.parse(await fs.readFile(path.join(manifest.parentPath, manifest.name), "utf8"));
    assert.equal(output.rows, 124769);
    assert.ok(output.chunks.length <= 5);
    storage = { chunks: output.chunks.length, chunkRows: output.chunks.map(({ rows }) => rows) };
  }

  const filterButton = grid.getByRole("button", { name: "Filter ordered_at", exact: true });
  await filterButton.click();
  const filter = page.getByRole("dialog", { name: "Filter ordered_at", exact: true });
  await filter.getByRole("combobox", { name: "Filter operator" }).selectOption("between");
  const from = filter.getByRole("textbox", { name: "From value", exact: true });
  const to = filter.getByRole("textbox", { name: "To value", exact: true });
  await from.fill("2024-07-01 00:00");
  await to.fill("2024-07-02 00:00");
  if (!storageDraft && !storageBaseline) {
    await page.screenshot({ path: path.join(scratch, "ordered-at-filter.png") });
  }
  await filter.getByRole("button", { name: "Apply", exact: true }).click();
  await poll(() => grid.getAttribute("aria-rowcount"), (count) => count === "118");
  return { sourceRows: 124769, filteredRows: 118, materializedMs, storage, input: ["2024-07-01 00:00", "2024-07-02 00:00"] };
}

function timestampPlan(columnId, operator, values, projection) {
  return {
    filters: [{ id: "timestamp", columnId, scalarType: "timestamp", operator, values }],
    search: null, sort: [], projection,
  };
}

async function checkCsvTimestampPrecision() {
  const opened = await invoke("open_data_paths", { request: {
    requestId: `p23-precision-${randomUUID()}`, origin: "startupArg", paths: [precisionCsv],
  }});
  assert.deepEqual(opened.failures, []);
  const { documentId, sessionId } = opened.opened[0];
  document = { documentId, sessionId };
  const cases = [
    ["equals", ["1969-12-31 23:59:59.999999999Z"], ["2"]],
    ["between", ["1969-12-31 23:59:59.999999999Z", "1970-01-01 00:00:00.000000001Z"], ["2", "3"]],
    ["equals", ["2500-01-01 00:00:00.123456789Z"], ["4"]],
  ];
  for (const [operator, values, expected] of cases) {
    const identity = { ...document, queryId: `p23-precision-${randomUUID()}`, taskId: `p23-task-${randomUUID()}` };
    const plan = timestampPlan("event_time", operator, values, ["id"]);
    await invoke("execute_query", { request: { ...identity, plan } });
    const status = await poll(() => invoke("get_query_status", identity), terminal);
    assert.equal(status.state, "complete", JSON.stringify(status));
    const { taskId, ...pageIdentity } = identity;
    const { page: result } = await invoke("read_query_page", {
      request: { ...pageIdentity, offset: 0, limit: 10, columns: ["id"] },
    });
    assert.deepEqual(result.rows.map(([id]) => id.display), expected);
  }
  return { cases: cases.length };
}

async function checkSqlTimestampSeconds() {
  const runId = `p23-seconds-${randomUUID()}`;
  await invoke("start_sql_query", { request: {
    runId, action: "execute", tables: [{ ...document, alias: "unused_fixture", columnMode: "name" }],
    sql: `SELECT * FROM (VALUES
        (1, '1969-12-31 23:59:59'::TIMESTAMP_S),
        (2, '1970-01-01 00:00:00'::TIMESTAMP_S),
        (3, '1970-01-01 00:00:01'::TIMESTAMP_S),
        (4, '2500-01-01 00:00:00'::TIMESTAMP_S),
        (5, NULL::TIMESTAMP_S)
      ) t(id, event_time) ORDER BY id`,
  }});
  const status = await poll(() => invoke("get_sql_query_status", { runId }), terminal);
  assert.equal(status.state, "complete", JSON.stringify(status));
  assert.equal(status.columns[1].logicalType, "TIMESTAMP_S");
  sqlResult = { runId, resultId: status.resultId };
  const cases = [
    ["equals", ["1969-12-31 23:59:59Z"], ["1"]],
    ["equals", ["1970-01-01 00:00:00.000000001Z"], []],
    ["between", ["1969-12-31 23:59:59.000000001Z", "1970-01-01 00:00:01Z"], ["2", "3"]],
    ["equals", ["2500-01-01 00:00"], ["4"]],
    ["isNull", [], ["5"]],
  ];
  for (const [operator, values, expected] of cases) {
    const ids = { ...sqlResult, viewId: `p23-precision-view-${randomUUID()}` };
    const plan = timestampPlan("r1", operator, values, ["r0"]);
    await invoke("start_sql_result_view", { ...ids, plan });
    try {
      const view = await poll(() => invoke("get_sql_result_view_status", ids), terminal);
      assert.equal(view.state, "complete", JSON.stringify(view));
      const result = await readView(ids, 0, 10, ["r0"]);
      assert.deepEqual(result.rows.map(([id]) => id.display), expected);
    } finally {
      await invoke("release_sql_result_view", ids);
    }
  }
  return { cases: cases.length };
}

async function checkStoragePageBoundaries() {
  if (sqlResult) await invoke("release_sql_result", sqlResult);
  sqlResult = undefined;
  const runId = `p23-storage-${randomUUID()}`;
  await invoke("start_sql_query", { request: {
    runId, action: "execute", tables: [{ ...document, alias: "unused_fixture", columnMode: "name" }],
    sql: "SELECT i, (i + 1)::VARCHAR AS label FROM range(70000) t(i) ORDER BY i",
  }});
  const status = await poll(() => invoke("get_sql_query_status", { runId }), terminal);
  assert.equal(status.state, "complete", JSON.stringify(status));
  assert.equal(status.rowCount, 70000);
  sqlResult = { runId, resultId: status.resultId };
  const offsets = [0, 2047, 32767, 65535, 69999];
  for (const offset of offsets) {
    const result = await invoke("read_sql_query_page", { request: {
      ...sqlResult, offset, limit: 3, columns: ["r1", "r0"],
    }});
    const expected = Array.from({ length: Math.min(3, 70000 - offset) },
      (_, i) => [String(offset + i + 1), String(offset + i)]);
    assert.deepEqual(result.rows.map((row) => row.map(({ display }) => display)), expected);
  }
  const ids = { ...sqlResult, viewId: `p23-storage-sort-${randomUUID()}` };
  await invoke("start_sql_result_view", { ...ids, plan: {
    filters: [], search: null, projection: ["r0"],
    sort: [{ columnId: "r0", direction: "descending", nullsLast: true }],
  }});
  try {
    const view = await poll(() => invoke("get_sql_result_view_status", ids), terminal);
    assert.equal(view.state, "complete", JSON.stringify(view));
    const result = await readView(ids, 37231, 3, ["r0"]);
    assert.deepEqual(result.rows.map(([value]) => value.display), ["32768", "32767", "32766"]);
  } finally {
    await invoke("release_sql_result_view", ids);
  }
  const exportDirectory = await fs.mkdtemp(path.join(scratch, "storage-export-"));
  const destination = path.join(exportDirectory, "whole.csv");
  const [saved, dialog] = await Promise.all([
    invoke("export_sql_result", { request: { ...sqlResult, format: "csv" } }),
    operateOwnedSaveDialog(powershell, { pid: owned.pid, title: "Export SQL result as CSV", destination }),
  ]);
  assert.equal(saved, true);
  assert.equal(dialog.saved, true);
  const csv = await fs.readFile(destination, "utf8");
  const expectedCsv = "\uFEFFi,label\r\n"
    + Array.from({ length: 70000 }, (_, i) => `${i},${i + 1}\r\n`).join("");
  assert.equal(hash(csv), hash(expectedCsv));
  return { offsets, rows: status.rowCount, exportSha256: hash(csv) };
}

async function checkStorageLimits() {
  const directory = await fs.mkdtemp(path.join(scratch, "storage-budget-"));
  const job = path.join(directory, "job.json");
  await fs.writeFile(job, JSON.stringify({
    sql: "SELECT i FROM range(70000) t(i)", action: "execute",
    tables: [], directory, allowance: 10_000, parent_pid: process.pid,
  }));
  await runFile(binary, ["--data-viewer-sql-worker", job], { windowsHide: true, timeout: 15_000 });
  const output = JSON.parse(await fs.readFile(path.join(directory, "output.json"), "utf8"));
  assert.equal(output.error?.code, "QueryTempLimitExceeded");
  assert.deepEqual(output.chunks, []);
  const runId = `p23-storage-cancel-${randomUUID()}`;
  await invoke("start_sql_query", { request: {
    runId, action: "execute", tables: [{ ...document, alias: "unused_fixture", columnMode: "name" }],
    sql: "SELECT SUM(SQRT(a.i + b.i + 1)) FROM range(1000000) a(i) CROSS JOIN range(1000000) b(i)",
  }});
  await poll(() => invoke("get_sql_query_status", { runId }), (status) => status.state === "running" || terminal(status));
  await invoke("cancel_sql_query", { runId });
  const cancelled = await poll(() => invoke("get_sql_query_status", { runId }), terminal);
  assert.equal(cancelled.state, "cancelled", JSON.stringify(cancelled));
  assert.equal(cancelled.resultId, null);
  return { budgetError: output.error.code, cancelState: cancelled.state };
}

async function checkExistingResults() {
  await check("T-P23-001/007 actual WebView filter and splitter", checkWorkspace);
  sqlResult = await runTypedResult();
  await check("T-P23-005 original result retained after source tab closure", async () => {
    const close = page.getByRole("button", { name: "Close input.csv", exact: true });
    await close.click();
    await close.waitFor({ state: "detached" });
    document = undefined;
    const retained = await readView(sqlResult, 459, 1, ["r0"]);
    assert.equal(retained.totalRows, golden.sqlRows);
    assert.equal(sourceOffset(raw(retained.rows[0][0])), 459);
    return { rows: retained.totalRows };
  });
  await check("T-P23-001/002 typed view, page boundary, release", () => checkTypedView(sqlResult));
  await check("T-P23-003 exact Find navigation", () => checkFind(sqlResult));
  await check("T-P23-004 full filtered Windows clipboard", () => checkClipboard(sqlResult));
  await check("T-P23-004 native save, cancel, filtered files and whole result", () => checkFileExports(sqlResult));
  await invoke("release_sql_result", sqlResult);
  sqlResult = undefined;
}

async function checkSourceOverwriteGuard() {
  const original = await fs.readFile(inputCsv);
  for (const expected of ["An open source file", "A SQL input file"]) {
    const save = invoke("export_sql_result", { request: { ...sqlResult, format: "csv" } })
      .then(() => "", (error) => String(error));
    const dialog = await operateOwnedSaveDialog(powershell, {
      pid: owned.pid, title: "Export SQL result as CSV", destination: inputCsv, overwrite: "accept",
    });
    assert.ok(dialog.saved);
    const error = await save;
    assert.ok(error.includes(expected), error || "The protected source export unexpectedly succeeded.");
    assert.deepEqual(await fs.readFile(inputCsv), original);
    if (document) {
      await invoke("close_document", document);
      document = undefined;
    }
  }
  return { protectedOpenAndClosedSource: true, sourceSha256: hash(original) };
}

try {
  await fs.mkdir(scratch, { recursive: true });
  if (exportOverwrite) await fs.copyFile(fixture("input.csv"), inputCsv);
  if (precisionFollowup) {
    await fs.writeFile(precisionCsv, [
      "id,event_time",
      "1,1969-12-31T23:59:59.999999998Z",
      "2,1970-01-01T08:59:59.999999999+09:00",
      "3,1970-01-01T00:00:00.000000001Z",
      "4,2500-01-01T00:00:00.123456789Z",
      "5,NULL",
      "",
    ].join("\n"));
  }
  report.sha256 = hash(await fs.readFile(binary));
  await launch();
  if (productSmoke) {
    await check("Product identity, version and WebView startup", async () => ({ appVersion: report.health.appVersion, identifier }));
  } else if (exportOverwrite) {
    sqlResult = await runTypedResult();
    await check("Overwrite CSV, TSV and Parquet through the native Save dialog", () => checkFileExports(sqlResult));
    await check("Reject replacing an open or referenced source", checkSourceOverwriteGuard);
  } else if (precisionFollowup) {
    await check("CSV exact nanosecond filters", checkCsvTimestampPrecision);
    await check("SQL Results exact TIMESTAMP_S filters", checkSqlTimestampSeconds);
    if (storageDraft) {
      await check("SQL result row-group and file page boundaries", checkStoragePageBoundaries);
      await check("SQL result storage budget and cancellation", checkStorageLimits);
    }
  } else if (timestampFollowup) {
    await check("T-P23-011 actual commerce JOIN timestamp filter", checkCommerceTimestamp);
  } else {
    await checkExistingResults();
  }
  report.status = report.checks.every(({ status }) => status === "PASS") ? "PASS" : "FAIL";
} catch (error) {
  report.status = "FAIL";
  report.error = error.stack ?? String(error);
  console.error(report.error);
} finally {
  if (page && !page.isClosed()) {
    if (sqlResult) await invoke("release_sql_result", sqlResult).catch(() => {});
    if (document) await invoke("close_document", document).catch(() => {});
    if (originalClipboard !== undefined) {
      try {
        await invoke("plugin:clipboard-manager|write_text", { text: originalClipboard ?? "" });
        report.clipboardTextRestored = true;
      } catch (error) {
        report.status = "FAIL";
        report.clipboardRestoreError = String(error);
      }
    }
  }
  try {
    await stop();
  } catch (error) {
    report.status = "FAIL";
    report.stopError = String(error);
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(scratch, "report.json"), JSON.stringify(report, null, 2));
}
if (report.status !== "PASS") process.exitCode = 1;
