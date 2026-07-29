import { expect, test, type Page } from "@playwright/test";
import { openMockFile } from "./helpers";

type CsvQueryProbe = { executeQuery: number; readQueryPage: number };

async function installCsvQueryProbe(page: Page): Promise<void> {
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
    const probe: CsvQueryProbe = { executeQuery: 0, readQueryPage: 0 };
    Reflect.set(window, "__csvQueryProbe", probe);
    const executeQuery = backend.executeQuery.bind(backend);
    backend.executeQuery = async (request) => {
      probe.executeQuery += 1;
      return executeQuery(request);
    };
    const readQueryPage = backend.readQueryPage.bind(backend);
    backend.readQueryPage = async (request) => {
      probe.readQueryPage += 1;
      return readQueryPage(request);
    };
  });
}

async function csvQueryProbe(page: Page): Promise<CsvQueryProbe> {
  return page.evaluate(() =>
    structuredClone(Reflect.get(window, "__csvQueryProbe") as CsvQueryProbe),
  );
}

test("shows byte progress for cold CSV preparation and removes it at Ready", async ({
  page,
}, testInfo) => {
  const artifactName = {
    "desktop-compact": "compact",
    "desktop-minimum": "minimum",
    "desktop-wide": "wide",
  }[testInfo.project.name];
  if (!artifactName) throw new Error(`Unexpected Playwright project: ${testInfo.project.name}`);
  await page.goto("/");
  await openMockFile(page, "csv-progress", "quoted-multiline.csv");
  const progress = page.getByRole("progressbar", { name: "CSV preparation progress" });
  const preparationCard = page.locator(".csv-preparation");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("max", "8192");
  const initialValue = Number(await progress.getAttribute("value"));
  expect(initialValue).toBeGreaterThan(0);
  const geometry = await progress.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.width).toBeGreaterThan(200);
  expect(geometry.height).toBeGreaterThanOrEqual(5);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  const cardHitTarget = await preparationCard.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 2);
    return {
      cardContainsTarget: topmost !== null && element.contains(topmost),
      targetClass: topmost?.getAttribute("class") ?? null,
      targetTag: topmost?.tagName ?? null,
    };
  });
  expect(cardHitTarget.cardContainsTarget, JSON.stringify(cardHitTarget)).toBe(true);
  const progressScreenshot = await page.screenshot({
    path: `artifacts/phase-15/ui/csv-progress-${artifactName}.png`,
  });
  await testInfo.attach(`csv-cold-progress-${testInfo.project.name}`, {
    body: progressScreenshot,
    contentType: "image/png",
  });
  await expect
    .poll(async () => Number(await progress.getAttribute("value")))
    .toBeGreaterThan(initialValue);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("csvReady", "1");
    window.history.replaceState(null, "", url);
  });
  await expect(progress).toHaveCount(0, { timeout: 2_500 });
});

test("blocks filter work while cold CSV preparation is running and enables it at Ready", async ({
  page,
}) => {
  await page.goto("/");
  await openMockFile(page, "csv-progress", "quoted-multiline.csv");
  await installCsvQueryProbe(page);
  const progress = page.getByRole("progressbar", { name: "CSV preparation progress" });
  const blocker = page.getByTestId("csv-preparation-blocker");
  const surface = page.getByTestId("csv-data-interaction-surface");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await expect(progress).toBeVisible();
  await expect(blocker).toBeVisible();
  await expect(surface).toHaveAttribute("inert", "");

  const activeRow = await grid.getAttribute("data-active-row");
  await page.evaluate(() => {
    const filter = document.querySelector<HTMLButtonElement>('[aria-label="Filter name"]');
    const dataGrid = document.querySelector<HTMLElement>(
      '[role="grid"][aria-label="Data preview"]',
    );
    filter?.click();
    dataGrid?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true }),
    );
  });
  await expect(page.getByRole("dialog", { name: "Filter name" })).toHaveCount(0);
  await expect(grid).toHaveAttribute("data-active-row", activeRow ?? "0");
  await expect(progress).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("gridcell", { name: "Kim, Mina", exact: true })).toBeVisible();
  expect((await csvQueryProbe(page)).executeQuery).toBe(0);
  await expect(grid).toHaveAttribute("data-query-id", "");

  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("csvReady", "1");
    window.history.replaceState(null, "", url);
  });
  await expect(progress).toHaveCount(0, { timeout: 2_500 });
  await expect(blocker).toHaveCount(0);
  await expect(surface).not.toHaveAttribute("inert", "");

  await page.getByRole("button", { name: "Filter name", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Filter name" });
  await expect(popover).toBeVisible();
  await popover.getByRole("textbox", { name: "Value", exact: true }).fill("Kim, Mina");
  await popover.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Active filters")).toContainText("name contains Kim, Mina");
  await expect.poll(async () => (await csvQueryProbe(page)).readQueryPage).toBeGreaterThan(0);
  await expect(grid).toHaveAttribute("data-query-id", /frontend-query-/);
  await expect(page.getByLabel("Active filters")).toContainText("name contains Kim, Mina");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await csvQueryProbe(page)).executeQuery).toBe(1);
});

test("opens multiple browserMock documents and retains independent view tabs", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No file open" })).toBeVisible();
  await expect(page.getByText("No files open")).toBeVisible();

  await openMockFile(page, "csv", "quoted-multiline.csv");
  await expect(page.getByText("Kim, Mina")).toBeVisible();
  await page.getByRole("tab", { name: "Metadata" }).click();
  await expect(page.getByRole("heading", { name: "CSV parsing" })).toBeVisible();

  await openMockFile(page, "parquet", "typed-row-groups.parquet");
  await expect(page.getByRole("tab", { name: "typed-row-groups.parquet" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Schema" }).click();
  await expect(page.getByRole("table", { name: "File schema" })).toBeVisible();

  await page.getByRole("tab", { name: "quoted-multiline.csv" }).click();
  await expect(page.getByRole("tab", { name: "Metadata" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "CSV parsing" })).toBeVisible();
});

test("changes copy presets without copying and saves the major custom copy controls", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await openMockFile(page, "parquet", "typed-row-groups.parquet");
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));

  await page.getByRole("button", { name: "Copy options" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Excel" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("menuitemradio", { name: "CSV" }).click();
  await expect(page.getByRole("button", { name: "Copy selection" })).toContainText("Copy (CSV)");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("unchanged");

  await page.getByRole("button", { name: "Copy options" }).click();
  await page.getByRole("menuitem", { name: "Copy settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Custom" }).click();
  await dialog.getByLabel("Delimiter").selectOption("semicolon");
  await dialog.getByRole("checkbox", { name: "Include column headers" }).check();
  await dialog.getByLabel("Quote mode").selectOption("always");
  await dialog.getByLabel("Quote character").fill("'");
  await dialog.getByLabel("Escape").selectOption("backslash");
  await dialog.getByRole("button", { name: "LF", exact: true }).click();
  await dialog.getByLabel("Null representation").fill("NULL");
  await dialog.getByLabel("Empty string representation").selectOption("quoted-empty");
  await dialog.getByLabel("Boolean representation").selectOption("numeric");
  await dialog.getByLabel("Date and timestamp representation").selectOption("custom");
  await dialog.getByLabel("Date and timestamp format").fill("YYYY/MM/DD HH:mm:ss");
  await expect(dialog.getByLabel("Copy preview")).toContainText(";");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy selection" })).toContainText("Copy (CUSTOM)");
});

test("runs explicit find, cycles sort, and applies a column filter popover", async ({ page }) => {
  await page.goto("/");
  await openMockFile(page, "parquet", "typed-row-groups.parquet");

  await page.keyboard.press("Control+f");
  const search = page.getByRole("searchbox", { name: "Find data" });
  await expect(search).toBeFocused();
  await search.fill("9007199254740993");
  await expect(page.getByText(/2 matches/)).toHaveCount(0);
  await search.press("Enter");
  await expect(page.getByText(/2 matches/)).toBeVisible();
  await page.getByRole("button", { name: "Next match" }).click();
  await page.getByRole("button", { name: "Previous match" }).click();
  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toHaveCount(0);

  const filterButton = page.getByRole("button", { name: "Filter id", exact: true });
  await filterButton.click();
  const popover = page.getByRole("dialog", { name: "Filter id" });
  await expect(popover).toBeVisible();
  await popover.getByLabel("Filter operator").selectOption("greaterThan");
  await popover.getByRole("textbox", { name: "Value", exact: true }).fill("9007199254740993");
  await popover.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Active filters")).toContainText("id > 9007199254740993");
  await expect(async () => {
    await filterButton.click();
    await expect(popover).toBeVisible({ timeout: 1_000 });
    await popover.press("Escape", { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(popover).toHaveCount(0);
  await expect(filterButton).toBeFocused();
  await page.getByRole("button", { name: "Remove filter id" }).click();
  await expect(page.getByLabel("Active filters")).not.toContainText("9007199254740993");

  const sort = page.getByRole("button", { name: "Sort id: not sorted" });
  await sort.click();
  await expect(page.getByRole("button", { name: /Sort id: ascending/ })).toBeVisible();
  await page.getByRole("button", { name: /Sort id: ascending/ }).click();
  await expect(page.getByRole("button", { name: /Sort id: descending/ })).toBeVisible();
  await page.getByRole("button", { name: /Sort id: descending/ }).click();
  await expect(sort).toBeVisible();
});

test("validates application settings and storage controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Total app-managed storage:/)).toContainText("0 B");
  await expect(dialog.getByRole("heading", { name: "Query temporary data" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Reusable CSV cache" })).toBeVisible();
  await expect(dialog.getByText("Browser mock (no persistent cache)")).toBeVisible();
  await expect(dialog.getByText(/20\.00 GiB available on disk/)).toBeVisible();

  const limit = dialog.getByRole("spinbutton", { name: "Query temporary storage limit" });
  const copyCells = dialog.getByRole("spinbutton", { name: "Maximum cells" });
  const copyMiB = dialog.getByRole("spinbutton", { name: "Maximum clipboard size" });
  await expect(copyCells).toHaveValue("1000000");
  await expect(copyMiB).toHaveValue("64");
  await copyCells.fill("999");
  await copyMiB.fill("257");
  await expect(dialog.getByText("Enter an integer from 1,000 to 10,000,000 cells.")).toHaveRole(
    "alert",
  );
  await expect(dialog.getByText("Enter an integer from 1 to 256 MiB.")).toHaveRole("alert");
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await copyCells.fill("1000");
  await copyMiB.fill("256");
  await limit.fill("0.01");
  await expect(dialog.getByRole("alert")).toContainText("64 MiB");
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await limit.fill("0.125");
  await dialog.getByRole("button", { name: "Clear inactive query data" }).click();
  await expect(dialog.getByText(/Inactive query data cleared/)).toBeVisible();
  await dialog.getByRole("button", { name: "Clear inactive CSV cache" }).click();
  await expect(dialog.getByText("Clear inactive CSV cache?")).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm clear inactive CSV cache" }).click();
  await expect(dialog.getByText(/CSV cache clear finished/)).toContainText(
    "Source CSV files were not changed",
  );
  await dialog.getByRole("button", { name: "All Text" }).click();
  await expect(dialog.getByText(/Keep every column as text/)).toBeVisible();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "Application settings" }).getByRole("button", {
      name: "All Text",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("dialog", { name: "Application settings" })
      .getByRole("spinbutton", { name: "Maximum cells" }),
  ).toHaveValue("1000");
  await expect(
    page
      .getByRole("dialog", { name: "Application settings" })
      .getByRole("spinbutton", { name: "Maximum clipboard size" }),
  ).toHaveValue("256");
  await dialog.press("Escape");

  await openMockFile(page, "oes", "spectrometer.oes.h5");
  const grid = page.getByRole("grid", { name: "Data preview" });
  await grid.press("Control+A");
  await page.getByRole("button", { name: "Copy selection" }).click();
  await expect(page.locator(".copy-status")).toContainText(
    "failed during preparing (selectionLimit): The selection exceeds the configured 1000-cell copy limit.",
  );
});
