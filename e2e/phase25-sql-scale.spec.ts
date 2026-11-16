import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReadPageRequest } from "../src/backend";
import type { SqlPageRequest } from "../src/sql-workspace/backend";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const rows = 1_000_257;
const sql = (page: Page) => page.getByRole("region", { name: "SQL workspace", exact: true });
const source = (page: Page) =>
  sql(page).getByRole("complementary", { name: "SQL source reference", exact: true });
const sourceGrid = (page: Page) =>
  source(page).getByRole("grid", { name: "Data preview", exact: true });
const editor = (page: Page) => sql(page).getByRole("textbox", { name: "SQL editor", exact: true });
const cell = (grid: Locator, row: number, column: number) =>
  grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
const workspace = (page: Page, name: "Data" | "SQL" | "Charts") =>
  page.getByRole("button", { name: `${name} workspace`, exact: true });

interface ScaleProbe {
  reads: ReadPageRequest[];
  hold?: string;
  release?: () => void;
  held: boolean;
  released: boolean;
  sqlReads: SqlPageRequest[];
}

async function probe(page: Page) {
  return page.evaluate(() => {
    const p = Reflect.get(window, "__p25Scale") as ScaleProbe;
    return { reads: p.reads, held: p.held, released: p.released, sqlReads: p.sqlReads };
  });
}

async function openScale(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(async (count) => {
    const backendUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!backendUrl) throw new Error("Browser backend did not load");
    const { browserMockBackend: backend } = (await (0, eval)(
      `import(${JSON.stringify(backendUrl)})`,
    )) as typeof import("../src/backend");
    const p: ScaleProbe = { reads: [], held: false, released: false, sqlReads: [] };
    Reflect.set(window, "__p25Scale", p);
    const sourceColumns = new Map<string, string[]>();
    const pageFor = (request: ReadPageRequest) => {
      const customer = request.sessionId === "browser-sql-session-2";
      const projection = request.columns ?? sourceColumns.get(request.sessionId);
      if (!projection) throw new Error("No columns registered for the source fixture");
      return {
        sessionId: request.sessionId,
        offset: request.offset,
        limit: request.limit,
        totalRows: count,
        hasMore: request.offset + request.limit < count,
        columns: projection,
        rows: Array.from(
          { length: Math.max(0, Math.min(request.limit, count - request.offset)) },
          (_, i) =>
            projection.map((column, c) => ({
              kind: "string" as const,
              state: "valid" as const,
              display:
                c === 0
                  ? String(request.offset + i)
                  : `${customer ? "CUSTOMER" : "ORDER"}-${request.offset + i}-${column}`,
            })),
        ),
      };
    };
    const open = backend.selectDataFilePath.bind(backend);
    backend.selectDataFilePath = async (requestId) => {
      const result = await open(requestId);
      if (!result || !("opened" in result)) return result;
      for (const entry of result.opened)
        sourceColumns.set(
          entry.sessionId,
          entry.summary.columns.map((column) => column.name),
        );
      return {
        ...result,
        opened: result.opened.map((entry) => ({
          ...entry,
          summary: {
            ...entry.summary,
            rowCount: count,
            rowCountStatus: {
              ...entry.summary.rowCountStatus,
              state: "complete" as const,
              rowsScanned: count,
            },
          },
          initialPage: pageFor({
            sessionId: entry.sessionId,
            offset: 0,
            limit: 200,
            columns: entry.summary.columns.map((column) => column.name),
          }),
        })),
      };
    };
    const read = backend.readPage.bind(backend);
    backend.readPage = async (request) => {
      p.reads.push(structuredClone(request));
      if (!request.sessionId.startsWith("browser-sql-session-")) return read(request);
      if (p.hold === request.sessionId) {
        delete p.hold;
        p.held = true;
        await new Promise<void>((resolve) => {
          p.release = resolve;
        });
        p.released = true;
      }
      return pageFor(request);
    };
    if (backend.sqlWorkspace) {
      const sqlRead = backend.sqlWorkspace.readPage.bind(backend.sqlWorkspace);
      backend.sqlWorkspace.readPage = async (request) => {
        p.sqlReads.push(structuredClone(request));
        return sqlRead(request);
      };
    }
  }, rows);
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await workspace(page, "SQL").click();
  await expect(source(page)).toBeVisible();
  await expect(sourceGrid(page)).toHaveAttribute("aria-rowcount", String(rows));
  await expect(cell(sourceGrid(page), 0, 0)).toHaveText("0");
  await expect
    .poll(async () => (await sourceGrid(page).boundingBox())?.height ?? 0)
    .toBeGreaterThan(80);
}

async function dragSeparator(page: Page, separator: Locator, delta: number) {
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + delta, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await expectNoHorizontalPageOverflow(page);
  const elements = [sql(page), editor(page), source(page), sourceGrid(page)];
  for (const element of elements) await expectInsideViewport(element);
  const measurements = await Promise.all(
    elements.map((element) =>
      element.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          scrollWidth: e.scrollWidth,
          clientWidth: e.clientWidth,
        };
      }),
    ),
  );
  expect(measurements.every((measurement) => measurement.width > 0 && measurement.height > 0)).toBe(
    true,
  );
  const folder = path.resolve(".tmp/phase-25/sql-scale/ui");
  await mkdir(folder, { recursive: true });
  const screenshot = path.join(folder, `browser-${info.project.name}-${name}.png`);
  const geometry = path.join(folder, `geometry-${info.project.name}-${name}.json`);
  await page.screenshot({ path: screenshot });
  await writeFile(
    geometry,
    JSON.stringify({ viewport: page.viewportSize(), measurements }, null, 2),
  );
  await info.attach(name, { path: screenshot, contentType: "image/png" });
  await info.attach(`${name} geometry`, { path: geometry, contentType: "application/json" });
}

test("Phase 25 SQL scale T-P25-101/102/103 resizes all three panes without losing SQL", async ({
  page,
}, info) => {
  await openScale(page);
  const statement = "SELECT customer_id FROM orders; -- preserved source browsing draft";
  await editor(page).fill(statement);
  const tables = sql(page).getByRole("complementary", {
    name: "SQL tables and columns",
    exact: true,
  });
  const tablesSeparator = sql(page).getByRole("separator", {
    name: "Resize SQL tables pane",
    exact: true,
  });
  const before = (await tables.boundingBox())!.width;
  const tablesMinimum = Number(await tablesSeparator.getAttribute("aria-valuemin"));
  const tablesMaximum = Number(await tablesSeparator.getAttribute("aria-valuemax"));
  const tablesDrag = before - tablesMinimum >= 30 ? -30 : Math.min(35, tablesMaximum - before);
  await dragSeparator(page, tablesSeparator, tablesDrag);
  await expect
    .poll(async () => Math.abs((await tables.boundingBox())!.width - before))
    .toBeGreaterThan(15);
  await tablesSeparator.focus();
  const tablesKeyboardBefore = (await tables.boundingBox())!.width;
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => Math.abs((await tables.boundingBox())!.width - tablesKeyboardBefore))
    .toBeGreaterThan(0);
  await expect(editor(page)).toHaveText(statement);
  const dockRight = source(page).getByRole("button", { name: "Dock right", exact: true });
  if (await dockRight.isVisible()) await dockRight.click();
  const sourceSeparator = sql(page).getByRole("separator", {
    name: "Resize SQL source pane",
    exact: true,
  });
  await expect(sourceSeparator).toBeVisible();
  const sourceBefore = (await source(page).boundingBox())!.width;
  await dragSeparator(page, sourceSeparator, 30);
  await expect
    .poll(async () => Math.abs((await source(page).boundingBox())!.width - sourceBefore))
    .toBeGreaterThan(10);
  await sourceSeparator.focus();
  const sourceKeyboardBefore = (await source(page).boundingBox())!.width;
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Math.abs((await source(page).boundingBox())!.width - sourceKeyboardBefore))
    .toBeGreaterThan(0);
  await expect(editor(page)).toHaveText(statement);
  const persistedTables = (await tables.boundingBox())!.width;
  const persistedSource = (await source(page).boundingBox())!.width;
  await source(page)
    .getByRole("group", { name: "Source files", exact: true })
    .getByRole("button", { name: /customers/ })
    .click();
  await expect(sourceGrid(page)).toHaveAttribute("data-session-id", "browser-sql-session-2");
  await expect(editor(page)).toHaveText(statement);
  expect(Math.abs((await tables.boundingBox())!.width - persistedTables)).toBeLessThanOrEqual(1);
  expect(Math.abs((await source(page).boundingBox())!.width - persistedSource)).toBeLessThanOrEqual(
    1,
  );
  await workspace(page, "Data").click();
  await workspace(page, "SQL").click();
  expect(Math.abs((await tables.boundingBox())!.width - persistedTables)).toBeLessThanOrEqual(1);
  expect(Math.abs((await source(page).boundingBox())!.width - persistedSource)).toBeLessThanOrEqual(
    1,
  );
  await capture(page, info, "source-panes");
});

test("Phase 25 SQL scale T-P25-104/105 browses original rows beyond one million and all source columns", async ({
  page,
}, info) => {
  await openScale(page);
  const original = sourceGrid(page);
  await expect(original).toHaveAttribute("aria-colcount", "38");
  await cell(original, 0, 0).click();
  await page.keyboard.press("Control+End");
  await expect(original).toHaveAttribute("data-active-row", String(rows - 1));
  await expect(original.locator(`[data-grid-row="${rows - 1}"]`).last()).toContainText(
    String(rows - 1),
  );
  await expect(original).toHaveAttribute("data-active-column", "37");
  await expect
    .poll(async () => (await probe(page)).reads.some((request) => request.offset > 1_000_000))
    .toBe(true);
  const reads = (await probe(page)).reads;
  expect(
    reads.every((request) => request.limit <= 200 && (request.columns?.length ?? 38) <= 64),
  ).toBe(true);
  expect(Number(await original.getAttribute("data-mounted-rows"))).toBeLessThan(70);
  await capture(page, info, "source-last-row");
  await source(page).getByRole("tab", { name: "Schema", exact: true }).click();
  await expect(source(page).getByText("BIGINT", { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: path.resolve(`.tmp/phase-25/sql-scale/ui/browser-${info.project.name}-source-schema.png`),
  });
  await source(page).getByRole("tab", { name: "Data", exact: true }).click();
  await expect(original).toHaveAttribute("data-active-row", String(rows - 1));
});

test("Phase 25 SQL scale T-P25-106 ignores a delayed full-source page after changing files", async ({
  page,
}) => {
  await openScale(page);
  await page.evaluate(() => {
    (Reflect.get(window, "__p25Scale") as ScaleProbe).hold = "browser-sql-session-0";
  });
  await cell(sourceGrid(page), 0, 0).click();
  await page.keyboard.press("Control+End");
  await expect.poll(async () => (await probe(page)).held).toBe(true);
  await source(page)
    .getByRole("group", { name: "Source files", exact: true })
    .getByRole("button", { name: /customers/ })
    .click();
  await expect(sourceGrid(page)).toHaveAttribute("data-session-id", "browser-sql-session-2");
  await expect(cell(sourceGrid(page), 0, 1)).toContainText("CUSTOMER");
  await page.evaluate(() => {
    (Reflect.get(window, "__p25Scale") as ScaleProbe).release?.();
  });
  await expect.poll(async () => (await probe(page)).released).toBe(true);
  await expect(sourceGrid(page)).toHaveAttribute("data-session-id", "browser-sql-session-2");
  await expect(cell(sourceGrid(page), 0, 1)).toContainText("CUSTOMER");
});

test("Phase 25 SQL scale T-P25-108/112/114 charts a large SQL selection without reading cells during capture", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openScale(page);
  await editor(page).fill("SELECT /* sql-scale */ * FROM orders;");
  await sql(page).getByRole("button", { name: "Run", exact: true }).click();
  const resultPanel = sql(page).getByRole("tabpanel", { name: "Results", exact: true });
  const result = resultPanel.getByRole("grid", { name: "Data preview", exact: true });
  await expect(result).toHaveAttribute("aria-rowcount", String(rows));
  const resultGeometry = await sql(page).evaluate((element) => {
    const selectors = [
      ".sql-main",
      ".sql-query-heading",
      ".sql-split",
      ".sql-editing",
      ".sql-output",
      ".sql-output-tabs",
      ".sql-result-content",
      ".sql-result-heading",
      ".virtual-grid-shell",
      ".query-toolbar",
      ".column-toolbar",
      ".paging-bar",
      ".virtual-grid",
    ];
    return selectors.flatMap((selector) =>
      Array.from(element.querySelectorAll<HTMLElement>(selector)).map((node) => {
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          selector,
          label: node.getAttribute("aria-label"),
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          display: style.display,
          overflow: style.overflow,
          rows: style.gridTemplateRows,
          minHeight: style.minHeight,
          flex: style.flex,
          padding: style.padding,
          scrollHeight: node.scrollHeight,
        };
      }),
    );
  });
  const geometryFolder = path.resolve(".tmp/phase-25/sql-scale/ui");
  await mkdir(geometryFolder, { recursive: true });
  await writeFile(
    path.join(geometryFolder, `result-ready-geometry-${info.project.name}.json`),
    JSON.stringify(resultGeometry, null, 2),
  );
  await page.screenshot({
    path: path.join(geometryFolder, `result-ready-${info.project.name}.png`),
  });
  await expect.poll(async () => (await result.boundingBox())?.height ?? 0).toBeGreaterThan(80);
  const resultBounds = (await result.boundingBox())!;
  const firstRowBounds = (await cell(result, 0, 0).boundingBox())!;
  expect(firstRowBounds.y + firstRowBounds.height).toBeLessThanOrEqual(
    resultBounds.y + resultBounds.height + 1,
  );
  await result
    .locator('[role="columnheader"][data-column-index="0"]')
    .getByText("value", { exact: true })
    .click();
  await result
    .locator('[role="columnheader"][data-column-index="2"]')
    .getByText("amount", { exact: true })
    .click({ modifiers: ["Control"] });
  await expect(result).toHaveAttribute("data-selection-bottom", String(rows - 1));
  await expect(result).toHaveAttribute("data-selection-column-count", "2");
  const readsBefore = (await probe(page)).sqlReads.length;
  await resultPanel
    .getByRole("button", { name: "Create Chart from Selection", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add chart to sheet", exact: true });
  await expect(dialog).toContainText(`${rows.toLocaleString()} rows · 2 columns`);
  expect((await probe(page)).sqlReads.length).toBe(readsBefore);
  await dialog.getByRole("button", { name: "Add chart", exact: true }).click();
  const charts = page.getByRole("region", { name: "Charts workspace", exact: true });
  await charts
    .getByRole("combobox", { name: "Chart type", exact: true })
    .selectOption({ label: "Scatter" });
  await charts.getByRole("combobox", { name: "X axis", exact: true }).selectOption("r0");
  await charts.getByRole("combobox", { name: "Y axis", exact: true }).selectOption("r2");
  const card = charts.getByRole("article", { name: "Scatter chart", exact: true });
  await expect(card).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(card).toContainText(`${rows.toLocaleString()} valid rows`);
  await workspace(page, "SQL").click();
  await editor(page).fill("SELECT 999 AS next_execution;");
  await sql(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(result).toHaveAttribute("aria-rowcount", "4");
  await workspace(page, "Charts").click();
  await expect(card).toHaveAttribute("data-state", "ready");
  await expect(card).toContainText(`${rows.toLocaleString()} valid rows`);
  const screenshot = path.resolve(
    `.tmp/phase-25/sql-scale/ui/browser-${info.project.name}-large-sql-selected-chart.png`,
  );
  await page.screenshot({ path: screenshot });
  await info.attach("large SQL selection retained across rerun", {
    path: screenshot,
    contentType: "image/png",
  });
});
