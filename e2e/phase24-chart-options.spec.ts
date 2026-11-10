import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const workspace = (page: Page) =>
  page.getByRole("region", { name: "Charts workspace", exact: true });
const inspector = (page: Page) =>
  workspace(page).getByRole("complementary", { name: "Chart settings", exact: true });
const combo = (page: Page, name: string) =>
  inspector(page).getByRole("combobox", { name, exact: true });
const number = (page: Page, name: string) =>
  inspector(page).getByRole("spinbutton", { name, exact: true });
const action = (page: Page, name: string) =>
  inspector(page).getByRole("button", { name, exact: true });
const card = (page: Page, title: string) =>
  workspace(page).getByRole("article", { name: title, exact: true });
const plot = (card: Locator, title: string) =>
  card.getByRole("img", { name: `${title} plot`, exact: true });
const probeKey = "__phase24OptionReads";

interface ReadProbe {
  reads: number;
  holdNext: boolean;
  release?: () => void;
}

async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(async (key) => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser fixture backend did not load.");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const sql = module.browserMockBackend.sqlWorkspace;
    if (!sql) throw new Error("SQL fixture did not load.");
    const probe: ReadProbe = { reads: 0, holdNext: false };
    Reflect.set(window, key, probe);
    const original = sql.readPage.bind(sql);
    sql.readPage = async (request) => {
      if (
        document
          .querySelector('button[aria-label="Charts workspace"]')
          ?.getAttribute("aria-pressed") === "true"
      ) {
        probe.reads++;
        if (probe.holdNext) {
          probe.holdNext = false;
          await new Promise<void>((resolve) => {
            probe.release = resolve;
          });
        }
      }
      const result = await original(request);
      return {
        ...result,
        rows: result.rows.map((row, rowIndex) =>
          row.map((value, columnIndex) => {
            const index = result.offset + rowIndex;
            const id = result.columns[columnIndex];
            const display =
              id === "r2"
                ? [0, 1, 2, 4][index]
                : id === "r0"
                  ? [-2, -1, 0, 3][index]
                  : "Fixture group";
            return { ...value, display: String(display), sourceDisplay: String(display) };
          }),
        ),
      };
    };
  }, probeKey);
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

function reads(page: Page) {
  return page.evaluate((key) => (Reflect.get(window, key) as ReadProbe).reads, probeKey);
}

async function holdNext(page: Page) {
  await page.evaluate((key) => {
    (Reflect.get(window, key) as ReadProbe).holdNext = true;
  }, probeKey);
}

async function waitForHeldRead(page: Page) {
  await expect
    .poll(() =>
      page.evaluate((key) => Boolean((Reflect.get(window, key) as ReadProbe).release), probeKey),
    )
    .toBe(true);
}

async function releaseHeldRead(page: Page) {
  await page.evaluate(async (key) => {
    const probe = Reflect.get(window, key) as ReadProbe;
    probe.release?.();
    delete probe.release;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, probeKey);
}

async function choose(select: Locator, option: RegExp) {
  const choice = select.locator("option").filter({ hasText: option });
  await expect(choice).toHaveCount(1);
  await select.selectOption((await choice.getAttribute("value"))!);
}

async function setType(page: Page, type: string, axes: Record<string, RegExp>) {
  await combo(page, "Chart type").selectOption({ label: type });
  for (const [axis, option] of Object.entries(axes)) await choose(combo(page, axis), option);
}

async function addCard(page: Page, title: string, type: string, axes: Record<string, RegExp>) {
  await workspace(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await choose(combo(page, "Data source"), /Query 1/);
  await setType(page, type, axes);
  const name = inspector(page).getByRole("textbox", { name: "Chart title", exact: true });
  await name.fill(title);
  await name.blur();
  await readyPlot(page, title);
}

async function readyPlot(page: Page, title: string) {
  const article = card(page, title);
  await article.scrollIntoViewIfNeeded();
  await expect(article).toHaveAttribute("data-state", "ready");
  const image = plot(article, title);
  await expect(image.locator("canvas").first()).toBeVisible();
  return image;
}

async function selectCard(page: Page, title: string) {
  await card(page, title)
    .getByRole("button", { name: `Edit ${title}`, exact: true })
    .click();
}

interface Series {
  type?: string;
  data?: unknown[];
  symbolSize?: unknown;
  lineStyle?: { width?: unknown };
  boxWidth?: unknown;
  barWidth?: unknown;
  renderItem?: (
    args: { dataIndex: number },
    api: { coord(position: [number, number]): [number, number] },
  ) => { children?: unknown[] } | null;
}

function readRenderer(image: Locator, includeDensity = false) {
  return image.evaluate(async (element, includeDensity) => {
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
    const option = echarts.getInstanceByDom(element as HTMLElement)?.getOption();
    const series = (option?.series as Series[] | undefined)?.[0];
    if (!series) return null;
    const xAxis = (option?.xAxis as { axisLabel?: { formatter?: (n: number) => string } }[])?.[0];
    const formatter = xAxis?.axisLabel?.formatter;
    return {
      kind: series.type,
      data: series.data,
      symbolSize: series.symbolSize,
      lineWidth: series.lineStyle?.width,
      boxWidth: series.boxWidth,
      barWidth: series.barWidth,
      tickAt2: typeof formatter === "function" ? formatter(2) : undefined,
      densityShape: includeDensity
        ? series.renderItem?.({ dataIndex: 0 }, { coord: ([x, y]) => [x * 100, y * 20] })?.children
        : undefined,
    };
  }, includeDensity);
}

const histogramAxes = { Value: /^amount$/ };
const numericAxes = { "X axis": /^amount$/, "Y axis": /^value(?: \(r0\))?$/ };
const groupedAxes = { Group: /^value \(r1\)$/, Value: /^amount$/ };

test("Phase 24 chart options T-P24-010/013/014 applies histogram bins to one card", async ({
  page,
}, info) => {
  await setup(page);
  await addCard(page, "Histogram options", "Histogram", histogramAxes);
  await addCard(page, "Unchanged distribution", "Histogram", histogramAxes);
  const otherImage = plot(card(page, "Unchanged distribution"), "Unchanged distribution");
  await expect.poll(async () => (await readRenderer(otherImage))?.kind).toBe("custom");
  const otherBefore = await readRenderer(otherImage);
  await selectCard(page, "Histogram options");
  const image = await readyPlot(page, "Histogram options");
  const article = card(page, "Histogram options");
  const before = await reads(page);
  await choose(combo(page, "Histogram bins"), /^Number of bins$/);
  const count = number(page, "Bin count");
  await count.fill("49");
  await action(page, "Apply histogram bins").click();
  await expect(count).toHaveAttribute("aria-invalid", "true");
  await expect(inspector(page).getByRole("alert")).toContainText("from 1 to 48");
  expect(await reads(page)).toBe(before);
  await count.fill("2");
  await count.press("Enter");
  await expect.poll(() => reads(page)).toBe(before + 1);
  await expect(article).toContainText(/· 2 bins\b/);
  await expect
    .poll(async () => (await readRenderer(image))?.data?.map((bin) => (bin as number[])[3]))
    .toEqual([2, 2]);

  await choose(combo(page, "Histogram bins"), /^Bin width$/);
  const width = number(page, "Bin width");
  await width.fill("0");
  await action(page, "Apply histogram bins").click();
  await expect(width).toHaveAttribute("aria-invalid", "true");
  await expect(inspector(page).getByRole("alert")).toContainText("greater than 0");
  expect(await reads(page)).toBe(before + 1);
  await width.fill("2");
  await action(page, "Apply histogram bins").click();
  await expect.poll(() => reads(page)).toBe(before + 2);
  await expect(article).toHaveAttribute("data-state", "ready");
  await width.fill("0.01");
  await action(page, "Apply histogram bins").click();
  await expect(article).toHaveAttribute("data-state", "error");
  await expect(article.getByRole("alert")).toContainText("48 bins");
  await expect(image.locator("canvas").first()).toBeVisible();
  await width.fill("2");
  await action(page, "Apply histogram bins").click();
  await expect(article).toHaveAttribute("data-state", "ready");
  // The last valid chart is already cached, so restoring it needs no new read.
  expect(await reads(page)).toBe(before + 3);
  await choose(combo(page, "X scale"), /^Log10$/);
  await expect(image).toHaveAttribute("data-x-scale", "log10");
  await expect(inspector(page).getByText(/bin width uses transformed log10 units/i)).toBeVisible();
  await expect(article).toContainText(/· 1 bins?\b/);
  await expect(article).toContainText("1 excluded by scale");

  const panel = inspector(page);
  for (const control of [
    combo(page, "Histogram bins"),
    width,
    action(page, "Apply histogram bins"),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expectInsideViewport(control);
  }
  await expectNoHorizontalPageOverflow(page);
  const geometry = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      inspector: bounds.toJSON(),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewport: { width: innerWidth, height: innerHeight },
      controls: [...element.querySelectorAll("select,input,button")].map((control) =>
        control.getBoundingClientRect().toJSON(),
      ),
    };
  });
  expect(geometry.inspector.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  for (const control of geometry.controls.filter((bounds) => bounds.width > 0)) {
    expect(control.left).toBeGreaterThanOrEqual(geometry.inspector.left - 1);
    expect(control.right).toBeLessThanOrEqual(geometry.inspector.right + 1);
  }
  const geometryPath = info.outputPath("phase24-chart-options-geometry.json");
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await info.attach("Chart options geometry", {
    path: geometryPath,
    contentType: "application/json",
  });
  const screenshot = info.outputPath("phase24-chart-options.png");
  await page.screenshot({ path: screenshot });
  await info.attach("Histogram bin controls", { path: screenshot, contentType: "image/png" });

  await selectCard(page, "Unchanged distribution");
  await expect(combo(page, "Histogram bins").locator("option:checked")).toHaveText("Auto");
  await expect.poll(() => readRenderer(otherImage)).toEqual(otherBefore);
  expect(await reads(page)).toBe(before + 4);
});

test("Phase 24 chart options T-P24-011/013 keeps independent axis scales through a stale read", async ({
  page,
}) => {
  await setup(page);
  await addCard(page, "Scaled scatter", "Scatter", numericAxes);
  await addCard(page, "Linear scatter", "Scatter", numericAxes);
  const otherImage = plot(card(page, "Linear scatter"), "Linear scatter");
  const initialSize = (await readRenderer(otherImage))?.symbolSize;
  await selectCard(page, "Scaled scatter");
  const article = card(page, "Scaled scatter");
  const image = await readyPlot(page, "Scaled scatter");
  const baseline = await reads(page);
  await holdNext(page);
  await choose(combo(page, "X scale"), /^Log \(ln\)$/);
  try {
    await waitForHeldRead(page);
    await expect(article).toHaveAttribute("data-state", "loading");
    await expect(image.locator("canvas").first()).toBeVisible();
    await choose(combo(page, "X scale"), /^Log10$/);
    await expect(image).toHaveAttribute("data-x-scale", "log10");
    await expect(article).toContainText("1 excluded by scale");
  } finally {
    await releaseHeldRead(page);
  }
  await expect(image).toHaveAttribute("data-x-scale", "log10");
  await expect(combo(page, "Y scale").locator("option:checked")).toHaveText("Linear");
  expect(await reads(page)).toBe(baseline + 2);
  await expect.poll(async () => (await readRenderer(image))?.tickAt2).toBe("100");

  await choose(combo(page, "Y scale"), /^Log1p$/);
  await expect(image).toHaveAttribute("data-x-scale", "log10");
  await expect(image).toHaveAttribute("data-y-scale", "log1p");
  await expect(article).toContainText("2 excluded by scale");
  await expect(article).toContainText("2 valid rows");
  const rendered = await readRenderer(image);
  const points = rendered?.data as [number, number][];
  expect(points).toHaveLength(2);
  expect(points[0]?.[0]).toBeCloseTo(Math.log10(2));
  expect(points[0]?.[1]).toBe(0);
  expect(points[1]?.[0]).toBeCloseTo(Math.log10(4));
  expect(points[1]?.[1]).toBeCloseTo(Math.log1p(3));

  const pointSize = inspector(page).getByRole("slider", {
    name: "Scatter point size",
    exact: true,
  });
  const beforeStyle = await reads(page);
  await pointSize.press("End");
  const selected = Number(await pointSize.inputValue());
  await expect.poll(async () => (await readRenderer(image))?.symbolSize).toBe(selected);
  expect(await reads(page)).toBe(beforeStyle);
  await selectCard(page, "Linear scatter");
  await expect(pointSize).toHaveValue(String(initialSize));
  await expect(otherImage).toHaveAttribute("data-x-scale", "linear");
  await expect(otherImage).toHaveAttribute("data-y-scale", "linear");
  expect(await reads(page)).toBe(beforeStyle);

  const sheets = workspace(page).getByRole("tablist", { name: "Chart sheets", exact: true });
  await workspace(page).getByRole("button", { name: "New sheet", exact: true }).click();
  await expect(sheets.getByRole("tab", { name: "Sheet 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await sheets.getByRole("tab", { name: "Sheet 1", exact: true }).click();
  await selectCard(page, "Scaled scatter");
  await expect(pointSize).toHaveValue(String(selected));
  const restored = await readyPlot(page, "Scaled scatter");
  await expect(restored).toHaveAttribute("data-x-scale", "log10");
  await expect(restored).toHaveAttribute("data-y-scale", "log1p");
  await expect.poll(async () => (await readRenderer(restored))?.symbolSize).toBe(selected);
  expect(await reads(page)).toBe(beforeStyle);
});

test("Phase 24 chart options T-P24-012/013 changes bandwidth and visual styling separately", async ({
  page,
}) => {
  await setup(page);
  await addCard(page, "Grouped options", "Violin", groupedAxes);
  const image = await readyPlot(page, "Grouped options");
  const baseline = await reads(page);
  const bandwidth = number(page, "Violin bandwidth");
  await bandwidth.fill("4.5");
  await action(page, "Apply bandwidth").click();
  await expect(bandwidth).toHaveAttribute("aria-invalid", "true");
  await expect(inspector(page).getByRole("alert")).toContainText("from 0.25 to 4");
  expect(await reads(page)).toBe(baseline);
  await bandwidth.fill("0.25");
  await action(page, "Apply bandwidth").click();
  await expect.poll(() => reads(page)).toBe(baseline + 1);
  await expect(card(page, "Grouped options")).toHaveAttribute("data-state", "ready");
  const narrow = await readRenderer(image, true);
  expect(narrow?.densityShape?.length).toBeGreaterThan(2);
  await bandwidth.fill("4");
  await action(page, "Apply bandwidth").click();
  await expect.poll(() => reads(page)).toBe(baseline + 2);
  await expect
    .poll(async () => (await readRenderer(image, true))?.densityShape)
    .not.toEqual(narrow?.densityShape);
  expect((await readRenderer(image))?.data).toEqual(narrow?.data);
  await expect(combo(page, "X scale")).toHaveCount(0);

  for (const [type, axes, label, key] of [
    ["Line", numericAxes, "Line thickness", "lineWidth"],
    ["Box plot", groupedAxes, "Box width", "boxWidth"],
    ["Bar", groupedAxes, "Bar width", "barWidth"],
  ] as const) {
    await setType(page, type, axes);
    const changed = await readyPlot(page, "Grouped options");
    const slider = inspector(page).getByRole("slider", { name: label, exact: true });
    const readBefore = await reads(page);
    await slider.press("End");
    const value = await slider.inputValue();
    const expected =
      key === "lineWidth"
        ? Number(value)
        : key === "boxWidth"
          ? [`${value}%`, `${value}%`]
          : `${value}%`;
    await expect.poll(async () => (await readRenderer(changed))?.[key]).toEqual(expected);
    expect(await reads(page)).toBe(readBefore);
    await expect(number(page, "Violin bandwidth")).toHaveCount(0);
  }
  await choose(combo(page, "Data source"), /orders\.csv \(sales\)/);
  await setType(page, "Line", { "X axis": /^주문 일시$/, "Y axis": /^결제 금액$/ });
  await expect(combo(page, "X scale")).toBeDisabled();
  await expect(combo(page, "Y scale")).toBeEnabled();
});
