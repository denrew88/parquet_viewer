import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  expectInsideViewport,
  expectNoHorizontalPageOverflow,
  openMockFile,
  setMockScenario,
} from "./helpers";

type PreparationState = "preparing" | "ready" | "failed" | "cancelled";

interface Phase16Probe {
  fixture: string;
  state: PreparationState;
  holdPrepare: boolean;
  prepareCsvSession: number;
  getCsvPreparationStatus: number;
  cancelCsvPreparation: number;
  readPage: number;
  listDistinctValues: number;
  executeQuery: number;
  readQueryPage: number;
  startCopy: number;
  getCopyStatus: number;
  getCopyHistory: number;
  findDataBoundary: number;
  readCellValue: number;
}

interface WarmFrameProbe {
  blockerSeen: boolean;
  progressSeen: boolean;
  cancelSeen: boolean;
}

interface RectSnapshot {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

const dataCounterKeys = [
  "readPage",
  "listDistinctValues",
  "executeQuery",
  "readQueryPage",
  "startCopy",
  "getCopyStatus",
  "getCopyHistory",
  "findDataBoundary",
  "readCellValue",
] as const satisfies readonly (keyof Phase16Probe)[];

function viewportName(projectName: string): "desktop" | "compact" | "minimum" {
  if (projectName.includes("minimum")) return "minimum";
  if (projectName.includes("compact")) return "compact";
  return "desktop";
}

async function installControlledFixture(
  page: Page,
  fixture: string,
  initialState: PreparationState,
  options: { holdPrepare?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    async ({ fixtureName, state, holdPrepare }) => {
      const backendUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname === "/src/backend.ts");
      if (!backendUrl) throw new Error("The browser mock backend module was not loaded.");
      const module = (await (0, eval)(
        `import(${JSON.stringify(backendUrl)})`,
      )) as typeof import("../src/backend");
      const backend = module.browserMockBackend;
      const controlled: Phase16Probe = {
        fixture: fixtureName,
        state,
        holdPrepare,
        prepareCsvSession: 0,
        getCsvPreparationStatus: 0,
        cancelCsvPreparation: 0,
        readPage: 0,
        listDistinctValues: 0,
        executeQuery: 0,
        readQueryPage: 0,
        startCopy: 0,
        getCopyStatus: 0,
        getCopyHistory: 0,
        findDataBoundary: 0,
        readCellValue: 0,
      };
      Reflect.set(window, "__phase16Probe", controlled);

      const status = (documentId: string, sessionId: string) => ({
        documentId,
        sessionId,
        state: controlled.state,
        rowsScanned: controlled.state === "ready" ? 1_000 : 375,
        totalRows: 1_000,
        sourceReadBytes: controlled.state === "ready" ? 8_192 : 3_072,
        totalBytes: 8_192,
        cacheOutputBytes: controlled.state === "ready" ? 6_144 : 2_048,
        navigationFrontierRow: controlled.state === "ready" ? 1_000 : 0,
        elapsedMs: controlled.state === "ready" ? 820 : 420,
        error:
          controlled.state === "failed"
            ? { code: "PreparationFailed", message: "Controlled preparation failure." }
            : controlled.state === "cancelled"
              ? { code: "Cancelled", message: "Controlled cancellation." }
              : null,
      });

      const originalSelectDataFilePath = backend.selectDataFilePath.bind(backend);
      backend.selectDataFilePath = async (requestId) => {
        const current = new URL(window.location.href);
        if (!current.searchParams.get("mock")?.startsWith("csv-")) {
          return originalSelectDataFilePath(requestId);
        }
        const csvUrl = new URL(current);
        csvUrl.searchParams.set("mock", "csv");
        window.history.replaceState(null, "", csvUrl);
        try {
          return await originalSelectDataFilePath(requestId);
        } finally {
          window.history.replaceState(null, "", current);
        }
      };

      backend.prepareCsvSession = async (documentId, sessionId) => {
        controlled.prepareCsvSession += 1;
        while (controlled.holdPrepare) {
          await new Promise((resolve) => window.setTimeout(resolve, 10));
        }
        return status(documentId, sessionId);
      };
      backend.getCsvPreparationStatus = async (documentId, sessionId) => {
        controlled.getCsvPreparationStatus += 1;
        return status(documentId, sessionId);
      };
      backend.cancelCsvPreparation = async (documentId, sessionId) => {
        controlled.cancelCsvPreparation += 1;
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        controlled.state = "cancelled";
        return status(documentId, sessionId);
      };

      const readPage = backend.readPage.bind(backend);
      backend.readPage = async (request) => {
        controlled.readPage += 1;
        return readPage(request);
      };
      const listDistinctValues = backend.listDistinctValues.bind(backend);
      backend.listDistinctValues = async (request) => {
        controlled.listDistinctValues += 1;
        return listDistinctValues(request);
      };
      const executeQuery = backend.executeQuery.bind(backend);
      backend.executeQuery = async (request) => {
        controlled.executeQuery += 1;
        return executeQuery(request);
      };
      const readQueryPage = backend.readQueryPage.bind(backend);
      backend.readQueryPage = async (request) => {
        controlled.readQueryPage += 1;
        return readQueryPage(request);
      };
      const startCopy = backend.startCopy.bind(backend);
      backend.startCopy = async (request) => {
        controlled.startCopy += 1;
        return startCopy(request);
      };
      const getCopyStatus = backend.getCopyStatus.bind(backend);
      backend.getCopyStatus = async (request) => {
        controlled.getCopyStatus += 1;
        return getCopyStatus(request);
      };
      const getCopyHistory = backend.getCopyHistory.bind(backend);
      backend.getCopyHistory = async (documentId, sessionId) => {
        controlled.getCopyHistory += 1;
        return getCopyHistory(documentId, sessionId);
      };
      const findDataBoundary = backend.findDataBoundary.bind(backend);
      backend.findDataBoundary = async (request) => {
        controlled.findDataBoundary += 1;
        return findDataBoundary(request);
      };
      const readCellValue = backend.readCellValue.bind(backend);
      backend.readCellValue = async (request) => {
        controlled.readCellValue += 1;
        return readCellValue(request);
      };
    },
    { fixtureName: fixture, state: initialState, holdPrepare: options.holdPrepare ?? false },
  );
}

async function phase16Probe(page: Page): Promise<Phase16Probe> {
  return page.evaluate(() =>
    structuredClone(Reflect.get(window, "__phase16Probe") as Phase16Probe),
  );
}

async function setPreparationState(page: Page, state: PreparationState): Promise<void> {
  await page.evaluate((next) => {
    const controlled = Reflect.get(window, "__phase16Probe") as Phase16Probe;
    controlled.state = next;
  }, state);
}

async function releasePrepare(page: Page, state: PreparationState): Promise<void> {
  await page.evaluate((next) => {
    const controlled = Reflect.get(window, "__phase16Probe") as Phase16Probe;
    controlled.state = next;
    controlled.holdPrepare = false;
  }, state);
}

function dataCounterTotal(value: Phase16Probe): number {
  return dataCounterKeys.reduce((total, key) => total + Number(value[key]), 0);
}

async function clickCenter(page: Page, locator: Locator): Promise<void> {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("The target has no layout box.");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

async function rect(locator: Locator): Promise<RectSnapshot> {
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      height: bounds.height,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      width: bounds.width,
    };
  });
}

function expectStableRect(before: RectSnapshot, after: RectSnapshot): void {
  for (const key of ["bottom", "height", "left", "right", "top", "width"] as const) {
    expect(Math.abs(before[key] - after[key]), `${key} layout shift`).toBeLessThanOrEqual(1);
  }
}

async function installWarmFrameObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state: WarmFrameProbe = {
      blockerSeen: false,
      progressSeen: false,
      cancelSeen: false,
    };
    Reflect.set(window, "__phase16WarmFrameProbe", state);
    const inspect = () => {
      state.blockerSeen ||=
        document.querySelector('[data-testid="csv-preparation-blocker"]') !== null;
      state.progressSeen ||=
        document.querySelector('progress[aria-label="CSV preparation progress"]') !== null;
      state.cancelSeen ||= Array.from(document.querySelectorAll(".csv-preparation button")).some(
        (button) => button.textContent?.trim() === "Cancel",
      );
    };
    inspect();
    new MutationObserver(inspect).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
}

async function warmFrameProbe(page: Page): Promise<WarmFrameProbe> {
  return page.evaluate(() =>
    structuredClone(Reflect.get(window, "__phase16WarmFrameProbe") as WarmFrameProbe),
  );
}

async function saveGeometry(testInfo: TestInfo, value: Record<string, unknown>): Promise<void> {
  await mkdir("artifacts/phase-16/ui", { recursive: true });
  const name = viewportName(testInfo.project.name);
  await writeFile(
    `artifacts/phase-16/ui/geometry-${name}.json`,
    `${JSON.stringify(
      {
        result: "PASS",
        project: testInfo.project.name,
        viewport: testInfo.project.use.viewport,
        ...value,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function captureState(
  page: Page,
  testInfo: TestInfo,
  state: "blocked" | "failed",
): Promise<void> {
  await mkdir("artifacts/phase-16/ui", { recursive: true });
  const viewport = viewportName(testInfo.project.name);
  const fileName =
    state === "blocked" ? `browser-${viewport}.png` : `csv-failed-unblocked-${viewport}.png`;
  const path = `artifacts/phase-16/ui/${fileName}`;
  await page.screenshot({ path });
  await testInfo.attach(`phase16-${state}-${viewport}`, { path, contentType: "image/png" });
}

test.describe("Phase 16 CSV preparation interaction gate", () => {
  test("T-P16-007/015 blocks repeated Data pointer and keyboard input with zero IPC delta", async ({
    page,
  }) => {
    await page.goto("/?mock=csv-preparing-controlled");
    await installControlledFixture(page, "csv-preparing-controlled", "preparing");
    await openMockFile(page, "csv-preparing-controlled", "quoted-multiline.csv");

    const surface = page.getByTestId("csv-data-interaction-surface");
    const blocker = page.getByTestId("csv-preparation-blocker");
    const grid = page.getByRole("grid", { name: "Data preview" });
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText("Preparing CSV data");
    await expect(surface).toHaveAttribute("inert", "");
    await expect(surface).toHaveAttribute("aria-disabled", "true");

    const initialSelection = await grid.evaluate((element) => ({
      activeColumn: element.getAttribute("data-active-column"),
      activeRow: element.getAttribute("data-active-row"),
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    }));
    const before = await phase16Probe(page);
    const filter = page.getByRole("button", { name: "Filter name", exact: true });
    const copy = page.getByRole("button", { name: "Copy selection" });
    const find = page.getByRole("button", { name: "Find", exact: true });
    const sorts = page.getByRole("button", { name: /^Sorts/ });
    const searchColumns = page.getByRole("searchbox", { name: "Search columns" });

    for (let index = 0; index < 10; index += 1) {
      await clickCenter(page, filter);
      await clickCenter(page, copy);
      await clickCenter(page, find);
      await clickCenter(page, sorts);
      await clickCenter(page, searchColumns);
      await page.keyboard.press("Control+f");
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+ArrowDown");
      await page.keyboard.press("Shift+ArrowRight");
      const gridBounds = await grid.boundingBox();
      if (gridBounds) {
        await page.mouse.move(
          gridBounds.x + gridBounds.width / 2,
          gridBounds.y + gridBounds.height / 2,
        );
        await page.mouse.wheel(0, 240);
      }
    }

    const after = await phase16Probe(page);
    expect(dataCounterTotal(after)).toBe(dataCounterTotal(before));
    expect(
      await grid.evaluate((element) => ({
        activeColumn: element.getAttribute("data-active-column"),
        activeRow: element.getAttribute("data-active-row"),
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
      })),
    ).toEqual(initialSelection);
    await expect(page.getByRole("dialog", { name: /^Filter / })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Column chooser" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Multi-column sort" })).toHaveCount(0);
    await expect(page.getByRole("menu", { name: "Copy options" })).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Find data" })).toHaveCount(0);
  });

  test("T-P16-007 closes starting-state transients and moves focus outside the inert subtree", async ({
    page,
  }) => {
    await page.goto("/?mock=csv-preparing-controlled");
    await installControlledFixture(page, "csv-preparing-controlled", "preparing", {
      holdPrepare: true,
    });
    await openMockFile(page, "csv-preparing-controlled", "quoted-multiline.csv");

    await page.getByRole("button", { name: "Find", exact: true }).click();
    const findInput = page.getByRole("searchbox", { name: "Find data" });
    await expect(findInput).toBeFocused();
    const before = await rect(page.getByTestId("csv-data-interaction-surface"));

    await releasePrepare(page, "preparing");
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();
    await expect(findInput).toHaveCount(0);
    const focusState = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="csv-data-interaction-surface"]');
      return {
        activeTag: document.activeElement?.tagName ?? null,
        insideSurface:
          surface !== null &&
          document.activeElement !== null &&
          surface.contains(document.activeElement),
      };
    });
    expect(focusState.insideSurface, JSON.stringify(focusState)).toBe(false);
    expectStableRect(before, await rect(page.getByTestId("csv-data-interaction-surface")));
  });

  test("T-P16-008/009 isolates a blocked CSV while tabs, views, Settings, and close remain usable", async ({
    page,
  }) => {
    await page.goto("/?mock=csv-preparing-controlled");
    await installControlledFixture(page, "two-doc-isolation", "preparing");
    await openMockFile(page, "csv-preparing-controlled", "quoted-multiline.csv");
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();

    await page.getByRole("tab", { name: "Schema", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Schema" })).toBeVisible();
    await page.getByRole("tab", { name: "Metadata", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Metadata" })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Application settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();

    await setMockScenario(page, "default");
    await page.getByRole("button", { name: "Open file" }).click();
    const parquetTab = page.getByRole("tab", { name: "typed-row-groups.parquet" });
    await expect(parquetTab).toBeVisible();
    const parquetGrid = page.getByRole("grid", { name: "Data preview" });
    await parquetGrid.getByRole("gridcell").nth(1).click();
    await expect(parquetGrid).toHaveAttribute("data-active-column", "1");

    await page.getByRole("tab", { name: "quoted-multiline.csv" }).click();
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();
    const pollsBeforeClose = (await phase16Probe(page)).getCsvPreparationStatus;
    await page.getByRole("button", { name: "Close quoted-multiline.csv" }).click();
    await expect(page.getByRole("tab", { name: "quoted-multiline.csv" })).toHaveCount(0);
    await expect(parquetTab).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(850);
    expect((await phase16Probe(page)).getCsvPreparationStatus).toBe(pollsBeforeClose);
  });

  test("T-P16-010 keeps the gate through Cancelling and enables direct Data at Cancelled", async ({
    page,
  }) => {
    await page.goto("/?mock=csv-terminal-controlled");
    await installControlledFixture(page, "csv-terminal-controlled", "preparing");
    await openMockFile(page, "csv-terminal-controlled", "quoted-multiline.csv");
    const card = page.locator(".csv-preparation");
    const cancel = card.getByRole("button", { name: "Cancel", exact: true });
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();
    await cancel.click();
    await expect(card.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();
    expect((await phase16Probe(page)).cancelCsvPreparation).toBe(1);

    await expect(card).toContainText("CSV preparation cancelled");
    await expect(page.getByTestId("csv-preparation-blocker")).toHaveCount(0);
    const before = await phase16Probe(page);
    await page.getByRole("button", { name: "Filter name", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Filter name" })).toBeVisible();
    await expect
      .poll(async () => (await phase16Probe(page)).listDistinctValues)
      .toBeGreaterThan(before.listDistinctValues);
  });

  test("T-P16-011/012 restores direct fallback, blocks Retry Preparing, then unlocks once at Ready", async ({
    page,
  }) => {
    await page.goto("/?mock=csv-terminal-controlled");
    await installControlledFixture(page, "csv-terminal-controlled", "failed");
    await openMockFile(page, "csv-terminal-controlled", "quoted-multiline.csv");
    const failed = page.getByRole("alert").filter({ hasText: "CSV preparation failed" });
    await expect(failed).toContainText("PreparationFailed: Controlled preparation failure.");
    await expect(page.getByTestId("csv-preparation-blocker")).toHaveCount(0);

    const directBefore = await phase16Probe(page);
    await page.getByRole("button", { name: "Filter name", exact: true }).click();
    const filter = page.getByRole("dialog", { name: "Filter name" });
    await filter.getByRole("textbox", { name: "Value", exact: true }).fill("Kim");
    await filter.getByRole("button", { name: "Apply" }).click();
    await expect
      .poll(async () => (await phase16Probe(page)).executeQuery)
      .toBeGreaterThan(directBefore.executeQuery);
    await page.getByRole("button", { name: "Copy selection" }).click();
    await expect
      .poll(async () => (await phase16Probe(page)).startCopy)
      .toBeGreaterThan(directBefore.startCopy);

    await setPreparationState(page, "preparing");
    await failed.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("csv-preparation-blocker")).toBeVisible();
    const blocked = await phase16Probe(page);
    await clickCenter(page, page.getByRole("button", { name: "Filter name", exact: true }));
    expect(dataCounterTotal(await phase16Probe(page))).toBe(dataCounterTotal(blocked));

    await setPreparationState(page, "ready");
    await expect(page.getByTestId("csv-preparation-blocker")).toHaveCount(0, { timeout: 2_500 });
    await expect(page.locator(".csv-preparation")).toHaveCount(0);
    expect((await phase16Probe(page)).prepareCsvSession).toBe(2);
  });

  test("T-P16-013 warm immediate Ready has zero blocker/progress frames and is first-frame interactive", async ({
    page,
  }) => {
    await page.goto("/?mock=csv-warm-immediate-ready");
    await installControlledFixture(page, "csv-warm-immediate-ready", "ready");
    await installWarmFrameObserver(page);
    await openMockFile(page, "csv-warm-immediate-ready", "quoted-multiline.csv");

    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(await warmFrameProbe(page)).toEqual({
      blockerSeen: false,
      progressSeen: false,
      cancelSeen: false,
    });
    const controlled = await phase16Probe(page);
    expect(controlled.prepareCsvSession).toBe(1);
    expect(controlled.getCsvPreparationStatus).toBe(0);
    const grid = page.getByRole("grid", { name: "Data preview" });
    await grid.getByRole("gridcell").nth(1).click();
    await expect(grid).toHaveAttribute("data-active-column", "1");
  });

  test("T-P16-021/022/023 validates blocker geometry, hit testing, layout stability, and screenshots", async ({
    page,
  }, testInfo) => {
    await page.goto("/?mock=csv-preparing-controlled");
    await installControlledFixture(page, "csv-preparing-controlled", "preparing");
    await openMockFile(page, "csv-preparing-controlled", "quoted-multiline.csv");

    const blocker = page.getByTestId("csv-preparation-blocker");
    const surface = page.getByTestId("csv-data-interaction-surface");
    const progress = page.getByRole("progressbar", { name: "CSV preparation progress" });
    const cancel = page.locator(".csv-preparation").getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    const settings = page.getByRole("button", { name: "Settings" });
    const dataTab = page.getByRole("tab", { name: "Data", exact: true });
    await expect(blocker).toBeVisible();
    await expect(progress).toBeVisible();
    await expectInsideViewport(blocker);
    await expectInsideViewport(progress);
    await expectInsideViewport(cancel);
    await expectNoHorizontalPageOverflow(page);

    const surfaceRect = await rect(surface);
    const blockerRect = await rect(blocker);
    expect(blockerRect.left).toBeLessThanOrEqual(surfaceRect.left + 1);
    expect(blockerRect.top).toBeLessThanOrEqual(surfaceRect.top + 1);
    expect(blockerRect.right).toBeGreaterThanOrEqual(surfaceRect.right - 1);
    expect(blockerRect.bottom).toBeGreaterThanOrEqual(surfaceRect.bottom - 1);
    const hitTest = await page.evaluate(() => {
      const snapshot = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return { contains: false, target: null };
        const bounds = element.getBoundingClientRect();
        const target = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return {
          contains: target !== null && element.contains(target),
          target:
            target?.getAttribute("data-testid") ??
            target?.getAttribute("aria-label") ??
            target?.tagName ??
            null,
        };
      };
      return {
        blocker: snapshot('[data-testid="csv-preparation-blocker"]'),
        cancel: snapshot(".csv-preparation button"),
        settings: snapshot('button[aria-label="Settings"], button[title="Settings"]'),
        dataTab: snapshot("#tab-data"),
      };
    });
    expect(hitTest.blocker.contains, JSON.stringify(hitTest)).toBe(true);
    expect(hitTest.cancel.contains, JSON.stringify(hitTest)).toBe(true);
    expect(hitTest.settings.contains, JSON.stringify(hitTest)).toBe(true);
    expect(hitTest.dataTab.contains, JSON.stringify(hitTest)).toBe(true);
    await expect(settings).toBeEnabled();
    await expect(dataTab).toBeEnabled();

    await captureState(page, testInfo, "blocked");
    await setPreparationState(page, "failed");
    await expect(page.getByTestId("csv-preparation-blocker")).toHaveCount(0, { timeout: 2_500 });
    await expect(
      page.getByRole("alert").filter({ hasText: "CSV preparation failed" }),
    ).toBeVisible();
    const terminalSurfaceRect = await rect(surface);
    expectStableRect(surfaceRect, terminalSurfaceRect);
    await captureState(page, testInfo, "failed");
    await saveGeometry(testInfo, {
      blocker: blockerRect,
      hitTest,
      layoutShiftPx: Object.fromEntries(
        (["bottom", "height", "left", "right", "top", "width"] as const).map((key) => [
          key,
          Math.abs(surfaceRect[key] - terminalSurfaceRect[key]),
        ]),
      ),
      surface: surfaceRect,
      terminalSurface: terminalSurfaceRect,
    });
  });
});
