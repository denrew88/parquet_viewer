import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type {
  CancelDataBoundaryNavigationRequest,
  DataValue,
  FindBoundaryRequest,
} from "../src/backend";
import type { SqlPageRequest } from "../src/sql-workspace/backend";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const fixtureSql = "SELECT 1 /* boundary */;";
const largeRowCount = 950_000;
const probeKey = "__sqlResultBoundaryProbe";
const workspace = (page: Page) => page.getByRole("region", { name: "SQL workspace", exact: true });
const panel = (page: Page) =>
  workspace(page).getByRole("tabpanel", { name: "Results", exact: true });
const grid = (page: Page) => panel(page).getByRole("grid", { name: "Data preview", exact: true });
const cell = (page: Page, row: number, column: number) =>
  grid(page).locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`);

interface BoundaryCall {
  runId: string;
  resultId: string;
  viewId?: string;
  request: FindBoundaryRequest;
}

interface Probe {
  boundaries: BoundaryCall[];
  pages: SqlPageRequest[];
  cancels: CancelDataBoundaryNavigationRequest[];
  views: { runId: string; resultId: string; viewId: string }[];
  holdNext: boolean;
  release?: () => void;
}

async function setup(page: Page, large = false) {
  await page.goto("/?mock=sql22");
  await page.evaluate(
    async ({ probeKey, large, largeRowCount }) => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname === "/src/backend.ts");
      if (!url) throw new Error("SQL browser backend did not load.");
      const module = (await (0, eval)(
        `import(${JSON.stringify(url)})`,
      )) as typeof import("../src/backend");
      const backend = module.browserMockBackend;
      const api = backend.sqlWorkspace;
      const resultView = api?.resultView;
      if (!api?.findBoundary || !resultView) throw new Error("SQL boundary backend missing.");
      const probe: Probe = {
        boundaries: [],
        pages: [],
        cancels: [],
        views: [],
        holdNext: false,
      };
      Reflect.set(window, probeKey, probe);
      const read = api.readPage.bind(api);
      api.readPage = async (request) => {
        probe.pages.push(structuredClone(request));
        if (!large) return read(request);
        const { columns, offset, limit, resultId } = request;
        // Generate only the requested page. Occupied endpoints in the payload
        // column model a long gap without retaining the intervening rows.
        const rows = Array.from(
          { length: Math.max(0, Math.min(limit, largeRowCount - offset)) },
          (_, index): DataValue[] =>
            columns.map((column) => {
              const row = offset + index;
              if (column === "r0") return { kind: "int", display: String(row + 1), state: "valid" };
              const occupied = row === 0 || row === largeRowCount - 1;
              return column === "r1" && !occupied
                ? { kind: "string", display: null, state: "null" }
                : { kind: "string", display: `edge ${row + 1}`, state: "valid" };
            }),
        );
        return {
          sessionId: resultId,
          offset,
          limit,
          columns,
          rows,
          totalRows: largeRowCount,
          hasMore: offset + rows.length < largeRowCount,
        };
      };
      if (large) {
        const status = api.getStatus.bind(api);
        api.getStatus = async (runId) => {
          const value = await status(runId);
          return value.state === "complete" && value.resultId
            ? { ...value, rowCount: largeRowCount, rowsProduced: largeRowCount }
            : value;
        };
      }
      const boundary = api.findBoundary.bind(api);
      api.findBoundary = async (runId, resultId, request, viewId) => {
        probe.boundaries.push({ runId, resultId, viewId, request: structuredClone(request) });
        const hold = probe.holdNext;
        probe.holdNext = false;
        const result = large
          ? {
              navigationId: request.navigationId,
              documentId: request.documentId,
              sessionId: request.sessionId,
              queryId: request.queryId,
              targetRow: request.direction === "down" ? largeRowCount - 1 : 0,
              targetColumnId: request.columnId,
              resolvedRowCount: largeRowCount,
            }
          : await boundary(runId, resultId, request, viewId);
        if (hold) {
          await new Promise<void>((resolve) => {
            probe.release = resolve;
          });
          delete probe.release;
        }
        return result;
      };
      const cancel = backend.cancelDataBoundaryNavigation.bind(backend);
      backend.cancelDataBoundaryNavigation = async (request) => {
        probe.cancels.push(structuredClone(request));
        return cancel(request);
      };
      const startView = resultView.start.bind(resultView);
      resultView.start = async (runId, resultId, viewId, plan) => {
        probe.views.push({ runId, resultId, viewId });
        return startView(runId, resultId, viewId, plan);
      };
    },
    { probeKey, large, largeRowCount },
  );
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  await workspace(page).getByRole("textbox", { name: "SQL editor", exact: true }).fill(fixtureSql);
  await workspace(page).getByRole("button", { name: "Run", exact: true }).click();
  await expect(grid(page)).toHaveAttribute("aria-rowcount", large ? String(largeRowCount) : "260");
  await expect(cell(page, 0, 0)).toHaveText("1");
}

function recorded(page: Page) {
  return page.evaluate((key) => {
    const { boundaries, pages, cancels, views, release } = Reflect.get(window, key) as Probe;
    return { boundaries, pages, cancels, views, held: Boolean(release) };
  }, probeKey);
}

type Rect = readonly [top: number, bottom: number, left: number, right: number];

async function selection(
  page: Page,
  row: number,
  column: number,
  rect: Rect = [row, row, column, column],
) {
  const table = grid(page);
  await expect(table).toHaveAttribute("data-active-row", String(row));
  await expect(table).toHaveAttribute("data-active-column", String(column));
  for (const [index, edge] of ["top", "bottom", "left", "right"].entries()) {
    await expect(table).toHaveAttribute(`data-selection-${edge}`, String(rect[index]));
  }
}

async function press(page: Page, key: string, row: number, column: number, rect?: Rect) {
  await page.keyboard.press(key);
  await selection(page, row, column, rect);
}

async function capture(page: Page, info: TestInfo, name: string, row: number, column: number) {
  const table = grid(page);
  await expect(table).toBeFocused();
  await expectInsideViewport(table);
  await expectNoHorizontalPageOverflow(page);
  const geometry = await cell(page, row, column).evaluate((active) => {
    const table = active.closest<HTMLElement>('[role="grid"]');
    if (!table) throw new Error("The active cell has no grid.");
    const outer = table.getBoundingClientRect();
    const inner = active.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      grid: {
        top: outer.top,
        bottom: outer.top + table.clientHeight,
        left: outer.left,
        right: outer.left + table.clientWidth,
      },
      cell: { top: inner.top, bottom: inner.bottom, left: inner.left, right: inner.right },
      selected: active.getAttribute("aria-selected"),
    };
  });
  expect(geometry.selected).toBe("true");
  expect(geometry.cell.top).toBeGreaterThanOrEqual(geometry.grid.top - 1);
  expect(geometry.cell.bottom).toBeLessThanOrEqual(geometry.grid.bottom + 1);
  expect(geometry.cell.left).toBeGreaterThanOrEqual(geometry.grid.left - 1);
  expect(geometry.cell.right).toBeLessThanOrEqual(geometry.grid.right + 1);
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await writeFile(info.outputPath(`${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  await info.attach(name, { path: screenshot, contentType: "image/png" });
}

test("Phase 24 SQL navigation T-P24-027 matches Data directional selection shortcuts", async ({
  page,
}, info) => {
  await setup(page);
  await cell(page, 0, 0).click();
  await expect(grid(page)).toBeFocused();
  await press(page, "Shift+ArrowRight", 0, 1, [0, 0, 0, 1]);
  await press(page, "Shift+ArrowDown", 1, 1, [0, 1, 0, 1]);
  await press(page, "Shift+ArrowLeft", 1, 0, [0, 1, 0, 0]);
  await press(page, "Shift+ArrowUp", 0, 0);
  expect((await recorded(page)).boundaries).toHaveLength(0);

  // Whitespace cells count as occupied, but NULL and empty VARCHAR are gaps.
  await press(page, "Control+ArrowRight", 0, 1);
  await press(page, "Control+ArrowRight", 0, 3);
  await press(page, "Control+ArrowLeft", 0, 1);
  await press(page, "Control+Shift+ArrowRight", 0, 3, [0, 0, 1, 3]);
  await press(page, "Control+Shift+ArrowLeft", 0, 1);
  await cell(page, 0, 1).click();
  await press(page, "Control+ArrowDown", 2, 1);
  await press(page, "Control+ArrowDown", 5, 1);
  await press(page, "Control+ArrowUp", 2, 1);
  await press(page, "Control+Shift+ArrowDown", 5, 1, [2, 5, 1, 1]);
  await capture(page, info, "sql-results-boundary-selection", 5, 1);
  await press(page, "Control+Shift+ArrowUp", 2, 1);
  await expect(grid(page)).toBeFocused();

  const calls = (await recorded(page)).boundaries;
  expect(calls.map(({ request }) => request.direction)).toEqual([
    "right",
    "right",
    "left",
    "right",
    "left",
    "down",
    "down",
    "up",
    "down",
    "up",
  ]);
  for (const { runId, resultId, viewId, request } of calls) {
    expect(viewId).toBeUndefined();
    expect(request).toMatchObject({
      documentId: "sql-workspace",
      sessionId: resultId,
      queryId: runId,
      mode: "dataBoundary",
      visibleColumnIds: ["r0", "r1", "r2", "r3", "r4"],
    });
  }
  await page.keyboard.press("Control+f");
  const find = panel(page).getByRole("searchbox", { name: "Find data", exact: true });
  await expect(find).toBeFocused();
  await find.fill("alpha beta");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect(find).toBeFocused();
  const edited = await find.evaluate((input: HTMLInputElement) =>
    input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
  );
  expect(edited).toBe("beta");
  expect((await recorded(page)).boundaries).toHaveLength(calls.length);
  await selection(page, 2, 1);
});

test("Phase 24 SQL navigation T-P24-028 follows the committed Results view and drops stale replies", async ({
  page,
}) => {
  await setup(page);
  await grid(page).getByRole("button", { name: "Filter row_id", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter row_id", exact: true });
  await filter
    .getByRole("combobox", { name: "Filter operator" })
    .selectOption("greaterThanOrEqual");
  await filter.getByRole("textbox", { name: "Value", exact: true }).fill("141");
  await filter.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "120");
  await expect(cell(page, 0, 0)).toHaveText("141");
  await grid(page).getByRole("button", { name: "Sort row_id: not sorted", exact: true }).click();
  await grid(page).getByRole("button", { name: "Sort row_id: ascending, priority 1" }).click();
  await expect(cell(page, 0, 0)).toHaveText("260");
  const descending = (await recorded(page)).views.at(-1)!;

  await cell(page, 0, 1).click();
  await press(page, "Control+ArrowDown", 1, 1);
  await press(page, "Control+Shift+ArrowDown", 39, 1, [1, 39, 1, 1]);
  await expect(cell(page, 39, 0)).toHaveText("221");
  await press(page, "Control+Shift+ArrowDown", 110, 1, [1, 110, 1, 1]);
  await expect(cell(page, 110, 0)).toHaveText("150");
  const committedCalls = (await recorded(page)).boundaries;
  expect(committedCalls.map(({ request }) => request.row)).toEqual([0, 1, 39]);
  for (const call of committedCalls) {
    expect(call).toMatchObject({ ...descending, request: { queryId: descending.viewId } });
  }

  await page.evaluate((key) => {
    (Reflect.get(window, key) as Probe).holdNext = true;
  }, probeKey);
  await page.keyboard.press("Control+ArrowUp");
  await expect.poll(async () => (await recorded(page)).held).toBe(true);
  const held = (await recorded(page)).boundaries.at(-1)!;
  expect(held.request.row).toBe(110);
  await grid(page).getByRole("button", { name: "Sort row_id: descending, priority 1" }).click();
  await expect(cell(page, 0, 0)).toHaveText("141");
  expect((await recorded(page)).views.at(-1)?.viewId).not.toBe(descending.viewId);
  await cell(page, 0, 0).click();
  const beforeRelease = (await recorded(page)).pages.length;
  await page.evaluate(async (key) => {
    (Reflect.get(window, key) as Probe).release?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, probeKey);
  await selection(page, 0, 0);
  await expect(grid(page)).toBeFocused();
  const afterRelease = await recorded(page);
  expect(afterRelease.cancels).toContainEqual(
    expect.objectContaining({
      navigationId: held.request.navigationId,
      queryId: descending.viewId,
    }),
  );
  expect(
    afterRelease.pages.slice(beforeRelease).some(({ viewId }) => viewId === descending.viewId),
  ).toBe(false);
});

test("Phase 24 SQL navigation T-P24-029 jumps to an unloaded boundary with bounded page reads", async ({
  page,
}, info) => {
  await setup(page, true);
  await cell(page, 0, 1).click();
  await expect(grid(page)).toBeFocused();
  const initial = await recorded(page);
  const lastRow = largeRowCount - 1;
  await press(page, "Control+ArrowDown", lastRow, 1);
  await expect(cell(page, lastRow, 1)).toHaveText(`edge ${largeRowCount}`);
  await capture(page, info, "sql-results-boundary-last-row", lastRow, 1);
  const jumped = await recorded(page);
  expect(jumped.boundaries).toHaveLength(1);
  expect(jumped.boundaries[0].request).toMatchObject({ row: 0, columnId: "r1", direction: "down" });
  const targetReads = jumped.pages.slice(initial.pages.length);
  expect(
    targetReads.filter(({ offset, limit }) => offset <= lastRow && offset + limit > lastRow),
  ).toHaveLength(1);
  expect(
    targetReads.every(({ offset, limit }) => offset <= limit || offset + 2 * limit >= lastRow),
  ).toBe(true);
  await press(page, "Control+Shift+ArrowUp", 0, 1, [0, lastRow, 1, 1]);
  await expect(cell(page, 0, 1)).toHaveText("edge 1");
  await expect(grid(page)).toBeFocused();
  expect((await recorded(page)).boundaries).toHaveLength(2);
});
