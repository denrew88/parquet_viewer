import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  expectInsideViewport,
  expectNoHorizontalPageOverflow,
  openMockFile,
  waitForScrollIdle,
} from "./helpers";

type Phase13Probe = {
  executeQuery: number;
  startCopy: number;
  lastExecuteQuery: unknown;
  lastStartCopy: unknown;
};

function viewportName(projectName: string): "wide" | "compact" | "minimum" {
  const names = {
    "desktop-wide": "wide",
    "desktop-compact": "compact",
    "desktop-minimum": "minimum",
  } as const;
  const name = names[projectName as keyof typeof names];
  if (!name) throw new Error(`Unexpected Playwright project: ${projectName}`);
  return name;
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const backendUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!backendUrl) throw new Error("The browser mock backend module was not loaded.");
    const module = (await (0, eval)(
      `import(${JSON.stringify(backendUrl)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend;
    const state: Phase13Probe = {
      executeQuery: 0,
      startCopy: 0,
      lastExecuteQuery: null,
      lastStartCopy: null,
    };
    Reflect.set(window, "__phase13Probe", state);
    const executeQuery = backend.executeQuery.bind(backend);
    backend.executeQuery = async (request) => {
      state.executeQuery += 1;
      state.lastExecuteQuery = request;
      return executeQuery(request);
    };
    const startCopy = backend.startCopy.bind(backend);
    backend.startCopy = async (request) => {
      state.startCopy += 1;
      state.lastStartCopy = request;
      return startCopy(request);
    };
  });
}

async function probe(page: Page): Promise<Phase13Probe> {
  return page.evaluate(() => Reflect.get(window, "__phase13Probe") as Phase13Probe);
}

async function capture(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await mkdir("artifacts/phase-13/ui", { recursive: true });
  const path = `artifacts/phase-13/ui/${name}-${viewportName(testInfo.project.name)}.png`;
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function pointerReorder(
  page: Page,
  source: Locator,
  target: Locator,
  orientation: "horizontal" | "vertical",
  movingState: Locator,
  targetState: Locator,
  feedback: "insertion" | "column-strip" = "insertion",
): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Reorder item has no geometry.");
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
  await expect(movingState).toHaveClass(/is-reordering/);
  await expect(page.locator(".workspace--drop-active")).toHaveCount(0);
  await page.mouse.move(targetX, targetY, { steps: 8 });
  if (feedback === "column-strip") {
    await expect(targetState).toHaveClass(/is-live-reflowing/);
    await expect(page.locator(".virtual-grid__column-drag-clip")).toBeVisible();
  } else {
    await expect(targetState).toHaveClass(/is-insert-before/);
  }
  await expect(page.locator(".workspace--drop-active")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".is-reordering")).toHaveCount(0);
  if (feedback === "column-strip") {
    await expect(page.locator(".virtual-grid__column-drag-clip")).toHaveCount(0);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await installProbe(page);
});

test("direct pointer reorder keeps internal drag separate from file drop", async ({
  page,
}, testInfo) => {
  await openMockFile(page, "large", "large-5850000.parquet");
  await openMockFile(page, "parquet", "typed-row-groups.parquet");
  const tabs = page.getByRole("tablist", { name: "Open files" });
  const typedTab = tabs.getByRole("tab", { name: "typed-row-groups.parquet" });
  const largeTab = tabs.getByRole("tab", { name: "large-5850000.parquet" });
  await pointerReorder(
    page,
    typedTab,
    largeTab,
    "horizontal",
    typedTab.locator(".."),
    largeTab.locator(".."),
  );
  await expect(tabs.getByRole("tab")).toHaveText([
    /typed-row-groups\.parquet/,
    /large-5850000\.parquet/,
  ]);
  await expect(typedTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".workspace--drop-active")).toHaveCount(0);

  await largeTab.click();
  const grid = page.getByRole("grid", { name: "Data preview" });
  const rowId = grid.getByRole("columnheader", { name: "row_id", exact: true });
  const category = grid.getByRole("columnheader", { name: "category", exact: true });
  await pointerReorder(page, category, rowId, "horizontal", category, rowId, "column-strip");
  const headerOrder = await grid
    .locator('.virtual-grid__column-header[role="columnheader"]')
    .evaluateAll((headers) =>
      headers.slice(0, 2).map((header) => header.getAttribute("aria-label")),
    );
  expect(headerOrder).toEqual(["category", "row_id"]);
  const categoryCell = grid.getByText("category-0", { exact: true }).first();
  await expect(categoryCell).toBeVisible();
  const aligned = await category.evaluate(
    (header, cell) => {
      const headerRect = header.getBoundingClientRect();
      const cellRect = (cell as HTMLElement).getBoundingClientRect();
      return {
        left: Math.abs(headerRect.left - cellRect.left),
        width: Math.abs(headerRect.width - cellRect.width),
      };
    },
    await categoryCell.elementHandle(),
  );
  expect(aligned.left).toBeLessThanOrEqual(1);
  expect(aligned.width).toBeLessThanOrEqual(1);
  await capture(page, "drag-reorder", testInfo);
  await expectNoHorizontalPageOverflow(page);
});

test("Sorts panel searches hidden columns and applies reordered criteria", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await page.getByRole("button", { name: "Choose columns" }).click();
  const chooser = page.getByRole("dialog", { name: "Column chooser" });
  const groupVisibility = chooser.getByRole("button", { name: "group_id", exact: true });
  await groupVisibility.click();
  await expect(groupVisibility).toHaveAttribute("aria-pressed", "false");
  await chooser.getByRole("button", { name: "Close column chooser" }).click();

  await page
    .getByRole("button", { name: "Sort row_id: not sorted" })
    .click({ modifiers: ["Shift"] });
  await expect(page.getByRole("button", { name: "Sorts (1)" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Sort row_id: ascending, priority 1/ }),
  ).toBeVisible();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(1);
  await expect(grid).not.toHaveAttribute("data-query-id", "");
  await waitForScrollIdle(page);

  const panel = page.getByRole("dialog", { name: "Multi-column sort" });
  await expect(async () => {
    if (!(await panel.isVisible())) await page.getByRole("button", { name: "Sorts (1)" }).click();
    await expect(panel).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await panel.getByRole("button", { name: "Add level" }).click();
  const addColumn = panel.getByRole("combobox", { name: "Column for sort priority 2" });
  await addColumn.fill("group");
  const hiddenGroup = panel.getByRole("option", { name: "group_id (Hidden)", exact: true });
  await expect(hiddenGroup).toBeVisible();
  await hiddenGroup.click();
  const groupHandle = panel.getByRole("button", { name: "Reorder sort group_id, priority 2" });
  const rowHandle = panel.getByRole("button", { name: "Reorder sort row_id, priority 1" });
  await pointerReorder(
    page,
    groupHandle,
    rowHandle,
    "vertical",
    groupHandle.locator(".."),
    rowHandle.locator(".."),
  );
  await expect(
    panel.getByRole("button", { name: "Reorder sort group_id, priority 1" }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "Direction for sort priority 1" })
    .selectOption("descending");
  expect((await probe(page)).executeQuery).toBe(1);
  await capture(page, "multi-sort", testInfo);
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "Sorts (2)" })).toBeVisible();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(2);
  const request = (await probe(page)).lastExecuteQuery as {
    plan: { sort: Array<{ columnId: string; direction: string }> };
  };
  expect(request.plan.sort.map(({ columnId, direction }) => [columnId, direction])).toEqual([
    ["group_id", "descending"],
    ["row_id", "ascending"],
  ]);
  await expect(grid).toHaveAttribute("aria-colcount", "14");
});

test("Ctrl+F executes only on Search or Enter", async ({ page }) => {
  await openMockFile(page, "large", "large-5850000.parquet");
  await page.keyboard.press("Control+f");
  const input = page.getByRole("searchbox", { name: "Find data" });
  await expect(input).toBeFocused();
  await input.fill("label-4");
  await page.waitForTimeout(300);
  expect((await probe(page)).executeQuery).toBe(0);
  await input.press("Enter");
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(1);
  await expect(page.getByText("2 matches")).toBeVisible();
  await input.fill("label-5");
  expect((await probe(page)).executeQuery).toBe(1);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(2);
});

test("copy history distinguishes attempts and closes on Escape and selection", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  await grid.press("Control+a");
  await page.getByRole("button", { name: "Copy selection" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(async () => (await probe(page)).startCopy).toBe(2);

  const trigger = page.getByRole("button", { name: "Copy history" });
  await trigger.click();
  const history = page.getByRole("list", { name: "Copy history" });
  const items = history.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Current");
  await expect(items.nth(1)).toContainText("Previous");
  const operationIds = (await items.allTextContents()).map(
    (text) => text.match(/copy-[^\s]+/)?.[0] ?? text,
  );
  expect(new Set(operationIds).size).toBe(2);
  await capture(page, "copy-history", testInfo);

  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await grid.click({ position: { x: 100, y: 100 } });
  await expect(history).toBeHidden();
  await expect(grid).toHaveAttribute("data-selection-kind", "cell");
});

test("Settings exposes Timestamp and Duration detail with Date only controls hidden", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings" });
  await expect(dialog.getByRole("heading", { name: "Value display formats" })).toBeVisible();
  const timestampRow = dialog.locator('[data-format-type="timestamp"]');
  await expect(
    timestampRow.getByRole("status").filter({ hasText: "2025-12-18 01:23:34.111111111" }),
  ).toBeVisible();
  const timestampPreset = dialog.getByRole("combobox", { name: "Timestamp preset" });
  await timestampPreset.selectOption("dateOnly");
  await expect(timestampRow.getByText("2025-12-18", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Show Timestamp details" }).click();
  await expect(dialog.getByLabel("Timestamp details", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Timestamp time format" })).toHaveValue(
    "hidden",
  );
  await expect(dialog.getByRole("combobox", { name: "Timestamp separator" })).toHaveCount(0);
  await expect(
    dialog.getByRole("combobox", { name: "Timestamp fractional digits mode" }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Timestamp timezone suffix" })).toHaveCount(0);

  await dialog.getByRole("combobox", { name: "Duration preset" }).selectOption("totalHours");
  await expect(dialog.getByText(/51:04:05\.123456789/)).toBeVisible();
  await dialog.getByRole("button", { name: "Show Duration details" }).click();
  await expect(dialog.getByLabel("Timestamp details", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Duration details", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Duration fractional digits mode" }),
  ).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Duration unit suffix" })).toBeVisible();
  await expectInsideViewport(dialog);
  await capture(page, "settings-formats", testInfo);
  await expectNoHorizontalPageOverflow(page);
});

test("the real final logical row is fully visible at every supported viewport", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  const lastCell = grid.locator('[data-grid-row="5849999"][data-grid-column="0"]');
  await expect(lastCell).toBeVisible();
  const geometry = await lastCell.evaluate(
    (cell, gridElement) => {
      const cellRect = cell.getBoundingClientRect();
      const element = gridElement as HTMLElement;
      const gridRect = element.getBoundingClientRect();
      return {
        cellTop: cellRect.top,
        cellBottom: cellRect.bottom,
        cellHeight: cellRect.height,
        gridTop: gridRect.top,
        gridBottom: gridRect.bottom,
        gridContentBottom: gridRect.top + element.clientHeight,
        bottomClearance: Number(element.dataset.bottomClearance),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        mountedRows: Number(element.dataset.mountedRows),
        mountedCells: Number(element.dataset.mountedCells),
      };
    },
    await grid.elementHandle(),
  );
  expect(geometry.cellHeight).toBe(48);
  expect(geometry.cellBottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.gridContentBottom - geometry.bottomClearance + 1,
  );
  expect(geometry.gridContentBottom).toBeLessThanOrEqual(geometry.gridBottom + 1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(30_000_000);
  expect(geometry.mountedRows).toBeLessThan(100);
  expect(geometry.mountedCells).toBeLessThan(1_000);
  await expect(grid).toBeFocused();
  await expectInsideViewport(page.locator(".virtual-grid-shell"));
  await expectNoHorizontalPageOverflow(page);
  await capture(page, "browser-final-row", testInfo);

  await mkdir("artifacts/phase-13/ui", { recursive: true });
  await writeFile(
    `artifacts/phase-13/ui/geometry-${viewportName(testInfo.project.name)}.json`,
    `${JSON.stringify(
      {
        result: "PASS",
        project: testInfo.project.name,
        viewport: page.viewportSize(),
        finalRow: geometry,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});
