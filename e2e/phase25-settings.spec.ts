import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "../src/settings/model";
import { DEFAULT_DISPLAY_FORMATS } from "../src/settings/model";
import type { StorageFolderKind, StorageLocations } from "../src/settings/storageFolders";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";
import { selectSettingsCategory, type SettingsCategory } from "./settingsHelpers";

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Application settings", exact: true });
const apply = (settings: Locator) => settings.getByRole("button", { name: "Apply", exact: true });
const cacheRegion = (settings: Locator) =>
  settings.getByRole("region", { name: "Reusable CSV cache", exact: true });
const queryRegion = (settings: Locator) =>
  settings.getByRole("region", { name: "Query temporary data", exact: true });
const categories: SettingsCategory[] = ["CSV", "SQL", "Copy", "Display", "Storage"];

interface Probe {
  locations: StorageLocations;
  opens: unknown[][];
  saved: AppSettings[];
  getLocations: number;
  failOpen?: StorageFolderKind;
}

async function setup(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((entry) => new URL(entry).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend did not load");
    const { browserMockBackend: backend } = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const folders = backend.storageFolders;
    if (!folders) throw new Error("Managed-folder browser backend is unavailable");
    const probe: Probe = {
      locations: {
        csvCache: {
          path: "D:\\Data Viewer Cache\\한글 & sample\\data-viewer-csv-cache",
          available: true,
        },
        queryTemp: {
          path: "C:\\Users\\Test User\\AppData\\Local\\Data Viewer\\query-temp",
          available: true,
        },
      },
      opens: [],
      saved: [],
      getLocations: 0,
    };
    Reflect.set(window, "__p25Settings", probe);
    folders.getLocations = async () => {
      probe.getLocations++;
      return structuredClone(probe.locations);
    };
    folders.openFolder = async (...args) => {
      probe.opens.push(structuredClone(args));
      if (probe.failOpen === args[0])
        throw new Error("Explorer could not open this managed folder.");
    };
    const save = backend.updateSettings.bind(backend);
    backend.updateSettings = async (settings) => {
      probe.saved.push(structuredClone(settings));
      return save(settings);
    };
  });
}

async function probe(page: Page) {
  return page.evaluate(() => structuredClone(Reflect.get(window, "__p25Settings") as Probe));
}

async function savedSettings(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((entry) => new URL(entry).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend did not load");
    const { browserMockBackend } = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    return browserMockBackend.getSettings();
  });
}

async function open(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = dialog(page);
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("tab", { name: "CSV", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return settings;
}

async function capture(page: Page, info: TestInfo, name: string) {
  const settings = dialog(page);
  await expectInsideViewport(settings);
  await expectNoHorizontalPageOverflow(page);
  const controls = [
    settings.getByRole("tablist", { name: "Settings categories", exact: true }),
    settings.locator(".settings-dialog__content"),
    apply(settings),
    settings.getByRole("button", { name: "Cancel", exact: true }),
  ];
  const geometry = await Promise.all(
    controls.map(async (control) => {
      await expectInsideViewport(control);
      return control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ??
            element.getAttribute("role") ??
            element.textContent?.trim(),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
    }),
  );
  expect(geometry.every((entry) => entry.width > 0 && entry.height > 0)).toBe(true);
  const panel = settings.getByRole("tabpanel");
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  for (const control of [
    apply(settings),
    settings.getByRole("button", { name: "Cancel", exact: true }),
  ]) {
    expect(
      await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit === element || (hit !== null && element.contains(hit));
      }),
    ).toBe(true);
  }
  const directory = path.resolve(".tmp/phase-25/settings/ui");
  await mkdir(directory, { recursive: true });
  const screenshot = path.join(directory, `${info.project.name}-${name}.png`);
  await page.screenshot({ path: screenshot });
  await writeFile(
    path.join(directory, `${info.project.name}-${name}.json`),
    JSON.stringify({ viewport: page.viewportSize(), geometry }, null, 2),
  );
  await info.attach(name, { path: screenshot, contentType: "image/png" });
}

async function editDraft(settings: Locator) {
  await selectSettingsCategory(settings, "CSV");
  await settings.getByRole("button", { name: "All Text", exact: true }).click();
  await selectSettingsCategory(settings, "SQL");
  await settings
    .getByRole("combobox", { name: "SQL suggestion mode", exact: true })
    .selectOption("manual");
  await selectSettingsCategory(settings, "Copy");
  await settings.getByRole("spinbutton", { name: "Maximum cells", exact: true }).fill("2000");
  await settings.getByRole("spinbutton", { name: "Maximum clipboard size", exact: true }).fill("2");
  await selectSettingsCategory(settings, "Display");
  await settings
    .getByRole("combobox", { name: "Integer grouping", exact: true })
    .selectOption("comma");
  await selectSettingsCategory(settings, "Storage");
  await settings
    .getByRole("spinbutton", { name: "Overall managed storage limit", exact: true })
    .fill("0.3");
  await settings
    .getByRole("spinbutton", { name: "SQL temporary storage per query (GiB)", exact: true })
    .fill("1");
}

test("Phase 25 Settings T-P25-S01/02/03 preserves a global draft and hidden validation", async ({
  page,
}, info) => {
  await setup(page);
  const baseline = await savedSettings(page);
  const settings = await open(page);
  const nav = settings.getByRole("tablist", { name: "Settings categories", exact: true });
  await expect(nav).toHaveAttribute("aria-orientation", "vertical");
  await expect(nav.getByRole("tab")).toHaveText(categories);
  await nav.getByRole("tab", { name: "CSV", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("tab", { name: "SQL", exact: true })).toBeFocused();
  await expect(settings.getByRole("tabpanel", { name: "SQL", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(nav.getByRole("tab", { name: "Storage", exact: true })).toBeFocused();
  await editDraft(settings);
  await selectSettingsCategory(settings, "Copy");
  const cells = settings.getByRole("spinbutton", { name: "Maximum cells", exact: true });
  await cells.fill("999");
  await expect(apply(settings)).toBeDisabled();
  await selectSettingsCategory(settings, "SQL");
  await expect(apply(settings)).toBeDisabled();
  await selectSettingsCategory(settings, "Copy");
  await expect(cells).toHaveValue("999");
  await expect(
    settings.getByText("Enter an integer from 1,000 to 10,000,000 cells.", { exact: true }),
  ).toBeVisible();
  await cells.fill("2000");
  await expect(apply(settings)).toBeEnabled();
  await capture(page, info, "cross-category-draft");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await savedSettings(page)).toEqual(baseline);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await open(page);
  await expect(settings.getByRole("button", { name: "Auto", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await editDraft(settings);
  await apply(settings).click();
  await expect(settings).toHaveCount(0);
  const committed = await savedSettings(page);
  expect(committed).toMatchObject({
    csvDefaultParsingMode: "allText",
    sqlCompletionMode: "manual",
    queryTempLimitBytes: 322122547,
    sqlTempLimitBytes: 1073741824,
    copyLimits: { maxCells: 2000, maxBytes: 2097152 },
    displayFormats: { integer: { grouping: "comma" } },
  });
  expect((await probe(page)).saved).toHaveLength(1);
  await open(page);
  await selectSettingsCategory(settings, "Copy");
  await expect(cells).toHaveValue("2000");
  await selectSettingsCategory(settings, "SQL");
  await expect(
    settings.getByRole("combobox", { name: "SQL suggestion mode", exact: true }),
  ).toHaveValue("manual");
  await settings.press("Escape");
  await expect(settings).toHaveCount(0);
});

test("Phase 25 Settings T-P25-S04/05/11 uses readable typography and all display previews", async ({
  page,
}, info) => {
  await setup(page);
  const baseline = await savedSettings(page);
  const settings = await open(page);
  await capture(page, info, "csv-default");
  const title = settings.getByRole("heading", { name: "Settings", exact: true });
  expect(await title.evaluate((element) => getComputedStyle(element).fontSize)).toBe("18px");
  const appFamily = await page
    .locator(".app-shell")
    .evaluate((element) => getComputedStyle(element).fontFamily);
  for (const control of await settings
    .locator(".settings-categories button, .settings-dialog__actions button")
    .all()) {
    const typography = await control.evaluate((element) => ({
      size: getComputedStyle(element).fontSize,
      family: getComputedStyle(element).fontFamily,
    }));
    expect(typography.size).toBe("13px");
    expect(typography.family).toBe(appFamily);
  }
  for (const category of categories) {
    const panel = await selectSettingsCategory(settings, category);
    const heading = panel.locator("h3").first();
    const metrics = await heading.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(element);
      const textBox = text.getBoundingClientRect();
      return {
        size: getComputedStyle(element).fontSize,
        family: getComputedStyle(element).fontFamily,
        top: box.top,
        bottom: box.bottom,
        textTop: textBox.top,
        textBottom: textBox.bottom,
      };
    });
    expect(metrics.size).toBe("14px");
    expect(metrics.family).toBe(appFamily);
    expect(metrics.textTop).toBeGreaterThanOrEqual(metrics.top - 1);
    expect(metrics.textBottom).toBeLessThanOrEqual(metrics.bottom + 1);
    const controls = panel.locator("input:visible,select:visible,button:visible");
    for (const control of await controls.all()) {
      const typography = await control.evaluate((element) => ({
        size: getComputedStyle(element).fontSize,
        family: getComputedStyle(element).fontFamily,
      }));
      expect(typography.size).toBe("13px");
      expect(typography.family).toBe(appFamily);
    }
    const description = panel.locator(".settings-section__heading p").first();
    expect(await description.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
      "12px",
    );
    if (category === "SQL") await capture(page, info, "sql-heading");
  }
  await selectSettingsCategory(settings, "CSV");
  await settings.getByRole("button", { name: "All Text", exact: true }).click();
  await selectSettingsCategory(settings, "Display");
  await expect(settings.locator("[data-format-type]")).toHaveCount(8);
  for (const type of [
    "string",
    "integer",
    "decimal",
    "date",
    "timestamp",
    "duration",
    "boolean",
    "binary",
  ]) {
    const output = settings.locator(`[data-format-type="${type}"] output`);
    await output.scrollIntoViewIfNeeded();
    await expect(output).not.toHaveText("");
    const metrics = await output.evaluate((element) => ({
      size: getComputedStyle(element).fontSize,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(metrics.size).toBe("13px");
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
  }
  await settings
    .getByRole("heading", { name: "Value display formats", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, info, "display-summary");
  await settings
    .getByRole("combobox", { name: "Integer grouping", exact: true })
    .selectOption("comma");
  await settings.getByRole("button", { name: "Show Timestamp details", exact: true }).click();
  await expect(settings.getByLabel("Timestamp details", { exact: true })).toBeVisible();
  await capture(page, info, "display-details");
  await settings.getByRole("button", { name: "Reset display formats", exact: true }).click();
  await expect(
    settings.getByRole("combobox", { name: "Integer grouping", exact: true }),
  ).toHaveValue("none");
  expect(await savedSettings(page)).toEqual(baseline);
  await selectSettingsCategory(settings, "CSV");
  await expect(settings.getByRole("button", { name: "All Text", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await apply(settings).click();
  expect((await savedSettings(page)).displayFormats).toEqual(DEFAULT_DISPLAY_FORMATS);
  expect((await savedSettings(page)).csvDefaultParsingMode).toBe("allText");
});

test("Phase 25 Settings T-P25-S06/08/09 opens only the chosen current managed-folder kind", async ({
  page,
}, info) => {
  await setup(page);
  const baseline = await savedSettings(page);
  const settings = await open(page);
  await selectSettingsCategory(settings, "Storage");
  const initial = await probe(page);
  await expect(cacheRegion(settings)).toContainText(initial.locations.csvCache.path);
  await expect(queryRegion(settings)).toContainText(initial.locations.queryTemp.path);
  await expect(
    cacheRegion(settings).getByRole("button", { name: "Open folder", exact: true }),
  ).toBeEnabled();
  await expect(
    queryRegion(settings).getByRole("button", { name: "Open folder", exact: true }),
  ).toBeEnabled();
  expect(initial.opens).toEqual([]);
  await capture(page, info, "storage-paths");
  await cacheRegion(settings).getByRole("button", { name: "Open folder", exact: true }).click();
  await queryRegion(settings).getByRole("button", { name: "Open folder", exact: true }).click();
  expect((await probe(page)).opens).toEqual([["csvCache"], ["queryTemp"]]);
  await page.evaluate(() => {
    (Reflect.get(window, "__p25Settings") as Probe).failOpen = "queryTemp";
  });
  await queryRegion(settings).getByRole("button", { name: "Open folder", exact: true }).click();
  await expect(queryRegion(settings).getByRole("alert")).toHaveText(
    "Explorer could not open this managed folder.",
  );
  await capture(page, info, "storage-launch-error");
  expect(await savedSettings(page)).toEqual(baseline);
  await expect
    .poll(() => settings.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.evaluate(() => {
    const state = Reflect.get(window, "__p25Settings") as Probe;
    state.locations.csvCache.available = false;
  });
  await open(page);
  await selectSettingsCategory(settings, "Storage");
  await expect(
    cacheRegion(settings).getByRole("button", { name: "Open folder", exact: true }),
  ).toBeDisabled();
  await expect(cacheRegion(settings)).toContainText(initial.locations.csvCache.path);
  await expect(
    queryRegion(settings).getByRole("button", { name: "Open folder", exact: true }),
  ).toBeEnabled();
  await capture(page, info, "storage-unavailable");
  expect((await probe(page)).opens).toEqual([["csvCache"], ["queryTemp"], ["queryTemp"]]);
});
