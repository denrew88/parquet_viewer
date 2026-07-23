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
    manifest: path.join(root, "artifacts", "phase-12", "fixture-manifest.json"),
    output: path.join(root, "artifacts", "phase-12", "native-results.json"),
    executable: path.join(root, "src-tauri", "target", "debug", "data-viewer.exe"),
    h5: path.join(root, "fixtures", "phase-11", "oef-v3-int32.oes.h5"),
    h5Integrity: path.join(root, "artifacts", "phase-11", "fixture-integrity.json"),
    screenshot: path.join(root, "artifacts", "phase-12", "ui", "native-desktop.png"),
    cdpPort: 9333,
    tabIterations: 20,
    timeoutMs: 300_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/native_phase12_smoke.mjs [options]",
          "  --manifest <path>       Phase 12 fixture manifest",
          "  --output <path>         Native JSON evidence",
          "  --executable <path>     Debug or release data-viewer.exe",
          "  --h5 <path>             Wide OES HDF5 fixture",
          "  --h5-integrity <path>   H5 integrity manifest",
          "  --screenshot <path>     Native screenshot evidence",
          "  --cdp-port <number>      WebView2 remote debugging port",
          "  --tab-iterations <n>     Large/H5 tab round trips",
          "  --timeout-ms <number>    Query/copy operation timeout",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    index += 1;
    if (key === "--manifest") options.manifest = path.resolve(root, value);
    else if (key === "--output") options.output = path.resolve(root, value);
    else if (key === "--executable") options.executable = path.resolve(root, value);
    else if (key === "--h5") options.h5 = path.resolve(root, value);
    else if (key === "--h5-integrity") options.h5Integrity = path.resolve(root, value);
    else if (key === "--screenshot") options.screenshot = path.resolve(root, value);
    else if (key === "--cdp-port") options.cdpPort = Number(value);
    else if (key === "--tab-iterations") options.tabIterations = Number(value);
    else if (key === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  assert.ok(Number.isSafeInteger(options.cdpPort) && options.cdpPort > 0);
  assert.ok(Number.isSafeInteger(options.tabIterations) && options.tabIterations > 0);
  assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 30_000);
  return options;
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

function relativePath(value) {
  return path.relative(root, value).replaceAll("\\", "/");
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function fixturePreflight(options) {
  const manifest = await readJson(options.manifest);
  assert.equal(manifest.validation, "PASS", "Phase 12 fixture manifest is not validated.");
  assert.equal(manifest.configuration?.rows, 5_850_000);
  const large = manifest.fixtures.filter(
    (fixture) => fixture.rows === 5_850_000 && ["low", "high"].includes(fixture.cardinality),
  );
  assert.deepEqual(
    new Set(large.map((fixture) => fixture.cardinality)),
    new Set(["low", "high"]),
    "The manifest must contain the low/high 5.85M Parquet pair.",
  );
  const fixtures = Object.fromEntries(
    await Promise.all(
      large.map(async (fixture) => {
        const file = resolveRepoPath(fixture.path);
        const metadata = await stat(file);
        assert.equal(metadata.size, fixture.bytes, `${fixture.id} size differs from the manifest.`);
        assert.equal(await sha256File(file), fixture.sha256, `${fixture.id} hash mismatch.`);
        return [fixture.cardinality, { ...fixture, file }];
      }),
    ),
  );
  const referencePath = resolveRepoPath(manifest.reference.path);
  assert.equal(await sha256File(referencePath), manifest.reference.sha256);
  const reference = await readJson(referencePath);
  assert.equal(reference.rows, 5_850_000);
  for (const fixture of Object.values(fixtures)) {
    assert.ok(reference.fixtures[fixture.id], `Reference pages are missing for ${fixture.id}.`);
  }

  const h5Metadata = await stat(options.h5);
  let h5ExpectedHash = null;
  try {
    const integrity = await readJson(options.h5Integrity);
    const entry = integrity.files?.find(
      (item) => resolveRepoPath(item.path).toLocaleLowerCase() === options.h5.toLocaleLowerCase(),
    );
    if (entry) {
      assert.equal(
        h5Metadata.size,
        entry.bytes,
        "H5 fixture size differs from its integrity file.",
      );
      assert.equal(await sha256File(options.h5), entry.sha256, "H5 fixture hash mismatch.");
      h5ExpectedHash = entry.sha256;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    manifest,
    reference,
    referencePath,
    fixtures,
    h5: { file: options.h5, bytes: h5Metadata.size, sha256: h5ExpectedHash },
  };
}

function referencePage(preflight, fixture, label) {
  const page = preflight.reference.fixtures[fixture.id].pages.find((item) => item.label === label);
  assert.ok(page, `${fixture.id} has no ${label} reference page.`);
  return page;
}

function sourceIdAt(page, position) {
  const index = position - page.offset;
  assert.ok(index >= 0 && index < page.sourceRowIds.length);
  return page.sourceRowIds[index];
}

function buildFlavor(executable) {
  const normalized = executable.replaceAll("\\", "/").toLocaleLowerCase();
  if (normalized.includes("/release/")) return "release";
  if (normalized.includes("/debug/")) return "debug";
  return "custom";
}

function markdownFor(result) {
  const lines = [
    "# Phase 12 네이티브 스모크 결과",
    "",
    `- 판정: **${result.overall}**`,
    `- 실행 시각: ${result.finishedAtUtc}`,
    `- 실행 파일: \`${result.execution.executable}\` (${result.execution.buildFlavor})`,
    `- 런타임: 실제 Tauri Rust IPC + Windows WebView2 (browser mock 미사용)`,
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
  if (result.failure) lines.push("", "## 실패", "", "```text", result.failure.message, "```");
  lines.push("", "## 산출물", "", ...result.artifacts.map((artifact) => `- \`${artifact}\``), "");
  return `${lines.join("\n")}\n`;
}

async function writeEvidence(options, result) {
  const markdownPath = path.join(path.dirname(options.output), "ui", "native-smoke.md");
  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(result), "utf8");
  if (!result.artifacts.includes(relativePath(markdownPath))) {
    result.artifacts.push(relativePath(markdownPath));
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, markdownFor(result), "utf8");
  }
}

async function connectWebView(port, app, output, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  let lastError;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(
        `Data Viewer exited before CDP startup with code ${app.exitCode}: ${output()}`,
      );
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

async function installIpcProbe(page) {
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      throw new Error(
        "Tauri internals are unavailable; refusing to treat a browser mock as native.",
      );
    }
    const originalInvoke = internals.invoke.bind(internals);
    const probe = { counts: {}, calls: [] };
    const clone = (value) => {
      try {
        return structuredClone(value);
      } catch {
        return null;
      }
    };
    const summarize = (value) => {
      if (!value || typeof value !== "object") return value;
      const pageValue = value.page;
      return {
        documentId: value.documentId,
        sessionId: value.sessionId,
        queryId: value.queryId,
        taskId: value.taskId,
        state: value.state,
        stage: value.stage,
        startedAt: value.startedAt,
        finishedAt: value.finishedAt,
        columns: Array.isArray(value.columns) ? [...value.columns] : undefined,
        progress: clone(value.progress),
        page: pageValue
          ? {
              offset: pageValue.offset,
              rowCount: Array.isArray(pageValue.rows) ? pageValue.rows.length : null,
              totalRows: pageValue.totalRows,
              columns: clone(pageValue.columns),
            }
          : undefined,
      };
    };
    window.__PHASE12_NATIVE_PROBE__ = probe;
    window.__PHASE12_NATIVE_ORIGINAL_INVOKE__ = originalInvoke;
    internals.invoke = async (command, args) => {
      probe.counts[command] = (probe.counts[command] ?? 0) + 1;
      const call = { command, args: clone(args), startedAt: performance.now() };
      probe.calls.push(call);
      if (probe.calls.length > 2_000) probe.calls.shift();
      try {
        const value = await originalInvoke(command, args);
        call.elapsedMs = performance.now() - call.startedAt;
        call.ok = true;
        call.result = summarize(value);
        return value;
      } catch (error) {
        call.elapsedMs = performance.now() - call.startedAt;
        call.ok = false;
        call.error = String(error);
        throw error;
      }
    };
  });
}

async function probeSnapshot(page) {
  return page.evaluate(() => structuredClone(window.__PHASE12_NATIVE_PROBE__));
}

async function commandCount(page, command) {
  return page.evaluate((name) => window.__PHASE12_NATIVE_PROBE__?.counts?.[name] ?? 0, command);
}

async function activeGrid(page) {
  const grid = page.getByRole("grid", { name: "Data preview" }).filter({ visible: true });
  await grid.waitFor({ state: "visible" });
  return grid;
}

async function selectTab(page, file) {
  const name = path.basename(file);
  const tab = page.getByRole("tab", { name: new RegExp(`^${regexEscape(name)}$`) });
  await tab.click();
  await assertFrameStable(page, name);
  return activeGrid(page);
}

async function assertFrameStable(page, expectedName) {
  const snapshots = await page.evaluate(
    ({ expectedName }) =>
      new Promise((resolve) => {
        const values = [];
        const sample = () => {
          const selected = document.querySelector('[role="tab"][aria-selected="true"]');
          const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
          const grid = panel?.querySelector('[role="grid"][aria-label="Data preview"]');
          values.push({
            selected: selected?.textContent?.trim() ?? null,
            cells: grid?.querySelectorAll("[data-grid-row][data-grid-column]").length ?? 0,
            mountedRows: Number(grid?.getAttribute("data-mounted-rows") ?? 0),
            busy: panel?.querySelector('[aria-label="Page navigation"]')?.getAttribute("aria-busy"),
            filter: grid ? getComputedStyle(grid).filter : null,
            opacity: grid ? getComputedStyle(grid).opacity : null,
          });
          if (values.length === 3) resolve(values);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    { expectedName },
  );
  assert.ok(
    snapshots.every(
      (snapshot) =>
        snapshot.selected?.includes(expectedName) &&
        snapshot.cells > 0 &&
        snapshot.mountedRows > 0 &&
        snapshot.busy !== "true" &&
        snapshot.filter === "none" &&
        snapshot.opacity === "1",
    ),
    `Tab restore exposed a blank, busy, or blurred frame: ${JSON.stringify(snapshots)}`,
  );
  return snapshots;
}

function gridCell(grid, row, column) {
  return grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
}

async function waitActive(grid, row, column, timeout) {
  await grid.page().waitForFunction(
    ({ row, column }) => {
      const active = [
        ...document.querySelectorAll('[role="grid"][aria-label="Data preview"]'),
      ].find((item) => item.getClientRects().length > 0);
      return (
        active?.getAttribute("data-active-row") === String(row) &&
        active?.getAttribute("data-active-column") === String(column)
      );
    },
    { row, column },
    { timeout },
  );
  await gridCell(grid, row, column).waitFor({ state: "visible", timeout });
}

async function waitCellText(grid, row, column, expected, timeout) {
  const target = gridCell(grid, row, column);
  await target.waitFor({ state: "visible", timeout });
  await assert.doesNotReject(() =>
    target.waitFor({ state: "visible", timeout }).then(async () => {
      await grid.page().waitForFunction(
        ({ row, column, expected }) => {
          const active = [
            ...document.querySelectorAll('[role="grid"][aria-label="Data preview"]'),
          ].find((item) => item.getClientRects().length > 0);
          const cell = active?.querySelector(
            `[data-grid-row="${row}"][data-grid-column="${column}"]`,
          );
          return cell?.textContent?.trim().replace(/[,.\s]/g, "") === String(expected);
        },
        { row, column, expected },
        { timeout },
      );
    }),
  );
}

async function lastReadQueryRequest(page) {
  return page.evaluate(() => {
    const calls = window.__PHASE12_NATIVE_PROBE__?.calls ?? [];
    const observed = [...calls]
      .reverse()
      .find((call) => call.command === "read_query_page" && call.ok)?.args?.request;
    if (observed) return observed;
    const grid = [...document.querySelectorAll('[role="grid"][aria-label="Data preview"]')].find(
      (item) => item.getClientRects().length > 0,
    );
    const documentId = grid?.getAttribute("data-document-id");
    const sessionId = grid?.getAttribute("data-session-id");
    const queryId = grid?.getAttribute("data-query-id");
    return documentId && sessionId && queryId ? { documentId, sessionId, queryId } : null;
  });
}

async function nativeQueryPage(page, base, offset, columns) {
  return page.evaluate(
    async ({ base, offset, columns }) => {
      const request = { ...base, offset, limit: 200, columns };
      return window.__TAURI_INTERNALS__.invoke("read_query_page", { request });
    },
    { base, offset, columns },
  );
}

async function assertPageIdentity(response, expectedPage, exactPosition, label) {
  assert.equal(response.page.offset, expectedPage.offset, `${label} offset`);
  assert.deepEqual(response.page.columns, ["row_id"], `${label} projection`);
  const expected = sourceIdAt(expectedPage, exactPosition);
  const actual = Number(
    String(response.page.rows[exactPosition - expectedPage.offset]?.[0]?.display).replace(
      /[,.\s]/g,
      "",
    ),
  );
  assert.equal(actual, expected, `${label} source row identity`);
  return actual;
}

async function geometryFor(grid, row, column) {
  const cell = gridCell(grid, row, column);
  await cell.waitFor({ state: "visible" });
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
      scrollTop: grid.scrollTop,
      focused: document.activeElement === grid,
    };
  });
  assert.ok(geometry.cellHeight > 0, `Row ${row} has zero height.`);
  assert.ok(
    geometry.cellBottom <= geometry.gridContentBottom - geometry.bottomClearance + 1,
    `Final row is clipped: ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.gridContentBottom <= geometry.gridBottom + 1);
  assert.equal(geometry.focused, true, "Grid focus was lost at the final row.");
  return geometry;
}

async function runSortedFixture(page, fixture, preflight, timeout, navigation) {
  const startedAt = performance.now();
  const grid = await selectTab(page, fixture.file);
  assert.equal(Number(await grid.getAttribute("aria-rowcount")), fixture.rows);
  const firstReference = referencePage(preflight, fixture, "first");
  const middleReference = referencePage(preflight, fixture, "reported-986803");
  const lastReference = referencePage(preflight, fixture, "last");
  const firstExpected = sourceIdAt(firstReference, 0);
  const middleExpected = sourceIdAt(middleReference, 986_803);
  const lastExpected = sourceIdAt(lastReference, fixture.rows - 1);

  await page.getByRole("button", { name: "Sort group_id: not sorted" }).click();
  await page
    .getByRole("button", { name: /Sort group_id: ascending, priority 1/ })
    .waitFor({ timeout });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="grid"][aria-label="Data preview"]')]
        .find((item) => item.getClientRects().length > 0)
        ?.getAttribute("data-query-id"),
    undefined,
    { timeout },
  );
  await waitCellText(grid, 0, 0, firstExpected, timeout);
  const base = await lastReadQueryRequest(page);
  assert.ok(base?.queryId, `${fixture.cardinality} sort did not expose a query page identity.`);

  const first = await nativeQueryPage(page, base, 0, ["row_id"]);
  const middle = await nativeQueryPage(page, base, middleReference.offset, ["row_id"]);
  const last = await nativeQueryPage(page, base, lastReference.offset, ["row_id"]);
  await assertPageIdentity(first, firstReference, 0, `${fixture.cardinality} first`);
  await assertPageIdentity(middle, middleReference, 986_803, `${fixture.cardinality} 986803`);
  await assertPageIdentity(last, lastReference, fixture.rows - 1, `${fixture.cardinality} last`);

  let navigationEvidence = null;
  if (navigation) {
    await gridCell(grid, 0, 0).click();
    const timings = {};
    const press = async (key, row, column) => {
      const started = performance.now();
      await grid.press(key);
      await waitActive(grid, row, column, timeout);
      timings[key] = performance.now() - started;
    };
    const ctrlRightStarted = performance.now();
    await grid.press("Control+ArrowRight");
    await page.waitForFunction(
      () =>
        Number(
          [...document.querySelectorAll('[role="grid"][aria-label="Data preview"]')]
            .find((item) => item.getClientRects().length > 0)
            ?.getAttribute("data-active-column"),
        ) > 0,
      undefined,
      { timeout },
    );
    const ctrlRightColumn = Number(await grid.getAttribute("data-active-column"));
    timings["Control+ArrowRight"] = performance.now() - ctrlRightStarted;
    await press("Control+ArrowLeft", 0, 0);
    await press("Control+ArrowDown", fixture.rows - 1, 0);
    const finalGeometry = await geometryFor(grid, fixture.rows - 1, 0);
    await press("Control+ArrowUp", 0, 0);
    await press("Control+Alt+ArrowRight", 0, fixture.columns - 1);
    await press("Control+Alt+ArrowLeft", 0, 0);
    await press("Control+Alt+ArrowDown", fixture.rows - 1, 0);
    await press("Control+Alt+ArrowUp", 0, 0);

    await grid.press("PageDown");
    await page.waitForFunction(
      () =>
        Number(
          [...document.querySelectorAll('[role="grid"][aria-label="Data preview"]')]
            .find((item) => item.getClientRects().length > 0)
            ?.getAttribute("data-active-row"),
        ) > 0,
      undefined,
      { timeout },
    );
    const pageDownRow = Number(await grid.getAttribute("data-active-row"));
    await grid.press("PageUp");
    await waitActive(grid, 0, 0, timeout);
    navigationEvidence = { ctrlRightColumn, pageDownRow, timings, finalGeometry };
  }
  return {
    cardinality: fixture.cardinality,
    queryId: base.queryId,
    sourceRowIds: { first: firstExpected, reported986803: middleExpected, last: lastExpected },
    elapsedMs: performance.now() - startedAt,
    navigation: navigationEvidence,
  };
}

async function configureCopyLimits(page, maxCells, maxMiB) {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings" });
  await dialog.getByLabel("Maximum cells").fill(String(maxCells));
  await dialog.getByLabel("Maximum clipboard size").fill(String(maxMiB));
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

async function configureCopyFormat(page) {
  await page.getByRole("button", { name: "Copy options" }).click();
  await page.getByRole("menuitem", { name: "Copy settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy settings" });
  await dialog.getByRole("button", { name: "TSV", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

async function clipboardSummary(page) {
  return page.evaluate(async () => {
    const text = await navigator.clipboard.readText();
    let newlineCount = 0;
    for (let index = 0; index < text.length; index += 1)
      if (text.charCodeAt(index) === 10) newlineCount += 1;
    const firstBreak = text.indexOf("\n");
    const lastBreak = text.lastIndexOf("\n");
    const trimCr = (value) => (value.endsWith("\r") ? value.slice(0, -1) : value);
    const firstLine = trimCr(firstBreak < 0 ? text : text.slice(0, firstBreak));
    const lastLine = trimCr(lastBreak < 0 ? text : text.slice(lastBreak + 1));
    return {
      characters: text.length,
      rows: text.length === 0 ? 0 : newlineCount + 1,
      firstLine,
      lastLine,
      firstColumns: firstLine.split("\t").length,
      lastColumns: lastLine.split("\t").length,
    };
  });
}

async function copyRawSelection(page, expectedRows, timeout) {
  const before = await commandCount(page, "start_copy");
  await page.evaluate(() => navigator.clipboard.writeText("__phase12_native_sentinel__"));
  await page.getByRole("button", { name: "Copy options" }).click();
  await page.getByRole("menuitem", { name: "Copy raw values" }).click();
  await page.waitForFunction(
    ({ expectedRows }) =>
      [...document.querySelectorAll('[role="status"].copy-status')].some((element) => {
        const text = element.textContent ?? "";
        const match = text.match(/completed:\s*([\d,.\s]+)\s+rows copied/i);
        return match && Number(match[1].replace(/\D/g, "")) === expectedRows;
      }),
    { expectedRows },
    { timeout },
  );
  const after = await commandCount(page, "start_copy");
  if (before > 0 || after > 0) assert.equal(after, before + 1);
  return { ...(await clipboardSummary(page)), ipcProbeObserved: after > before };
}

async function runFindAndQueryCopy(page, fixture, preflight, options) {
  const grid = await selectTab(page, fixture.file);
  await gridCell(grid, 0, 0).click();
  const middleReference = referencePage(preflight, fixture, "reported-986803");
  const lastReference = referencePage(preflight, fixture, "last");
  const middleExpected = sourceIdAt(middleReference, 986_803);
  const firstExpected = sourceIdAt(referencePage(preflight, fixture, "first"), 0);
  const lastExpected = sourceIdAt(lastReference, fixture.rows - 1);
  const executeBefore = await commandCount(page, "execute_query");

  await page.keyboard.press("Control+f");
  const find = page.getByRole("searchbox", { name: "Find data" });
  await find.waitFor();
  assert.equal(await find.evaluate((element) => document.activeElement === element), true);
  await find.fill(String(middleExpected));
  await page.waitForTimeout(300);
  assert.equal(
    await commandCount(page, "execute_query"),
    executeBefore,
    "Typing in Find executed the query before explicit Search.",
  );
  await page.getByRole("button", { name: "Search options" }).click();
  const searchMenu = page.getByRole("menu", { name: "Search options" });
  await searchMenu.getByRole("menuitemcheckbox", { name: /Exact match/ }).click();
  await searchMenu.getByRole("menuitemcheckbox", { name: /^row_id/ }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText("1 matches", { exact: true }).waitFor({ timeout: options.timeoutMs });
  await page.getByRole("button", { name: "Next match" }).click();
  await waitActive(grid, 986_803, 0, options.timeoutMs);
  await waitCellText(grid, 986_803, 0, middleExpected, options.timeoutMs);

  await grid.press("Control+Alt+ArrowDown");
  await waitActive(grid, fixture.rows - 1, 0, options.timeoutMs);
  await waitCellText(grid, fixture.rows - 1, 0, lastExpected, options.timeoutMs);
  const geometry = await geometryFor(grid, fixture.rows - 1, 0);
  await grid.press("Control+Alt+ArrowUp");
  await waitActive(grid, 0, 0, options.timeoutMs);
  await waitCellText(grid, 0, 0, firstExpected, options.timeoutMs);

  await configureCopyLimits(page, 10_000_000, 256);
  await configureCopyFormat(page);
  const readQueryBefore = await commandCount(page, "read_query_page");
  await grid
    .getByRole("columnheader", { name: "row_id", exact: true })
    .click({ position: { x: 8, y: 8 } });
  assert.equal(await grid.getAttribute("data-selection-top"), "0");
  assert.equal(await grid.getAttribute("data-selection-bottom"), String(fixture.rows - 1));
  assert.equal(await grid.getAttribute("data-selection-left"), "0");
  assert.equal(await grid.getAttribute("data-selection-right"), "0");
  const clipboard = await copyRawSelection(page, fixture.rows, options.timeoutMs * 2);
  assert.equal(clipboard.rows, fixture.rows, "The query-aware clipboard row count is incomplete.");
  assert.equal(Number(clipboard.firstLine), firstExpected);
  assert.equal(Number(clipboard.lastLine), lastExpected);
  assert.equal(clipboard.firstColumns, 1);
  assert.equal(clipboard.lastColumns, 1);
  assert.equal(
    await commandCount(page, "read_query_page"),
    readQueryBefore,
    "Backend query copy unexpectedly paged through the frontend.",
  );
  const startRequest = await page.evaluate(() => {
    const calls = window.__PHASE12_NATIVE_PROBE__?.calls ?? [];
    return [...calls].reverse().find((call) => call.command === "start_copy")?.args?.request;
  });
  const activeQuery = await lastReadQueryRequest(page);
  assert.ok(activeQuery?.queryId, "The sorted grid did not retain a query identity.");
  if (startRequest) {
    assert.ok(startRequest.queryId, "The copy request was not query-aware.");
    assert.deepEqual(startRequest.selection.columnIds, ["row_id"]);
    assert.equal(startRequest.options.representation, "rawCanonical");
  }
  return {
    queryId: startRequest?.queryId ?? activeQuery.queryId,
    copyRequestProbeObserved: Boolean(startRequest),
    middleMatch: { logicalRow: 986_803, sourceRowId: middleExpected },
    clipboard,
    geometry,
  };
}

async function runH5Copy(page, preflight, options) {
  const grid = await selectTab(page, preflight.h5.file);
  const rows = Number(await grid.getAttribute("aria-rowcount"));
  const columns = Number(await grid.getAttribute("aria-colcount"));
  assert.ok(rows > 0);
  assert.ok(columns > 64, `The H5 fixture is not wide enough: ${columns} columns.`);
  await gridCell(grid, 0, 0).click();
  await grid.press("Control+Alt+ArrowDown");
  await waitActive(grid, rows - 1, 0, options.timeoutMs);
  await grid.press("Control+Alt+ArrowRight");
  await waitActive(grid, rows - 1, columns - 1, options.timeoutMs);
  const geometry = await geometryFor(grid, rows - 1, columns - 1);
  await grid.press("Control+a");
  assert.equal(await grid.getAttribute("data-selection-right"), String(columns - 1));
  assert.equal(await grid.getAttribute("data-selection-bottom"), String(rows - 1));
  const readBefore = await commandCount(page, "read_page");
  const clipboard = await copyRawSelection(page, rows, options.timeoutMs);
  assert.equal(clipboard.rows, rows);
  assert.equal(clipboard.firstColumns, columns);
  assert.equal(clipboard.lastColumns, columns);
  assert.equal(
    await commandCount(page, "read_page"),
    readBefore,
    "H5 backend copy unexpectedly used frontend page reads.",
  );
  const request = await page.evaluate(() => {
    const calls = window.__PHASE12_NATIVE_PROBE__?.calls ?? [];
    return [...calls].reverse().find((call) => call.command === "start_copy")?.args?.request;
  });
  if (request) assert.equal(request.selection.columnIds.length, columns);
  return { rows, columns, clipboard, geometry, copyRequestProbeObserved: Boolean(request) };
}

async function runTabRoundTrips(page, largeFile, h5File, iterations) {
  await selectTab(page, largeFile);
  const before = await probeSnapshot(page);
  const frames = [];
  for (let index = 0; index < iterations; index += 1) {
    await selectTab(page, h5File);
    frames.push({ iteration: index + 1, target: "h5" });
    await selectTab(page, largeFile);
    frames.push({ iteration: index + 1, target: "large" });
  }
  const after = await probeSnapshot(page);
  const beforeReads = (before.counts.read_page ?? 0) + (before.counts.read_query_page ?? 0);
  const afterReads = (after.counts.read_page ?? 0) + (after.counts.read_query_page ?? 0);
  const ipcProbeObserved =
    Object.keys(before.counts).length > 0 || Object.keys(after.counts).length > 0;
  if (ipcProbeObserved)
    assert.equal(afterReads, beforeReads, "Cache-valid tab round trips issued page IPC.");
  return {
    iterations,
    pageIpcDelta: ipcProbeObserved ? afterReads - beforeReads : null,
    ipcProbeObserved,
    sampledTransitions: frames.length,
  };
}

const options = parseArguments(process.argv.slice(2));
const result = {
  schemaVersion: 1,
  overall: "RUNNING",
  startedAtUtc: new Date().toISOString(),
  finishedAtUtc: null,
  execution: {
    executable: relativePath(options.executable),
    buildFlavor: buildFlavor(options.executable),
    browserMock: false,
    nativeRustIpc: true,
    url: null,
    title: null,
    devicePixelRatio: null,
    cdpPort: options.cdpPort,
  },
  fixtures: {},
  checks: [],
  ipcCounts: null,
  artifacts: [relativePath(options.output), relativePath(options.screenshot)],
  failure: null,
};
let browser;
let page;
let app;
let originalSettings;
let runError;
let appOutput = "";

const pass = (id, summary, details = {}) => {
  result.checks.push({ id, status: "PASS", summary, details });
};

try {
  const preflight = await fixturePreflight(options);
  await stat(options.executable);
  result.fixtures = {
    manifest: relativePath(options.manifest),
    reference: relativePath(preflight.referencePath),
    low: relativePath(preflight.fixtures.low.file),
    high: relativePath(preflight.fixtures.high.file),
    h5: relativePath(preflight.h5.file),
  };
  pass("NATIVE12-PREFLIGHT", "manifest hash·size와 low/high/H5 실제 파일을 확인했습니다.");

  await mkdir(path.dirname(options.screenshot), { recursive: true });
  const localAppData = path.join(path.dirname(options.output), "native-localappdata");
  await mkdir(localAppData, { recursive: true });
  app = spawn(
    options.executable,
    ["--file", preflight.fixtures.low.file, preflight.fixtures.high.file, preflight.h5.file],
    {
      cwd: root,
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
          process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
          `--remote-debugging-port=${options.cdpPort}`,
        ]
          .filter(Boolean)
          .join(" "),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appendOutput = (chunk) => {
    appOutput = `${appOutput}${chunk.toString()}`.slice(-64 * 1024);
  };
  app.stdout.on("data", appendOutput);
  app.stderr.on("data", appendOutput);
  browser = await connectWebView(options.cdpPort, app, () => appOutput.trim(), options.timeoutMs);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  assert.ok(page, "WebView2 exposed no page through CDP.");
  await page.waitForLoadState("domcontentloaded");
  await page
    .getByRole("tablist", { name: "Open files" })
    .getByRole("tab")
    .nth(2)
    .waitFor({ timeout: options.timeoutMs });
  assert.match(
    page.url(),
    /^(?:tauri:|https?:\/\/tauri\.localhost)/,
    `Expected a Tauri URL, received ${page.url()}.`,
  );
  result.execution.url = page.url();
  result.execution.title = await page.title();
  result.execution.devicePixelRatio = await page.evaluate(() => devicePixelRatio);
  await installIpcProbe(page);
  originalSettings = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
  pass(
    "NATIVE12-RUNTIME",
    "browser mock이 아닌 Tauri URL, Rust invoke와 WebView2 CDP를 확인했습니다.",
  );

  const low = await runSortedFixture(
    page,
    preflight.fixtures.low,
    preflight,
    options.timeoutMs,
    true,
  );
  pass(
    "NATIVE12-LOW",
    "low-cardinality 정렬의 first/986803/last identity와 모든 Ctrl/Ctrl+Alt 방향, PageUp/Down을 확인했습니다.",
    low,
  );
  const high = await runSortedFixture(
    page,
    preflight.fixtures.high,
    preflight,
    options.timeoutMs,
    false,
  );
  pass(
    "NATIVE12-HIGH",
    "high-cardinality 정렬의 first/986803/last source identity를 실제 query page IPC로 확인했습니다.",
    high,
  );

  const queryCopy = await runFindAndQueryCopy(page, preflight.fixtures.low, preflight, options);
  pass(
    "NATIVE12-FIND-COPY",
    "명시적 Find로 986803행에 이동하고 query-aware 5.85M×1 raw copy와 Windows clipboard를 확인했습니다.",
    queryCopy,
  );
  const h5Copy = await runH5Copy(page, preflight, options);
  pass(
    "NATIVE12-H5-COPY",
    "64열보다 넓은 H5 전체 선택을 backend copy하고 clipboard 행·열 및 마지막 행 geometry를 확인했습니다.",
    h5Copy,
  );
  const tabRestore = await runTabRoundTrips(
    page,
    preflight.fixtures.low.file,
    preflight.h5.file,
    options.tabIterations,
  );
  pass(
    "NATIVE12-TAB-RESTORE",
    `${options.tabIterations}회 tab 왕복 동안 blank/blur/busy frame이 없었습니다.${tabRestore.ipcProbeObserved ? " page IPC 재발행도 없었습니다." : " 로드 후 invoke hook 제한으로 page IPC 횟수는 browser E2E 증거를 사용합니다."}`,
    tabRestore,
  );

  await selectTab(page, preflight.fixtures.low.file);
  await page.screenshot({ path: options.screenshot, fullPage: true });
  result.ipcCounts = (await probeSnapshot(page)).counts;
  result.overall = "PASS";
} catch (error) {
  runError = error;
  result.overall = "FAIL";
  result.failure = {
    message: errorText(error),
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
