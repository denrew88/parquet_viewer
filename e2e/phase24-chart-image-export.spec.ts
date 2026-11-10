import {
  expect,
  test,
  type Download,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const chartTitle = "분석 & <비교>";
const probeKey = "__chartImageExportReads";
const workspace = (page: Page) =>
  page.getByRole("region", { name: "Charts workspace", exact: true });
const settings = (page: Page) =>
  workspace(page).getByRole("complementary", { name: "Chart settings", exact: true });
const combo = (page: Page, name: string) =>
  settings(page).getByRole("combobox", { name, exact: true });
const card = (page: Page) =>
  workspace(page).getByRole("article", { name: chartTitle, exact: true });
const plot = (page: Page) =>
  card(page).getByRole("img", { name: `${chartTitle} plot`, exact: true });
const trigger = (page: Page) =>
  card(page).getByRole("button", { name: "Export chart image", exact: true });
const menu = (page: Page) => page.getByRole("dialog", { name: "Export chart image", exact: true });
const svgDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Save chart as SVG", exact: true });

type Row = [number | null, number, string];
const seed: Row[] = [
  [1, 0, "Keep"],
  [10, 25, "Keep"],
  [100, 50, "Keep"],
  [100, 50, "Keep"],
  [1000, 75, "Keep"],
  [10_000, 100, "Keep"],
  [0, 50, "Keep"],
  [-10, 50, "Keep"],
  [100, 50, "Drop"],
  [null, 50, "Keep"],
];
const repetitions = 22;
const rows = Array.from({ length: repetitions }, () => seed).flat();

interface ReadProbe {
  reads: { columns: string[]; resultId: string }[];
  holdAt?: number;
  release?: () => void;
  finishBackgroundSql?: () => void;
  backgroundResultId?: string;
  releaseBackgroundChart?: () => void;
}

async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(
    async ({ rows, probeKey }) => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname === "/src/backend.ts");
      if (!url) throw new Error("Browser backend module did not load.");
      const module = (await (0, eval)(
        `import(${JSON.stringify(url)})`,
      )) as typeof import("../src/backend");
      const api = module.browserMockBackend.sqlWorkspace;
      if (!api) throw new Error("SQL fixture did not load.");
      const probe: ReadProbe = { reads: [] };
      Reflect.set(window, probeKey, probe);
      let backgroundRunId: string | undefined;
      let finishBackgroundSql: Promise<void> | undefined;
      const originalStart = api.startQuery.bind(api);
      api.startQuery = async (request) => {
        if (request.sql === "SELECT 2 AS amount;") {
          backgroundRunId = request.runId;
          finishBackgroundSql = new Promise<void>((resolve) => {
            probe.finishBackgroundSql = resolve;
          });
        }
        return originalStart(request);
      };
      const originalStatus = api.getStatus.bind(api);
      api.getStatus = async (id) => {
        if (id === backgroundRunId) await finishBackgroundSql;
        const status = await originalStatus(id);
        if (id === backgroundRunId && status.resultId) probe.backgroundResultId = status.resultId;
        return {
          ...status,
          columns: status.columns.map((column) => ({
            ...column,
            name:
              ({ r0: "Coordinate X", r1: "Group", r2: "Coordinate Y" } as Record<string, string>)[
                column.id
              ] ?? column.name,
          })),
        };
      };
      const originalRead = api.readPage.bind(api);
      api.readPage = async (request) => {
        const { columns, resultId, offset, limit } = request;
        if (
          document
            .querySelector('button[aria-label="Charts workspace"]')
            ?.getAttribute("aria-pressed") !== "true" ||
          (resultId === probe.backgroundResultId && columns[1] === "r1")
        )
          return originalRead(request);
        probe.reads.push({ columns, resultId });
        if (resultId === probe.backgroundResultId && offset === 0) {
          await new Promise<void>((resolve) => {
            probe.releaseBackgroundChart = resolve;
          });
          delete probe.releaseBackgroundChart;
        }
        if (probe.reads.length === probe.holdAt) {
          await new Promise<void>((resolve) => {
            probe.release = resolve;
          });
          delete probe.release;
        }
        const batch: import("../src/backend").DataValue[][] = rows
          .slice(offset, offset + limit)
          .map(([x, y, group]) =>
            columns.map((column) => {
              const value = column === "r0" ? x : column === "r1" ? group : y;
              const display = value === null ? null : String(value);
              return {
                kind: column === "r1" ? "string" : column === "r2" ? "decimal" : "int",
                state: value === null ? "null" : "valid",
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
          totalRows: rows.length,
          rows: batch,
          hasMore: offset + batch.length < rows.length,
        };
      };
    },
    { rows, probeKey },
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
  await workspace(page).getByRole("button", { name: "Add chart", exact: true }).click();
  await combo(page, "Data source").selectOption({ label: "SQL · Query 1" });
  await combo(page, "Chart type").selectOption({ label: "Scatter" });
  await combo(page, "X axis").selectOption({ label: "Coordinate X" });
  await combo(page, "Y axis").selectOption({ label: "Coordinate Y" });
  const title = settings(page).getByRole("textbox", { name: "Chart title", exact: true });
  await title.fill(chartTitle);
  await title.blur();
  await combo(page, "Filter column").selectOption({ label: "Group" });
  await settings(page).getByRole("textbox", { name: "Filter value", exact: true }).fill("Keep");
  await settings(page).getByRole("button", { name: "Apply filter", exact: true }).click();
  await combo(page, "X scale").selectOption({ label: "Log10" });
  await card(page).scrollIntoViewIfNeeded();
  await expect(card(page)).toHaveAttribute("data-state", "ready");
  await expect(plot(page)).toHaveAttribute("data-x-scale", "log10");
  await expect(card(page)).toContainText(`${6 * repetitions} valid rows`);
  await expect(plot(page).locator("canvas").first()).toBeVisible();
}

async function capture(page: Page, dialog: Locator, name: string, info: TestInfo) {
  await expectInsideViewport(dialog);
  await expectNoHorizontalPageOverflow(page);
  const geometry = await dialog.evaluate((element) => {
    const box = (target: Element) => {
      const { left, top, right, bottom, width, height } = target.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: box(element),
      controls: [...element.querySelectorAll("button, label")].map((control) => ({
        text: control.textContent?.trim(),
        ...box(control),
      })),
    };
  });
  for (const control of geometry.controls.filter(({ width, height }) => width > 0 && height > 0)) {
    expect(control.left).toBeGreaterThanOrEqual(geometry.dialog.left - 1);
    expect(control.right).toBeLessThanOrEqual(geometry.dialog.right + 1);
    expect(control.top).toBeGreaterThanOrEqual(geometry.dialog.top - 1);
    expect(control.bottom).toBeLessThanOrEqual(geometry.dialog.bottom + 1);
  }
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await writeFile(info.outputPath(`${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  await info.attach(name, { path: screenshot, contentType: "image/png" });
}

async function downloaded(download: Download, extension: ".png" | ".svg") {
  expect(download.suggestedFilename().toLowerCase().endsWith(extension)).toBe(true);
  expect(await download.failure()).toBeNull();
  return readFile(await download.path());
}

// Count horizontal bands of painted teal markers after Chromium decodes the
// image. A clipped SVG point may still have a path node, so DOM counts alone
// cannot prove that Displayed points honored the current zoom.
function imageEvidence(page: Page, file?: { type: string; base64: string }) {
  return page.evaluate(async (file) => {
    let blob: Blob;
    if (file) {
      blob = new Blob([Uint8Array.from(atob(file.base64), (value) => value.charCodeAt(0))], {
        type: file.type,
      });
    } else {
      const image = (await navigator.clipboard.read()).find((item) =>
        item.types.includes("image/png"),
      );
      if (!image) throw new Error("The clipboard does not contain a PNG image.");
      blob = await image.getType("image/png");
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const { naturalWidth: width, naturalHeight: height } = image;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, width, height);
      const marked = new Uint8Array(width);
      let titleInk = 0;
      const titleHeight = file?.type === "image/svg+xml" ? 32 : 64;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const [red, green, blue, alpha] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
          if (alpha < 240) continue;
          if (y < titleHeight && red < 160 && green < 160 && blue < 160) titleInk++;
          if (y >= titleHeight && green - red > 35 && Math.abs(green - blue) < 16) marked[x] = 1;
        }
      }
      const markerBands = marked.reduce(
        (count, value, index) => count + (value && !marked[index - 1] ? 1 : 0),
        0,
      );
      return { width, height, titleInk, markerBands };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, file);
}

async function readProbe(page: Page) {
  return page.evaluate((key) => (Reflect.get(window, key) as ReadProbe).reads, probeKey);
}

async function chooseSvg(
  page: Page,
  view: "Current zoom" | "Entire chart",
  points: "Displayed points" | "All valid points",
) {
  await trigger(page).click();
  await menu(page).getByRole("button", { name: "Save SVG", exact: true }).click();
  const dialog = svgDialog(page);
  await dialog.getByRole("radio", { name: view, exact: true }).check();
  await dialog.getByRole("radio", { name: points, exact: true }).check();
  return dialog;
}

async function svgEvidence(page: Page, data: string) {
  return page.evaluate((data) => {
    const xml = new DOMParser().parseFromString(data, "image/svg+xml");
    const root = xml.documentElement;
    const all = root.querySelector('[data-chart-points="all"]');
    return {
      root: root.localName,
      viewBox: root.getAttribute("viewBox"),
      heading: [...root.children].find((element) => element.localName === "text")?.textContent,
      text: root.textContent,
      paths: root.querySelectorAll("path").length,
      nonVectorOrActive: root.querySelectorAll("image, script, foreignObject, [onload]").length,
      displayed: root.querySelectorAll('path[fill="#087f78"], circle[fill="#087f78"]').length,
      all: all ? all.querySelectorAll("circle").length : null,
    };
  }, data);
}

test("Phase 24 image export T-P24-022/023 copies and downloads a zoomed chart PNG", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  await card(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(card(page).getByRole("button", { name: "Reset zoom", exact: true })).toBeEnabled();
  await trigger(page).press("Enter");
  await expect(menu(page)).toBeVisible();
  await capture(page, menu(page), "chart-image-export-menu", info);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).press("Enter");
  await menu(page).getByRole("button", { name: "Copy image", exact: true }).click();
  await expect(page.getByText("Chart image copied.", { exact: true })).toBeVisible();
  const clipboard = await imageEvidence(page);
  expect(clipboard.titleInk).toBeGreaterThan(30);
  expect(clipboard.markerBands).toBe(3);

  await trigger(page).click();
  const download = page.waitForEvent("download");
  await menu(page).getByRole("button", { name: "Save PNG", exact: true }).click();
  const png = await downloaded(await download, ".png");
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  const surface = await plot(page).evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  expect(png.readUInt32BE(16)).toBe(surface.width * 2);
  expect(png.readUInt32BE(20)).toBe((surface.height + 32) * 2);
  const file = await imageEvidence(page, { type: "image/png", base64: png.toString("base64") });
  expect(file).toEqual(clipboard);
  await expect(page.getByText("Chart image saved.", { exact: true })).toBeVisible();

  await workspace(page).getByRole("button", { name: "Add chart", exact: true }).click();
  const added = workspace(page).getByRole("article", { name: "New chart", exact: true });
  await expect(
    added.getByRole("button", { name: "Export chart image", exact: true }),
  ).toBeDisabled();
  await combo(page, "Data source").selectOption({ label: "SQL · Query 1" });
  await combo(page, "Chart type").selectOption({ label: "Histogram" });
  await combo(page, "Value").selectOption({ label: "Coordinate Y" });
  const histogram = workspace(page).getByRole("article", { name: "Histogram chart", exact: true });
  await histogram.scrollIntoViewIfNeeded();
  await histogram.getByRole("button", { name: "Export chart image", exact: true }).click();
  await menu(page).getByRole("button", { name: "Save SVG", exact: true }).click();
  await expect(
    svgDialog(page).getByRole("radio", { name: "Current zoom", exact: true }),
  ).toBeChecked();
  await expect(
    svgDialog(page).getByRole("radio", { name: "All valid points", exact: true }),
  ).toHaveCount(0);
  await svgDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card(page)).toHaveAttribute("data-state", "ready");
});

test("Phase 24 image export T-P24-026 keeps the captured result while SQL finishes", async ({
  page,
}) => {
  await setup(page);
  const firstResult = await card(page).getAttribute("data-result-id");
  expect(firstResult).toBeTruthy();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const sql = page.getByRole("region", { name: "SQL workspace", exact: true });
  await sql.getByRole("textbox", { name: "SQL editor", exact: true }).fill("SELECT 2 AS amount;");
  await sql.getByRole("button", { name: "Run", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => Boolean((Reflect.get(window, key) as ReadProbe).finishBackgroundSql),
        probeKey,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Charts workspace", exact: true }).click();
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();

  await page.evaluate((key) => {
    (Reflect.get(window, key) as ReadProbe).finishBackgroundSql?.();
  }, probeKey);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => Boolean((Reflect.get(window, key) as ReadProbe).releaseBackgroundChart),
        probeKey,
      ),
    )
    .toBe(true);
  const readsBeforeSave = (await readProbe(page)).length;
  const secondResult = await page.evaluate(
    (key) => (Reflect.get(window, key) as ReadProbe).backgroundResultId,
    probeKey,
  );
  expect(secondResult).toBeTruthy();
  expect(secondResult).not.toBe(firstResult);
  await menu(page).getByRole("button", { name: "Save SVG", exact: true }).click();
  const dialog = svgDialog(page);
  await dialog.getByRole("radio", { name: "All valid points", exact: true }).check();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save SVG", exact: true }).click();
  const svg = await downloaded(await download, ".svg");
  expect((await svgEvidence(page, svg.toString("utf8"))).all).toBe(6 * repetitions);
  const exportReads = (await readProbe(page)).slice(readsBeforeSave);
  expect(exportReads).toHaveLength(3);
  expect(exportReads.map(({ resultId }) => resultId)).toEqual(Array(3).fill(firstResult));
  await page.evaluate((key) => {
    (Reflect.get(window, key) as ReadProbe).releaseBackgroundChart?.();
  }, probeKey);
  await expect(card(page)).toHaveAttribute("data-result-id", secondResult!);
  await expect(card(page)).toHaveAttribute("data-state", "ready");
});

test("Phase 24 image export T-P24-022/024/025 keeps SVG point and zoom choices independent", async ({
  page,
}, info) => {
  await setup(page);
  await card(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  const resultId = await card(page).getAttribute("data-result-id");
  expect(resultId).toBeTruthy();
  const initialReads = (await readProbe(page)).length;
  for (const scenario of [
    { view: "Current zoom", points: "Displayed points", bands: 3, count: 4 * repetitions },
    { view: "Entire chart", points: "Displayed points", bands: 5, count: 6 * repetitions },
    { view: "Current zoom", points: "All valid points", bands: 3, count: 4 * repetitions },
    { view: "Entire chart", points: "All valid points", bands: 5, count: 6 * repetitions },
  ] as const) {
    const dialog = await chooseSvg(page, scenario.view, scenario.points);
    if (scenario.view === "Current zoom" && scenario.points === "All valid points") {
      await capture(page, dialog, "chart-image-svg-settings", info);
    }
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Save SVG", exact: true }).click();
    const svg = await downloaded(await download, ".svg");
    const evidence = await svgEvidence(page, svg.toString("utf8"));
    const isDisplayed = scenario.points === "Displayed points";
    expect(evidence).toMatchObject({
      root: "svg",
      heading: chartTitle,
      nonVectorOrActive: 0,
      displayed: isDisplayed ? scenario.count : 0,
      all: isDisplayed ? null : scenario.count,
    });
    expect(evidence.viewBox).toMatch(/^0 0 \d+ \d+$/);
    expect(evidence.text).toContain("Coordinate X");
    expect(evidence.text).toContain("Coordinate Y");
    expect(evidence.paths).toBeGreaterThan(0);
    const rendered = await imageEvidence(page, {
      type: "image/svg+xml",
      base64: svg.toString("base64"),
    });
    expect(rendered.markerBands).toBe(scenario.bands);
    if (isDisplayed) expect(await readProbe(page)).toHaveLength(initialReads);
    await expect(page.getByText("Chart image saved.", { exact: true })).toBeVisible();
  }
  const exportReads = (await readProbe(page)).slice(initialReads);
  expect(exportReads).toHaveLength(2 * Math.ceil(rows.length / 100));
  for (const read of exportReads) {
    expect(read.resultId).toBe(resultId);
    expect([...read.columns].sort()).toEqual(["r0", "r1", "r2"]);
  }

  await page.evaluate((key) => {
    const probe = Reflect.get(window, key) as ReadProbe;
    probe.holdAt = probe.reads.length + 2;
  }, probeKey);
  const cancelledDownloads: string[] = [];
  page.on("download", (item) => {
    cancelledDownloads.push(item.suggestedFilename());
  });
  const dialog = await chooseSvg(page, "Entire chart", "All valid points");
  await dialog.getByRole("button", { name: "Save SVG", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate((key) => Boolean((Reflect.get(window, key) as ReadProbe).release), probeKey),
    )
    .toBe(true);
  const cancel = card(page).getByRole("button", { name: "Cancel export", exact: true });
  await expect(cancel).toBeVisible();
  await expect(card(page).getByText(/100 rows scanned/)).toBeVisible();
  await expect(
    card(page).getByRole("progressbar", { name: "SVG export progress" }),
  ).toHaveAttribute("value", "100");
  await expectInsideViewport(cancel);
  const pending = info.outputPath("chart-image-export-pending.png");
  await page.screenshot({ path: pending });
  await info.attach("Pending SVG export", { path: pending, contentType: "image/png" });
  await cancel.click();
  await page.evaluate((key) => {
    (Reflect.get(window, key) as ReadProbe).release?.();
  }, probeKey);
  await expect(cancel).toBeHidden();
  await expect(
    card(page).getByText("Chart image export cancelled.", { exact: true }),
  ).toBeVisible();
  await expect(trigger(page)).toBeEnabled();
  await expect(card(page).getByRole("button", { name: "Reset zoom", exact: true })).toBeEnabled();
  expect(cancelledDownloads).toEqual([]);
});
