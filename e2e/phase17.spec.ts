import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow, openMockFile } from "./helpers";

type Phase17Endpoint = "readPage" | "readQueryPage";

type Phase17RequestLog = {
  endpoint: Phase17Endpoint;
  startedAt: number;
  resolvedAt: number | null;
  documentId: string | null;
  sessionId: string;
  queryId: string | null;
  offset: number;
  limit: number;
  columns: string[];
  deferred: boolean;
};

type Phase17ProbeView = {
  logs: Phase17RequestLog[];
  deferredCount: number;
};

const ROW_HEIGHT = 48;
const PAGE_LIMIT = 200;
const QUIET_MS = 120;
const PARALLEL_E2E_IMMEDIATE_MS = 500;
const PHYSICAL_SCROLL_HEIGHT_MAX = 36 + 200_000 * ROW_HEIGHT + 18;

function viewportName(projectName: string): "desktop" | "compact" | "minimum" {
  const names: Record<string, "desktop" | "compact" | "minimum"> = {
    "desktop-wide": "desktop",
    "desktop-compact": "compact",
    "desktop-minimum": "minimum",
  };
  const name = names[projectName];
  if (!name) throw new Error(`Unexpected Playwright project: ${projectName}`);
  return name;
}

async function installPhase17Probe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    let backendUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!backendUrl) {
      const appSource = await fetch(new URL("/src/App.tsx", window.location.href)).then(
        (response) => response.text(),
      );
      const transformedImport = appSource.match(/["'](\/src\/backend\.ts[^"']*)["']/)?.[1];
      if (!transformedImport)
        throw new Error("The transformed browser backend import was not found.");
      backendUrl = new URL(transformedImport, window.location.href).href;
    }
    const module = (await (0, eval)(
      `import(${JSON.stringify(backendUrl)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend;
    const originalReadPage = backend.readPage.bind(backend);
    const originalReadQueryPage = backend.readQueryPage.bind(backend);
    type Deferred = {
      run: () => Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    };
    const controlled = {
      logs: [] as Phase17RequestLog[],
      deferNext: { readPage: 0, readQueryPage: 0 } as Record<Phase17Endpoint, number>,
      deferred: [] as Deferred[],
      reset() {
        this.logs.length = 0;
      },
      async releaseAll() {
        const pending = this.deferred.splice(0);
        for (const deferred of pending.reverse()) {
          try {
            deferred.resolve(await deferred.run());
          } catch (error) {
            deferred.reject(error);
          }
        }
      },
    };

    function record<T>(
      endpoint: Phase17Endpoint,
      request: {
        documentId?: string;
        sessionId: string;
        queryId?: string;
        offset: number;
        limit: number;
        columns: string[];
      },
      run: () => Promise<T>,
    ): Promise<T> {
      const deferred = controlled.deferNext[endpoint] > 0;
      if (deferred) controlled.deferNext[endpoint] -= 1;
      const log: Phase17RequestLog = {
        endpoint,
        startedAt: performance.now(),
        resolvedAt: null,
        documentId: request.documentId ?? null,
        sessionId: request.sessionId,
        queryId: request.queryId ?? null,
        offset: request.offset,
        limit: request.limit,
        columns: [...request.columns],
        deferred,
      };
      controlled.logs.push(log);
      const trackedRun = async () => {
        const result = await run();
        log.resolvedAt = performance.now();
        return result;
      };
      if (!deferred) return trackedRun();
      return new Promise<T>((resolve, reject) => {
        controlled.deferred.push({
          run: trackedRun,
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
    }

    backend.readPage = (request) =>
      record("readPage", { ...request, columns: request.columns ?? [] }, () =>
        originalReadPage(request),
      );
    backend.readQueryPage = (request) =>
      record("readQueryPage", request, () => originalReadQueryPage(request));
    Reflect.set(window, "__phase17Probe", controlled);
  });
}

async function probe(page: Page): Promise<Phase17ProbeView> {
  return page.evaluate(() => {
    const controlled = Reflect.get(window, "__phase17Probe") as {
      logs: Phase17RequestLog[];
      deferred: unknown[];
    };
    return { logs: structuredClone(controlled.logs), deferredCount: controlled.deferred.length };
  });
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const controlled = Reflect.get(window, "__phase17Probe") as { reset: () => void };
    controlled.reset();
  });
}

async function deferNext(page: Page, endpoint: Phase17Endpoint): Promise<void> {
  await page.evaluate((value) => {
    const controlled = Reflect.get(window, "__phase17Probe") as {
      deferNext: Record<Phase17Endpoint, number>;
    };
    controlled.deferNext[value] += 1;
  }, endpoint);
}

async function releaseDeferred(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const controlled = Reflect.get(window, "__phase17Probe") as {
      releaseAll: () => Promise<void>;
    };
    await controlled.releaseAll();
  });
}

async function waitForInitialGrid(page: Page): Promise<Locator> {
  const grid = page.getByRole("grid", { name: "Data preview" });
  await expect(grid).toHaveAttribute("aria-rowcount", "5850000");
  await expect(grid).toHaveAttribute("data-scroll-mode", "idle");
  await expect(grid.locator('[data-grid-row="0"][data-grid-column="0"]')).toHaveText("0");
  // Initial adjacent prefetch is outside every scenario's measured delta.
  await page.waitForTimeout(320);
  await resetProbe(page);
  return grid;
}

async function scrollRowsFast(grid: Locator, rows: number[], hold = false): Promise<void> {
  await grid.evaluate(
    async (element, input) => {
      const gridElement = element as HTMLElement;
      for (const row of input.rows) {
        gridElement.scrollTop = row * 48;
        gridElement.dispatchEvent(new Event("scroll"));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (input.hold) {
        const settledScrollTop = gridElement.scrollTop;
        const interval = window.setInterval(() => {
          gridElement.scrollTop = settledScrollTop + 400 * 48;
          gridElement.dispatchEvent(new Event("scroll"));
          gridElement.scrollTop = settledScrollTop;
          gridElement.dispatchEvent(new Event("scroll"));
        }, 35);
        Reflect.set(window, "__phase17ScrollHold", interval);
      }
    },
    { rows, hold },
  );
}

async function stopScrollHoldAndSettle(grid: Locator): Promise<void> {
  await grid.evaluate((element) => {
    const interval = Reflect.get(window, "__phase17ScrollHold") as number | undefined;
    if (interval !== undefined) window.clearInterval(interval);
    Reflect.deleteProperty(window, "__phase17ScrollHold");
    element.dispatchEvent(new Event("scrollend"));
  });
}

async function suppressNativeScrollEnd(grid: Locator, suppress: boolean): Promise<void> {
  await grid.evaluate((element, enabled) => {
    Reflect.set(window, "__phase17SuppressScrollEnd", enabled);
    if (element.getAttribute("data-phase17-scrollend-probe") === "installed") return;
    element.setAttribute("data-phase17-scrollend-probe", "installed");
    element.addEventListener(
      "scrollend",
      (event) => {
        if (Reflect.get(window, "__phase17SuppressScrollEnd")) event.stopImmediatePropagation();
      },
      { capture: true },
    );
  }, suppress);
}

async function scrollToRow(grid: Locator, row: number): Promise<number> {
  return grid.evaluate((element, targetRow) => {
    const startedAt = performance.now();
    (element as HTMLElement).scrollTop = targetRow * 48;
    element.dispatchEvent(new Event("scroll"));
    return startedAt;
  }, row);
}

async function dispatchWheelBurst(grid: Locator, count: number, deltaY: number): Promise<number> {
  return grid.evaluate(
    (element, input) => {
      const gridElement = element as HTMLElement;
      const startedAt = performance.now();
      for (let index = 0; index < input.count; index += 1) {
        gridElement.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: input.deltaY }),
        );
        gridElement.scrollTop += input.deltaY;
        gridElement.dispatchEvent(new Event("scroll"));
      }
      return performance.now() - startedAt;
    },
    { count, deltaY },
  );
}

async function expectSingleFinalRequest(
  page: Page,
  endpoint: Phase17Endpoint,
  expectedOffset?: number,
): Promise<Phase17RequestLog> {
  await expect.poll(async () => (await probe(page)).logs.length).toBe(1);
  const [request] = (await probe(page)).logs;
  expect(request.endpoint).toBe(endpoint);
  expect(request.limit).toBe(PAGE_LIMIT);
  if (expectedOffset !== undefined) expect(request.offset).toBe(expectedOffset);
  expect(request.columns.length).toBeGreaterThan(0);
  return request;
}

async function activateCategorySort(page: Page, grid: Locator): Promise<string> {
  await page.getByRole("button", { name: "Sort category: not sorted" }).click();
  await expect(
    page.getByRole("button", { name: /Sort category: ascending, priority 1/ }),
  ).toBeVisible();
  await expect.poll(async () => grid.getAttribute("data-query-id")).not.toBe("");
  const queryId = await grid.getAttribute("data-query-id");
  if (!queryId) throw new Error("The query ID was not committed.");
  await expect(grid).toHaveAttribute("data-scroll-mode", "idle");
  await page.waitForTimeout(320);
  await resetProbe(page);
  return queryId;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open file" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => new URL(entry.name).pathname === "/src/backend.ts"),
      ),
    )
    .toBe(true);
  await installPhase17Probe(page);
});

test("T-P17-023/024 suppresses intermediate source reads for scrollbar and wheel scrub", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = await waitForInitialGrid(page);

  await scrollRowsFast(grid, [600, 1_200, 1_800, 2_500, 3_200, 4_000, 5_000, 6_200, 7_400, 9_137]);
  await expect(grid).toHaveAttribute("data-visible-offset", "9000");
  await page.waitForTimeout(70);
  const scrollbarLogsBeforeExplicitSettle = (await probe(page)).logs;
  expect(scrollbarLogsBeforeExplicitSettle.map((request) => request.offset)).toEqual(
    scrollbarLogsBeforeExplicitSettle.length === 0 ? [] : [9_000],
  );
  if (scrollbarLogsBeforeExplicitSettle.length === 0) await stopScrollHoldAndSettle(grid);
  const scrollbarRequest = await expectSingleFinalRequest(page, "readPage", 9_000);
  expect(scrollbarRequest.sessionId).toContain("large-parquet-session");
  await expect(grid.locator('[data-grid-row="9137"][data-grid-column="0"]')).toHaveText("913700");
  await page.waitForTimeout(QUIET_MS + 80);
  expect((await probe(page)).logs).toHaveLength(1);

  await resetProbe(page);
  await suppressNativeScrollEnd(grid, true);
  // Two adjacent 100-row samples are individually sub-page but cumulatively cross one page
  // inside the 120ms velocity window.
  const wheelBurstMs = await dispatchWheelBurst(grid, 20, 480);
  expect(wheelBurstMs).toBeLessThan(QUIET_MS);
  await page.waitForTimeout(70);
  const wheelLogsDuringBurst = (await probe(page)).logs;
  expect(wheelLogsDuringBurst.length).toBeLessThanOrEqual(1);
  const wheelVisibleOffset = Number(await grid.getAttribute("data-visible-offset"));
  expect(wheelLogsDuringBurst.every((request) => request.offset === wheelVisibleOffset)).toBe(true);
  const wheelRequest = await expectSingleFinalRequest(page, "readPage");
  await expect(grid).toHaveAttribute("data-scroll-mode", "idle");
  await suppressNativeScrollEnd(grid, false);
  const finalVisibleOffset = Number(await grid.getAttribute("data-visible-offset"));
  expect(wheelRequest.offset).toBe(finalVisibleOffset);
  expect(wheelRequest.offset).toBeGreaterThan(9_000);
  await page.waitForTimeout(QUIET_MS + 80);
  expect((await probe(page)).logs).toHaveLength(1);
});

test("T-P17-025 keeps slow foreground, adjacent prefetch, and cache hits immediate", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = await waitForInitialGrid(page);

  await scrollToRow(grid, 10);
  await page.waitForTimeout(QUIET_MS + 20);
  await resetProbe(page);
  const slowStartedAt = await scrollToRow(grid, 210);
  const slowRequest = await expectSingleFinalRequest(page, "readPage", 200);
  expect(slowRequest.startedAt - slowStartedAt).toBeLessThan(PARALLEL_E2E_IMMEDIATE_MS);
  await expect(grid).toHaveAttribute("data-scroll-mode", "idle");
  await expect(grid.locator('[data-grid-row="210"][data-grid-column="0"]')).toHaveText("21000");

  await page.waitForTimeout(QUIET_MS + 20);
  await resetProbe(page);
  await scrollToRow(grid, 350);
  const prefetch = await expectSingleFinalRequest(page, "readPage", 400);
  expect(prefetch.offset).toBe(400);
  await expect.poll(async () => (await probe(page)).logs[0]?.resolvedAt ?? null).not.toBeNull();

  await scrollToRow(grid, 420);
  await expect(grid).toHaveAttribute("data-visible-offset", "400");
  await page.waitForTimeout(QUIET_MS + 20);
  await scrollToRow(grid, 421);
  await resetProbe(page);
  await suppressNativeScrollEnd(grid, true);
  await scrollRowsFast(grid, [20], true);
  await expect(grid).toHaveAttribute("data-scroll-mode", "scrub");
  await expect(grid).toHaveAttribute("data-visible-offset", "0");
  await expect(grid.locator('[data-grid-row="20"][data-grid-column="0"]')).toHaveText("2000");
  expect((await probe(page)).logs).toEqual([]);
  await suppressNativeScrollEnd(grid, false);
  await stopScrollHoldAndSettle(grid);
});

test("T-P17-026 rejects stale source and query pages after the final scrub target", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = await waitForInitialGrid(page);

  await scrollToRow(grid, 220);
  await page.waitForTimeout(QUIET_MS + 20);
  await deferNext(page, "readPage");
  await resetProbe(page);
  await scrollToRow(grid, 410);
  await expect.poll(async () => (await probe(page)).deferredCount).toBe(1);
  await suppressNativeScrollEnd(grid, true);
  await scrollRowsFast(grid, [800, 1_800, 5_000, 9_137]);
  await page.waitForTimeout(70);
  const sourceBeforeSettle = (await probe(page)).logs;
  const sourceOld = sourceBeforeSettle.filter((request) => request.offset !== 9_000);
  expect(sourceOld.length).toBeLessThanOrEqual(2);
  expect(sourceOld.every((request) => request.offset === 400 || request.offset === 800)).toBe(true);
  expect(
    sourceBeforeSettle.filter((request) => request.offset === 9_000).length,
  ).toBeLessThanOrEqual(1);
  await suppressNativeScrollEnd(grid, false);
  if (!sourceBeforeSettle.some((request) => request.offset === 9_000)) {
    await stopScrollHoldAndSettle(grid);
  }
  await expect.poll(async () => (await probe(page)).logs.at(-1)?.offset).toBe(9_000);
  const sourceRequests = (await probe(page)).logs;
  expect(sourceRequests.slice(0, -1).length).toBeLessThanOrEqual(2);
  expect(sourceRequests.slice(0, -1).every((request) => [400, 800].includes(request.offset))).toBe(
    true,
  );
  await expect(grid.locator('[data-grid-row="9137"][data-grid-column="0"]')).toHaveText("913700");
  await releaseDeferred(page);
  await expect(grid).toHaveAttribute("data-visible-offset", "9000");
  await expect(grid.locator('[data-grid-row="9137"][data-grid-column="0"]')).toHaveText("913700");

  const queryId = await activateCategorySort(page, grid);
  await scrollToRow(grid, 220);
  await page.waitForTimeout(QUIET_MS + 20);
  await deferNext(page, "readQueryPage");
  await resetProbe(page);
  await scrollToRow(grid, 410);
  await expect.poll(async () => (await probe(page)).deferredCount).toBe(1);
  await suppressNativeScrollEnd(grid, true);
  await scrollRowsFast(grid, [800, 1_800, 5_000, 9_137]);
  await page.waitForTimeout(70);
  const queryBeforeSettle = (await probe(page)).logs;
  const queryOld = queryBeforeSettle.filter((request) => request.offset !== 9_000);
  expect(queryOld.length).toBeLessThanOrEqual(2);
  expect(queryOld.every((request) => request.offset === 400 || request.offset === 800)).toBe(true);
  expect(
    queryBeforeSettle.filter((request) => request.offset === 9_000).length,
  ).toBeLessThanOrEqual(1);
  await suppressNativeScrollEnd(grid, false);
  if (!queryBeforeSettle.some((request) => request.offset === 9_000)) {
    await stopScrollHoldAndSettle(grid);
  }
  await expect.poll(async () => (await probe(page)).logs.at(-1)?.offset).toBe(9_000);
  const queryRequests = (await probe(page)).logs;
  expect(queryRequests.slice(0, -1).length).toBeLessThanOrEqual(2);
  expect(queryRequests.slice(0, -1).every((request) => [400, 800].includes(request.offset))).toBe(
    true,
  );
  expect(queryRequests.at(-1)?.offset).toBe(9_000);
  expect(queryRequests.every((request) => request.endpoint === "readQueryPage")).toBe(true);
  expect(queryRequests.every((request) => request.queryId === queryId)).toBe(true);
  expect(queryRequests.at(-1)?.columns).toEqual(queryRequests[0].columns);
  await expect(grid.locator('[data-grid-row="9137"][data-grid-column="0"]')).toHaveText("913700");
  await releaseDeferred(page);
  await expect(grid).toHaveAttribute("data-query-id", queryId);
  await expect(grid).toHaveAttribute("data-visible-offset", "9000");
  await expect(grid.locator('[data-grid-row="9137"][data-grid-column="0"]')).toHaveText("913700");
  await expect(page.getByText(/page could not be read/i)).toHaveCount(0);
});

test("T-P17-027 preserves keyboard selection, focus, and segmented last-row geometry", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = await waitForInitialGrid(page);
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  await resetProbe(page);

  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  await expect(grid).toHaveAttribute("data-visible-offset", "5849800");
  const lastCell = grid.locator('[data-grid-row="5849999"][data-grid-column="0"]');
  await expect(lastCell).toHaveText("584999900");
  await expect(lastCell).toBeVisible();
  await expect(grid).toBeFocused();
  expect(
    (await probe(page)).logs.filter((request) => request.endpoint === "readPage").length,
  ).toBeLessThanOrEqual(1);

  await grid.press("PageUp");
  const pageUpRow = Number(await grid.getAttribute("data-active-row"));
  expect(pageUpRow).toBeLessThan(5_849_999);
  await grid.press("PageDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  await expect(lastCell).toBeVisible();
  await expect(grid).toBeFocused();

  await grid.press("Control+Alt+Shift+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid).toHaveAttribute("data-selection-top", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "5849999");
  await expect(grid.locator('[data-grid-row="0"][data-grid-column="0"]')).toBeVisible();
  await expect(grid).toBeFocused();
});

test("T-P17-028/029 records three-viewport scrub, settled, and geometry evidence", async ({
  page,
}, testInfo: TestInfo) => {
  test.setTimeout(90_000);
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = await waitForInitialGrid(page);
  const shell = page.locator(".virtual-grid-shell");
  const shellBefore = await shell.boundingBox();
  if (!shellBefore) throw new Error("The grid shell is not measurable.");

  await deferNext(page, "readPage");
  await suppressNativeScrollEnd(grid, true);
  await scrollRowsFast(grid, [600, 1_800, 5_000, 7_400, 9_137]);
  await expect(grid).toHaveAttribute("data-scroll-mode", /^(scrub|idle)$/);
  await expect(grid).toHaveAttribute("data-visible-offset", "9000");
  await expect(grid.getByRole("rowheader", { name: "9138" })).toBeVisible();
  const scrubLogs = (await probe(page)).logs;
  expect(scrubLogs.length).toBeLessThanOrEqual(1);
  expect(scrubLogs.every((request) => request.offset === 9_000)).toBe(true);
  const pendingCell = grid.locator('[data-grid-row="9137"][data-grid-column="0"]');
  await expect(pendingCell).toHaveClass(/virtual-grid__cell--loading/);

  const artifactName = viewportName(testInfo.project.name);
  await mkdir("artifacts/phase-17/ui", { recursive: true });
  await page.screenshot({
    path: `artifacts/phase-17/ui/browser-${artifactName}.png`,
    fullPage: true,
  });

  await suppressNativeScrollEnd(grid, false);
  await stopScrollHoldAndSettle(grid);
  await expectSingleFinalRequest(page, "readPage", 9_000);
  await expect.poll(async () => (await probe(page)).deferredCount).toBe(1);
  await releaseDeferred(page);
  await expect(pendingCell).toHaveText("913700");
  await pendingCell.click();
  await expect(grid).toBeFocused();
  await page.screenshot({
    path: `artifacts/phase-17/ui/settled-${artifactName}.png`,
    fullPage: true,
  });

  const header = grid.getByRole("columnheader", { name: "row_id" });
  const geometry = await grid.evaluate((element) => {
    const gridElement = element as HTMLElement;
    const shellElement = gridElement.closest<HTMLElement>(".virtual-grid-shell");
    const headerElement = gridElement.querySelector<HTMLElement>(
      '[role="columnheader"][aria-label="row_id"]',
    );
    const cellElement = gridElement.querySelector<HTMLElement>(
      '[data-grid-row="9137"][data-grid-column="0"]',
    );
    const rowHeader = gridElement.querySelector<HTMLElement>('[role="rowheader"]');
    if (!shellElement || !headerElement || !cellElement || !rowHeader) {
      throw new Error("Required grid geometry element is missing.");
    }
    const rect = (target: HTMLElement) => {
      const bounds = target.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      grid: rect(gridElement),
      shell: rect(shellElement),
      header: rect(headerElement),
      cell: rect(cellElement),
      rowHeader: rect(rowHeader),
      clientHeight: gridElement.clientHeight,
      scrollHeight: gridElement.scrollHeight,
      scrollTop: gridElement.scrollTop,
      mountedRows: Number(gridElement.dataset.mountedRows),
      mountedCells: Number(gridElement.dataset.mountedCells),
      visibleOffset: Number(gridElement.dataset.visibleOffset),
    };
  });
  const shellAfter = await shell.boundingBox();
  if (!shellAfter) throw new Error("The settled grid shell is not measurable.");
  expect(Math.abs(geometry.header.left - geometry.cell.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.header.width - geometry.cell.width)).toBeLessThanOrEqual(1);
  expect(geometry.cell.height).toBe(ROW_HEIGHT);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(PHYSICAL_SCROLL_HEIGHT_MAX);
  expect(geometry.mountedRows).toBeLessThan(100);
  expect(geometry.mountedCells).toBeLessThan(1_500);
  expect(geometry.visibleOffset).toBe(9_000);
  expect(Math.abs(shellAfter.width - shellBefore.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(shellAfter.height - shellBefore.height)).toBeLessThanOrEqual(1);
  await expect(header).toBeVisible();

  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  const finalRow = await grid.locator('[data-grid-row="5849999"][data-grid-column="0"]').evaluate(
    (cell, gridElement) => {
      const cellRect = cell.getBoundingClientRect();
      const element = gridElement as HTMLElement;
      const gridRect = element.getBoundingClientRect();
      return {
        cellBottom: cellRect.bottom,
        cellHeight: cellRect.height,
        gridBottom: gridRect.top + element.clientHeight,
        bottomClearance: Number(element.dataset.bottomClearance),
      };
    },
    await grid.elementHandle(),
  );
  expect(finalRow.cellHeight).toBe(ROW_HEIGHT);
  expect(finalRow.cellBottom).toBeLessThanOrEqual(
    finalRow.gridBottom - finalRow.bottomClearance + 1,
  );
  await expect(grid).toBeFocused();
  await expectInsideViewport(shell);
  await expectNoHorizontalPageOverflow(page);

  await writeFile(
    `artifacts/phase-17/ui/geometry-${artifactName}.json`,
    `${JSON.stringify(
      {
        result: "PASS",
        project: testInfo.project.name,
        viewport: page.viewportSize(),
        scrubAndSettled: geometry,
        finalRow,
        shellShift: {
          width: shellAfter.width - shellBefore.width,
          height: shellAfter.height - shellBefore.height,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});
