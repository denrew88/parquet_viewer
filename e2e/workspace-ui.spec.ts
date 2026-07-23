import { expect, test } from "@playwright/test";
import { openMockFile } from "./helpers";

test("opens multiple browserMock documents and retains independent view tabs", async ({ page }) => {
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

test("validates application settings and temporary-storage controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/0 B used/)).toBeVisible();
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
