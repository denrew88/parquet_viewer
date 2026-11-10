import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const charts = (page: Page) => page.getByRole("region", { name: "Charts workspace", exact: true });
const settings = (page: Page) =>
  charts(page).getByRole("complementary", { name: "Chart settings", exact: true });
const combo = (page: Page, name: string) =>
  settings(page).getByRole("combobox", { name, exact: true });
const field = (page: Page, name: string) =>
  settings(page).getByRole("spinbutton", { name, exact: true });
const action = (page: Page, name: string) =>
  settings(page).getByRole("button", { name, exact: true });
const card = (page: Page, title: string) => charts(page).getByRole("article", { name: title });
const plot = (page: Page, title: string) =>
  card(page, title).getByRole("img", { name: `${title} plot` });
const controls = (article: Locator, name: string) =>
  article.getByRole("button", { name, exact: true });
const readKey = "__phase24AnalysisReads";

type Row = [number | string, string, number];
const numericRows: Row[] = [
  [1, "Row one", 0],
  [7, "Row two", 1],
  [4, "Row three", 2],
  [14, "Row four", 4],
  [0, "Row five", 8],
  [9, "Row six", 10],
  [23, "Row seven", 16],
  [6, "Row eight", 24],
  [17, "Row nine", 35],
  [35, "Row ten", 50],
  [11, "Row eleven", 70],
  [60, "Row twelve", 100],
];
const timelineRows: Row[] = [
  ["2026-01-01T00:00:00Z", "start", 2],
  ["2026-01-01T00:00:02Z", "early", 6],
  ["2026-01-01T00:00:09Z", "edge before", 4],
  ["2026-01-01T00:00:10Z", "edge", 10],
  ["2026-01-01T00:00:14Z", "middle", 14],
  ["2026-01-01T00:00:27Z", "late", 20],
];
const barRows: Row[] = [
  ...Array.from({ length: 40 }, (_, i): Row => [
    i,
    `Group ${String(i + 1).padStart(2, "0")}`,
    i + 1,
  ]),
  ...[50, 60, 70, 80, 90].map((value, i): Row => [40 + i, "Winner after 40", value]),
  ...[100, 100, 100].map((value, i): Row => [45 + i, "Runner after 40", value]),
];
const groupedRows: Row[] = [
  ...[1, 2, 2, 3, 3, 4, 5, 100].map((value, i): Row => [i, "Zeta", value]),
  [8, "Alpha", 9],
  [9, "Beta", 20],
  [10, "Beta", 21],
  [11, "Eta", 40],
  [12, "Eta", 41],
  [13, "Eta", 42],
  [14, "Theta", 50],
  [15, "Theta", 51],
  [16, "Theta", 52],
  [17, "Theta", 53],
  [18, "Iota", 7],
  [19, "Lambda", 23],
  [20, "Lambda", 24],
  [21, "Sigma", 30],
  [22, "Sigma", 31],
  [23, "Sigma", 32],
];

async function setup(page: Page, input: Row[], timestamp = false) {
  await page.goto("/?mock=sql22");
  await page.evaluate(
    async ({ input, timestamp, readKey }) => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname === "/src/backend.ts");
      if (!url) throw new Error("The browser chart backend did not load.");
      const module = (await (0, eval)(
        `import(${JSON.stringify(url)})`,
      )) as typeof import("../src/backend");
      const api = module.browserMockBackend.sqlWorkspace;
      if (!api) throw new Error("SQL browser fixture did not load.");
      const reads: string[][] = [];
      Reflect.set(window, readKey, reads);
      const status = api.getStatus.bind(api);
      api.getStatus = async (id) => {
        const original = await status(id);
        return {
          ...original,
          columns: original.columns.map((column) => {
            if (column.id === "r0")
              return {
                ...column,
                name: "coordinate",
                logicalType: timestamp ? "TIMESTAMP_NS" : "BIGINT",
              };
            if (column.id === "r1") return { ...column, name: "label" };
            return column;
          }),
        };
      };
      const page = api.readPage.bind(api);
      api.readPage = async (request) => {
        if (
          document
            .querySelector('button[aria-label="Charts workspace"]')
            ?.getAttribute("aria-pressed") !== "true"
        )
          return page(request);
        const { columns, offset, limit, resultId } = request;
        reads.push([...columns]);
        const rows: import("../src/backend").DataValue[][] = input
          .slice(offset, offset + limit)
          .map(([x, label, y]) =>
            columns.map((column) => {
              const display = String(column === "r0" ? x : column === "r1" ? label : y);
              return {
                kind:
                  column === "r1"
                    ? "string"
                    : column === "r2"
                      ? "decimal"
                      : timestamp
                        ? "timestamp"
                        : "int",
                state: "valid",
                display,
                sourceDisplay: display,
              };
            }),
          );
        return {
          sessionId: resultId,
          columns,
          offset,
          limit,
          totalRows: input.length,
          rows,
          hasMore: offset + rows.length < input.length,
        };
      };
    },
    { input, timestamp, readKey },
  );
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const sql = page.getByRole("region", { name: "SQL workspace", exact: true });
  await sql.getByRole("textbox", { name: "SQL editor", exact: true }).fill("SELECT 1 AS amount;");
  await sql.getByRole("button", { name: "Run", exact: true }).click();
  await expect(sql.getByRole("grid", { name: "Data preview" })).toHaveAttribute(
    "aria-rowcount",
    "4",
  );
  await page.getByRole("button", { name: "Charts workspace", exact: true }).click();
}

function readCount(page: Page) {
  return page.evaluate((key) => (Reflect.get(window, key) as string[][]).length, readKey);
}

async function option(select: Locator, name: RegExp) {
  const item = select.locator("option").filter({ hasText: name });
  await expect(item).toHaveCount(1);
  await select.selectOption((await item.getAttribute("value"))!);
}

async function ready(page: Page, title: string) {
  await card(page, title).scrollIntoViewIfNeeded();
  await expect(card(page, title)).toHaveAttribute("data-state", "ready");
  await expect(plot(page, title).locator("canvas").first()).toBeVisible();
  await expect(card(page, title).getByRole("alert")).toHaveCount(0);
}

async function addCard(page: Page, title: string, type: string, axes: Record<string, RegExp>) {
  await charts(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await option(combo(page, "Data source"), /Query 1/);
  await combo(page, "Chart type").selectOption({ label: type });
  for (const [axis, column] of Object.entries(axes)) await option(combo(page, axis), column);
  const name = settings(page).getByRole("textbox", { name: "Chart title", exact: true });
  await name.fill(title);
  await name.blur();
  await ready(page, title);
}

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ChartView {
  x: [number, number];
  y: [number, number];
  box: Bounds;
  target: Bounds;
  targetX: [number, number];
  targetY: [number, number];
  hover: [number, number];
  option: {
    xAxis: AxisOption[];
    yAxis: AxisOption[];
    series: SeriesOption[];
    dataZoom?: unknown[];
  };
  tooltip: string;
}

interface AxisOption {
  type?: string;
  data?: string[];
  axisLabel?: { interval?: number | "auto"; hideOverlap?: boolean; rotate?: number };
}

interface SeriesOption {
  type?: string;
  data?: unknown[];
  connectNulls?: boolean;
  label?: { show?: boolean; text?: string };
  widths?: number[];
}

interface HoverTarget {
  point: [number, number];
  index: number;
  kind: "scatter" | "line" | "boxplot" | "violin";
  seriesIndex?: number;
}

function renderer(locator: Locator, hoverTarget?: HoverTarget) {
  return locator.evaluate(async (element, hoverTarget): Promise<ChartView | null> => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (name) =>
          /\/(?:echarts_core|core)\.js$/.test(new URL(name).pathname) && name.includes("echarts"),
      );
    if (!url) return null;
    const echarts = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("echarts/core");
    const instance = echarts.getInstanceByDom(element as HTMLElement);
    if (!instance) return null;
    const option = instance.getOption() as Omit<ChartView["option"], "series"> & {
      series: (Omit<SeriesOption, "label"> & {
        label?: {
          show?: boolean;
          formatter?: (params: { dataIndex: number; value: unknown; name: string }) => string;
        };
        renderItem?: (
          params: { dataIndex: number },
          api: { coord: (position: [number, number]) => [number, number] },
        ) => { children?: { type: string; shape?: { points?: [number, number][] } }[] } | null;
      })[];
      tooltip?: { formatter?: (params: unknown) => string }[];
    };
    const model = (
      instance as unknown as {
        getModel(): {
          getComponent(
            kind: string,
            index: number,
          ): {
            coordinateSystem: {
              getRect(): { x: number; y: number; width: number; height: number };
            };
          };
        };
      }
    ).getModel();
    const grid = model.getComponent("grid", 0)?.coordinateSystem?.getRect();
    if (!grid || !option.xAxis?.length || !option.yAxis?.length || !option.series?.length)
      return null;
    const bounds = element.getBoundingClientRect();
    const left = bounds.left + grid.x,
      top = bounds.top + grid.y;
    const box = { left, top, width: grid.width, height: grid.height };
    const target = {
      left: Math.round(left + grid.width * 0.2),
      top: Math.round(top + grid.height * 0.22),
      width: 0,
      height: 0,
    };
    target.width = Math.round(left + grid.width * 0.78) - target.left;
    target.height = Math.round(top + grid.height * 0.82) - target.top;
    const convert = (x: number, y: number) =>
      instance.convertFromPixel({ gridIndex: 0 }, [x - bounds.left, y - bounds.top]) as [
        number,
        number,
      ];
    const [xMin, yMin] = convert(left, top + grid.height);
    const [xMax, yMax] = convert(left + grid.width, top);
    const [targetXMin, targetYMin] = convert(target.left, target.top + target.height);
    const [targetXMax, targetYMax] = convert(target.left + target.width, target.top);
    const hover = hoverTarget
      ? (instance.convertToPixel({ gridIndex: 0 }, hoverTarget.point) as [number, number])
      : ([0, 0] as [number, number]);
    const format = option.tooltip?.[0]?.formatter;
    const item = hoverTarget
      ? option.series[hoverTarget.seriesIndex ?? 0]?.data?.[hoverTarget.index]
      : undefined;
    let tooltip = "";
    if (hoverTarget && typeof format === "function" && item !== undefined) {
      const params = {
        dataIndex: hoverTarget.index,
        seriesIndex: hoverTarget.seriesIndex ?? 0,
        value: typeof item === "object" && item !== null && "value" in item ? item.value : item,
        data: item,
        seriesType: hoverTarget.kind,
        axisValue: hoverTarget.point[0],
        marker: "",
      };
      tooltip = format(hoverTarget.kind === "line" ? [params] : params);
    }
    return {
      x: [xMin, xMax],
      y: [yMin, yMax],
      box,
      target,
      targetX: [targetXMin, targetXMax],
      targetY: [targetYMin, targetYMax],
      hover: [bounds.left + hover[0], bounds.top + hover[1]],
      option: {
        xAxis: option.xAxis.map(({ type, data, axisLabel }) => ({
          type,
          data,
          axisLabel: axisLabel
            ? {
                interval: axisLabel.interval,
                hideOverlap: axisLabel.hideOverlap,
                rotate: axisLabel.rotate,
              }
            : undefined,
        })),
        yAxis: option.yAxis.map(({ type, data, axisLabel }) => ({
          type,
          data,
          axisLabel: axisLabel
            ? {
                interval: axisLabel.interval,
                hideOverlap: axisLabel.hideOverlap,
                rotate: axisLabel.rotate,
              }
            : undefined,
        })),
        series: option.series.map(({ type, data, connectNulls, label, renderItem }, i) => ({
          type,
          data,
          connectNulls,
          widths:
            type === "custom" && option.xAxis[0]?.type === "category" && renderItem
              ? data?.map((_, dataIndex) => {
                  const polygon = renderItem(
                    { dataIndex },
                    { coord: ([x, y]) => [x * 100, y] },
                  )?.children?.find(({ type }) => type === "polygon");
                  const xs = polygon?.shape?.points?.map(([x]) => x);
                  return xs?.length ? Math.max(...xs) - Math.min(...xs) : 0;
                })
              : undefined,
          label: label
            ? {
                show: label.show,
                text:
                  type === "bar" && label.show && typeof label.formatter === "function"
                    ? label.formatter({
                        dataIndex: 0,
                        name: (option.yAxis[0]?.data ?? option.xAxis[0]?.data)?.[0] ?? "",
                        value: option.series[i]?.data?.[0],
                      })
                    : undefined,
              }
            : undefined,
        })),
        dataZoom: option.dataZoom,
      },
      tooltip,
    };
  }, hoverTarget);
}

async function view(page: Page, title: string, hoverTarget?: HoverTarget) {
  await expect.poll(async () => Boolean(await renderer(plot(page, title), hoverTarget))).toBe(true);
  const value = await renderer(plot(page, title), hoverTarget);
  if (!value) throw new Error("ECharts plot disappeared.");
  return value;
}

function pixels(locator: Locator) {
  return locator
    .locator("canvas")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLCanvasElement).toDataURL()).join(""));
}

async function drag(page: Page, bounds: Bounds, modifier?: "Shift", reverse = false) {
  if (modifier) await page.keyboard.down(modifier);
  try {
    const startX = reverse ? bounds.left + bounds.width : bounds.left;
    const startY = reverse ? bounds.top + bounds.height : bounds.top;
    const endX = reverse ? bounds.left : bounds.left + bounds.width;
    const endY = reverse ? bounds.top : bounds.top + bounds.height;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 6 });
    await page.mouse.up();
  } finally {
    if (modifier) await page.keyboard.up(modifier);
  }
}

function expectRange(actual: ChartView, x: ChartView["x"], y: ChartView["y"], base: ChartView) {
  const toleranceX = (Math.abs(base.x[1] - base.x[0]) * 2) / base.box.width;
  const toleranceY = (Math.abs(base.y[1] - base.y[0]) * 2) / base.box.height;
  for (const i of [0, 1] as const) {
    expect(Math.abs(actual.x[i] - x[i])).toBeLessThanOrEqual(toleranceX);
    expect(Math.abs(actual.y[i] - y[i])).toBeLessThanOrEqual(toleranceY);
  }
}

const xy = { "X axis": /^amount$/, "Y axis": /^coordinate$/ };

test("Phase 24 chart analysis T-P24-016/017/021 applies and restores rectangle zoom without a read", async ({
  page,
}, info) => {
  await setup(page, numericRows);
  await addCard(page, "Scatter zoom", "Scatter", xy);
  await option(combo(page, "Point label"), /^label$/);
  await ready(page, "Scatter zoom");
  await addCard(page, "Independent scatter", "Scatter", xy);
  const other = await view(page, "Independent scatter");
  const scatter = card(page, "Scatter zoom");
  await controls(scatter, "Edit Scatter zoom").click();
  await scatter.scrollIntoViewIfNeeded();
  await expect(scatter).toContainText("12 points displayed");
  await expect(scatter).toContainText("12 valid rows");
  const before = await view(page, "Scatter zoom", { point: [35, 17], index: 8, kind: "scatter" });
  const reads = await readCount(page);
  const beforeHover = await pixels(plot(page, "Scatter zoom"));
  await page.mouse.move(...before.hover);
  await expect.poll(() => pixels(plot(page, "Scatter zoom"))).not.toBe(beforeHover);
  expect(before.tooltip).toContain("Row nine");
  expect(before.tooltip).toContain("Source row: 9");
  expect(before.tooltip).toContain("35");
  expect(before.tooltip).toContain("17");
  await expect(scatter.getByText("Drag to zoom · Shift+drag to pan")).toBeVisible();
  await drag(page, before.target, undefined, true);
  await expect(controls(scatter, "Undo zoom")).toBeEnabled();
  const zoom = await view(page, "Scatter zoom");
  expectRange(zoom, before.targetX, before.targetY, before);
  expect(zoom.option.series[0]?.data).toEqual(before.option.series[0]?.data);
  await expectNoHorizontalPageOverflow(page);
  for (const name of ["Zoom in", "Zoom out", "Undo zoom", "Reset zoom"]) {
    await expectInsideViewport(controls(scatter, name));
  }
  const screenshot = info.outputPath("phase24-chart-analysis.png");
  const geometry = info.outputPath("phase24-chart-analysis-geometry.json");
  await page.screenshot({ path: screenshot });
  await writeFile(
    geometry,
    JSON.stringify(
      {
        viewport: page.viewportSize(),
        grid: before.box,
        drag: before.target,
        before: [before.x, before.y],
        expected: [before.targetX, before.targetY],
        zoom: [zoom.x, zoom.y],
      },
      null,
      2,
    ),
  );
  await info.attach("Rectangle zoom", { path: screenshot, contentType: "image/png" });
  await info.attach("Rectangle zoom geometry", { path: geometry, contentType: "application/json" });

  await controls(scatter, "Zoom out").click();
  const expanded = await view(page, "Scatter zoom");
  expect(expanded.x[1] - expanded.x[0]).toBeGreaterThan(zoom.x[1] - zoom.x[0]);
  expect(expanded.y[1] - expanded.y[0]).toBeGreaterThan(zoom.y[1] - zoom.y[0]);
  await controls(scatter, "Undo zoom").click();
  expectRange(await view(page, "Scatter zoom"), before.targetX, before.targetY, before);
  await controls(scatter, "Undo zoom").click();
  expectRange(await view(page, "Scatter zoom"), before.x, before.y, before);
  const restored = await view(page, "Scatter zoom");
  await drag(page, restored.target);
  const beforePan = await view(page, "Scatter zoom");
  expectRange(beforePan, restored.targetX, restored.targetY, before);
  await drag(
    page,
    {
      left: beforePan.box.left + beforePan.box.width * 0.35,
      top: beforePan.box.top + beforePan.box.height * 0.4,
      width: beforePan.box.width * 0.2,
      height: beforePan.box.height * 0.12,
    },
    "Shift",
  );
  await expect
    .poll(async () => (await view(page, "Scatter zoom")).x[0])
    .toBeLessThan(beforePan.x[0]);
  const panned = await view(page, "Scatter zoom");
  expect(panned.y[0]).toBeGreaterThan(beforePan.y[0]);
  for (const [axis, pixels] of [
    ["x", beforePan.box.width],
    ["y", beforePan.box.height],
  ] as const) {
    const span = beforePan[axis][1] - beforePan[axis][0];
    const pannedSpan = panned[axis][1] - panned[axis][0];
    expect(Math.abs(pannedSpan - span)).toBeLessThanOrEqual(span / pixels);
  }
  await controls(scatter, "Reset zoom").click();
  expectRange(await view(page, "Scatter zoom"), before.x, before.y, before);
  const origin = await view(page, "Scatter zoom");
  await drag(page, {
    left: origin.target.left,
    top: origin.target.top,
    width: origin.box.left + origin.box.width + 6 - origin.target.left,
    height: origin.box.top + origin.box.height + 6 - origin.target.top,
  });
  expectRange(
    await view(page, "Scatter zoom"),
    [origin.targetX[0], origin.x[1]],
    [origin.y[0], origin.targetY[1]],
    origin,
  );
  await controls(scatter, "Reset zoom").click();
  await drag(page, { ...origin.target, width: 1, height: 1 });
  expectRange(await view(page, "Scatter zoom"), before.x, before.y, before);
  await page.mouse.move(origin.target.left, origin.target.top);
  await page.mouse.down();
  await page.mouse.move(
    origin.target.left + origin.target.width,
    origin.target.top + origin.target.height,
  );
  await expect(scatter.locator("[data-zoom-selection]")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(scatter.locator("[data-zoom-selection]")).toHaveCount(0);
  expectRange(await view(page, "Scatter zoom"), before.x, before.y, before);

  const resumed = await view(page, "Scatter zoom");
  await drag(page, resumed.target);
  const tabList = charts(page).getByRole("tablist", { name: "Chart sheets" });
  await charts(page).getByRole("button", { name: "New sheet", exact: true }).click();
  await tabList.getByRole("tab", { name: "Sheet 1", exact: true }).click();
  await ready(page, "Scatter zoom");
  expectRange(await view(page, "Scatter zoom"), resumed.targetX, resumed.targetY, before);
  await ready(page, "Independent scatter");
  const unchanged = await view(page, "Independent scatter");
  expectRange(unchanged, other.x, other.y, other);
  expect(await readCount(page)).toBe(reads);
  if (info.project.name === "desktop-wide") {
    const sibling = card(page, "Independent scatter");
    await sibling
      .getByRole("button", { name: "Move Independent scatter", exact: true })
      .dragTo(scatter.getByRole("heading", { name: "Scatter zoom", exact: true }));
    await expect(charts(page).getByRole("article").first()).toHaveAccessibleName(
      "Independent scatter",
    );
    expectRange(await view(page, "Scatter zoom"), resumed.targetX, resumed.targetY, before);
    expect(await readCount(page)).toBe(reads);
  }
  await controls(scatter, "Edit Scatter zoom").click();
  await combo(page, "X scale").selectOption({ label: "Log10" });
  await ready(page, "Scatter zoom");
  await expect(plot(page, "Scatter zoom")).toHaveAttribute("data-x-scale", "log10");
  const logHover = await view(page, "Scatter zoom", {
    point: [Math.log10(35), 17],
    index: 7,
    kind: "scatter",
  });
  expect(logHover.tooltip).toContain("Row nine");
  expect(logHover.tooltip).toContain("35");
  expect(logHover.tooltip).toContain("17");
  await expect(scatter).toContainText("11 points displayed");
});

test("Phase 24 chart analysis T-P24-017/021 dense progressive scatter preserves actual pointer hits", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop-wide", "Dense scatter uses one desktop timing run.");
  const pointCount = 12_000;
  const target: HoverTarget = { point: [53, 47], index: pointCount - 1, kind: "scatter" };
  const title = "Dense progressive scatter";
  const label = "Isolated progressive point";
  const rows = Array.from({ length: pointCount - 1 }, (_, index): Row => {
    const base = index % 2 === 0 ? 0 : 80;
    return [base + (index % 997) / 50, `Point ${index + 1}`, base + (index % 991) / 50];
  });
  rows.push([target.point[1], label, target.point[0]]);
  await setup(page, rows);
  await addCard(page, title, "Scatter", xy);

  const configuredAt = performance.now();
  await option(combo(page, "Point label"), /^label$/);
  await ready(page, title);
  await expect(card(page, title)).toContainText("12,000 valid rows");
  await expect(card(page, title)).toContainText("12,000 points displayed");
  const base = await view(page, title, target);
  expect(base.option.series[0]?.data).toHaveLength(pointCount);

  const surface = plot(page, title);
  const progressive = await surface.evaluate(async (element) => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (name) =>
          /\/(?:echarts_core|core)\.js$/.test(new URL(name).pathname) && name.includes("echarts"),
      );
    const echarts = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("echarts/core");
    const instance = echarts.getInstanceByDom(element as HTMLElement);
    if (!instance) throw new Error("The dense scatter did not initialize.");
    let hit = -1;
    let hitMs = -1;
    let hits = 0;
    let pointerAt = 0;
    element.addEventListener("pointermove", () => (pointerAt = performance.now()), true);
    instance.on("mouseover", ({ dataIndex, seriesType }) => {
      if (seriesType === "scatter") {
        hit = dataIndex;
        hitMs = performance.now() - pointerAt;
        hits += 1;
      }
    });
    Reflect.set(element, "readPhase24ScatterProbe", () => ({
      hit,
      hitMs,
      hits,
      text: instance
        .getZr()
        .storage.getRoots()
        .filter((node) => node.type === "text" && !node.ignore)
        .map((node) => (node as unknown as { style: { text?: string } }).style.text)
        .join("\n"),
    }));
    const { series } = instance.getOption() as {
      series: { large: boolean; progressive: number; progressiveThreshold: number }[];
    };
    const { large, progressive, progressiveThreshold } = series[0]!;
    return { large, progressive, progressiveThreshold };
  });
  expect(progressive.large).toBe(false);
  expect(progressive.progressive).toBeGreaterThan(0);
  expect(progressive.progressiveThreshold).toBeLessThan(pointCount);

  const probe = () =>
    surface.evaluate((element) => {
      const read = Reflect.get(element, "readPhase24ScatterProbe") as () => {
        hit: number;
        hitMs: number;
        hits: number;
        text: string;
      };
      return read();
    });
  const checkHover = async (position: [number, number]) => {
    let hitMs = -1;
    const { hits } = await probe();
    await expect(async () => {
      await page.mouse.move(2, 2);
      await page.mouse.move(...position);
      const result = await probe();
      expect(result.hits).toBeGreaterThan(hits);
      expect(result.hit).toBe(target.index);
      expect(result.text).toContain(label);
      expect(result.text).toContain("Source row: 12,000");
      expect(result.text).toContain("amount: 53");
      expect(result.text).toContain("coordinate: 47");
      hitMs = result.hitMs;
    }).toPass({ timeout: 5000 });
    return hitMs;
  };

  const initialHoverMs = await checkHover(base.hover);
  const labelToInteractiveMs = performance.now() - configuredAt;
  const reads = await readCount(page);
  const zoomAt = performance.now();
  await drag(page, base.target);
  const zoom = await view(page, title, target);
  expectRange(zoom, base.targetX, base.targetY, base);
  expect(zoom.option.series[0]?.data).toHaveLength(pointCount);
  const zoomedHoverMs = await checkHover(zoom.hover);
  expect(await readCount(page)).toBe(reads);
  const timings = info.outputPath("dense-scatter-browser-timing.json");
  await writeFile(
    timings,
    JSON.stringify(
      {
        pointCount,
        labelToInteractiveMs,
        dragToInteractiveMs: performance.now() - zoomAt,
        initialHoverMs,
        zoomedHoverMs,
        additionalReads: 0,
      },
      null,
      2,
    ),
  );
  await info.attach("Dense scatter browser timings", {
    path: timings,
    contentType: "application/json",
  });
});

function seriesValues(series: SeriesOption | undefined) {
  return (
    series?.data?.map((point) =>
      typeof point === "object" && point !== null && "value" in point ? point.value : point,
    ) ?? []
  );
}

const grouped = { Group: /^label$/, Value: /^amount$/ };

test("Phase 24 chart analysis T-P24-018 preserves histogram bin geometry across zoom", async ({
  page,
}) => {
  await setup(page, numericRows);
  await addCard(page, "Bounded histogram", "Histogram", { Value: /^amount$/ });
  const histogram = card(page, "Bounded histogram");
  await combo(page, "Histogram bins").selectOption({ label: "Bin width" });
  await field(page, "Bin width").fill("4");
  await action(page, "Apply histogram bins").click();
  await ready(page, "Bounded histogram");
  const beforeInvalid = await readCount(page);
  await field(page, "Histogram minimum").fill("9");
  await field(page, "Histogram maximum").fill("1");
  await action(page, "Apply histogram range").click();
  await expect(settings(page).getByRole("alert")).toContainText("larger maximum");
  expect(await readCount(page)).toBe(beforeInvalid);
  await field(page, "Histogram minimum").fill("1");
  await field(page, "Histogram maximum").fill("9");
  await action(page, "Apply histogram range").click();
  await ready(page, "Bounded histogram");
  const count = await view(page, "Bounded histogram");
  expect(count.option.xAxis[0]?.type).toBe("value");
  expect(seriesValues(count.option.series[0])).toEqual([
    [1, 5, 3, 3],
    [5, 9, 1, 1],
  ]);
  await expect(histogram).toContainText(/2 bins\b/);
  await expect(histogram).toContainText(/1 (?:below|underflow)/i);
  await expect(histogram).toContainText(/7 (?:above|overflow)/i);
  await combo(page, "Histogram normalization").selectOption({ label: "Percent" });
  await ready(page, "Bounded histogram");
  const percent = await view(page, "Bounded histogram");
  expect(seriesValues(percent.option.series[0])).toEqual([
    [1, 5, 75, 3],
    [5, 9, 25, 1],
  ]);
  await combo(page, "Histogram normalization").selectOption({ label: "Density" });
  await ready(page, "Bounded histogram");
  const density = await view(page, "Bounded histogram");
  expect(seriesValues(density.option.series[0])).toEqual([
    [1, 5, 0.1875, 3],
    [5, 9, 0.0625, 1],
  ]);
  const reads = await readCount(page);
  await controls(histogram, "Zoom in").click();
  const zoomed = await view(page, "Bounded histogram");
  expect(zoomed.x[1] - zoomed.x[0]).toBeLessThan(density.x[1] - density.x[0]);
  expect(seriesValues(zoomed.option.series[0])).toEqual(seriesValues(density.option.series[0]));
  expect(await readCount(page)).toBe(reads);
});

test("Phase 24 chart analysis T-P24-018 applies elapsed-time buckets and visible line gaps", async ({
  page,
}) => {
  await setup(page, timelineRows, true);
  await addCard(page, "Timed analysis", "Line", { "X axis": /^coordinate$/, "Y axis": /^amount$/ });
  const raw = await view(page, "Timed analysis");
  const rawPoints = seriesValues(raw.option.series[0]) as [number, number][];
  expect(rawPoints).toHaveLength(6);
  const hovered = await view(page, "Timed analysis", {
    point: rawPoints[3]!,
    index: 3,
    kind: "line",
  });
  expect(hovered.tooltip).toContain("00:00:10");
  await field(page, "Gap threshold").fill("5");
  await action(page, "Apply line options").click();
  await ready(page, "Timed analysis");
  const gap = await view(page, "Timed analysis");
  expect(gap.option.series[0]?.connectNulls).toBe(false);
  expect(seriesValues(gap.option.series[0])).toContainEqual([expect.any(Number), null]);
  expect(
    seriesValues(gap.option.series[0]).filter((point) => Array.isArray(point) && point[1] === null),
  ).toHaveLength(2);
  await combo(page, "Line aggregation").selectOption({ label: "Mean" });
  await field(page, "Bucket seconds").fill("10");
  await field(page, "Gap threshold").fill("");
  await action(page, "Apply line options").click();
  await ready(page, "Timed analysis");
  await expect
    .poll(async () => seriesValues((await view(page, "Timed analysis")).option.series[0]))
    .toEqual([
      [expect.any(Number), 4],
      [expect.any(Number), 12],
      [expect.any(Number), 20],
    ]);
  await combo(page, "Line aggregation").selectOption({ label: "Sum" });
  await action(page, "Apply line options").click();
  await ready(page, "Timed analysis");
  expect(seriesValues((await view(page, "Timed analysis")).option.series[0])).toEqual([
    [expect.any(Number), 12],
    [expect.any(Number), 24],
    [expect.any(Number), 20],
  ]);
});

test("Phase 24 chart analysis T-P24-017/019 ranks late groups and switches bar orientation", async ({
  page,
}) => {
  await setup(page, barRows);
  await addCard(page, "Global leaders", "Bar", grouped);
  await combo(page, "Bar order").selectOption({ label: "Value descending" });
  await combo(page, "Bar aggregation").selectOption({ label: "Count" });
  await field(page, "Top N").fill("3");
  await action(page, "Apply bar limit").click();
  await ready(page, "Global leaders");
  const first = await view(page, "Global leaders");
  expect(first.option.xAxis[0]?.type).toBe("value");
  expect(first.option.yAxis[0]?.type).toBe("category");
  expect(first.option.yAxis[0]?.data?.slice(0, 2)).toEqual(["Winner after 40", "Runner after 40"]);
  expect(seriesValues(first.option.series[0])).toEqual([5, 3, 1]);
  await settings(page).getByRole("checkbox", { name: "Show values", exact: true }).check();
  await settings(page).getByRole("checkbox", { name: "Show share", exact: true }).check();
  const labeled = await view(page, "Global leaders");
  expect(labeled.option.series[0]?.label?.show).toBe(true);
  expect(labeled.option.series[0]?.label?.text).toContain("10.42%");
  await combo(page, "Bar aggregation").selectOption({ label: "Sum" });
  await ready(page, "Global leaders");
  expect(seriesValues((await view(page, "Global leaders")).option.series[0])).toEqual([
    350, 300, 40,
  ]);
  await combo(page, "Bar aggregation").selectOption({ label: "Mean" });
  await ready(page, "Global leaders");
  const mean = await view(page, "Global leaders");
  expect(mean.option.yAxis[0]?.data?.slice(0, 2)).toEqual(["Runner after 40", "Winner after 40"]);
  expect(seriesValues(mean.option.series[0])).toEqual([100, 70, 40]);
  await expect(
    settings(page).getByRole("checkbox", { name: "Show share", exact: true }),
  ).toBeDisabled();
  await combo(page, "Bar orientation").selectOption({ label: "Vertical" });
  const vertical = await view(page, "Global leaders");
  expect(vertical.option.xAxis[0]?.type).toBe("category");
  expect(vertical.option.yAxis[0]?.type).toBe("value");
  expect(seriesValues(vertical.option.series[0])).toEqual([100, 70, 40]);

  await field(page, "Top N").fill("16");
  await action(page, "Apply bar limit").click();
  await ready(page, "Global leaders");
  await combo(page, "Category labels").selectOption({ label: "All" });
  const dense = await view(page, "Global leaders");
  expect(dense.option.xAxis[0]?.data).toHaveLength(16);
  expect(dense.option.xAxis[0]?.axisLabel?.interval).toBe(0);
  expect(dense.option.xAxis[0]?.axisLabel?.hideOverlap).toBe(false);
  expect(dense.option.xAxis[0]?.axisLabel?.rotate).toBeGreaterThan(0);
  const reads = await readCount(page);
  await controls(card(page, "Global leaders"), "Zoom in").click();
  const sliced = await view(page, "Global leaders");
  expect(sliced.x[1] - sliced.x[0]).toBeLessThan(dense.x[1] - dense.x[0]);
  await drag(
    page,
    {
      left: sliced.box.left + sliced.box.width * 0.15,
      top: sliced.box.top + sliced.box.height * 0.5,
      width: sliced.box.width * 0.75,
      height: 0,
    },
    "Shift",
    true,
  );
  await expect
    .poll(async () => (await view(page, "Global leaders")).x[1])
    .toBeGreaterThanOrEqual(dense.x[1]);
  expect(await readCount(page)).toBe(reads);
});

test("Phase 24 chart analysis T-P24-017/020 shows bounded outlier points on box and violin", async ({
  page,
}) => {
  await setup(page, groupedRows);
  await addCard(page, "Eight groups", "Box plot", grouped);
  const readBefore = await readCount(page);
  const show = settings(page).getByRole("checkbox", { name: "Show outlier points", exact: true });
  const outliers = (value: ChartView) =>
    seriesValues(value.option.series.find(({ type }) => type === "scatter"));
  await show.uncheck();
  await expect.poll(async () => outliers(await view(page, "Eight groups"))).toHaveLength(0);
  await show.check();
  const box = await view(page, "Eight groups");
  expect(await readCount(page)).toBe(readBefore);
  expect(box.option.xAxis[0]?.data).toHaveLength(8);
  expect(box.option.xAxis[0]?.axisLabel?.interval).toBe(0);
  expect(box.option.xAxis[0]?.axisLabel?.hideOverlap).toBe(false);
  expect(outliers(box)).toHaveLength(1);
  expect(JSON.stringify(outliers(box))).toContain("100");
  await combo(page, "Category order").selectOption({ label: "Count" });
  const counted = await view(page, "Eight groups");
  expect(counted.option.xAxis[0]?.data?.slice(0, 2)).toEqual(["Zeta", "Theta"]);
  await combo(page, "Category order").selectOption({ label: "Median" });
  const median = await view(page, "Eight groups");
  expect(median.option.xAxis[0]?.data?.slice(0, 3)).toEqual(["Zeta", "Iota", "Alpha"]);
  const summaries = (value: ChartView) =>
    seriesValues(value.option.series.find(({ type }) => type === "boxplot")) as number[][];
  expect(summaries(median)[0]?.[4]).toBe(5);
  const summary = await view(page, "Eight groups", { point: [0, 3], index: 0, kind: "boxplot" });
  for (const line of [
    "N: 8",
    "Minimum: 1",
    "Q1: 2",
    "Median: 3",
    "Q3: 4.25",
    "Maximum: 100",
    "Rule: 1.5 × IQR",
    "Outliers: 1",
  ])
    expect(summary.tooltip).toContain(line);
  expect(summary.tooltip).not.toContain("Sample:");
  const outlier = await view(page, "Eight groups", {
    point: [0, 100],
    index: 0,
    seriesIndex: 1,
    kind: "scatter",
  });
  expect(outlier.tooltip).toContain("Outlier: 100");
  await combo(page, "Box whiskers").selectOption({ label: "Minimum and maximum" });
  expect(summaries(await view(page, "Eight groups"))[0]?.[4]).toBe(100);

  await combo(page, "Chart type").selectOption({ label: "Violin" });
  await option(combo(page, "Group"), /^label$/);
  await option(combo(page, "Value"), /^amount$/);
  await ready(page, "Eight groups");
  await show.check();
  const violin = await view(page, "Eight groups");
  expect(outliers(violin)).toHaveLength(1);
  expect(JSON.stringify(outliers(violin))).toContain("100");
  const baseline = await readCount(page);
  const theta = violin.option.xAxis[0]?.data?.indexOf("Theta") ?? -1;
  expect(theta).toBeGreaterThanOrEqual(0);
  const peakWidth = violin.option.series[0]?.widths?.[theta];
  expect(peakWidth).toBeGreaterThan(0);
  await combo(page, "Violin width normalization").selectOption({ label: "Area" });
  await expect
    .poll(async () => (await view(page, "Eight groups")).option.series[0]?.widths)
    .not.toEqual(violin.option.series[0]?.widths);
  await combo(page, "Violin width normalization").selectOption({ label: "Count" });
  await expect(combo(page, "Violin width normalization").locator("option:checked")).toHaveText(
    "Count",
  );
  const countedViolin = await view(page, "Eight groups");
  expect(countedViolin.option.series[0]?.widths?.[theta]).toBeCloseTo(peakWidth! / 2);
  expect(outliers(countedViolin)).toHaveLength(1);
  expect(await readCount(page)).toBe(baseline);
  const violinTooltip = await view(page, "Eight groups", {
    point: [0, 3],
    index: 0,
    kind: "violin",
  });
  expect(violinTooltip.tooltip).toContain("Outliers: 1");
});
