import assert from "node:assert/strict";
import path from "node:path";

// Phase 24's native harness owns the candidate process and CDP connection.
// This scenario exercises the real WebView and Rust IPC with its orders fixture.
export async function verifyPhase25Workspaces({ page, check, scratch }) {
  const navigate = (name) => page.getByRole("button", { name: `${name} workspace`, exact: true });
  const sql = page.getByRole("region", { name: "SQL workspace", exact: true });
  const charts = page.getByRole("region", { name: "Charts workspace", exact: true });
  const files = page.getByRole("tablist", { name: "Open files", exact: true });
  const orders = files.getByRole("tab", { name: "orders.parquet", exact: true });
  const editor = sql.getByRole("textbox", { name: "SQL editor", exact: true });
  const data = page.getByRole("grid", { name: "Data preview", exact: true });
  const cell = (grid, row, column) =>
    grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
  const header = (index) => data.locator(`[role="columnheader"][data-column-index="${index}"]`);
  const sqlResult = sql.getByRole("tabpanel", { name: "Results", exact: true });
  const sqlGrid = sqlResult.getByRole("grid", { name: "Data preview", exact: true });

  await navigate("Data").click();
  await orders.click();
  await check(data).toHaveAttribute("aria-rowcount", "640");
  await check(cell(data, 0, 2)).toHaveText("Fitness");
  const expectedFirst = [await cell(data, 0, 1).textContent(), await cell(data, 0, 3).textContent()];

  await header(1).getByText("ordinal", { exact: true }).click();
  await header(3).getByText("amount", { exact: true }).click({ modifiers: ["Shift"] });
  await check(data).toHaveAttribute("data-selection-column-count", "3");
  await header(2).getByText("category", { exact: true }).click({ modifiers: ["Control"] });
  await check(data).toHaveAttribute("data-selection-column-count", "2");
  await check(cell(data, 0, 1)).toHaveAttribute("aria-selected", "true");
  await check(cell(data, 0, 2)).toHaveAttribute("aria-selected", "false");
  await check(cell(data, 0, 3)).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: path.join(scratch, "native-data-selection.png") });

  await page.getByRole("button", { name: "Create Chart from Selection", exact: true }).click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await check(destination).toContainText("640 rows · 2 columns");
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  const kind = charts.getByRole("combobox", { name: "Chart type", exact: true });
  await check(kind).toHaveValue("");
  await kind.selectOption({ label: "Scatter" });
  const x = charts.getByRole("combobox", { name: "X axis", exact: true });
  const y = charts.getByRole("combobox", { name: "Y axis", exact: true });
  await check(x.getByRole("option", { name: "category", exact: true })).toHaveCount(0);
  await check(y.getByRole("option", { name: "category", exact: true })).toHaveCount(0);
  await x.selectOption("ordinal");
  await y.selectOption("amount");
  const chart = charts.getByRole("article", { name: "Scatter chart", exact: true });
  await check(chart).toHaveAttribute("data-state", "ready");
  await check(chart).toContainText("640 valid rows");
  await check(chart.locator("canvas").first()).toBeVisible();
  await charts.getByRole("button", { name: "Source Reference", exact: true }).click();
  const chartReference = page.getByRole("complementary", { name: "Chart source reference" });
  const snapshotPreview = chartReference.getByRole("table", { name: "Selection preview", exact: true });
  await check(snapshotPreview.locator("tbody tr")).toHaveCount(6);
  assert.deepEqual(await snapshotPreview.locator("tbody tr").first().locator("td").allTextContents(), expectedFirst);
  await check(chartReference.getByText("1–6 / 640 rows", { exact: true })).toBeVisible();
  await chartReference.getByRole("button", { name: "Schema", exact: true }).click();
  const projectedColumns = await chartReference
    .getByRole("table", { name: "Source schema", exact: true })
    .locator("tbody tr td:first-child")
    .allTextContents();
  assert.deepEqual(projectedColumns, ["ordinal", "amount"]);
  await page.screenshot({ path: path.join(scratch, "native-desktop.png") });
  await chartReference.getByRole("button", { name: "Open Original File", exact: true }).click();
  await check(orders).toHaveAttribute("aria-selected", "true");
  await check(data).toHaveAttribute("data-selection-column-count", "2");

  await page.getByRole("button", { name: "Open in New SQL Tab", exact: true }).click();
  await check(editor).toContainText(/\bFROM\s+"?orders"?/i);
  const selectedSqlTab = page.getByRole("tablist", { name: "SQL tabs", exact: true })
    .getByRole("tab", { selected: true });
  const queryName = (await selectedSqlTab.textContent()).trim();
  const statement = "SELECT ordinal, category, amount FROM orders WHERE ordinal < 2 ORDER BY month, ordinal;";
  await editor.fill(statement);
  await sql.getByRole("button", { name: "Run", exact: true }).click();
  await check(sqlGrid).toHaveAttribute("aria-rowcount", "4");
  await check(cell(sqlGrid, 0, 1)).toHaveText("Fitness");
  await check(cell(sqlGrid, 1, 1)).toHaveText("Outdoor");
  const sqlReference = page.getByRole("complementary", { name: "SQL source reference" });
  await check(sqlReference).toBeVisible();
  await check(sql.getByRole("button", { name: "Source Data", exact: true })).toHaveAttribute("aria-expanded", "true");
  const preview = sqlReference.getByRole("grid", { name: "Data preview", exact: true });
  await check(preview).toHaveAttribute("aria-rowcount", "640");
  await check(cell(preview, 0, 2)).toHaveText("Fitness");
  assert.ok(Number(await preview.getAttribute("data-mounted-rows")) < 70);
  await check(editor).toHaveText(statement);
  await page.screenshot({ path: path.join(scratch, "native-sql-reference.png") });

  await navigate("Charts").click();
  await check(chart).toHaveAttribute("data-state", "ready");
  await navigate("SQL").click();
  await check(editor).toHaveText(statement);
  await check(cell(sqlGrid, 0, 1)).toHaveText("Fitness");
  await navigate("Data").click();
  await check(data).toHaveAttribute("data-selection-column-count", "2");
  const relatedQuery = page.getByRole("complementary", { name: "Related Work", exact: true })
    .getByRole("button", { name: queryName, exact: true });
  await relatedQuery.click();
  await check(selectedSqlTab).toHaveText(queryName);
  await check(editor).toHaveText(statement);
  return { projectedColumns, validChartRows: 640, resultRows: 4, sourceRows: 640, queryName };
}

export async function verifyPhase25CardActions({ page, check, scratch }) {
  await page.getByRole("button", { name: "Charts workspace", exact: true }).click();
  const charts = page.getByRole("region", { name: "Charts workspace", exact: true });
  const chart = charts.getByRole("article", { name: "Scatter chart", exact: true });
  await chart.locator(".chart-card-title p").click();
  await check(chart).toHaveAttribute("data-selected", "true");
  await check(chart).toBeFocused();
  await chart.locator("canvas").first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Chart actions", exact: true });
  await check(menu).toBeVisible();
  await page.screenshot({ path: path.join(scratch, "native-chart-menu.png") });
  await menu.getByRole("menuitem", { name: "Duplicate Chart", exact: true }).click();
  const copy = charts.getByRole("article", { name: "Scatter chart copy", exact: true });
  await check(copy).toBeVisible();
  await check(copy).toBeFocused();
  await page.keyboard.press("Delete");
  await check(copy).toHaveCount(0);
  await check(chart).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await check(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await check(chart).toBeFocused();
  await chart.locator(".chart-card-title p").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete Chart", exact: true }).click();
  await check(chart).toHaveCount(0);
  await check(charts.getByText("No charts in this sheet", { exact: true })).toBeVisible();
  return { keyboardDelete: true, contextDelete: true, snapshotSharedUntilLastRemoval: true };
}
