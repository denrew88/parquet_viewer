import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const title = "Dense cloud tooltip";
const pointLabel = "Premium yoga mat";
const pointIndex = 6_048;
const pointCount = 12_000;
const charts = (page: Page) => page.getByRole("region", { name: "Charts workspace", exact: true });

async function denseScatter(page: Page, label = pointLabel) {
  await page.goto("/?mock=sql22");
  await page.evaluate(
    async ({ pointCount, pointLabel }) => {
      const backendUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname === "/src/backend.ts");
      if (!backendUrl) throw new Error("The browser chart backend did not load.");
      const { browserMockBackend } = (await (0, eval)(
        `import(${JSON.stringify(backendUrl)})`,
      )) as typeof import("../src/backend");
      const api = browserMockBackend.sqlWorkspace!;
      const status = api.getStatus.bind(api);
      api.getStatus = async (id) => {
        const current = await status(id);
        return {
          ...current,
          columns: current.columns.map((column) => ({
            ...column,
            name: column.id === "r0" ? "coordinate" : column.id === "r1" ? "label" : "amount",
            logicalType: column.id === "r1" ? "VARCHAR" : "DOUBLE",
          })),
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
        const { offset, limit, columns, resultId } = request;
        const rows = Array.from(
          { length: Math.min(limit, Math.max(0, pointCount - offset)) },
          (_, local) => {
            const index = offset + local;
            return columns.map((column): import("../src/backend").DataValue => ({
              kind: column === "r1" ? "string" : "float",
              state: "valid",
              display:
                column === "r0"
                  ? String(index % 120)
                  : column === "r1"
                    ? pointLabel
                    : String(Math.floor(index / 120)),
            }));
          },
        );
        return {
          sessionId: resultId,
          offset,
          limit,
          columns,
          rows,
          totalRows: pointCount,
          hasMore: offset + rows.length < pointCount,
        };
      };
    },
    { pointCount, pointLabel: label },
  );
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const sql = page.getByRole("region", { name: "SQL workspace", exact: true });
  await sql.getByRole("textbox", { name: "SQL editor", exact: true }).fill("SELECT 1 AS points;");
  await sql.getByRole("button", { name: "Run", exact: true }).click();
  await expect(sql.getByRole("grid", { name: "Data preview", exact: true })).toHaveAttribute(
    "aria-rowcount",
    "4",
  );
  await page.getByRole("button", { name: "Charts workspace", exact: true }).click();
  await charts(page).getByRole("button", { name: "Add chart", exact: true }).click();
  const settings = charts(page).getByRole("complementary", { name: "Chart settings", exact: true });
  await settings
    .getByRole("combobox", { name: "Data source", exact: true })
    .selectOption({ label: "SQL · Query 1" });
  await settings
    .getByRole("combobox", { name: "Chart type", exact: true })
    .selectOption({ label: "Scatter" });
  await settings.getByRole("combobox", { name: "X axis", exact: true }).selectOption("r0");
  await settings.getByRole("combobox", { name: "Y axis", exact: true }).selectOption("r2");
  await settings.getByRole("combobox", { name: "Point label", exact: true }).selectOption("r1");
  await settings.getByRole("textbox", { name: "Chart title", exact: true }).fill(title);
  await settings.getByRole("textbox", { name: "Chart title", exact: true }).blur();
  const card = charts(page).getByRole("article", { name: title, exact: true });
  await expect(card).toHaveAttribute("data-state", "ready");
  await expect(card).toContainText("12,000 points displayed");
  return card.getByRole("img", { name: `${title} plot`, exact: true });
}

function tooltipPosition(surface: Locator) {
  return surface.evaluate(async (element, pointIndex) => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (name) =>
          /\/(?:echarts_core|core)\.js$/.test(new URL(name).pathname) && name.includes("echarts"),
      );
    if (!moduleUrl) throw new Error("The chart renderer did not load.");
    const echarts = (await (0, eval)(
      `import(${JSON.stringify(moduleUrl)})`,
    )) as typeof import("echarts/core");
    const chart = echarts.getInstanceByDom(element as HTMLElement)!;
    const point: [number, number] = [pointIndex % 120, Math.floor(pointIndex / 120)];
    const pixel = chart.convertToPixel({ gridIndex: 0 }, point) as [number, number];
    const bounds = element.getBoundingClientRect();
    Reflect.set(element, "readTooltipLayers", () => {
      const model = (
        chart as unknown as {
          getModel(): {
            getComponent(type: string): { get(key: string): unknown };
            getSeriesByIndex(index: number): { get(key: string): unknown };
          };
        }
      ).getModel();
      const roots = chart.getZr().storage.getRoots() as unknown as {
        type: string;
        z: number;
        zlevel: number;
        ignore: boolean;
        style?: { text?: string; backgroundColor?: string };
      }[];
      const series = (
        chart.getOption() as {
          series: {
            progressive: number;
            progressiveThreshold: number;
            large: boolean;
            data: unknown[];
          }[];
        }
      ).series[0];
      return {
        seriesZlevel: model.getSeriesByIndex(0).get("zlevel"),
        tooltipModelZlevel: model.getComponent("tooltip").get("zlevel"),
        tooltipRenderMode: model.getComponent("tooltip").get("renderMode"),
        roots: roots
          .filter((root) => root.type === "text" && !root.ignore)
          .map(({ z, zlevel, style }) => ({
            z,
            zlevel,
            text: style?.text,
            backgroundColor: style?.backgroundColor,
          })),
        progressive: series.progressive,
        progressiveThreshold: series.progressiveThreshold,
        large: series.large,
        points: series.data.length,
      };
    });
    return [bounds.left + pixel[0], bounds.top + pixel[1]] as [number, number];
  }, pointIndex);
}

test("Phase 25 T-P25-025 keeps dense scatter tooltip above the point cloud", async ({
  page,
}, info) => {
  const surface = await denseScatter(page);
  const hover = await tooltipPosition(surface);
  const probe = () =>
    surface.evaluate((element) => (Reflect.get(element, "readTooltipLayers") as () => unknown)());
  await page.mouse.move(2, 2);
  await page.mouse.move(...hover);
  await expect
    .poll(async () => {
      const layers = (await probe()) as { roots: { text?: string }[] };
      return [...layers.roots.map(({ text }) => text ?? ""), await surface.innerText()].join("\n");
    })
    .toContain(pointLabel);
  await expectNoHorizontalPageOverflow(page);
  const screenshot = info.outputPath("dense-tooltip.png");
  const metadata = info.outputPath("dense-tooltip-layers.json");
  const layers = (await probe()) as {
    points: number;
    progressive: number;
    progressiveThreshold: number;
    large: boolean;
  };
  await page.screenshot({ path: screenshot });
  await writeFile(
    metadata,
    JSON.stringify({ viewport: page.viewportSize(), hover, ...layers }, null, 2),
  );
  await info.attach("Dense scatter tooltip", { path: screenshot, contentType: "image/png" });
  await info.attach("Dense scatter layers", { path: metadata, contentType: "application/json" });
  expect(layers.points).toBe(pointCount);
  expect(layers.progressive).toBeGreaterThan(0);
  expect(layers.progressiveThreshold).toBeLessThan(pointCount);
  expect(layers.large).toBe(false);
  const tooltip = surface.getByText(pointLabel, { exact: false });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(/Source row: [\d,]+/);
  await expect(tooltip.locator("b,img,script")).toHaveCount(0);
  await expect(tooltip).toHaveCSS("pointer-events", "none");
  await expect(tooltip).toHaveCSS("z-index", "2");
  await expect(tooltip).toHaveCSS("background-color", "rgba(255, 255, 255, 0.85)");
  await expect(tooltip).toHaveCSS("opacity", "1");
  await expectInsideViewport(tooltip);
  const [plotBounds, tooltipBounds] = await Promise.all([
    surface.boundingBox(),
    tooltip.boundingBox(),
  ]);
  expect(tooltipBounds!.x).toBeGreaterThanOrEqual(plotBounds!.x - 1);
  expect(tooltipBounds!.y).toBeGreaterThanOrEqual(plotBounds!.y - 1);
  expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(
    plotBounds!.x + plotBounds!.width + 1,
  );
  expect(tooltipBounds!.y + tooltipBounds!.height).toBeLessThanOrEqual(
    plotBounds!.y + plotBounds!.height + 1,
  );

  if (info.project.name === "desktop-wide") {
    const literalLabel = "<b>dense & point</b>";
    const safetySurface = await denseScatter(page, literalLabel);
    const safetyHover = await tooltipPosition(safetySurface);
    await page.mouse.move(2, 2);
    await page.mouse.move(...safetyHover);
    const safetyTooltip = safetySurface.locator(".chart-point-tooltip");
    await expect(safetyTooltip).toBeVisible();
    await expect(safetyTooltip).toContainText(literalLabel);
    await expect(safetyTooltip.locator("b,img,script")).toHaveCount(0);
  }
});
