import fs from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

async function openDistinct(page: Page) {
  await page.goto("/?mock=parquet&phase21=1");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(page.getByRole("tab", { name: "typed-row-groups.parquet" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Column values id", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Column values: id", exact: true });
  await expect(dialog.getByText("237 distinct values", { exact: true })).toBeVisible();
  await expect(dialog.locator("tbody tr")).toHaveCount(100);
  return { dialog, trigger };
}

async function saveGeometry(panel: Locator, name: string, info: TestInfo) {
  await expectInsideViewport(panel);
  const geometry = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const footer = element.querySelector("footer")?.getBoundingClientRect();
    const closeSvg = element
      .querySelector('[aria-label="Close column values"] svg')
      ?.getBoundingClientRect();
    const progress = element
      .querySelector('[aria-label="Cache migration progress"]')
      ?.getBoundingClientRect();
    return {
      panel: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        bottom: bounds.bottom,
        right: bounds.right,
      },
      footer: footer && { top: footer.top, bottom: footer.bottom, right: footer.right },
      closeSvg: closeSvg && { width: closeSvg.width, height: closeSvg.height },
      progress: progress && { top: progress.top, bottom: progress.bottom, width: progress.width },
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  if (geometry.closeSvg) {
    expect(geometry.closeSvg.width).toBe(18);
    expect(geometry.closeSvg.height).toBe(18);
  }
  if (geometry.footer) {
    expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
    expect(geometry.footer.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
    if (geometry.progress) {
      expect(geometry.progress.top).toBeGreaterThanOrEqual(geometry.panel.y);
      expect(geometry.progress.bottom).toBeLessThanOrEqual(geometry.footer.top + 1);
      expect(geometry.progress.width).toBeGreaterThan(100);
    }
  }
  const folder = "artifacts/phase-21/ui";
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(
    `${folder}/${name}-${info.project.name}.json`,
    JSON.stringify(geometry, null, 2),
  );
  await panel.screenshot({ path: `${folder}/${name}-${info.project.name}.png` });
}

test("T-P21-006/009/032 distinct exact totals, pagination, sorting and full-result copy", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { dialog, trigger } = await openDistinct(page);
  const nav = dialog.getByRole("navigation", { name: "Distinct values pages" });
  await expect(nav).toContainText("1–100 of 237");
  await expect(dialog.getByText("NULL", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Empty string", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Invalid", { exact: true })).toBeVisible();
  const firstPageRows = await dialog.locator("tbody tr").allTextContents();
  await saveGeometry(dialog, "distinct", info);
  await expectNoHorizontalPageOverflow(page);
  await nav.getByRole("button", { name: "Next", exact: true }).click();
  await expect(nav).toContainText("101–200 of 237");
  const middlePageRows = await dialog.locator("tbody tr").allTextContents();
  expect(middlePageRows).not.toEqual(firstPageRows);
  await saveGeometry(dialog, "distinct-cursor-middle", info);
  await nav.getByRole("button", { name: "Next", exact: true }).click();
  await expect(nav).toContainText("201–237 of 237");
  await expect(dialog.locator("tbody tr")).toHaveCount(37);
  await expect(nav.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  const lastPageRows = await dialog.locator("tbody tr").allTextContents();
  await saveGeometry(dialog, "distinct-cursor-last", info);
  await nav.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(nav).toContainText("101–200 of 237");
  expect(await dialog.locator("tbody tr").allTextContents()).toEqual(middlePageRows);
  await nav.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(nav).toContainText("1–100 of 237");
  expect(await dialog.locator("tbody tr").allTextContents()).toEqual(firstPageRows);
  await expect(nav.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await nav.getByRole("button", { name: "Next", exact: true }).click();
  await expect(nav).toContainText("101–200 of 237");
  await nav.getByRole("button", { name: "Next", exact: true }).click();
  await expect(nav).toContainText("201–237 of 237");
  expect(await dialog.locator("tbody tr").allTextContents()).toEqual(lastPageRows);
  await dialog
    .getByRole("combobox", { name: "Distinct value order" })
    .selectOption("valueDescending");
  await expect(nav).toContainText("1–100 of 237");
  await expect(dialog.locator("tbody tr").first()).toContainText("value-236");
  await dialog.getByRole("button", { name: "Copy values", exact: true }).click();
  const all = [
    "Value",
    ...Array.from({ length: 234 }, (_, i) => `value-${String(236 - i).padStart(3, "0")}`),
    "bad number",
    '""',
    "NULL",
  ].join("\r\n");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(all);
  await expect(dialog.getByText("Copied 237 values.", { exact: true })).toBeVisible();
  const search = dialog.getByRole("textbox", { name: "Search column values" });
  await search.fill("value-23");
  await search.press("Enter");
  await expect(dialog.locator("tbody tr")).toHaveCount(7);
  await expect(dialog.locator(".column-values-summary")).toContainText("7 matching");
  await expect(dialog.locator(".column-values-summary")).toContainText("237 distinct values");
  await dialog.getByRole("button", { name: "Copy values and counts", exact: true }).click();
  const filtered = [
    "Value\tCount",
    ...Array.from({ length: 7 }, (_, i) => `value-${236 - i}\t${2 + i}`),
  ].join("\r\n");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(filtered);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((x) => x.name)
      .find((x) => new URL(x).pathname === "/src/backend.ts")!;
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend,
      original = backend.readColumnValuesPage.bind(backend);
    backend.readColumnValuesPage = async (request) => {
      const result = await original(request);
      if (request.search !== "slow") return result;
      return new Promise((resolve) => {
        Reflect.set(window, "__phase21SlowPageIssued", true);
        Reflect.set(window, "__phase21ReleaseSlowPage", () => resolve(result));
      });
    };
  });
  await search.fill("slow");
  await search.press("Enter");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__phase21SlowPageIssued")))
    .toBe(true);
  await search.fill("value-23");
  await search.press("Enter");
  await expect(dialog.locator("tbody tr")).toHaveCount(7);
  await page.evaluate(async () => {
    (Reflect.get(window, "__phase21ReleaseSlowPage") as () => void)();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(dialog.locator("tbody tr")).toHaveCount(7);
  await expect(dialog.locator(".column-values-summary")).toContainText("7 matching");
  await search.fill("not-present");
  await search.press("Enter");
  await expect(dialog.getByText("No matching values.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy values", exact: true })).toBeDisabled();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("T-P21-002/008 source and filtered scopes stay isolated and calculation cancels", async ({
  page,
}) => {
  const { dialog } = await openDistinct(page);
  await dialog.press("Escape");
  await page.getByRole("button", { name: "Filter id", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter id", exact: true });
  await filter.getByLabel("Filter operator").selectOption("greaterThan");
  await filter.getByRole("textbox", { name: "Value", exact: true }).fill("1");
  await filter.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Data preview" })).not.toHaveAttribute(
    "data-query-id",
    "",
  );
  await page.getByRole("button", { name: "Column values id", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Column values: id", exact: true });
  await expect(panel.getByRole("combobox", { name: "Distinct value scope" })).toHaveValue(
    "filtered",
  );
  await expect(panel.getByText("17 distinct values", { exact: true })).toBeVisible();
  await panel.getByRole("combobox", { name: "Distinct value scope" }).selectOption("source");
  await expect(panel.getByText("237 distinct values", { exact: true })).toBeVisible();
  await panel.press("Escape");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((x) => x.name)
      .find((x) => new URL(x).pathname === "/src/backend.ts")!;
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend;
    const start = backend.startColumnValues.bind(backend),
      cancel = backend.cancelColumnValues.bind(backend);
    backend.startColumnValues = async (request) => ({
      ...(await start(request)),
      state: "running",
      stage: "grouping",
      totalCount: null,
      matchedCount: null,
    });
    backend.getColumnValuesStatus = async (request) => ({
      ...request,
      queryId: null,
      columnId: "id",
      state: "running",
      stage: "grouping",
      totalCount: null,
      matchedCount: null,
      error: null,
    });
    backend.cancelColumnValues = async (request) => {
      Reflect.set(window, "__phase21Cancelled", true);
      return cancel(request);
    };
  });
  await page.getByRole("button", { name: "Column values id", exact: true }).click();
  await panel.getByRole("button", { name: "Cancel calculation", exact: true }).click();
  await expect(panel.getByText("Calculation cancelled.", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__phase21Cancelled")))
    .toBe(true);
  await expect(
    panel.getByRole("button", { name: "Close column values", exact: true }),
  ).toBeFocused();
  await panel.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Application settings", exact: true });
  await expect(
    settings.getByRole("button", { name: "Choose cache location…", exact: true }),
  ).toBeDisabled();
  await expect(settings.getByText(/Close all open files before moving the cache/)).toBeVisible();
});

test("T-P21-013/015/030/032 cache cap validates decimals, persists and shows effective cap", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings", exact: true });
  const overall = dialog.getByRole("spinbutton", {
    name: "Overall managed storage limit",
    exact: true,
  });
  const cache = dialog.getByRole("spinbutton", { name: "CSV cache maximum size", exact: true });
  for (const invalid of ["0.0624999999", "10.0000000001", ""]) {
    await cache.fill(invalid);
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  }
  await overall.fill("0.3");
  await cache.fill("0.5");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Choose cache location…", exact: true }),
  ).toBeDisabled();
  await cache.scrollIntoViewIfNeeded();
  await expect(dialog.getByText(/Effective cache limit:/)).toContainText("307.2 MiB");
  await dialog.getByText(/Effective cache limit:/).scrollIntoViewIfNeeded();
  await saveGeometry(dialog, "storage", info);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const settings = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((x) => x.name)
      .find((x) => new URL(x).pathname === "/src/backend.ts")!;
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    return module.browserMockBackend.getSettings();
  });
  expect(settings.queryTempLimitBytes).toBe(322122547);
  expect(settings.csvCacheLimitBytes).toBe(536870912);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(overall).toHaveValue("0.3");
  await expect(cache).toHaveValue("0.5");
});

test("T-P21-018/024/025 migration preview, cancellation, failure and successful location refresh", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((x) => x.name)
      .find((x) => new URL(x).pathname === "/src/backend.ts")!;
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend;
    const original = backend.startCsvCacheMigration.bind(backend);
    let status: Awaited<ReturnType<typeof backend.startCsvCacheMigration>>;
    backend.startCsvCacheMigration = async (id) => {
      const mode = Reflect.get(window, "__phase21MigrationMode");
      if (mode === "success") return original(id);
      status = {
        operationId: "migration-probe",
        state: mode === "fail" ? "failed" : "running",
        sourcePath: "Browser mock (no persistent cache)",
        targetPath: "D:\\Data Viewer Cache\\data-viewer-csv-cache",
        progress: {
          copiedBytes: 1024,
          totalBytes: 4096,
          copiedEntries: 0,
          totalEntries: 1,
          phase: "copying",
        },
        error:
          mode === "fail"
            ? { code: "Io", message: "Destination is full; original cache retained." }
            : null,
        result: null,
      };
      return status;
    };
    backend.getCsvCacheMigrationStatus = async () => status;
    backend.cancelCsvCacheMigration = async () =>
      (status = {
        ...status,
        state: "cancelled",
        progress: { ...status.progress, phase: "cancelled" },
      });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings", exact: true });
  const choose = dialog.getByRole("button", { name: "Choose cache location…", exact: true });
  await choose.click();
  await expect(dialog.getByRole("region", { name: "Cache migration preview" })).toContainText(
    "D:\\Data Viewer Cache",
  );
  await dialog.getByRole("button", { name: "Cancel location change", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Cache migration preview" })).toHaveCount(0);
  await choose.click();
  await dialog.getByRole("button", { name: "Move cache here", exact: true }).click();
  await expect(
    dialog.getByRole("progressbar", { name: "Cache migration progress" }),
  ).toHaveAttribute("value", "1024");
  await dialog
    .getByRole("button", { name: "Cancel cache move", exact: true })
    .scrollIntoViewIfNeeded();
  await saveGeometry(dialog, "migration", info);
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel cache move", exact: true }).click();
  await expect(dialog.getByText("Cache move cancelled", { exact: true })).toBeVisible();
  await expect(dialog.locator(".storage-path")).toContainText("Browser mock (no persistent cache)");
  await page.evaluate(() => Reflect.set(window, "__phase21MigrationMode", "fail"));
  await choose.click();
  await dialog.getByRole("button", { name: "Move cache here", exact: true }).click();
  await expect(dialog.getByText("Cache move failed", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Destination is full; original cache retained.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".storage-path")).toContainText("Browser mock (no persistent cache)");
  await page.evaluate(() => Reflect.set(window, "__phase21MigrationMode", "success"));
  await choose.click();
  await dialog.getByRole("button", { name: "Move cache here", exact: true }).click();
  await expect(dialog.getByText("Cache moved successfully", { exact: true })).toBeVisible();
  await expect(dialog.locator(".storage-path")).toContainText(
    "D:\\Data Viewer Cache\\data-viewer-csv-cache",
  );
});
