import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow, openMockFile } from "./helpers";

interface Phase14Probe {
  executeQuery: number;
  readPage: number;
}

function viewportName(projectName: string): "wide" | "compact" | "minimum" {
  if (projectName.includes("minimum")) return "minimum";
  if (projectName.includes("compact")) return "compact";
  return "wide";
}

function firstOf(...locators: Locator[]): Locator {
  if (locators.length === 0) throw new Error("firstOf requires a locator");
  return locators
    .slice(1)
    .reduce((combined, locator) => combined.or(locator), locators[0])
    .first();
}

async function installProbe(page: Page): Promise<void> {
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
    const state: Phase14Probe = { executeQuery: 0, readPage: 0 };
    Reflect.set(window, "__phase14Probe", state);
    const executeQuery = backend.executeQuery.bind(backend);
    backend.executeQuery = async (request) => {
      state.executeQuery += 1;
      return executeQuery(request);
    };
    const readPage = backend.readPage.bind(backend);
    backend.readPage = async (request) => {
      state.readPage += 1;
      return readPage(request);
    };
  });
}

async function probe(page: Page): Promise<Phase14Probe> {
  return page.evaluate(() => Reflect.get(window, "__phase14Probe") as Phase14Probe);
}

async function capture(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await mkdir("artifacts/phase-14/ui", { recursive: true });
  const path = `artifacts/phase-14/ui/${name}-${viewportName(testInfo.project.name)}.png`;
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function saveGeometry(
  testInfo: TestInfo,
  name: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir("artifacts/phase-14/ui", { recursive: true });
  await writeFile(
    `artifacts/phase-14/ui/geometry-${name}-${viewportName(testInfo.project.name)}.json`,
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

function sortColumnControl(panel: Locator, priority: number): Locator {
  return firstOf(
    panel.getByRole("combobox", {
      name: new RegExp(
        `(?:Column.*priority ${priority}|Choose a column|Sort column ${priority})`,
        "i",
      ),
    }),
    panel
      .locator(".query-sort-editor__row")
      .nth(priority - 1)
      .getByRole("combobox")
      .first(),
  );
}

async function chooseColumn(panel: Locator, control: Locator, columnId: string): Promise<void> {
  const tagName = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tagName === "select") {
    await control.selectOption(columnId);
    return;
  }
  await control.click();
  const search = firstOf(
    panel.getByRole("searchbox", { name: /Search columns/i }),
    panel.getByPlaceholder(/Search columns/i),
    control,
  );
  if (await search.isEditable()) await search.fill(columnId);
  await panel.getByRole("option", { name: new RegExp(`^${columnId}(?:\\s|$)`, "i") }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await installProbe(page);
});

test("blank-first multi-sort keeps incomplete rows as UI draft", async ({ page }, testInfo) => {
  await openMockFile(page, "large", "large-5850000.parquet");
  await page.getByRole("button", { name: "Choose columns" }).click();
  const chooser = page.getByRole("dialog", { name: "Column chooser" });
  await chooser.getByRole("button", { name: "group_id", exact: true }).click();
  await chooser.getByRole("button", { name: "Close column chooser" }).click();

  await page.getByRole("button", { name: "Sorts (0)" }).click();
  const panel = page.getByRole("dialog", { name: "Multi-column sort" });
  const addLevel = panel.getByRole("button", { name: /^(?:Add level|Add sort level)$/i });
  await expect(addLevel).toBeEnabled();
  await addLevel.click();

  const rows = panel.locator(".query-sort-editor__row");
  await expect(rows).toHaveCount(1);
  const column = sortColumnControl(panel, 1);
  await expect(column).toBeFocused();
  await expect(column).toHaveValue("");
  const apply = panel.getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeDisabled();
  expect((await probe(page)).executeQuery).toBe(0);

  const direction = firstOf(
    panel.getByRole("combobox", { name: /Direction.*(?:priority 1|empty|sort)/i }),
    rows.nth(0).getByRole("combobox").nth(1),
  );
  await expect(direction).toHaveValue("ascending");
  await direction.selectOption("descending");
  await expect(column).toHaveValue("");

  const hiddenOption = panel.getByRole("option", { name: /group_id.*Hidden/i });
  await expect(hiddenOption).toHaveCount(1);
  await chooseColumn(panel, column, "group_id");
  await expect(apply).toBeEnabled();
  expect((await probe(page)).executeQuery).toBe(0);
  await capture(page, "multi-sort", testInfo);
  await apply.click();
  await expect.poll(async () => (await probe(page)).executeQuery).toBe(1);
  await expect(page.getByRole("button", { name: "Sorts (1)" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("display formats expose primary controls and one inline detail accordion", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings" });
  const title = dialog.getByRole("heading", { name: "Settings", exact: true });
  const section = dialog.getByRole("heading", { name: "Value display formats" });
  await expect(title).toBeVisible();
  await expect(section).toBeVisible();
  for (const name of [
    "Integer grouping",
    "Floating notation",
    "Date display format",
    "Timestamp preset",
    "Duration preset",
    "Boolean display format",
    "Binary display encoding",
  ]) {
    await expect(dialog.getByRole("combobox", { name })).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: /All formats/i })).toHaveCount(0);
  await capture(page, "settings-inline", testInfo);

  const timestampToggle = dialog.getByRole("button", { name: /(?:Show|Hide) Timestamp details/i });
  const durationToggle = dialog.getByRole("button", { name: /(?:Show|Hide) Duration details/i });
  await timestampToggle.click();
  await expect(timestampToggle).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByLabel("Timestamp details", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Timestamp date format" })).toBeVisible();
  await durationToggle.click();
  await expect(timestampToggle).toHaveAttribute("aria-expanded", "false");
  await expect(durationToggle).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByLabel("Timestamp details", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Duration details", { exact: true })).toBeVisible();

  const typography = await dialog.evaluate((element) => {
    const titleElement = element.querySelector("h2");
    const sectionElement = Array.from(element.querySelectorAll("h3")).find(
      (heading) => heading.textContent?.trim() === "Value display formats",
    );
    const typeElement = element.querySelector(".display-format-row strong");
    const previewElement = element.querySelector(".display-format-row output");
    if (!titleElement || !sectionElement || !typeElement || !previewElement)
      throw new Error("Display format typography elements are missing.");
    return {
      title: getComputedStyle(titleElement).fontSize,
      section: getComputedStyle(sectionElement).fontSize,
      type: getComputedStyle(typeElement).fontSize,
      preview: getComputedStyle(previewElement).fontSize,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    };
  });
  expect(typography.title).toBe("16px");
  expect(typography.section).toBe("13px");
  expect(typography.type).toBe("12px");
  expect(typography.preview).toBe("11px");
  expect(typography.bodyScrollWidth).toBeLessThanOrEqual(typography.bodyClientWidth + 1);
  await expectInsideViewport(dialog);
  await capture(page, "settings-accordion", testInfo);
  await saveGeometry(testInfo, "settings", { typography });
});

test("column drag floats mounted cells, live-reflows peers, and restores source order", async ({
  page,
}, testInfo) => {
  await openMockFile(page, "large", "large-5850000.parquet");
  const grid = page.getByRole("grid", { name: "Data preview" });
  const rowId = grid.getByRole("columnheader", { name: "row_id", exact: true });
  const category = grid.getByRole("columnheader", { name: "category", exact: true });
  const before = await Promise.all([rowId.boundingBox(), category.boundingBox()]);
  if (!before[0] || !before[1]) throw new Error("Column headers have no geometry.");
  const readsBefore = (await probe(page)).readPage;

  const startX = before[1].x + before[1].width / 2;
  const startY = before[1].y + before[1].height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY);
  await page.mouse.move(before[0].x + 2, before[0].y + before[0].height / 2, { steps: 8 });

  const floating = firstOf(
    page.getByTestId("column-drag-overlay"),
    page.locator(".virtual-grid__column-drag-overlay"),
    page.locator(".virtual-grid__floating-column"),
    page.locator(".virtual-grid__drag-column-strip"),
    page.locator('[data-column-drag-overlay="true"]'),
  );
  await expect(floating).toBeVisible();
  await expect(floating).toHaveAttribute("aria-hidden", "true");
  expect(await floating.locator(".virtual-grid__cell").count()).toBeGreaterThan(0);
  await expect(page.locator(".virtual-grid__column-header.is-insert-before")).toHaveCount(0);
  await expect(page.locator(".virtual-grid__column-header.is-insert-after")).toHaveCount(0);

  const duringRowId = await rowId.boundingBox();
  if (!duringRowId) throw new Error("Reflowed row_id header has no geometry.");
  expect(Math.abs(duringRowId.x - (before[0].x + before[1].width))).toBeLessThanOrEqual(1);
  expect((await probe(page)).readPage).toBe(readsBefore);
  await capture(page, "column-live-drag", testInfo);
  await page.mouse.up();

  const orderAfterDrop = await grid
    .locator('.virtual-grid__column-header[role="columnheader"]')
    .evaluateAll((headers) =>
      headers.slice(0, 3).map((header) => header.getAttribute("aria-label")),
    );
  expect(orderAfterDrop).toEqual(["category", "row_id", "label"]);
  const restore = page.getByRole("button", { name: "Restore source column order" });
  await expect(restore).toBeEnabled();
  await restore.click();
  const restored = await grid
    .locator('.virtual-grid__column-header[role="columnheader"]')
    .evaluateAll((headers) =>
      headers.slice(0, 3).map((header) => header.getAttribute("aria-label")),
    );
  expect(restored).toEqual(["row_id", "category", "label"]);
  await expect(restore).toBeDisabled();
  const restoredCategory = await category.boundingBox();
  if (!restoredCategory) throw new Error("Restored category header has no geometry.");
  expect(Math.abs(restoredCategory.width - before[1].width)).toBeLessThanOrEqual(1);
  await capture(page, "column-source-order", testInfo);
  await saveGeometry(testInfo, "column-drag", {
    source: { rowId: before[0], category: before[1] },
    preview: { rowId: duringRowId },
    restored: { category: restoredCategory },
    pageReadsDuringDrag: (await probe(page)).readPage - readsBefore,
  });
  await expectNoHorizontalPageOverflow(page);
});

test("source order restore is document-local and preserves hidden columns", async ({ page }) => {
  await openMockFile(page, "large", "large-5850000.parquet");
  await openMockFile(page, "parquet", "typed-row-groups.parquet");
  await page.getByRole("tab", { name: "large-5850000.parquet" }).click();
  await page.getByRole("button", { name: "Choose columns" }).click();
  const chooser = page.getByRole("dialog", { name: "Column chooser" });
  await chooser.getByRole("button", { name: "group_id", exact: true }).click();
  await chooser.getByRole("button", { name: "Close column chooser" }).click();

  const grid = page.getByRole("grid", { name: "Data preview" });
  const rowId = grid.getByRole("columnheader", { name: "row_id", exact: true });
  const category = grid.getByRole("columnheader", { name: "category", exact: true });
  const rowBox = await rowId.boundingBox();
  const categoryBox = await category.boundingBox();
  if (!rowBox || !categoryBox) throw new Error("Column headers have no geometry.");
  await page.mouse.move(categoryBox.x + categoryBox.width / 2, categoryBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(categoryBox.x + categoryBox.width / 2 + 10, categoryBox.y + 10);
  await page.mouse.move(rowBox.x + 2, rowBox.y + 10, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Restore source column order" }).click();
  await expect(grid.getByRole("columnheader", { name: "group_id", exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "typed-row-groups.parquet" }).click();
  await expect(page.getByRole("button", { name: "Restore source column order" })).toBeDisabled();
  await page.getByRole("tab", { name: "large-5850000.parquet" }).click();
  await expect(grid.getByRole("columnheader", { name: "group_id", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore source column order" })).toBeDisabled();
});
