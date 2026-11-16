import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { writeFile } from "node:fs/promises";
import type { ReadPageRequest, StartCopyRequest } from "../src/backend";
import type { FileDragDropEvent } from "../src/dragDrop";
import type { SqlPageRequest } from "../src/sql-workspace/backend";
import {
  expectInsideViewport,
  expectNoHorizontalPageOverflow,
  openMockFile,
  waitForScrollIdle,
} from "./helpers";

const workspace = (page: Page, name: "Data" | "SQL" | "Charts") =>
  page.getByRole("button", { name: `${name} workspace`, exact: true });
const sql = (page: Page) => page.getByRole("region", { name: "SQL workspace", exact: true });
const charts = (page: Page) => page.getByRole("region", { name: "Charts workspace", exact: true });
const editor = (page: Page) => sql(page).getByRole("textbox", { name: "SQL editor", exact: true });
const queryTabs = (page: Page) => page.getByRole("tablist", { name: "SQL tabs", exact: true });
const sheets = (page: Page) => page.getByRole("tablist", { name: "Chart sheets", exact: true });
const fileTabs = (page: Page) => page.getByRole("tablist", { name: "Open files", exact: true });
const grid = (owner: Page | Locator) =>
  owner.getByRole("grid", { name: "Data preview", exact: true });
const results = (page: Page) => sql(page).getByRole("tabpanel", { name: "Results", exact: true });
const cell = (table: Locator, row: number, column: number) =>
  table.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
const header = (table: Locator, column: number) =>
  table.locator(`[role="columnheader"][data-column-index="${column}"]`);
const headerLabel = (table: Locator, column: number) =>
  header(table, column).locator(":scope > span");
const related = (page: Page) =>
  page.getByRole("complementary", { name: "Related Work", exact: true });
const sqlReference = (page: Page) =>
  page.getByRole("complementary", { name: "SQL source reference", exact: true });
const chartReference = (page: Page) =>
  page.getByRole("complementary", { name: "Chart source reference", exact: true });

interface WorkspacesProbe {
  files: ReadPageRequest[];
  sql: SqlPageRequest[];
  copies: StartCopyRequest[];
  holdFileSession?: string;
  releaseFile?: () => void;
  releasedFile?: boolean;
}

async function installProbe(page: Page) {
  await page.evaluate(async () => {
    const backendUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!backendUrl) throw new Error("Browser backend module did not load.");
    const module = (await (0, eval)(
      `import(${JSON.stringify(backendUrl)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend;
    const api = backend.sqlWorkspace;
    if (!api) throw new Error("SQL browser backend is unavailable.");
    const probe: WorkspacesProbe = { files: [], sql: [], copies: [] };
    Reflect.set(window, "__phase25Workspaces", probe);

    const readFilePage = backend.readPage.bind(backend);
    backend.readPage = async (request) => {
      probe.files.push(structuredClone(request));
      const result = await readFilePage(request);
      if (request.limit === 200 && request.sessionId === probe.holdFileSession) {
        delete probe.holdFileSession;
        await new Promise<void>((resolve) => {
          probe.releaseFile = resolve;
        });
        probe.releasedFile = true;
      }
      return result;
    };
    const readSqlPage = api.readPage.bind(api);
    api.readPage = (request) => {
      probe.sql.push(structuredClone(request));
      return readSqlPage(request);
    };
    const startCopy = backend.startCopy.bind(backend);
    backend.startCopy = (request) => {
      probe.copies.push(structuredClone(request));
      return startCopy(request);
    };
  });
}

const probe = (page: Page) =>
  page.evaluate(() => {
    const { files, sql, copies, releaseFile, releasedFile } = Reflect.get(
      window,
      "__phase25Workspaces",
    ) as WorkspacesProbe;
    return { files, sql, copies, heldFile: Boolean(releaseFile), releasedFile };
  });

async function emitDrop(page: Page, event: FileDragDropEvent) {
  await page.evaluate(async (payload) => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/dragDrop.ts");
    if (!moduleUrl) throw new Error("Browser drag/drop adapter did not load.");
    const module = (await (0, eval)(
      `import(${JSON.stringify(moduleUrl)})`,
    )) as typeof import("../src/dragDrop");
    module.emitBrowserDragDropEvent(payload);
  }, event);
}

async function openFixture(page: Page) {
  await page.goto("/?mock=sql22");
  await installProbe(page);
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(
    fileTabs(page).getByRole("tab", { name: "orders.csv (sales)", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(cell(grid(page), 0, 0)).toHaveText("0");
}

async function run(page: Page, statement: string) {
  await editor(page).fill(statement);
  await sql(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(grid(results(page))).toHaveAttribute("aria-rowcount", "4");
  await expect(sql(page).getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await expect(cell(grid(results(page)), 0, 1)).toHaveText("Seoul");
}

async function capture(page: Page, info: TestInfo, name: string, landmarks: Locator[]) {
  // The SQL22 mock exposes CSV rows directly. Close its baseline prep warning
  // for the populated reference images after all interaction assertions.
  const mockPrepWarning = page
    .getByRole("alert")
    .filter({ hasText: "The current file is not CSV." });
  if (await mockPrepWarning.isVisible()) {
    await mockPrepWarning.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  await expectNoHorizontalPageOverflow(page);
  const controls = [
    workspace(page, "Data"),
    workspace(page, "SQL"),
    workspace(page, "Charts"),
    page.getByRole("button", { name: "Files", exact: true }),
    page.getByRole("button", { name: "Open file", exact: true }),
    ...landmarks,
  ];
  for (const control of controls) await expectInsideViewport(control);
  const geometry = await Promise.all(controls.map((control) => control.boundingBox()));
  const toolbarControls = geometry.slice(0, 5);
  for (const [index, first] of toolbarControls.entries()) {
    for (const second of toolbarControls.slice(index + 1)) {
      const overlapX =
        Math.min(first!.x + first!.width, second!.x + second!.width) -
        Math.max(first!.x, second!.x);
      const overlapY =
        Math.min(first!.y + first!.height, second!.y + second!.height) -
        Math.max(first!.y, second!.y);
      expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1);
    }
  }
  const primaryContent =
    name === "sql-source-reference" || name === "sql-linked-charts"
      ? editor(page)
      : name === "data-related-work"
        ? grid(page)
        : name === "chart-pinned-sql-reference"
          ? charts(page).getByRole("article", { name: "Histogram chart", exact: true })
          : null;
  const primary = await primaryContent?.boundingBox();
  if (primary) {
    const reference = geometry.at(-1)!;
    expect(primary.x + primary.width).toBeLessThanOrEqual(reference.x + 1);
  }
  const screenshot = info.outputPath(`${name}.png`);
  const measurement = info.outputPath(`${name}-geometry.json`);
  await page.screenshot({ path: screenshot });
  await writeFile(
    measurement,
    JSON.stringify({ viewport: page.viewportSize(), controls: geometry, primary }, null, 2),
  );
  await info.attach(`${name} screenshot`, { path: screenshot, contentType: "image/png" });
  await info.attach(`${name} geometry`, {
    path: measurement,
    contentType: "application/json",
  });
}

async function selectedHeaders(table: Locator, indexes: number[]) {
  await expect(table).toHaveAttribute("data-selection-kind", "column");
  await expect(table).toHaveAttribute("data-selection-column-count", String(indexes.length));
  for (const index of indexes) {
    await expect(header(table, index)).toHaveAttribute("aria-selected", "true");
    await expect(cell(table, 0, index)).toHaveAttribute("aria-selected", "true");
    const [head, body] = await Promise.all([
      header(table, index).boundingBox(),
      cell(table, 0, index).boundingBox(),
    ]);
    expect(head).toBeTruthy();
    expect(body).toBeTruthy();
    expect(Math.abs(head!.x - body!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(head!.width - body!.width)).toBeLessThanOrEqual(1);
  }
}

test("Phase 25 T-P25-001/002/003/008 Data and SQL preserve exact tabs and reference context", async ({
  page,
}, info) => {
  await openFixture(page);
  await workspace(page, "SQL").click();
  const previous = "SELECT 123 AS existing_draft;";
  await editor(page).fill(previous);
  await workspace(page, "Data").click();
  await cell(grid(page), 1, 1).click();
  await page.getByRole("button", { name: "Open in New SQL Tab", exact: true }).click();
  await expect(workspace(page, "SQL")).toHaveAttribute("aria-pressed", "true");
  const contextualTab = queryTabs(page).getByRole("tab", { selected: true });
  const contextualName = (await contextualTab.textContent())!.trim();
  expect(contextualName).not.toBe("Query 1");
  await expect(editor(page)).toContainText(/\bFROM\s+"?orders"?/i);
  await queryTabs(page).getByRole("tab", { name: "Query 1", exact: true }).click();
  await expect(editor(page)).toHaveText(previous);
  await queryTabs(page).getByRole("tab", { name: contextualName, exact: true }).click();
  const statement = "SELECT * FROM orders LIMIT 4;";
  await run(page, statement);

  await expect(sqlReference(page)).toBeVisible();
  await expect(sql(page).getByRole("button", { name: "Source Data", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const reference = sqlReference(page);
  await reference.getByRole("tab", { name: "Data", exact: true }).click();
  const preview = grid(reference);
  await expect(cell(preview, 1, 2)).toHaveText("102");
  await expect(preview).toHaveAttribute("aria-colcount", "38");
  await expect(preview).toHaveAttribute("aria-rowcount", "4");
  await expect
    .poll(async () =>
      (await probe(page)).files.some(
        (request) =>
          request.sessionId === "browser-sql-session-0" &&
          request.offset === 0 &&
          request.limit === 200 &&
          request.columns !== undefined &&
          request.columns.length <= 64,
      ),
    )
    .toBe(true);
  await reference.getByRole("tab", { name: "Schema", exact: true }).click();
  await expect(reference.getByText("BIGINT", { exact: true }).first()).toBeVisible();
  await expect(editor(page)).toHaveText(statement);
  await expect(cell(grid(results(page)), 0, 1)).toHaveText("Seoul");
  await capture(page, info, "sql-source-reference", [reference]);

  await page.getByRole("button", { name: "Files", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Open Files", exact: true });
  await picker.getByRole("searchbox", { name: "Search open files", exact: true }).fill("customers");
  await expect(picker.getByRole("button", { name: "orders.csv (sales)", exact: true })).toHaveCount(
    0,
  );
  await picker.getByRole("button", { name: "customers.parquet", exact: true }).click();
  await expect(
    fileTabs(page).getByRole("tab", { name: "customers.parquet", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await fileTabs(page).getByRole("tab", { name: "orders.csv (sales)", exact: true }).click();
  await expect(cell(grid(page), 1, 1)).toHaveAttribute("aria-selected", "true");
  const queryLink = related(page).getByRole("button", { name: contextualName, exact: true });
  await expect(queryLink).toBeVisible();
  await queryLink.click();
  await expect(contextualTab).toHaveText(contextualName);
  await expect(editor(page)).toHaveText(statement);
  await expect(cell(grid(results(page)), 0, 1)).toHaveText("Seoul");
});

test("Phase 25 T-P25-003 ignores a late preview when the SQL reference changes source", async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const state = Reflect.get(window, "__phase25Workspaces") as WorkspacesProbe;
    state.holdFileSession = "browser-sql-session-0";
  });
  await workspace(page, "SQL").click();
  await expect.poll(async () => (await probe(page)).heldFile).toBe(true);
  const cachedSource = grid(sqlReference(page));
  await expect(cachedSource).toHaveAttribute("data-session-id", "browser-sql-session-0");
  await expect(cell(cachedSource, 1, 2)).toHaveText("102");
  await sql(page).getByRole("button", { name: "customers", exact: true }).click();
  const preview = grid(sqlReference(page));
  await expect(preview).toHaveAttribute("data-session-id", "browser-sql-session-2");
  await expect(preview.getByRole("columnheader", { name: "이메일", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = Reflect.get(window, "__phase25Workspaces") as WorkspacesProbe;
    state.releaseFile?.();
  });
  await expect.poll(async () => (await probe(page)).releasedFile).toBe(true);
  await expect(preview).toHaveAttribute("data-session-id", "browser-sql-session-2");
  await expect(preview.getByRole("columnheader", { name: "이메일", exact: true })).toBeVisible();
  await expect(preview.getByRole("columnheader", { name: "주문 번호", exact: true })).toHaveCount(
    0,
  );
});

test("Phase 25 T-P25-004/005/006/007/008 uses exact disjoint Data and SQL columns", async ({
  page,
}, info) => {
  await openFixture(page);
  const data = grid(page);
  await headerLabel(data, 0).click();
  await headerLabel(data, 2).click({ modifiers: ["Shift"] });
  await selectedHeaders(data, [0, 1, 2]);
  await headerLabel(data, 1).click({ modifiers: ["Control"] });
  await selectedHeaders(data, [0, 2]);
  await expect(header(data, 1)).not.toHaveAttribute("aria-selected", "true");
  await expect(cell(data, 0, 1)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await probe(page)).copies.at(-1)?.selection)
    .toEqual({
      rowStart: 0,
      rowEndExclusive: 4,
      columnIds: ["주문 번호", "결제 금액"],
    });
  const createChart = page.getByRole("button", {
    name: "Create Chart from Selection",
    exact: true,
  });
  await capture(page, info, "data-disjoint-columns", [createChart]);
  await createChart.click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await expect(destination).toContainText("4 rows · 2 columns");
  await expect
    .poll(
      async () =>
        (await probe(page)).files.find(
          (request) => request.sessionId === "browser-sql-session-0" && request.limit === 4,
        )?.columns,
    )
    .toEqual(["주문 번호", "결제 금액"]);
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  const chartType = charts(page).getByRole("combobox", { name: "Chart type", exact: true });
  await expect(chartType).toHaveValue("");
  await expect(
    charts(page).getByRole("article", { name: "New chart", exact: true }),
  ).toHaveAttribute("data-state", "blocked");
  await chartType.selectOption({ label: "Scatter" });
  const xAxis = charts(page).getByRole("combobox", { name: "X axis", exact: true });
  const yAxis = charts(page).getByRole("combobox", { name: "Y axis", exact: true });
  for (const axis of [xAxis, yAxis]) {
    await expect(axis.getByRole("option", { name: "주문 번호", exact: true })).toHaveCount(1);
    await expect(axis.getByRole("option", { name: "결제 금액", exact: true })).toHaveCount(1);
    await expect(axis.getByRole("option", { name: "고객 번호", exact: true })).toHaveCount(0);
  }
  await xAxis.selectOption("주문 번호");
  await yAxis.selectOption("결제 금액");
  await expect(
    charts(page).getByRole("article", { name: "Scatter chart", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  const originalSheet = sheets(page).getByRole("tab", { selected: true });
  const originalSheetName = (await originalSheet.textContent())!.trim();
  await capture(page, info, "charts-settings", [chartType]);

  await charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();
  const selectedPreview = chartReference(page).getByRole("table", {
    name: "Selection preview",
    exact: true,
  });
  await expect(selectedPreview.getByRole("columnheader")).toHaveText(["주문 번호", "결제 금액"]);
  await expect(selectedPreview.locator("tbody tr").first().getByRole("cell")).toHaveText([
    "0",
    "2",
  ]);
  await expect(selectedPreview.locator("tbody tr").last().getByRole("cell")).toHaveText([
    "300",
    "302",
  ]);
  await expect(selectedPreview.locator('thead [data-chart-column="true"]')).toHaveCount(2);

  await workspace(page, "SQL").click();
  await run(page, "SELECT 1 AS value;");
  const output = grid(results(page));
  await headerLabel(output, 0).click();
  await headerLabel(output, 2).click({ modifiers: ["Control"] });
  await selectedHeaders(output, [0, 2]);
  await expect(cell(output, 0, 1)).toHaveAttribute("aria-selected", "false");
  await waitForScrollIdle(page);
  const pointer = await output.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const header = element.querySelector(".virtual-grid__header")?.getBoundingClientRect();
    const bodyTop = Math.max(viewport.top, header?.bottom ?? viewport.top);
    for (const selected of element.querySelectorAll('[role="gridcell"][aria-selected="true"]')) {
      const bounds = selected.getBoundingClientRect();
      const left = Math.max(bounds.left, viewport.left);
      const right = Math.min(bounds.right, viewport.left + element.clientWidth);
      const top = Math.max(bounds.top, bodyTop);
      const bottom = Math.min(bounds.bottom, viewport.top + element.clientHeight);
      if (right - left < 2 || bottom - top < 2) continue;
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      if (document.elementFromPoint(x, y)?.closest('[role="gridcell"]') === selected)
        return { x, y };
    }
    throw new Error("No selected SQL result cell is visible for a pointer click.");
  });
  await page.mouse.click(pointer.x, pointer.y, { button: "right" });
  const contextAction = page.getByRole("menuitem", {
    name: "Create chart from selection",
    exact: true,
  });
  await expect(contextAction).toBeVisible();
  await contextAction.press("Escape");
  await expect(contextAction).toBeHidden();
  const sqlReadsBeforeCapture = (await probe(page)).sql.length;
  await results(page)
    .getByRole("button", { name: "Create Chart from Selection", exact: true })
    .click();
  await expect(destination).toContainText("4 rows · 2 columns");
  expect((await probe(page)).sql.length).toBe(sqlReadsBeforeCapture);
  await destination.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(originalSheet).toHaveText(originalSheetName);
  await workspace(page, "SQL").click();
  await selectedHeaders(output, [0, 2]);
  await results(page)
    .getByRole("button", { name: "Create Chart from Selection", exact: true })
    .click();
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  await charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();
  const sqlSelectionPreview = chartReference(page).getByRole("table", {
    name: "Selection preview",
    exact: true,
  });
  await expect(sqlSelectionPreview.getByRole("columnheader")).toHaveText(["value", "amount"]);
  await expect(sqlSelectionPreview.locator("tbody tr").first().getByRole("cell")).toHaveText([
    "1",
    "100000.25",
  ]);
  await expect(sqlSelectionPreview.locator("tbody tr").last().getByRole("cell")).toHaveText([
    "4",
    "400000.25",
  ]);
});

test("Phase 25 T-P25-004/008 keeps chart SQL reference attached to the pinned execution", async ({
  page,
}, info) => {
  await openFixture(page);
  await workspace(page, "SQL").click();
  const initial = "SELECT 11 AS initial_execution;";
  await run(page, initial);
  await workspace(page, "Charts").click();
  await charts(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await charts(page).getByRole("combobox", { name: "Data source", exact: true }).selectOption({
    label: "SQL · Query 1",
  });
  await charts(page).getByRole("combobox", { name: "Chart type", exact: true }).selectOption({
    label: "Histogram",
  });
  await charts(page).getByRole("combobox", { name: "Value", exact: true }).selectOption("r2");
  const chart = charts(page).getByRole("article", { name: "Histogram chart", exact: true });
  await expect(chart).toHaveAttribute("data-state", "ready");
  await charts(page).getByRole("combobox", { name: "Refresh mode", exact: true }).selectOption({
    label: "Pin this result",
  });
  const pinned = await chart.getAttribute("data-result-id");
  expect(pinned).toBeTruthy();

  const reference = chartReference(page);
  await charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();
  const resultPreview = reference.getByRole("table", { name: "SQL result preview", exact: true });
  await expect(resultPreview.getByText("Seoul", { exact: true })).toBeVisible();
  await expect(reference.getByText("1–4 / 4 rows", { exact: true })).toBeVisible();
  await expect(
    resultPreview.getByRole("columnheader", { name: "amount", exact: true }),
  ).toHaveAttribute("data-chart-column", "true");
  const previewReads = async () =>
    (await probe(page)).sql.filter(
      (request) => request.resultId === pinned && request.offset === 0 && request.limit === 6,
    );
  expect(await previewReads()).toHaveLength(1);
  await reference.getByRole("button", { name: "Query", exact: true }).click();
  await expect(reference).toContainText(initial);
  await reference.getByRole("button", { name: "Open in SQL", exact: true }).click();
  await expect(queryTabs(page).getByRole("tab", { name: "Query 1", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const linkedReference = sqlReference(page);
  await expect(linkedReference).toBeVisible();
  await linkedReference.getByRole("tab", { name: "Linked Charts", exact: true }).click();
  await expect(
    linkedReference.getByRole("img", { name: "Histogram chart preview", exact: true }),
  ).toBeVisible();
  await capture(page, info, "sql-linked-charts", [linkedReference]);
  await linkedReference
    .getByRole("button", { name: "Open Histogram chart in Charts", exact: true })
    .click();
  await expect(chart).toHaveAttribute("data-result-id", pinned!);
  await expect(reference).toContainText(initial);
  await workspace(page, "SQL").click();
  const next = "SELECT 22 AS next_execution;";
  await run(page, next);
  await workspace(page, "Charts").click();
  await expect(chart).toHaveAttribute("data-result-id", pinned!);
  await expect(reference).toContainText(initial);
  await reference.getByRole("button", { name: "Result Preview", exact: true }).click();
  await expect(resultPreview.getByText("Seoul", { exact: true })).toBeVisible();
  expect(await previewReads()).toHaveLength(1);
  await reference.getByRole("button", { name: "Query", exact: true }).click();
  await expect(reference).toContainText(initial);
  await expect(reference).not.toContainText(next);
  await expect(reference.getByRole("button", { name: "Open in SQL", exact: true })).toHaveCount(0);
  await capture(page, info, "chart-pinned-sql-reference", [reference]);

  await charts(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await charts(page).getByRole("combobox", { name: "Data source", exact: true }).selectOption({
    label: "File · orders.csv (archive)",
  });
  const fileChart = charts(page).getByRole("article", { name: "New chart", exact: true });
  await charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();
  await expect(
    reference.getByRole("table", { name: "File data preview", exact: true }),
  ).toBeVisible();
  await chart.getByRole("button", { name: "Histogram chart", exact: true }).press("Enter");
  await expect(resultPreview.getByText("Seoul", { exact: true })).toBeVisible();
  await expect(chart.getByText("Reference open", { exact: true })).toBeVisible();
  await fileChart.getByRole("button", { name: "New chart", exact: true }).click();
  await expect(
    reference.getByRole("table", { name: "File data preview", exact: true }),
  ).toBeVisible();
  await expect(fileChart.getByText("Reference open", { exact: true })).toBeVisible();
  await fileChart.scrollIntoViewIfNeeded();
  await capture(page, info, "chart-switch-source-reference", [reference, fileChart]);
  await fileChart.getByRole("button", { name: "Edit New chart", exact: true }).click();
  await expect(
    charts(page).getByRole("complementary", { name: "Chart settings", exact: true }),
  ).toBeVisible();
});

test("Phase 25 T-P25-021 previews captured file and SQL cells after their origins close", async ({
  page,
}, info) => {
  await openFixture(page);
  const reference = chartReference(page);
  const selection = reference.getByRole("table", { name: "Selection preview", exact: true });
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  const addSelected = async (table: Locator, owner: Page | Locator) => {
    await cell(table, 1, 0).click();
    await cell(table, 2, 2).click({ modifiers: ["Shift"] });
    await owner.getByRole("button", { name: "Create Chart from Selection", exact: true }).click();
    await expect(destination).toContainText("2 rows · 3 columns");
    await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  };
  const expectValues = async (columns: string[], rows: string[][]) => {
    await expect(selection.getByRole("columnheader")).toHaveText(columns);
    await expect(selection.locator("tbody tr")).toHaveCount(rows.length);
    for (const [index, values] of rows.entries())
      await expect(selection.locator("tbody tr").nth(index).getByRole("cell")).toHaveText(values);
    await expect(reference.getByText("1–2 / 2 rows", { exact: true })).toBeVisible();
  };
  const openReference = () =>
    charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();

  await addSelected(grid(page), page);
  const title = charts(page).getByRole("textbox", { name: "Chart title", exact: true });
  await title.fill("Captured file rows");
  await charts(page).getByRole("combobox", { name: "Chart type", exact: true }).selectOption({
    label: "Histogram",
  });
  await charts(page)
    .getByRole("combobox", { name: "Value", exact: true })
    .selectOption("결제 금액");
  await openReference();
  await expectValues(
    ["주문 번호", "고객 번호", "결제 금액"],
    [
      ["100", "101", "102"],
      ["200", "201", "202"],
    ],
  );
  await expect(selection.getByRole("columnheader", { name: "결제 금액" })).toHaveAttribute(
    "data-chart-column",
    "true",
  );
  await reference.getByRole("button", { name: "Schema", exact: true }).click();
  await expect(reference.getByRole("table", { name: "Source schema", exact: true })).toBeVisible();
  await reference.getByRole("button", { name: "Selection Preview", exact: true }).click();
  await workspace(page, "Data").click();
  await page.getByRole("button", { name: "Close orders.csv (sales)", exact: true }).click();
  await workspace(page, "Charts").click();
  await expectValues(
    ["주문 번호", "고객 번호", "결제 금액"],
    [
      ["100", "101", "102"],
      ["200", "201", "202"],
    ],
  );
  await expect(reference.getByRole("button", { name: "Open Original File" })).toHaveCount(0);
  await capture(page, info, "chart-captured-file-reference", [reference]);

  await workspace(page, "SQL").click();
  await run(page, "SELECT 1 AS captured_rows;");
  await addSelected(grid(results(page)), results(page));
  await title.fill("Captured SQL rows");
  await openReference();
  const headers = ["value", "value", "amount"];
  const values = [
    ["2", "Busan", "200000.25"],
    ["3", "Incheon", "300000.25"],
  ];
  await expectValues(headers, values);
  await workspace(page, "SQL").click();
  await page.getByRole("button", { name: "Close Query 1", exact: true }).click();
  await workspace(page, "Charts").click();
  await expectValues(headers, values);
  await expect(reference.getByRole("button", { name: "Open Original SQL Tab" })).toHaveCount(0);
  await capture(page, info, "chart-captured-sql-reference", [reference]);
});

test("Phase 25 T-P25-022/023/024 selects chart chrome and deletes through the keyboard or menu", async ({
  page,
}, info) => {
  await openFixture(page);
  await workspace(page, "Charts").click();
  const addChart = charts(page).getByRole("button", { name: "Add chart", exact: true });
  const title = charts(page).getByRole("textbox", { name: "Chart title", exact: true });
  const chartType = charts(page).getByRole("combobox", { name: "Chart type", exact: true });
  for (const name of ["Orders one", "Orders two"]) {
    await addChart.click();
    await title.fill(name);
    await chartType.selectOption({ label: "Histogram" });
    await expect(charts(page).getByRole("article", { name, exact: true })).toHaveAttribute(
      "data-state",
      "ready",
    );
  }
  const first = charts(page).getByRole("article", { name: "Orders one", exact: true });
  const second = charts(page).getByRole("article", { name: "Orders two", exact: true });
  const secondTitle = second.getByRole("button", { name: "Orders two", exact: true });
  const reference = chartReference(page);
  const menu = page.getByRole("menu", { name: "Chart actions", exact: true });
  await charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();
  await first.locator("footer").click({ position: { x: 8, y: 8 } });
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(first).toBeFocused();
  await expect(reference.getByRole("heading", { name: "Orders one" })).toBeVisible();
  await second.locator("canvas").first().click();
  await expect(second).toHaveAttribute("data-selected", "false");
  await expect(reference.getByRole("heading", { name: "Orders one" })).toBeVisible();

  await second.locator("canvas").first().click({ button: "right" });
  await expect(second).toHaveAttribute("data-selected", "true");
  await expect(menu).toBeVisible();
  await expectInsideViewport(menu);
  await capture(page, info, "chart-context-menu", [reference, menu]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(second).toBeFocused();

  await secondTitle.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "Chart Settings", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Duplicate Chart", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const copy = charts(page).getByRole("article", { name: "Orders two copy", exact: true });
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute("data-selected", "true");
  await expect(copy).toBeFocused();
  await expect(menu).toBeHidden();

  await first.scrollIntoViewIfNeeded();
  await waitForScrollIdle(page);
  await first.locator(".chart-card-title p").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Chart Settings", exact: true }).click();
  await expect(title).toHaveValue("Orders one");
  await title.press("Home");
  await title.press("Delete");
  await expect(title).toHaveValue("rders one");
  await title.fill("Orders one");
  await first.locator("footer").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Delete");
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await expect(copy).toBeVisible();

  await copy.scrollIntoViewIfNeeded();
  await waitForScrollIdle(page);
  await copy.locator(".chart-card-title p").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete Chart", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await expect(second).toBeVisible();
});

test("Phase 25 T-P25-001/002/004 links a file chart to the exact document and sheet", async ({
  page,
}, info) => {
  await openFixture(page);
  await workspace(page, "Charts").click();
  await charts(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await charts(page).getByRole("combobox", { name: "Data source", exact: true }).selectOption({
    label: "File · orders.csv (archive)",
  });
  const title = charts(page).getByRole("textbox", { name: "Chart title", exact: true });
  await title.fill("Archived orders");
  await title.blur();
  const sheet = sheets(page).getByRole("tab", { selected: true });
  const sheetName = (await sheet.textContent())!.trim();
  await charts(page).getByRole("button", { name: "Source Reference", exact: true }).click();
  const reference = chartReference(page);
  await expect(
    reference.getByRole("table", { name: "File data preview", exact: true }),
  ).toBeVisible();
  await expect(reference).toContainText("orders.csv (archive)");
  await expect
    .poll(async () =>
      (await probe(page)).files.some(
        (request) =>
          request.sessionId === "browser-sql-session-1" &&
          request.offset === 0 &&
          request.limit === 6,
      ),
    )
    .toBe(true);
  await reference.getByRole("button", { name: "Open in Data", exact: true }).click();
  await expect(
    fileTabs(page).getByRole("tab", { name: "orders.csv (archive)", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await capture(page, info, "data-related-work", [related(page)]);
  await related(page).getByRole("button", { name: "Archived orders", exact: true }).click();
  await expect(sheet).toHaveText(sheetName);
  await expect(
    charts(page).getByRole("article", { name: "Archived orders", exact: true }),
  ).toBeVisible();
});

test("Phase 25 T-P25-009 displays the external multi-file drop target in each workspace", async ({
  page,
}, info) => {
  const paths = ["C:\\Drop\\dropped.parquet", "C:\\Drop\\dropped.csv"];
  const position = new PhysicalPosition(240, 180);
  for (const name of ["Data", "SQL", "Charts"] as const) {
    await page.goto("/");
    await workspace(page, name).click();
    await expect(workspace(page, name)).toHaveAttribute("aria-pressed", "true");
    const overlay = page.getByTestId("drop-target");
    await emitDrop(page, { type: "enter", paths, position });
    await expect(overlay).toContainText("Open 2 files");
    await expectInsideViewport(overlay);
    await emitDrop(page, { type: "leave" });
    await expect(overlay).toBeHidden();
    await emitDrop(page, { type: "enter", paths, position });
    if (name === "Charts") {
      const screenshot = info.outputPath("charts-file-drop.png");
      await page.screenshot({ path: screenshot });
      await info.attach("Charts multi-file drop", { path: screenshot, contentType: "image/png" });
    }
    await emitDrop(page, { type: "drop", paths, position });
    await expect(overlay).toBeHidden();
    await workspace(page, "Data").click();
    for (const fileName of ["dropped.parquet", "dropped.csv"]) {
      await expect(fileTabs(page).getByRole("tab", { name: fileName, exact: true })).toHaveCount(1);
    }
  }
});

test("Phase 25 T-P25-006 streams selected large file columns without a snapshot capture", async ({
  page,
}) => {
  await page.goto("/");
  await installProbe(page);
  await openMockFile(page, "large", "large-5850000.parquet");
  const data = grid(page);
  await headerLabel(data, 0).click();
  await headerLabel(data, 2).click({ modifiers: ["Control"] });
  await selectedHeaders(data, [0, 2]);
  await page.getByRole("button", { name: "Create Chart from Selection", exact: true }).click();
  const destination = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await expect(destination).toContainText("5,850,000 rows · 2 columns");
  const countBeforeAdd = (await probe(page)).files.length;
  await destination.getByRole("button", { name: "Add chart", exact: true }).click();
  await expect(
    charts(page).getByRole("article", { name: "New chart", exact: true }),
  ).toHaveAttribute("data-state", "blocked");
  await expect(charts(page).getByRole("combobox", { name: "Chart type", exact: true })).toHaveValue(
    "",
  );
  expect((await probe(page)).files).toHaveLength(countBeforeAdd);
});
