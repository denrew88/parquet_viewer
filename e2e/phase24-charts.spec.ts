import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow, openMockFile } from "./helpers";

const sql = (page: Page) => page.getByRole("region", { name: "SQL workspace", exact: true });
const charts = (page: Page) => page.getByRole("region", { name: "Charts workspace", exact: true });
const editor = (page: Page) => sql(page).getByRole("textbox", { name: "SQL editor", exact: true });
const sqlTabs = (page: Page) => page.getByRole("tablist", { name: "SQL tabs", exact: true });
const results = (page: Page) => sql(page).getByRole("tabpanel", { name: "Results", exact: true });
const dataGrid = (owner: Page | Locator) =>
  owner.getByRole("grid", { name: "Data preview", exact: true });
const cell = (grid: Locator, row: number, column: number) =>
  grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
const card = (page: Page, title: string) =>
  charts(page).getByRole("article", { name: title, exact: true });
const combo = (owner: Locator, name: string) => owner.getByRole("combobox", { name, exact: true });

async function openSql(page: Page) {
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  await expect(sql(page)).toBeVisible();
}

async function openCharts(page: Page) {
  await page.getByRole("button", { name: "Charts workspace", exact: true }).click();
  await expect(charts(page)).toBeVisible();
}

async function run(page: Page, statement: string) {
  await editor(page).fill(statement);
  await sql(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(sql(page).getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await expect(dataGrid(results(page))).toHaveAttribute("aria-rowcount", "4");
}

async function chooseOption(select: Locator, name: RegExp) {
  const option = select.locator("option").filter({ hasText: name });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(value!);
}

async function addHistogram(page: Page, source: RegExp, title: string) {
  await charts(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await chooseOption(combo(charts(page), "Data source"), source);
  await expect(combo(charts(page), "Chart type")).toHaveValue("");
  const draft = card(page, "New chart");
  await expect(draft).toHaveAttribute("data-state", "blocked");
  await expect(draft.locator("canvas")).toHaveCount(0);
  await combo(charts(page), "Chart type").selectOption({ label: "Histogram" });
  await chooseOption(combo(charts(page), "Value"), /^amount$/);
  const field = charts(page).getByRole("textbox", { name: "Chart title", exact: true });
  await field.fill(title);
  await field.blur();
  const added = card(page, title);
  await added.scrollIntoViewIfNeeded();
  await expect(added).toHaveAttribute("data-state", "ready");
  await expect(added.locator("canvas").first()).toBeVisible();
  return added;
}

async function selectAndSend(page: Page, grid: Locator, keyboard = false) {
  await cell(grid, 0, 0).click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(grid).toHaveAttribute("data-selection-bottom", "1");
  await expect(grid).toHaveAttribute("data-selection-right", "1");
  if (keyboard) await grid.press("Shift+F10");
  else await cell(grid, 0, 0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create chart from selection", exact: true }).click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await expect(destination).toBeVisible();
  await expectInsideViewport(destination);
  await chooseOption(combo(destination, "Destination sheet"), /^New sheet/);
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  await expect(charts(page)).toBeVisible();
  return charts(page).getByRole("article");
}

test("Phase 24 SQL tab naming keeps the editor, result, and linked chart", async ({
  page,
}, info) => {
  await page.goto("/?mock=sql22");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await openSql(page);
  const statement = "SELECT 11 AS amount;";
  await run(page, statement);
  await openCharts(page);
  const linked = await addHistogram(page, /^SQL · Query 1$/, "Order distribution");
  const resultId = await linked.getAttribute("data-result-id");
  expect(resultId).toBeTruthy();
  await openSql(page);
  const tab = sqlTabs(page).getByRole("tab", { name: "Query 1", exact: true });
  const name = page.getByRole("textbox", { name: "SQL tab name", exact: true });

  await tab.press("F2");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Query 1");
  await name.fill(" ");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await name.press("Escape");
  await expect(tab).toBeFocused();

  await tab.dblclick();
  await expect(name).toBeFocused();
  await name.press("Escape");
  await page.getByRole("button", { name: "Rename tab", exact: true }).click();
  await name.fill("  요가 주문  ");
  const controls = page.getByRole("navigation", { name: "SQL tab controls", exact: true });
  await expectInsideViewport(controls);
  await expectNoHorizontalPageOverflow(page);
  await controls.screenshot({ path: info.outputPath("sql-tab-rename.png") });
  await name.press("Enter");
  await expect(sqlTabs(page).getByRole("tab", { name: "요가 주문", exact: true })).toBeFocused();
  await expect(editor(page)).toHaveText(statement);
  await expect(dataGrid(results(page))).toHaveAttribute("aria-rowcount", "4");
  await page.getByRole("button", { name: "New SQL tab", exact: true }).click();
  await expect(sqlTabs(page).getByRole("tab", { name: "Query 2", exact: true })).toBeVisible();

  await openCharts(page);
  await expect(linked).toHaveAttribute("data-result-id", resultId!);
  await expect(linked).toHaveAttribute("data-state", "ready");
  await expect(linked.getByText("SQL · 요가 주문", { exact: true })).toBeVisible();
  const sources = combo(charts(page), "Data source");
  await expect(sources.getByRole("option", { name: "SQL · 요가 주문", exact: true })).toHaveCount(
    1,
  );
});

test("Phase 24 T-P24-001/002/006 keeps SQL tabs independent and refreshes only linked cards", async ({
  page,
}, info) => {
  await page.goto("/?mock=sql22");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await openSql(page);
  const query1 = sqlTabs(page).getByRole("tab", { name: "Query 1", exact: true });
  await expect(query1).toHaveAttribute("aria-selected", "true");
  await run(page, "SELECT 11 AS amount;");
  await page.getByRole("button", { name: "New SQL tab", exact: true }).click();
  const query2 = sqlTabs(page).getByRole("tab", { name: "Query 2", exact: true });
  await expect(query2).toHaveAttribute("aria-selected", "true");
  await run(page, "SELECT 22 AS amount;");
  await query1.click();
  await expect(editor(page)).toHaveText("SELECT 11 AS amount;");
  await expect(dataGrid(results(page))).toHaveAttribute("aria-rowcount", "4");
  await query2.click();
  await expect(editor(page)).toHaveText("SELECT 22 AS amount;");

  await openCharts(page);
  const left = await addHistogram(page, /Query 1/, "Query one distribution");
  const right = await addHistogram(page, /Query 2/, "Query two distribution");
  await left.getByRole("button", { name: "Edit Query one distribution", exact: true }).click();
  await chooseOption(combo(charts(page), "Filter column"), /^amount$/);
  await charts(page).getByRole("textbox", { name: "Filter value", exact: true }).fill("200000.25");
  await charts(page).getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(left).toContainText("1 valid rows");
  await expect(right).toContainText("4 valid rows");
  const firstId = await left.getAttribute("data-result-id");
  const secondId = await right.getAttribute("data-result-id");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(firstId).not.toEqual(secondId);
  await right.getByRole("button", { name: "Edit Query two distribution", exact: true }).click();
  await combo(charts(page), "Refresh mode").selectOption({ label: "Pin this result" });

  await openSql(page);
  await query1.click();
  await run(page, "SELECT 33 AS amount;");
  await openCharts(page);
  await left.scrollIntoViewIfNeeded();
  await expect(left).not.toHaveAttribute("data-result-id", firstId!);
  await expect(right).toHaveAttribute("data-result-id", secondId!);
  await expect(left).toHaveAttribute("data-state", "ready");
  const refreshed = await left.getAttribute("data-result-id");
  expect(refreshed).toBeTruthy();

  await openSql(page);
  await editor(page).fill("SELECT 44 AS amount; /* fail */");
  await sql(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    sql(page)
      .getByText(/mock sql failure/i)
      .first(),
  ).toBeVisible();
  await editor(page).fill("SELECT 55 AS amount; /* slow */");
  await sql(page).getByRole("button", { name: "Run", exact: true }).click();
  const cancel = sql(page).getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeEnabled();
  await query2.click();
  await editor(page).fill("SELECT 77 AS amount;");
  const runButton = sql(page).getByRole("button", { name: "Run", exact: true });
  await runButton.click();
  await expect(runButton).toBeDisabled();
  await expect(dataGrid(results(page))).toHaveAttribute("aria-rowcount", "4");
  await query1.click();
  await cancel.click();
  await expect(cancel).toBeDisabled();
  await query2.click();
  await expect(runButton).toBeEnabled();
  await expect(dataGrid(results(page))).toHaveAttribute("aria-rowcount", "4");
  await query1.click();
  await editor(page).fill("SELECT 66 AS amount;");
  await sql(page).getByRole("button", { name: "Explain", exact: true }).click();
  await expect(sql(page).getByRole("tab", { name: "Execution plan", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Close Query 2", exact: true }).click();
  await expect(query2).toHaveCount(0);
  await openCharts(page);
  await expect(left).toHaveAttribute("data-result-id", refreshed!);
  await expect(right).toHaveAttribute("data-result-id", secondId!);

  const workspace = charts(page);
  await left.scrollIntoViewIfNeeded();
  await expectNoHorizontalPageOverflow(page);
  await expectInsideViewport(workspace.getByRole("tablist", { name: "Chart sheets" }));
  const geometry = await workspace.evaluate((element) => {
    const measure = (item: Element) => {
      const rect = item.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
        clientWidth: item.clientWidth,
        scrollWidth: item.scrollWidth,
      };
    };
    const list = (selector: string) =>
      [...element.querySelectorAll(selector)]
        .filter((item) => item.getClientRects().length)
        .map(measure);
    return {
      workspace: measure(element),
      sheet: list(".chart-sheet-scroll"),
      inspector: list(".chart-inspector"),
      cards: list(".chart-card"),
      plots: list(".chart-plot"),
    };
  });
  expect(geometry.cards).toHaveLength(2);
  expect(geometry.plots).toHaveLength(2);
  expect(geometry.workspace.scrollWidth).toBeLessThanOrEqual(geometry.workspace.clientWidth + 1);
  for (const bounds of [...geometry.cards, ...geometry.plots]) {
    expect(bounds.width).toBeGreaterThan(100);
    expect(bounds.height).toBeGreaterThan(60);
    expect(bounds.right).toBeLessThanOrEqual(geometry.workspace.right + 1);
  }
  const [first, second] = geometry.cards;
  expect(first!.right <= second!.x + 1 || first!.bottom <= second!.y + 1).toBe(true);
  for (const panel of geometry.inspector) {
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    expect(panel.right).toBeLessThanOrEqual(geometry.workspace.right + 1);
  }
  const geometryPath = info.outputPath("phase24-geometry.json");
  await writeFile(
    geometryPath,
    JSON.stringify({ viewport: page.viewportSize(), ...geometry }, null, 2),
  );
  await info.attach("Phase 24 chart geometry", {
    path: geometryPath,
    contentType: "application/json",
  });
  await info.attach("Phase 24 chart workspace", {
    body: await page.screenshot({ path: info.outputPath("phase24-charts.png") }),
    contentType: "image/png",
  });

  const move = right.getByRole("button", { name: "Move Query two distribution" });
  if (info.project.name === "desktop-wide") {
    await move.dragTo(left.getByRole("heading", { name: "Query one distribution" }));
    await expect(workspace.getByRole("article").first()).toHaveAccessibleName(
      "Query two distribution",
    );
    await move.press("ArrowRight");
    await expect(workspace.getByRole("article").first()).toHaveAccessibleName(
      "Query one distribution",
    );
  }
  const resize = right.getByRole("separator", { name: "Resize Query two distribution" });
  const height = Number(await resize.getAttribute("aria-valuenow"));
  await resize.press("ArrowDown");
  await expect(resize).toHaveAttribute("aria-valuenow", String(height + 30));
  const defaultWidth = (await right.boundingBox())!.width;
  await resize.press("ArrowLeft");
  await expect.poll(async () => (await right.boundingBox())!.width).toBeLessThan(defaultWidth);
  const width = (await right.boundingBox())!.width;
  await resize.press("ArrowRight");
  await expect.poll(async () => (await right.boundingBox())!.width).toBeGreaterThan(width);
  await move.press("ArrowLeft");
  await expect(workspace.getByRole("article").first()).toHaveAccessibleName(
    "Query two distribution",
  );
  await expect(right).toHaveAttribute("data-result-id", secondId!);
  if (info.project.name === "desktop-wide") {
    await resize.scrollIntoViewIfNeeded();
    const handle = await resize.boundingBox();
    expect(handle).not.toBeNull();
    const x = handle!.x + handle!.width / 2;
    const y = handle!.y + handle!.height / 2;
    const startWidth = (await right.boundingBox())!.width;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y + 10, { steps: 5 });
    await expect
      .poll(async () => (await right.boundingBox())!.width)
      .toBeGreaterThan(startWidth + 17);
    await page.mouse.move(x + 44, y + 25, { steps: 5 });
    await expect
      .poll(async () => (await right.boundingBox())!.width)
      .toBeGreaterThan(startWidth + 41);
    await page.mouse.up();
    await expect(resize).toHaveAttribute("aria-valuenow", String(height + 55));
  }
});

test("Phase 24 T-P24-003/004 sends file and SQL selections to independent sheets", async ({
  page,
}) => {
  await page.goto("/?mock=sql22");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  const fileGrid = dataGrid(page);
  await expect(fileGrid).toHaveAttribute("aria-rowcount", "4");
  const fileBlock = await selectAndSend(page, fileGrid);
  await expect(fileBlock).toHaveCount(1);
  await expect(fileBlock).toContainText(/selected cells/i);
  const fileSheet = charts(page)
    .getByRole("tablist", { name: "Chart sheets" })
    .locator('[aria-selected="true"]');
  const fileSheetName = (await fileSheet.textContent())!.trim();

  await openSql(page);
  await run(page, "SELECT 11 AS amount;");
  const sqlBlock = await selectAndSend(page, dataGrid(results(page)), true);
  await expect(sqlBlock).toHaveCount(1);
  await expect(sqlBlock).toContainText(/selected cells/i);
  await expect(fileSheet).not.toHaveText(fileSheetName);
  const sqlSheetName = (await fileSheet.textContent())!.trim();

  await openSql(page);
  await run(page, "SELECT 33 AS amount;");
  await openCharts(page);
  await expect(charts(page).getByRole("tab", { name: sqlSheetName, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sqlBlock).toContainText(/selected cells/i);
  await charts(page).getByRole("tab", { name: fileSheetName, exact: true }).click();
  await expect(fileBlock).toHaveCount(1);
  await expect(fileBlock).toContainText(/selected cells/i);
  await charts(page).getByRole("button", { name: "Close sheet", exact: true }).click();
  await expect(charts(page).getByRole("tab", { name: fileSheetName, exact: true })).toHaveCount(0);
  await expect(charts(page).getByRole("tab", { name: sqlSheetName, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sqlBlock).toContainText(/selected cells/i);
});

test("Phase 24 streams a whole category column above the fixed chart selection limit", async ({
  page,
}) => {
  await page.goto("/");
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = dataGrid(page);
  await expect(grid).toHaveAttribute("aria-rowcount", "5850000");
  const header = grid.locator('[role="columnheader"][data-column-index="1"]');
  await header.getByText("category", { exact: true }).click();
  await expect(grid).toHaveAttribute("data-selection-bottom", "5849999");
  await cell(grid, 0, 1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create chart from selection", exact: true }).click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await expect(destination).toContainText("5,850,000 rows · 1 column");
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  await expect(card(page, "New chart")).toHaveAttribute("data-state", "blocked");
  await expect(combo(charts(page), "Chart type")).toHaveValue("");
  await combo(charts(page), "Chart type").selectOption({ label: "Bar" });
  await expect(combo(charts(page), "Group")).toHaveValue("category");
  await expect(combo(charts(page), "Group").locator("option")).toHaveCount(2);
  await expect(combo(charts(page), "Value")).toHaveValue("");
  const bar = card(page, "Bar chart");
  await expect(bar).toHaveAttribute("data-state", "loading");
  await bar.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(bar).toHaveAttribute("data-state", "cancelled");
});
