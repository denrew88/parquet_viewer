import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { DataValue } from "../src/backend";
import type { CountedChartExtent } from "../src/chart-workspace/contract";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const charts = (page: Page) => page.getByRole("region", { name: "Charts workspace", exact: true });
const settings = (page: Page) =>
  charts(page).getByRole("complementary", { name: "Chart settings" });
const select = (page: Page, name: string) =>
  settings(page).getByRole("combobox", { name, exact: true });
const button = (owner: Locator, name: string) => owner.getByRole("button", { name, exact: true });
const sparseRows = 24_004;
const rareGroup = "Zebra 76";
const readsKey = "__phase25FidelityReads";

async function openCharts(page: Page, fixture: "scatter" | "groups") {
  await page.goto("/?mock=sql22");
  await page.evaluate(
    async ({ fixture, rareGroup, readsKey, sparseRows }) => {
      const backendUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname === "/src/backend.ts");
      if (!backendUrl) throw new Error("The chart browser backend did not load.");
      const { browserMockBackend } = (await (0, eval)(
        `import(${JSON.stringify(backendUrl)})`,
      )) as typeof import("../src/backend");
      const api = browserMockBackend.sqlWorkspace;
      if (!api) throw new Error("The SQL browser backend did not load.");
      const reads: { offset: number; limit: number; columns: string[] }[] = [];
      Reflect.set(window, readsKey, reads);
      const status = api.getStatus.bind(api);
      api.getStatus = async (id) => {
        const original = await status(id);
        return {
          ...original,
          columns: original.columns.map((column) => {
            if (column.id === "r0") return { ...column, name: "coordinate", logicalType: "BIGINT" };
            if (column.id === "r1") return { ...column, name: "label" };
            return column;
          }),
        };
      };

      const readPage = api.readPage.bind(api);
      api.readPage = async (request) => {
        if (
          document
            .querySelector('button[aria-label="Charts workspace"]')
            ?.getAttribute("aria-pressed") !== "true"
        )
          return readPage(request);

        const { columns, limit, offset, resultId } = request;
        reads.push({ columns, limit, offset });
        const totalRows = fixture === "scatter" ? sparseRows : 151;
        const rows: DataValue[][] = [];
        for (let row = offset; row < Math.min(offset + limit, totalRows); row++) {
          // Place remote rows after the dense block so the overview sample can
          // omit the singleton and the occupied cells still have to account for it.
          const remote = [74, 74, 100, 90][row - 24_000];
          const values =
            fixture === "groups"
              ? [
                  row,
                  row === 150
                    ? rareGroup
                    : `Group ${String(Math.floor(row / 2) + 1).padStart(2, "0")}`,
                  row === 150 ? 7 : 20,
                ]
              : row < 24_000
                ? [row % 10, "dense", Math.floor(row / 10) % 10]
                : [remote, "remote", remote];
          rows.push(
            columns.map((column) => {
              const index = Number(column.slice(1));
              const display = String(values[index]);
              return {
                kind: index === 1 ? "string" : index === 2 ? "decimal" : "int",
                state: "valid",
                display,
                sourceDisplay: display,
              };
            }),
          );
        }
        return {
          sessionId: resultId,
          columns,
          limit,
          offset,
          totalRows,
          rows,
          hasMore: offset + rows.length < totalRows,
        };
      };
    },
    { fixture, rareGroup, readsKey, sparseRows },
  );

  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const sql = page.getByRole("region", { name: "SQL workspace", exact: true });
  await sql.getByRole("textbox", { name: "SQL editor", exact: true }).fill("SELECT 1 AS amount;");
  await button(sql, "Run").click();
  await expect(sql.getByRole("grid", { name: "Data preview" })).toHaveAttribute(
    "aria-rowcount",
    "4",
  );
  await page.getByRole("button", { name: "Charts workspace", exact: true }).click();
}

const sourceReads = (page: Page) =>
  page.evaluate((key) => (Reflect.get(window, key) as unknown[]).length, readsKey);

async function addChart(page: Page, type: string, axes: Record<string, string>) {
  await button(charts(page), "Add chart").click();
  const source = select(page, "Data source");
  const result = source.getByRole("option", { name: /Query 1/ });
  await expect(result).toHaveCount(1);
  await source.selectOption((await result.getAttribute("value"))!);
  await select(page, "Chart type").selectOption({ label: type });
  for (const [axis, label] of Object.entries(axes))
    await select(page, axis).selectOption({ label });
  const title = settings(page).getByRole("textbox", { name: "Chart title", exact: true });
  await title.fill(`${type} fidelity`);
  await title.blur();
  const chart = charts(page).getByRole("article", { name: `${type} fidelity`, exact: true });
  await expect(chart).toHaveAttribute("data-state", "ready");
  await expect(chart.getByRole("img").locator("canvas").first()).toBeVisible();
  return chart;
}

type Point = [number, number];

function scatterView(plot: Locator, endpoints?: [Point, Point]) {
  return plot.evaluate(async (element, endpoints) => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (name) =>
          /\/(?:echarts_core|core)\.js$/.test(new URL(name).pathname) && name.includes("echarts"),
      );
    if (!url) throw new Error("The chart renderer did not load.");
    const echarts = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("echarts/core");
    const instance = echarts.getInstanceByDom(element as HTMLElement);
    if (!instance) throw new Error("No renderer is attached to the scatter plot.");
    const { series } = instance.getOption() as {
      series: { id?: string; type: string; data: Point[] | CountedChartExtent[] }[];
    };
    const dots = (series.find(({ type }) => type === "scatter")?.data ?? []) as Point[];
    const tiles = (series.find(({ id }) => id === "scatter-occupancy")?.data ??
      []) as CountedChartExtent[];
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return {
      dots: dots.length,
      sampleHasRare: dots.some(([x, y]) => x === 90 && y === 90),
      tileCount: tiles.reduce((sum, tile) => sum + tile[4], 0),
      rareTile: tiles.find(([x0, x1, y0, y1]) => x0 <= 90 && 90 < x1 && y0 <= 90 && 90 < y1)?.[4],
      pairTile: tiles.find(([x0, x1, y0, y1]) => x0 <= 74 && 74 < x1 && y0 <= 74 && 74 < y1)?.[4],
      exact: dots.length <= 2 ? dots : undefined,
      bounds: { left, top, right, bottom },
      targets: endpoints?.map((point): Point => {
        const [x, y] = instance.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, point);
        return [left + x, top + y];
      }),
    };
  }, endpoints);
}

async function dragRange(page: Page, plot: Locator, first: Point, last: Point) {
  await plot.scrollIntoViewIfNeeded();
  await expectInsideViewport(plot);
  const { bounds, targets } = await scatterView(plot, [first, last]);
  for (const [x, y] of targets ?? []) {
    expect(x).toBeGreaterThan(bounds.left);
    expect(x).toBeLessThan(bounds.right);
    expect(y).toBeGreaterThan(bounds.top);
    expect(y).toBeLessThan(bounds.bottom);
  }
  const [start, end] = targets!;
  await page.mouse.move(...start);
  await page.mouse.down();
  await page.mouse.move(...end, { steps: 5 });
  await page.mouse.up();
}

async function evidence(
  page: Page,
  info: TestInfo,
  name: string,
  focus: Locator,
  metrics: unknown,
) {
  await focus.scrollIntoViewIfNeeded();
  await expectInsideViewport(focus);
  await expectNoHorizontalPageOverflow(page);
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
  await info.attach(`${name}-geometry`, {
    body: JSON.stringify({
      viewport: page.viewportSize(),
      bounds: await focus.boundingBox(),
      metrics,
    }),
    contentType: "application/json",
  });
}

test("Phase 25 chart fidelity T-P25-012/013 recovers points absent from the scatter overview sample", async ({
  page,
}, info) => {
  await openCharts(page, "scatter");
  const chart = await addChart(page, "Scatter", { "X axis": "coordinate", "Y axis": "amount" });
  const plot = chart.getByRole("img", { name: "Scatter fidelity plot", exact: true });
  const zoom = chart.getByRole("group", { name: "Chart zoom" });
  const occupancyLegend = chart.getByText("Shading shows cell counts · Dot marks sparse cells");
  await expect(occupancyLegend).toBeVisible();
  const overview = await scatterView(plot);
  expect(overview).toMatchObject({
    dots: 20_000,
    sampleHasRare: false,
    tileCount: sparseRows,
    rareTile: 1,
    pairTile: 2,
  });
  const reads = await sourceReads(page);
  expect(reads).toBeGreaterThan(0);
  await evidence(page, info, "scatter-overview", plot, { ...overview, reads });

  await dragRange(page, plot, [82, 98], [98, 82]);
  await expect(zoom.getByRole("status")).toHaveText("1 row in view");
  await expect(occupancyLegend).toBeHidden();
  const detail = await scatterView(plot);
  expect(detail).toMatchObject({ exact: [[90, 90]], tileCount: 0 });
  await evidence(page, info, "scatter-singleton-detail", plot, {
    ...detail,
    reads: await sourceReads(page),
  });

  await dragRange(page, plot, [83, 96], [88, 92]);
  await expect(zoom.getByRole("status")).toHaveText("No observations in view");
  expect((await scatterView(plot)).exact).toEqual([]);
  await button(zoom, "Undo zoom").click();
  await expect(zoom.getByRole("status")).toHaveText("1 row in view");
  expect((await scatterView(plot)).exact).toEqual([[90, 90]]);

  await button(zoom, "Reset zoom").click();
  await expect(button(zoom, "Reset zoom")).toBeDisabled();
  await expect(occupancyLegend).toBeVisible();
  expect((await scatterView(plot)).tileCount).toBe(sparseRows);
  await dragRange(page, plot, [82, 98], [98, 82]);
  await expect(zoom.getByRole("status")).toHaveText("1 row in view");
  expect((await scatterView(plot)).exact).toEqual([[90, 90]]);
  expect(await sourceReads(page)).toBe(reads);
});

test("Phase 25 chart fidelity T-P25-016/017 finds late singleton categories and groups without rereading source pages", async ({
  page,
}, info) => {
  await openCharts(page, "groups");
  const axes = { Group: "label", Value: "amount" };
  const bar = await addChart(page, "Bar", axes);
  await expect(bar.getByText(/of 76 categories/)).toBeVisible();
  const barReads = await sourceReads(page);
  expect(barReads).toBeGreaterThan(0);
  await button(bar, "Inspect categories").click();
  const categories = bar.getByRole("region", { name: "Chart categories" });
  await expect(categories.getByRole("status")).toHaveText("1–32 of 76");
  await expect(button(categories, "Previous page")).toBeDisabled();
  await button(categories, "Next page").click();
  await expect(categories.getByRole("status")).toHaveText("33–64 of 76");
  await button(categories, "Next page").click();
  await expect(categories.getByRole("status")).toHaveText("65–76 of 76");
  await expect(button(categories, "Next page")).toBeDisabled();
  const search = categories.getByRole("textbox", { name: "Search categories" });
  await search.fill("missing label");
  await expect(categories.getByRole("status")).toHaveText("No matching categories.");
  await search.fill("zEbRa");
  await expect(categories.getByRole("status")).toHaveText("1–1 of 1");
  const row = categories.getByRole("row").filter({ hasText: rareGroup });
  await expect(row.getByRole("rowheader")).toHaveText(rareGroup);
  await expect(row.getByRole("cell")).toHaveText(["1", "7"]);
  expect(await sourceReads(page)).toBe(barReads);
  await evidence(page, info, "bar-category-search", categories, {
    reads: barReads,
    category: rareGroup,
  });
  await button(categories, "Close details").click();
  await expect(categories).toHaveCount(0);

  const box = await addChart(page, "Box plot", axes);
  await expect(box.getByText(/32 of 76 categories/)).toBeVisible();
  const boxReads = await sourceReads(page);
  await button(box, "Inspect groups").click();
  const groups = box.getByRole("region", { name: "Chart groups" });
  await groups.getByRole("textbox", { name: "Search groups" }).fill("zebra");
  await expect(groups.getByRole("status")).toHaveText("1–1 of 1");
  await button(groups, `Inspect group ${rareGroup}`).click();
  await expect(groups.getByText(rareGroup, { exact: true })).toBeVisible();
  await expect(box.getByText(/32 of 76 categories/)).toBeHidden();
  for (const measure of ["Minimum", "Median", "Maximum"]) {
    await expect(groups.getByText(measure, { exact: true }).locator("+ dd")).toHaveText("7");
  }
  await expect(groups.getByText("Rows", { exact: true }).locator("+ dd")).toHaveText("1");
  await evidence(page, info, "box-singleton-group", groups, {
    reads: await sourceReads(page),
    category: rareGroup,
  });
  await button(groups, "Back to groups").click();
  await expect(groups.getByRole("textbox", { name: "Search groups" })).toHaveValue("zebra");
  await expect(button(groups, `Inspect group ${rareGroup}`)).toBeVisible();
  await button(groups, "Close details").click();
  await expect(groups).toHaveCount(0);
  expect(await sourceReads(page)).toBe(boxReads);
});
