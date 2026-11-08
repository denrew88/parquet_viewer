import { expect, test, type Locator, type Page } from "@playwright/test";
import type { QueryPlan } from "../src/query/model";
import { expectInsideViewport, expectNoHorizontalPageOverflow, openMockFile } from "./helpers";

interface ViewProbe {
  runs: number;
  starts: number;
  finds: number;
  plans: QueryPlan[];
  exports: { runId: string; resultId: string; viewId?: string | null; format: string }[];
  rejectNextViewPage: boolean;
  releasePage?: () => void;
}

const editor = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const resultPanel = (workspace: Locator) =>
  workspace.getByRole("tabpanel", { name: "Results", exact: true });
const resultGrid = (workspace: Locator) =>
  resultPanel(workspace).getByRole("grid", { name: "Data preview", exact: true });
const cell = (grid: Locator, row: number, column: number) =>
  grid.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);

async function openWorkspace(page: Page) {
  await page.goto("/?mock=sql22");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  await expect(workspace.getByRole("button", { name: "orders", exact: true })).toBeVisible();
  return workspace;
}

async function watchSql(page: Page, timestampResult = false) {
  await page.evaluate(async (withTimestamp) => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend missing.");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const api = module.browserMockBackend.sqlWorkspace;
    const view = api?.resultView;
    if (!api || !view) throw new Error("SQL result view mock missing.");
    const probe: ViewProbe = {
      runs: 0,
      starts: 0,
      finds: 0,
      plans: [],
      exports: [],
      rejectNextViewPage: false,
    };
    Reflect.set(window, "__phase23", probe);
    const run = api.startQuery.bind(api);
    api.startQuery = (...args) => {
      probe.runs++;
      return run(...args);
    };
    if (withTimestamp) {
      const getStatus = api.getStatus.bind(api);
      api.getStatus = async (runId) => {
        const status = await getStatus(runId);
        return {
          ...status,
          columns: status.columns.map((column) =>
            column.id === "r2"
              ? { ...column, name: "ordered_at", logicalType: "TIMESTAMP_NS" }
              : column,
          ),
        };
      };
    }
    const start = view.start.bind(view);
    view.start = (...args) => {
      probe.starts++;
      probe.plans.push(structuredClone(args[3]));
      return start(...args);
    };
    const find = view.find.bind(view);
    view.find = (...args) => {
      probe.finds++;
      return find(...args);
    };
    const read = api.readPage.bind(api);
    api.readPage = async (request) => {
      if (request.viewId && probe.rejectNextViewPage) {
        probe.rejectNextViewPage = false;
        await new Promise<void>((resolve) => {
          probe.releasePage = resolve;
        });
        delete probe.releasePage;
        throw new Error("Result page test failure");
      }
      return read(request);
    };
    api.exportResult = async (request) => {
      probe.exports.push({ ...request });
      return request.format !== "tsv";
    };
  }, timestampResult);
}

function readProbe(page: Page) {
  return page.evaluate(() => {
    const { runs, starts, finds, plans, exports, releasePage } = Reflect.get(
      window,
      "__phase23",
    ) as ViewProbe;
    return { runs, starts, finds, plans, exports, blocked: Boolean(releasePage) };
  });
}

async function runResult(workspace: Locator, sql = "SELECT 1;") {
  await editor(workspace).fill(sql);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(resultGrid(workspace)).toHaveAttribute("aria-rowcount", "4");
}

async function filterAmount(workspace: Locator, page: Page, value: string) {
  await resultGrid(workspace).getByRole("button", { name: "Filter amount", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter amount", exact: true });
  await filter
    .getByRole("combobox", { name: "Filter operator" })
    .selectOption("greaterThanOrEqual");
  await filter.getByRole("textbox", { name: "Value", exact: true }).fill(value);
  await filter.getByRole("button", { name: "Apply", exact: true }).click();
}

async function sortAmountDescending(grid: Locator) {
  await grid.getByRole("button", { name: "Sort amount: not sorted", exact: true }).click();
  const ascending = grid.getByRole("button", { name: "Sort amount: ascending, priority 1" });
  await expect(ascending).toBeVisible();
  await ascending.click();
  await expect(
    grid.getByRole("button", { name: "Sort amount: descending, priority 1" }),
  ).toBeVisible();
  await expect(cell(grid, 0, 0)).toHaveText("4");
}

async function readHeaderControl(control: Locator) {
  await expect(control).toBeVisible();
  return control.evaluate((button) => {
    const svg = button.querySelector("svg");
    if (!svg) throw new Error("Missing header glyph");
    const buttonStyle = getComputedStyle(button);
    const iconStyle = getComputedStyle(svg);
    return {
      glyph: svg.innerHTML,
      color: buttonStyle.color,
      background: buttonStyle.backgroundColor,
      borderColor: buttonStyle.borderColor,
      padding: buttonStyle.padding,
      width: iconStyle.width,
      height: iconStyle.height,
    };
  });
}

test("T-P23-009/010 types a 24-hour timestamp and shares header controls", async ({
  page,
}, info) => {
  const workspace = await openWorkspace(page);
  await watchSql(page, true);
  await runResult(workspace);
  const grid = resultGrid(workspace);
  const filterButton = grid.getByRole("button", { name: "Filter ordered_at", exact: true });
  const sortButton = grid.getByRole("button", {
    name: "Sort ordered_at: not sorted",
    exact: true,
  });
  await page.mouse.move(1, 1);
  const resultFilterStyle = await readHeaderControl(filterButton);
  const resultSortStyle = await readHeaderControl(sortButton);

  const filePage = await page.context().newPage();
  await filePage.goto("/");
  await openMockFile(filePage, "large", "large-5850000.parquet");
  await filePage.mouse.move(1, 1);
  const fileGrid = filePage.getByRole("grid", { name: "Data preview", exact: true });
  const fileFilter = fileGrid.getByRole("button", { name: "Filter category", exact: true });
  const fileSort = fileGrid.getByRole("button", {
    name: "Sort category: not sorted",
    exact: true,
  });
  expect(resultFilterStyle).toEqual(await readHeaderControl(fileFilter));
  expect(resultSortStyle).toEqual(await readHeaderControl(fileSort));
  await fileFilter.click();
  await expect(filePage.getByRole("dialog", { name: "Filter category" })).toBeVisible();
  await filePage.close();

  const initialQueryId = (await grid.getAttribute("data-query-id")) ?? "";
  expect(initialQueryId).toBeTruthy();
  await sortButton.click();
  await expect(
    grid.getByRole("button", { name: "Sort ordered_at: ascending, priority 1", exact: true }),
  ).toBeVisible();
  await expect(grid).not.toHaveAttribute("data-query-id", initialQueryId);
  await filterButton.click();
  const dialog = page.getByRole("dialog", { name: "Filter ordered_at", exact: true });
  const operator = dialog.getByRole("combobox", { name: "Filter operator", exact: true });
  await operator.selectOption("between");
  const from = dialog.getByRole("textbox", { name: "From value", exact: true });
  const to = dialog.getByRole("textbox", { name: "To value", exact: true });
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });
  await expect(from).toBeVisible();
  await from.fill("2026-01-01 24:00");
  await to.fill("2026-01-01 23:59:59.123456789");
  await expect(from).toHaveAttribute("aria-invalid", "true");
  await expect(apply).toBeDisabled();
  expect((await readProbe(page)).starts).toBe(1);
  await from.fill("2026-01-01 00:00:00");
  await expect(apply).toBeEnabled();
  for (const control of [dialog, operator, from, to, apply]) {
    await expectInsideViewport(control);
  }
  await apply.click({ trial: true });
  await expectNoHorizontalPageOverflow(page);
  await info.attach("ordered_at filter popover", {
    body: await page.screenshot({ path: info.outputPath("ordered-at-filter.png") }),
    contentType: "image/png",
  });
  await apply.click();
  await expect.poll(async () => (await readProbe(page)).plans.length).toBe(2);
  const [filter] = (await readProbe(page)).plans[1].filters;
  expect(filter).toMatchObject({ columnId: "r2", scalarType: "timestamp", operator: "between" });
  expect(filter.values[0]).toMatch(/^2026-01-01[ T]00:00:00$/);
  expect(filter.values[1]).toMatch(/^2026-01-01[ T]23:59:59\.123456789$/);
  await expect(resultPanel(workspace)).toContainText("0 of 4 rows");
});

test("T-P23-001/002/003 applies shared Results filter, sort and Find", async ({ page }, info) => {
  const workspace = await openWorkspace(page);
  await watchSql(page);
  await runResult(workspace);
  const results = resultPanel(workspace);
  const grid = resultGrid(workspace);
  await filterAmount(workspace, page, "200000.25");
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  await expect(results).toContainText("3 of 4 rows");
  await expect(cell(grid, 0, 0)).toHaveText("2");
  await sortAmountDescending(grid);
  await expect(cell(grid, 1, 0)).toHaveText("3");
  await expect(cell(grid, 2, 0)).toHaveText("2");

  await cell(grid, 0, 0).click();
  await page.keyboard.press("Control+f");
  const find = results.getByRole("searchbox", { name: "Find data", exact: true });
  await expect(find).toBeFocused();
  const before = await readProbe(page);
  await find.fill("u");
  await expect(find).toHaveValue("u");
  const draft = await readProbe(page);
  expect({ starts: draft.starts, finds: draft.finds }).toEqual({
    starts: before.starts,
    finds: before.finds,
  });
  await find.press("Enter");
  await expect(results.getByText(/2 matches/)).toBeVisible();
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  const first = await grid.getAttribute("data-active-row");
  expect(["0", "2"]).toContain(first);
  await results.getByRole("button", { name: "Next match" }).click();
  await expect(grid).toHaveAttribute("data-active-row", first === "0" ? "2" : "0");
  await results.getByRole("button", { name: "Previous match" }).click();
  await expect(grid).toHaveAttribute("data-active-row", first!);
  await expect(cell(grid, 0, 0)).toHaveText("4");
  await expect(cell(grid, 2, 0)).toHaveText("2");
  expect((await readProbe(page)).runs).toBe(1);
  await expectInsideViewport(find);
  const toolbar = results.locator('[aria-label="Query tools"]');
  const queryControls = [
    toolbar.getByRole("button", { name: "Search", exact: true }),
    toolbar.getByRole("button", { name: "Clear", exact: true }),
  ];
  const controlsGeometry = [];
  for (const control of queryControls) {
    await control.click({ trial: true, timeout: 5_000 });
    await expectInsideViewport(control);
    const geometry = await control.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      const hits = [rect.left + 4, (rect.left + rect.right) / 2, rect.right - 4].map((x) =>
        button.contains(document.elementFromPoint(x, centerY)),
      );
      return { label: button.textContent, bounds: rect.toJSON(), hits };
    });
    expect(geometry.hits, geometry.label ?? undefined).toEqual([true, true, true]);
    controlsGeometry.push(geometry);
  }
  await info.attach("Find controls geometry", {
    body: JSON.stringify({ viewport: page.viewportSize(), controls: controlsGeometry }),
    contentType: "application/json",
  });
  await expectNoHorizontalPageOverflow(page);
  await info.attach("filtered Results with Find", {
    body: await workspace.screenshot(),
    contentType: "image/png",
  });
  await find.press("Escape");
  await expect(find).toBeHidden();
  await editor(workspace).press("Control+f");
  await expect(find).toBeHidden();
  await expect(workspace.locator(".cm-search")).toBeVisible();
});

test("T-P23-004/005 exports chosen result scope and retains a view through failure", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const workspace = await openWorkspace(page);
  await watchSql(page);
  await runResult(workspace);
  const results = resultPanel(workspace);
  const grid = resultGrid(workspace);
  await filterAmount(workspace, page, "200000.25");
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  await sortAmountDescending(grid);
  const exportButton = results.getByRole("button", { name: "Export results", exact: true });
  const formats = results.getByRole("group", { name: "Export format", exact: true });
  async function exportFrom(scope: "Current view" | "Whole result", format: string) {
    await exportButton.click();
    const group = formats.getByRole("group", { name: scope, exact: true });
    await expectInsideViewport(group);
    await group.getByRole("button", { name: format, exact: true }).click();
    await expect(exportButton).toBeEnabled();
  }
  await cell(grid, 1, 0).click();
  await exportButton.click();
  await expectInsideViewport(formats);
  await info.attach("filtered Results export scopes", {
    body: await workspace.screenshot(),
    contentType: "image/png",
  });
  await exportButton.click();
  for (const format of ["CSV", "TSV", "Parquet"]) await exportFrom("Current view", format);
  await exportFrom("Whole result", "CSV");
  const calls = (await readProbe(page)).exports;
  expect(calls.map((call) => call.format)).toEqual(["csv", "tsv", "parquet", "csv"]);
  const viewId = calls[0].viewId;
  expect(viewId).toBeTruthy();
  expect(calls.slice(0, 3).map((call) => call.viewId)).toEqual([viewId, viewId, viewId]);
  expect(calls[3].viewId ?? null).toBeNull();
  expect(new Set(calls.map(({ runId, resultId }) => `${runId}:${resultId}`)).size).toBe(1);
  const readClipboard = () =>
    page.evaluate(async () => (await navigator.clipboard.readText()).split(/\r?\n/));
  await exportFrom("Current view", "Clipboard");
  await expect
    .poll(readClipboard)
    .toEqual([
      "value\tvalue\tamount",
      "4\tDaegu\t400000.25",
      "3\tIncheon\t300000.25",
      "2\tBusan\t200000.25",
    ]);
  await exportFrom("Whole result", "Clipboard");
  await expect
    .poll(readClipboard)
    .toEqual([
      "value\tvalue\tamount",
      "1\tSeoul\t100000.25",
      "2\tBusan\t200000.25",
      "3\tIncheon\t300000.25",
      "4\tDaegu\t400000.25",
    ]);

  await page.evaluate(() => {
    (Reflect.get(window, "__phase23") as ViewProbe).rejectNextViewPage = true;
  });
  await filterAmount(workspace, page, "300000.25");
  await expect.poll(async () => (await readProbe(page)).blocked).toBe(true);
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  await expect(cell(grid, 2, 0)).toHaveText("2");
  await page.evaluate(() => (Reflect.get(window, "__phase23") as ViewProbe).releasePage?.());
  await expect(
    results.getByRole("alert").filter({ hasText: "Result page test failure" }),
  ).toBeVisible();
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  await expect(cell(grid, 0, 0)).toHaveText("4");
  expect((await readProbe(page)).runs).toBe(1);

  await editor(workspace).fill("SELECT /* fail */ 1;");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    workspace.getByRole("tabpanel", { name: "Messages", exact: true }).getByRole("alert"),
  ).toBeVisible();
  await workspace.getByRole("tab", { name: "Results", exact: true }).click();
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  await expect(cell(grid, 0, 0)).toHaveText("4");
  await expectNoHorizontalPageOverflow(page);
});

test("T-P23-007 resizes Query and output through keyboard, pointer and viewport changes", async ({
  page,
}, info) => {
  const workspace = await openWorkspace(page);
  await runResult(workspace);
  const split = workspace.getByRole("separator", { name: "Resize query and output", exact: true });
  const query = workspace.locator(".sql-editing");
  const tabs = workspace.getByRole("tablist", { name: "SQL output", exact: true });
  const splitValue = async () => Number(await split.getAttribute("aria-valuenow"));
  await expect(split).toHaveAttribute("aria-orientation", "horizontal");
  await split.focus();
  await expect(split).toBeFocused();
  await split.press("Home");
  const minimum = Number(await split.getAttribute("aria-valuemin"));
  expect(minimum).toBeGreaterThan(0);
  expect(await splitValue()).toBe(minimum);
  const minHeight = (await query.boundingBox())!.height;
  await split.press("End");
  const maximum = Number(await split.getAttribute("aria-valuemax"));
  expect(maximum).toBeGreaterThan(minimum);
  expect(await splitValue()).toBe(maximum);
  expect((await query.boundingBox())!.height).toBeGreaterThan(minHeight);
  await split.press("ArrowUp");
  expect(await splitValue()).toBeLessThan(maximum);
  await split.press("ArrowDown");
  expect(await splitValue()).toBe(maximum);
  await split.press("Home");
  const dragDown = async (distance: number) => {
    const bounds = (await split.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + distance, { steps: 5 });
  };
  await dragDown(30);
  expect(await splitValue()).toBeGreaterThan(minimum);
  await page.mouse.up();
  const committed = await splitValue();
  await dragDown(15);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await splitValue()).toBe(committed);
  await dragDown(15);
  await split.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  expect(await splitValue()).toBe(committed);

  const viewport = page.viewportSize()!;
  const resized =
    viewport.height > 600 ? { width: 800, height: 600 } : { width: 1024, height: 768 };
  await split.press("End");
  await page.setViewportSize(resized);
  await expect
    .poll(async () => (await splitValue()) <= Number(await split.getAttribute("aria-valuemax")))
    .toBe(true);
  await page.setViewportSize(viewport);
  await split.press("End");
  await expectInsideViewport(split);
  await expectInsideViewport(tabs);
  const [queryBox, splitBox, tabsBox] = await Promise.all([
    query.boundingBox(),
    split.boundingBox(),
    tabs.boundingBox(),
  ]);
  expect(queryBox!.y + queryBox!.height).toBeLessThanOrEqual(splitBox!.y + 1);
  expect(splitBox!.y + splitBox!.height).toBeLessThanOrEqual(tabsBox!.y + 1);
  await expectInsideViewport(workspace.getByRole("button", { name: "Run", exact: true }));
  await tabs.getByRole("tab", { name: "Execution plan", exact: true }).click();
  await expect(
    workspace.getByRole("tabpanel", { name: "Execution plan", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "Results", exact: true }).click();
  await expect(resultGrid(workspace)).toHaveAttribute("aria-rowcount", "4");
  await expectNoHorizontalPageOverflow(page);
  await info.attach("Query expanded above Results", {
    body: await workspace.screenshot(),
    contentType: "image/png",
  });
});
