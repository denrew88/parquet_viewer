import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const text = (value) => value?.display ?? value?.sourceDisplay;
const terminal = (status) => ["complete", "cancelled", "failed"].includes(status.state);
const cell = (grid, row, column) =>
  grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);

async function poll(read, done, timeout = 120_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Phase 25 SQL scale operation did not finish in time.");
}

async function resize(page, separator, delta) {
  const box = await separator.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

export async function verifyPhase25SqlScale({
  page,
  check,
  scratch,
  fixtureDir,
  invoke,
  openSources,
  sampleProcess,
}) {
  const golden = JSON.parse(await fs.readFile(path.join(fixtureDir, "golden.json"), "utf8"));
  const fixture = path.join(fixtureDir, golden.file);
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(fixture))
      .digest("hex"),
    golden.sha256,
  );
  assert.ok(golden.rows > 1_000_000);
  assert.ok(golden.selectionPayloadBytes > 16 * 1024 * 1024);
  const observations = {
    sourceRows: golden.rows,
    sourceColumns: golden.columns.length,
    selectionPayloadBytes: golden.selectionPayloadBytes,
  };
  const workspace = (name) => page.getByRole("button", { name: `${name} workspace`, exact: true });
  const sql = page.getByRole("region", { name: "SQL workspace", exact: true });
  const source = sql.getByRole("complementary", { name: "SQL source reference", exact: true });
  const sourceGrid = source.getByRole("grid", { name: "Data preview", exact: true });
  const editor = sql.getByRole("textbox", { name: "SQL editor", exact: true });
  const output = sql.getByRole("tabpanel", { name: "Results", exact: true });
  const resultGrid = output.getByRole("grid", { name: "Data preview", exact: true });
  const charts = page.getByRole("region", { name: "Charts workspace", exact: true });

  await workspace("SQL").click();
  await check(source).toBeVisible();
  await source
    .getByRole("group", { name: "Source files", exact: true })
    .getByRole("button", { name: /sql-scale/ })
    .click();
  await check(sourceGrid).toHaveAttribute("aria-rowcount", String(golden.rows));
  assert.ok(
    (await sourceGrid.boundingBox()).height > 80,
    "Source grid must have a usable row viewport",
  );
  await cell(sourceGrid, 0, 0).click();
  await page.keyboard.press("Control+End");
  await check(sourceGrid).toHaveAttribute("data-active-row", String(golden.lastId));
  await check(sourceGrid).toHaveAttribute("data-active-column", String(golden.columns.length - 1));
  await check(sourceGrid.locator(`[data-grid-row="${golden.lastId}"]`).last()).toHaveText(
    golden.lastMarker,
  );
  const tablesSeparator = sql.getByRole("separator", {
    name: "Resize SQL tables pane",
    exact: true,
  });
  const tables = sql.getByRole("complementary", { name: "SQL tables and columns", exact: true });
  const tablesBefore = (await tables.boundingBox()).width;
  await resize(page, tablesSeparator, -30);
  assert.ok(Math.abs((await tables.boundingBox()).width - tablesBefore) > 10);
  const dock = source.getByRole("button", { name: "Dock right", exact: true });
  if (await dock.isVisible()) await dock.click();
  const sourceSeparator = sql.getByRole("separator", {
    name: "Resize SQL source pane",
    exact: true,
  });
  const sourceBefore = (await source.boundingBox()).width;
  await resize(page, sourceSeparator, 35);
  assert.ok(Math.abs((await source.boundingBox()).width - sourceBefore) > 10);
  await page.screenshot({ path: path.join(scratch, "native-source-last-row.png") });

  const statement = "SELECT id, value, category, padding FROM sql_scale ORDER BY id;";
  await editor.fill(statement);
  await sql.getByRole("button", { name: "Run", exact: true }).click();
  await check(resultGrid).toHaveAttribute("aria-rowcount", String(golden.rows), {
    timeout: 120_000,
  });
  assert.ok(
    (await resultGrid.boundingBox()).height > 80,
    "SQL result must have a usable row viewport",
  );
  const resultBounds = await resultGrid.boundingBox();
  const firstRowBounds = await cell(resultGrid, 0, 0).boundingBox();
  assert.ok(
    firstRowBounds.y + firstRowBounds.height <= resultBounds.y + resultBounds.height + 1,
    "The complete first SQL result row must fit above the paging bar",
  );
  await resultGrid.locator('[role="columnheader"][data-column-index="0"]').focus();
  await page.keyboard.press("Control+a");
  await check(resultGrid).toHaveAttribute("data-selection-kind", "all");
  await check(resultGrid).toHaveAttribute("data-selection-top", "0");
  await check(resultGrid).toHaveAttribute("data-selection-bottom", String(golden.lastId));
  await check(resultGrid).toHaveAttribute("data-selection-left", "0");
  await check(resultGrid).toHaveAttribute("data-selection-right", "3");
  observations.controlASelectsEntireSqlResult = true;
  await page.keyboard.press("Control+Home");
  await cell(resultGrid, 0, 0).click();
  await page.keyboard.press("Control+End");
  await check(resultGrid).toHaveAttribute("data-active-row", String(golden.lastId));
  await page.keyboard.press("Control+Home");
  await check(cell(resultGrid, 0, 0)).toHaveText("0");
  const header = (column) =>
    resultGrid.locator(`[role="columnheader"][data-column-index="${column}"]`);
  await header(0).getByText("id", { exact: true }).click();
  await header(1)
    .getByText("value", { exact: true })
    .click({ modifiers: ["Control"] });
  await header(3)
    .getByText("padding", { exact: true })
    .click({ modifiers: ["Control"] });
  await check(resultGrid).toHaveAttribute("data-selection-column-count", "3");
  const before = sampleProcess ? await sampleProcess() : null;
  const start = performance.now();
  await output.getByRole("button", { name: "Create Chart from Selection", exact: true }).click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await check(destination).toContainText(`${golden.rows.toLocaleString()} rows`, {
    timeout: 30_000,
  });
  observations.captureMs = Math.round(performance.now() - start);
  observations.capturePrivateBytesBefore = before?.privateBytes;
  observations.capturePrivateBytesAfter = sampleProcess
    ? (await sampleProcess()).privateBytes
    : null;
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  await charts
    .getByRole("combobox", { name: "Chart type", exact: true })
    .selectOption({ label: "Histogram" });
  await charts.getByRole("combobox", { name: "Value", exact: true }).selectOption("r1");
  const card = charts.getByRole("article", { name: "Histogram chart", exact: true });
  await check(card).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await check(card).toContainText(`${golden.rows.toLocaleString()} valid rows`);
  await workspace("SQL").click();
  await editor.fill("SELECT 999 AS id, 3 AS value, 'new result' AS category, 'new' AS padding;");
  await sql.getByRole("button", { name: "Run", exact: true }).click();
  await check(resultGrid).toHaveAttribute("aria-rowcount", "1");
  await workspace("Charts").click();
  await check(card).toHaveAttribute("data-state", "ready");
  await check(card).toContainText(`${golden.rows.toLocaleString()} valid rows`);
  await workspace("SQL").click();
  const queryTabs = page.getByRole("tablist", { name: "SQL tabs", exact: true });
  const queryName = (await queryTabs.getByRole("tab", { selected: true }).textContent()).trim();
  await queryTabs.getByRole("button", { name: `Close ${queryName}`, exact: true }).click();
  await workspace("Data").click();
  await page.getByRole("button", { name: "Close sql-scale.parquet", exact: true }).click();
  await workspace("Charts").click();
  await check(card).toHaveAttribute("data-state", "ready");
  await check(card).toContainText(`${golden.rows.toLocaleString()} valid rows`);
  await card.locator(".chart-card-title p").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Chart actions", exact: true });
  await menu.getByRole("menuitem", { name: "Duplicate Chart", exact: true }).click();
  const copy = charts.getByRole("article", { name: "Histogram chart copy", exact: true });
  await check(copy).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await card.locator(".chart-card-title p").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete Chart", exact: true }).click();
  await check(card).toHaveCount(0);
  await check(copy).toHaveAttribute("data-state", "ready");
  await check(copy).toContainText(`${golden.rows.toLocaleString()} valid rows`);
  await page.screenshot({ path: path.join(scratch, "native-large-selection-chart.png") });
  await copy.locator(".chart-card-title p").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete Chart", exact: true }).click();
  observations.chartSurvivedRerunSqlTabCloseFileCloseAndDuplicate = true;

  const [identity] = await openSources([fixture]);
  async function run(statement) {
    const runId = `p25-scale-${randomUUID()}`;
    await invoke("start_sql_query", {
      request: {
        runId,
        action: "execute",
        sql: statement,
        tables: [{ ...identity, alias: "scale", columnMode: "name" }],
      },
    });
    const status = await poll(() => invoke("get_sql_query_status", { runId }), terminal);
    assert.equal(status.state, "complete", JSON.stringify(status));
    return { runId, resultId: status.resultId, status };
  }
  const result = await run(
    "SELECT id, value, category, padding, large_id, observed_at FROM scale ORDER BY id",
  );
  assert.equal(result.status.rowCount, golden.rows);
  const resultIdentity = { runId: result.runId, resultId: result.resultId };
  const lastPage = await invoke("read_sql_query_page", {
    request: { ...resultIdentity, offset: golden.rows - 1, limit: 1, columns: ["r0", "r4", "r5"] },
  });
  assert.equal(text(lastPage.rows[0][0]), String(golden.lastId));
  assert.equal(text(lastPage.rows[0][1]), String(BigInt(golden.largeBase) + BigInt(golden.lastId)));
  const lastNanos = BigInt(golden.timeBaseNs) + BigInt(golden.lastId);
  const fraction = String(lastNanos % 1_000_000_000n).padStart(9, "0");
  assert.ok(
    [lastPage.rows[0][2].display, lastPage.rows[0][2].sourceDisplay].some((value) =>
      String(value).includes(`.${fraction}`),
    ),
    "Nanosecond timestamp precision missing",
  );
  const ids = { ...resultIdentity, viewId: `p25-scale-view-${randomUUID()}` };
  await invoke("start_sql_result_view", {
    ...ids,
    plan: {
      projection: ["r3", "r1", "r0", "r2"],
      filters: [
        {
          id: "min-id",
          columnId: "r0",
          scalarType: "number",
          operator: "greaterThanOrEqual",
          values: ["7"],
        },
      ],
      search: null,
      sort: [{ columnId: "r0", direction: "descending", nullsLast: true }],
    },
  });
  const view = await poll(() => invoke("get_sql_result_view_status", ids), terminal);
  assert.equal(view.state, "complete", JSON.stringify(view));
  const selection = { rowStart: 3, rowEndExclusive: 500_000, columnIds: ["r3", "r1", "r0", "r2"] };
  const blockId = `p25-scale-block-${randomUUID()}`;
  const sourceRef = { kind: "sql", ...ids };
  await invoke("capture_chart_selection", {
    request: { requestId: blockId, source: sourceRef, selection },
  });
  const preview = await invoke("read_chart_block_preview", {
    blockId,
    limit: 6,
    columns: selection.columnIds,
  });
  assert.deepEqual(preview.columns, selection.columnIds);
  assert.equal(preview.totalRows, selection.rowEndExclusive - selection.rowStart);
  for (const [index, row] of preview.rows.entries())
    assert.equal(text(row[2]), String(golden.lastId - selection.rowStart - index));
  await invoke("release_sql_result_view", ids);
  await invoke("release_sql_result", resultIdentity);
  const block = { kind: "block", blockId };
  const selectedRows = selection.rowEndExclusive - selection.rowStart;
  const options = [
    { kind: "histogram", x: "r1", histogram: { mode: "width", width: 10 } },
    { kind: "scatter", x: "r0", y: "r1" },
    { kind: "line", x: "r0", y: "r1" },
    { kind: "bar", x: "r2", bar: { aggregate: "count", sort: "category", limit: 4 } },
    { kind: "box", x: "r2", y: "r1" },
    { kind: "violin", x: "r2", y: "r1" },
  ];
  observations.chartKinds = [];
  for (const config of options) {
    const computed = await invoke("compute_chart", {
      request: { requestId: `p25-scale-compute-${randomUUID()}`, source: block, ...config },
    });
    assert.equal(computed.totalRows, selectedRows);
    assert.equal(computed.validRows, selectedRows);
    const minId = golden.lastId - selection.rowEndExclusive + 1;
    const maxId = golden.lastId - selection.rowStart;
    const residueCount = (residue, period) =>
      Math.floor((maxId - residue) / period) - Math.floor((minId - 1 - residue) / period);
    if (config.kind === "histogram") {
      assert.equal(
        computed.bins.reduce((sum, bin) => sum + bin.count, 0),
        selectedRows,
      );
      assert.equal(computed.bins.length, 10);
      for (const [binIndex, bin] of computed.bins.entries()) {
        const expected = Array.from({ length: 10 }, (_, j) =>
          residueCount(binIndex * 10 + j, 100),
        ).reduce((sum, count) => sum + count, 0);
        assert.equal(bin.count, expected, `Selected-view histogram bin ${binIndex}`);
      }
    }
    if (["box", "violin", "bar"].includes(config.kind)) {
      assert.equal(
        computed.groups.reduce((sum, group) => sum + group.count, 0),
        selectedRows,
      );
      for (const group of computed.groups)
        assert.equal(group.count, residueCount("ABCD".indexOf(group.label), 4));
    }
    if (config.kind === "scatter") {
      assert.ok(computed.scatterExtent);
      assert.equal(computed.scatterExtent[0], minId);
      assert.equal(computed.scatterExtent[1], maxId);
      const detail = await invoke("compute_chart", {
        request: { requestId: `p25-scale-detail-${randomUUID()}`, source: block, ...config },
        detail: { kind: "range", x: [maxId - 2, maxId], y: [0, 100] },
      });
      assert.equal(detail.validRows, 3);
      assert.deepEqual(
        detail.points.map(([x]) => x).sort((a, b) => a - b),
        [maxId - 2, maxId - 1, maxId],
      );
    }
    observations.chartKinds.push(config.kind);
  }
  const afterRelease = await invoke("read_chart_block_preview", {
    blockId,
    limit: 1,
    columns: ["r0"],
  });
  assert.equal(text(afterRelease.rows[0][0]), String(golden.lastId - selection.rowStart));
  await invoke("release_chart_block", { blockId });
  await assert.rejects(invoke("read_chart_block_preview", { blockId, limit: 1, columns: ["r0"] }));
  observations.filteredSelectedRows = selectedRows;
  observations.releasedViewAndResultRemainReadable = true;
  return observations;
}
