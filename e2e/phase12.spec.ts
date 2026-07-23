import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  expectInsideViewport,
  expectNoHorizontalPageOverflow,
  openMockFile,
  waitForScrollIdle,
} from "./helpers";

type Phase12Probe = {
  executeQuery: number;
  findDataBoundary: number;
  readPage: number;
  readPageDelayMs: number;
  readPageRequests: Array<{
    sessionId: string;
    offset: number;
    limit: number;
    columns: string[] | null;
  }>;
  readQueryPage: number;
  startCopy: number;
  lastExecuteQuery: unknown;
  lastStartCopy: unknown;
};

function viewportName(projectName: string): string {
  const name = {
    "desktop-wide": "wide",
    "desktop-compact": "compact",
    "desktop-minimum": "minimum",
  }[projectName];
  if (!name) throw new Error(`Unexpected Playwright project: ${projectName}`);
  return name;
}

async function installPhase12Probe(page: Page): Promise<void> {
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
    const probe: Phase12Probe = {
      executeQuery: 0,
      findDataBoundary: 0,
      readPage: 0,
      readPageDelayMs: 0,
      readPageRequests: [],
      readQueryPage: 0,
      startCopy: 0,
      lastExecuteQuery: null,
      lastStartCopy: null,
    };
    Reflect.set(window, "__phase12Probe", probe);

    const executeQuery = backend.executeQuery.bind(backend);
    backend.executeQuery = async (request) => {
      probe.executeQuery += 1;
      probe.lastExecuteQuery = request;
      return executeQuery(request);
    };
    const findDataBoundary = backend.findDataBoundary.bind(backend);
    backend.findDataBoundary = async (request) => {
      probe.findDataBoundary += 1;
      return findDataBoundary(request);
    };
    const readPage = backend.readPage.bind(backend);
    backend.readPage = async (request) => {
      probe.readPage += 1;
      probe.readPageRequests.push({
        sessionId: request.sessionId,
        offset: request.offset,
        limit: request.limit,
        columns: request.columns ? [...request.columns] : null,
      });
      if (probe.readPageDelayMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, probe.readPageDelayMs));
      }
      return readPage(request);
    };
    const readQueryPage = backend.readQueryPage.bind(backend);
    backend.readQueryPage = async (request) => {
      probe.readQueryPage += 1;
      return readQueryPage(request);
    };
    const startCopy = backend.startCopy.bind(backend);
    backend.startCopy = async (request) => {
      probe.startCopy += 1;
      probe.lastStartCopy = request;
      return startCopy(request);
    };
  });
}

async function probe(page: Page): Promise<Phase12Probe> {
  return page.evaluate(() => Reflect.get(window, "__phase12Probe") as Phase12Probe);
}

async function screenshot(page: Page, name: string, projectName: string): Promise<void> {
  await mkdir("artifacts/phase-12/ui", { recursive: true });
  await page.screenshot({
    path: `artifacts/phase-12/ui/${name}-${viewportName(projectName)}.png`,
    fullPage: true,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await installPhase12Probe(page);
});

test("explicit Find, focus preservation, multi-sort, column order, and query-aware copy", async ({
  page,
}, testInfo) => {
  // This scenario performs screenshots and several independent query commits.
  // Keep its outer test budget above the full-suite parallel-load variance;
  // product foreground requests retain their own 15-second timeout contract.
  test.setTimeout(180_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await expect(grid).toHaveAttribute("aria-rowcount", "5850000");

  await grid.locator('[data-grid-row="2"][data-grid-column="1"]').click();
  await grid.locator('[data-grid-row="4"][data-grid-column="2"]').click({ modifiers: ["Shift"] });
  await expect(grid).toHaveAttribute("data-selection-top", "2");
  await expect(grid).toHaveAttribute("data-selection-bottom", "4");

  await page.keyboard.press("Control+f");
  const findInput = page.getByRole("searchbox", { name: "Find data" });
  await expect(findInput).toBeFocused();
  await findInput.fill("label-4");
  await page.waitForTimeout(300);
  expect((await probe(page)).executeQuery).toBe(0);
  await expect(grid).toHaveAttribute("aria-rowcount", "5850000");
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toHaveCount(0);
  await screenshot(page, "find", testInfo.project.name);

  await findInput.press("Enter");
  await expect(page.getByText("2 matches")).toBeVisible();
  await expect(grid).toHaveAttribute("aria-rowcount", "5850000");
  expect((await probe(page)).executeQuery).toBe(1);
  await expect(grid).toHaveAttribute("data-active-row", "4");
  await expect(grid).toHaveAttribute("data-active-column", "2");
  await expect(grid).toHaveAttribute("data-selection-top", "4");
  await expect(grid).toHaveAttribute("data-selection-bottom", "4");
  await expect(findInput).toBeFocused();

  await page.getByRole("button", { name: "Next match" }).click();
  await expect(grid).toHaveAttribute("data-active-row", "1");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await findInput.focus();
  await findInput.press("Escape");
  await expect(findInput).toBeHidden();
  await page.keyboard.press("Control+f");
  await expect(findInput).toBeFocused();
  await expect(page.getByRole("button", { name: "Filter category" })).toBeVisible();

  await page.getByRole("button", { name: "Sort category: not sorted" }).click();
  await expect(
    page.getByRole("button", { name: /Sort category: ascending, priority 1/ }),
  ).toBeVisible();
  const beforeRowSortQueryId = await grid.getAttribute("data-query-id");
  await page
    .getByRole("button", { name: "Sort row_id: not sorted" })
    .click({ modifiers: ["Shift"] });
  await expect(page.getByRole("button", { name: "Sorts (1)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort category: not sorted" })).toBeVisible();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(3);
  await expect(grid).not.toHaveAttribute("data-query-id", beforeRowSortQueryId ?? "");
  await waitForScrollIdle(page);

  await page.getByRole("button", { name: "Sorts (1)" }).click();
  const sortDialog = page.getByRole("dialog", { name: "Multi-column sort" });
  await sortDialog.getByRole("button", { name: "Add level" }).click();
  const categorySortColumn = sortDialog.getByRole("combobox", {
    name: "Column for sort priority 2",
  });
  await categorySortColumn.fill("category");
  await sortDialog.getByRole("option", { name: "category", exact: true }).click();
  await sortDialog
    .getByRole("combobox", { name: "Direction for sort priority 2" })
    .selectOption("descending");
  expect((await probe(page)).executeQuery).toBe(3);
  await screenshot(page, "multisort", testInfo.project.name);
  const sortApply = sortDialog.getByRole("button", { name: "Apply" });
  const applyHitTarget = await sortApply.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === button || Boolean(hit && button.contains(hit));
  });
  expect
    .soft(applyHitTarget, "multi-sort Apply must not be covered by the column toolbar")
    .toBe(true);
  const beforeMultiSortQueryId = await grid.getAttribute("data-query-id");
  await sortApply.click();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(4);
  await expect(grid).not.toHaveAttribute("data-query-id", beforeMultiSortQueryId ?? "");
  await waitForScrollIdle(page);
  await expect(
    page.getByRole("button", { name: /Sort row_id: ascending, priority 1/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sorts (2)" }).click();
  const cancelDialog = page.getByRole("dialog", { name: "Multi-column sort" });
  await cancelDialog
    .getByRole("combobox", { name: "Direction for sort priority 1" })
    .selectOption("descending");
  await cancelDialog.getByRole("button", { name: "Cancel" }).click();
  expect((await probe(page)).executeQuery).toBe(4);
  await expect(
    page.getByRole("button", { name: /Sort row_id: ascending, priority 1/ }),
  ).toBeVisible();

  await grid
    .getByRole("columnheader", { name: "category", exact: true })
    .press("Alt+Shift+ArrowLeft");
  const orderedHeaders = await grid
    .locator('.virtual-grid__column-header[role="columnheader"]')
    .evaluateAll((headers) =>
      headers.slice(0, 2).map((header) => header.getAttribute("aria-label")),
    );
  expect(orderedHeaders).toEqual(["category", "row_id"]);
  await screenshot(page, "column-reorder", testInfo.project.name);

  await grid.locator('[data-grid-row="4"][data-grid-column="0"]').click();
  await grid.locator('[data-grid-row="5"][data-grid-column="1"]').click({ modifiers: ["Shift"] });
  const groupFilterButton = page.getByRole("button", { name: "Filter group_id" });
  const filterDialog = page.getByRole("dialog", { name: "Filter group_id" });
  await expect(async () => {
    if (!(await filterDialog.isVisible())) await groupFilterButton.click();
    await expect(filterDialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await filterDialog.getByRole("textbox", { name: "Value", exact: true }).fill("4");
  await filterDialog.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(5);
  await expect(grid).toHaveAttribute("data-active-row", "5");
  await expect(grid).toHaveAttribute("data-active-column", "1");
  await expect(grid).toHaveAttribute("data-selection-top", "5");
  await expect(grid).toHaveAttribute("data-selection-bottom", "5");
  await grid.locator('[data-grid-row="4"][data-grid-column="0"]').click();
  await grid.locator('[data-grid-row="5"][data-grid-column="1"]').click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Copy selection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /rows copied/ })).toBeVisible();
  const copyRequest = (await probe(page)).lastStartCopy as {
    queryId: string | null;
    selection: { rowStart: number; rowEndExclusive: number; columnIds: string[] };
  };
  expect(copyRequest.queryId).not.toBeNull();
  expect(copyRequest.selection).toEqual({
    rowStart: 4,
    rowEndExclusive: 6,
    columnIds: ["category", "row_id"],
  });

  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  await grid.press("Control+Shift+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "5849999");
  expect((await probe(page)).findDataBoundary).toBe(2);
  await expect(grid).toBeFocused();
  await expectInsideViewport(page.locator(".virtual-grid-shell"));
  await expectNoHorizontalPageOverflow(page);
});

test("copy failures expose typed current and previous attempts", async ({ page }, testInfo) => {
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  await grid.press("Control+a");
  await expect(page.getByText(/Excel limit:/)).toContainText(
    "5,850,000 rows exceed 1,048,576; copy is not truncated.",
  );
  await page.getByRole("button", { name: "Copy selection" }).click();
  const failure = page.getByRole("status").filter({ hasText: /selectionLimit/ });
  await expect(failure).toContainText("failed during preparing");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const firstMessage = await failure.textContent();

  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failure).not.toHaveText(firstMessage ?? "");
  await page.getByText("Copy history").click();
  const history = page.getByRole("list", { name: "Copy history" });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  const attempts = await history.getByRole("listitem").allTextContents();
  expect(new Set(attempts.map((item) => item.match(/copy-[0-9a-f-]+/)?.[0])).size).toBe(2);
  expect(attempts.every((item) => item.includes("selectionLimit"))).toBe(true);
  expect((await probe(page)).startCopy).toBe(2);
  expect(
    ((await probe(page)).lastStartCopy as { selection: { rowEndExclusive: number } }).selection,
  ).toHaveProperty("rowEndExclusive", 5_850_000);
  await screenshot(page, "copy-failure-history", testInfo.project.name);
  await expectNoHorizontalPageOverflow(page);
});

test("pending pages cannot overwrite another tab and cached tab restores stay stable", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.evaluate(() => {
    const current = Reflect.get(window, "__phase12Probe") as Phase12Probe;
    current.readPageDelayMs = 800;
  });
  await openMockFile(page, "large", "large-5850000.parquet");
  await openMockFile(page, "parquet", "typed-row-groups.parquet");

  const largeTab = page.getByRole("tab", { name: "large-5850000.parquet" });
  const typedTab = page.getByRole("tab", { name: "typed-row-groups.parquet" });
  await largeTab.click();
  const largePanel = page.getByRole("tabpanel", { name: "large-5850000.parquet" });
  let grid = page.getByRole("grid", { name: "Data preview" });
  await largePanel.getByRole("button", { name: "Next page" }).click();
  await expect(largePanel.getByLabel("Page navigation")).toHaveAttribute("aria-busy", "true");
  await screenshot(page, "query-loading", testInfo.project.name);
  await typedTab.click();
  grid = page.getByRole("grid", { name: "Data preview" });
  await expect(grid).toHaveAttribute("aria-rowcount", "240");
  await expect(grid.locator('[data-grid-row="0"][data-grid-column="0"]')).toContainText(
    "9007199254740993",
  );
  await page.waitForTimeout(300);
  await expect(grid).toHaveAttribute("aria-rowcount", "240");

  await largeTab.click();
  await expect(page.getByRole("grid", { name: "Data preview" })).toHaveAttribute(
    "aria-rowcount",
    "5850000",
  );
  await expect(largePanel.getByLabel("Page navigation")).toHaveAttribute("aria-busy", "false");
  const readsBeforeSwitches = (await probe(page)).readPage;
  for (let index = 0; index < 20; index += 1) {
    await typedTab.click();
    await expect(page.getByRole("grid", { name: "Data preview" })).toHaveAttribute(
      "aria-rowcount",
      "240",
    );
    await largeTab.click();
    await expect(page.getByRole("grid", { name: "Data preview" })).toHaveAttribute(
      "aria-rowcount",
      "5850000",
    );
  }
  const probeAfterSwitches = await probe(page);
  await mkdir("artifacts/phase-12/ui", { recursive: true });
  await writeFile(
    `artifacts/phase-12/ui/tab-reads-${viewportName(testInfo.project.name)}.json`,
    `${JSON.stringify(
      {
        readsBeforeSwitches,
        readsAfterSwitches: probeAfterSwitches.readPage,
        switchRequests: probeAfterSwitches.readPageRequests.slice(readsBeforeSwitches),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  expect
    .soft(probeAfterSwitches.readPage, "cached tab switches must not issue page reads")
    .toBe(readsBeforeSwitches);

  await typedTab.press("Alt+Shift+ArrowLeft");
  const tabOrder = await page
    .getByRole("tablist", { name: "Open files" })
    .getByRole("tab")
    .allTextContents();
  expect(tabOrder).toEqual(["typed-row-groups.parquet", "large-5850000.parquet"]);
  await expect(largeTab).toHaveAttribute("aria-selected", "true");
  await screenshot(page, "tab-restore", testInfo.project.name);
  await expectInsideViewport(largePanel.locator(".virtual-grid-shell"));
  await expectNoHorizontalPageOverflow(page);
});

test("final row and navigation targets remain fully visible", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  const lastCell = grid.locator('[data-grid-row="5849999"][data-grid-column="0"]');
  await expect(lastCell).toBeVisible();
  const finalRow = await lastCell.evaluate(
    (cell, gridElement) => {
      const cellRect = cell.getBoundingClientRect();
      const gridRect = (gridElement as HTMLElement).getBoundingClientRect();
      const element = gridElement as HTMLElement;
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
        scrollTop: element.scrollTop,
      };
    },
    await grid.elementHandle(),
  );
  expect(finalRow.cellHeight).toBe(48);
  expect(finalRow.cellBottom, JSON.stringify(finalRow)).toBeLessThanOrEqual(
    finalRow.gridContentBottom - finalRow.bottomClearance + 1,
  );
  expect(finalRow.gridContentBottom).toBeLessThanOrEqual(finalRow.gridBottom);
  await expect(grid).toBeFocused();
  await screenshot(page, "last-row", testInfo.project.name);
  await mkdir("artifacts/phase-12/ui", { recursive: true });
  await writeFile(
    `artifacts/phase-12/ui/geometry-${viewportName(testInfo.project.name)}.json`,
    `${JSON.stringify(
      {
        result: "PASS",
        project: testInfo.project.name,
        viewport: page.viewportSize(),
        finalRow,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await grid.press("PageUp");
  const pageUpRow = Number(await grid.getAttribute("data-active-row"));
  expect(pageUpRow).toBeLessThan(5_849_999);
  await grid.press("PageDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  await expect(lastCell).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});
