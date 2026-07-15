import { expect, test, type Page } from "@playwright/test";
import { expectCleanCsvSelectionUsed, installCleanCsvSelection, openMockFile } from "./helpers";

async function expectInsideViewport(page: Page, selector: string): Promise<void> {
  const result = await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });

  expect(result.left).toBeGreaterThanOrEqual(0);
  expect(result.top).toBeGreaterThanOrEqual(0);
  expect(result.right).toBeLessThanOrEqual(result.viewportWidth);
  expect(result.bottom).toBeLessThanOrEqual(result.viewportHeight);
}

async function expectControlsInsideContainer(page: Page, containerSelector: string): Promise<void> {
  const clipped = await page.locator(containerSelector).evaluate((container) => {
    const containerBounds = container.getBoundingClientRect();
    return Array.from(container.querySelectorAll<HTMLElement>("button, input, select"))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
          left: bounds.left,
          right: bounds.right,
        };
      })
      .filter(
        (control) =>
          control.left < containerBounds.left - 1 || control.right > containerBounds.right + 1,
      );
  });

  expect(clipped).toEqual([]);
}

test("validates CSV profile selection and type-specific numeric separators", async ({
  page,
}, testInfo) => {
  await page.goto("/?mock=csv");
  await page.getByRole("button", { name: "Open file" }).click();
  await expect(page.getByRole("tab", { name: "quoted-multiline.csv" })).toBeVisible();

  await page.getByRole("button", { name: "CSV Parsing Profile" }).click();
  const dialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });
  await expect(dialog).toBeVisible();

  const nameCheckbox = dialog.getByRole("checkbox", { name: "Select name" });
  await nameCheckbox.click();
  await expect(nameCheckbox).toHaveAttribute("aria-checked", "true");
  await nameCheckbox.click();
  await expect(nameCheckbox).toHaveAttribute("aria-checked", "false");

  await nameCheckbox.click();
  await dialog.getByLabel("Type for name").selectOption("UInt64");

  const thousands = dialog.getByLabel("Thousands separator for selected columns");
  await expect(thousands).toBeVisible();
  await expect(dialog.getByLabel("Decimal separator for selected columns")).toHaveCount(0);
  await expect(thousands.locator("option")).toHaveText(["None", ",", ".", "Space"]);
  await thousands.selectOption(".");
  await expect(thousands).toHaveValue(".");
  await expect(dialog.getByText(/Head sample · generation/)).toBeVisible();
  await expect(dialog.getByText("The backend returned an invalid CSV profile.")).toHaveCount(0);

  await testInfo.attach(`csv-profile-uint64-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await expectControlsInsideContainer(page, ".csv-profile-bulk-toolbar");

  await thousands.selectOption("");
  await dialog.getByLabel("Type for name").selectOption("Float64");
  const decimal = dialog.getByLabel("Decimal separator for selected columns");
  await expect(decimal).toBeVisible();
  await expect(decimal).toHaveValue(".");
  await expect(thousands.locator("option")).toHaveText(["None", ",", "Space"]);

  await decimal.selectOption(",");
  await expect(thousands.locator("option")).toHaveText(["None", ".", "Space"]);

  await dialog.getByLabel("Type for name").selectOption("Text");
  await expect(dialog.getByLabel("Decimal separator for selected columns")).toHaveCount(0);
  await expect(dialog.getByLabel("Thousands separator for selected columns")).toHaveCount(0);

  await expectInsideViewport(page, ".csv-profile-dialog");
  const bodyGeometry = await page.locator("body").evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));
  expect(bodyGeometry.scrollWidth).toBeLessThanOrEqual(bodyGeometry.clientWidth);
});

test("covers bulk selection, every separator, dynamic type controls, undo, and reset", async ({
  page,
}) => {
  await page.goto("/?mock=csv");
  await openMockFile(page, "csv", "quoted-multiline.csv");
  await page.getByRole("button", { name: "CSV Parsing Profile" }).click();
  const dialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });

  const name = dialog.getByRole("checkbox", { name: "Select name" });
  const empty = dialog.getByRole("checkbox", { name: "Select empty" });
  await name.click();
  await empty.click({ modifiers: ["Shift"] });
  await expect(dialog.getByLabel("3 selected", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Clear" }).click();
  await expect(dialog.getByLabel("0 selected", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Select shown" }).click();
  await expect(dialog.getByLabel("3 selected", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Select all filtered columns" }).click();
  await expect(dialog.getByLabel("0 selected", { exact: true })).toBeVisible();
  await name.click();

  const type = dialog.getByLabel("Type for selected columns");
  await type.selectOption("Boolean");
  await expect(dialog.getByLabel("Boolean true tokens for selected columns")).toBeVisible();
  await expect(dialog.getByLabel("Boolean false tokens for selected columns")).toBeVisible();
  await dialog.getByLabel("Boolean true tokens for selected columns").fill("yes | 1");
  await dialog.getByLabel("Boolean true tokens for selected columns").blur();
  await dialog.getByLabel("Boolean false tokens for selected columns").fill("no | 0");
  await dialog.getByLabel("Boolean false tokens for selected columns").blur();

  await type.selectOption("Date");
  await expect(dialog.getByLabel("Date formats for selected columns")).toBeVisible();
  await expect(dialog.getByLabel("Timezone policy for selected columns")).toHaveCount(0);
  await dialog.getByLabel("Date formats for selected columns").fill("YYYY-MM-DD; DD/MM/YYYY");
  await dialog.getByLabel("Date formats for selected columns").blur();

  await type.selectOption("Timestamp");
  await dialog.getByLabel("Timezone policy for selected columns").selectOption("Fixed");
  await expect(dialog.getByLabel("Timezone offset for selected columns")).toBeEnabled();
  await dialog.getByLabel("Timezone offset for selected columns").fill("+09:00");
  await dialog.getByLabel("Timezone offset for selected columns").blur();
  await expect(dialog.getByLabel("Failure policy for selected columns")).toBeVisible();

  await type.selectOption("UInt64");
  const thousands = dialog.getByLabel("Thousands separator for selected columns");
  await expect(thousands.locator("option")).toHaveText(["None", ",", ".", "Space"]);
  for (const separator of [",", ".", " ", ""]) {
    await thousands.selectOption(separator);
    await expect(thousands).toHaveValue(separator);
  }

  await type.selectOption("Float64");
  const decimal = dialog.getByLabel("Decimal separator for selected columns");
  await decimal.selectOption(".");
  await expect(thousands.locator("option")).toHaveText(["None", ",", "Space"]);
  for (const separator of [",", " ", ""]) await thousands.selectOption(separator);
  await decimal.selectOption(",");
  await expect(thousands.locator("option")).toHaveText(["None", ".", "Space"]);
  for (const separator of [".", " ", ""]) await thousands.selectOption(separator);

  await thousands.selectOption(".");
  await thousands.selectOption(" ");
  await dialog.getByRole("button", { name: "Undo" }).click();
  await expect(thousands).toHaveValue(".");
  await type.selectOption("Int64");
  await dialog.getByRole("button", { name: "Reset to inferred" }).click();
  await expect(dialog.getByLabel("Type for name")).toHaveValue("Text");

  await type.selectOption("Text");
  await expect(dialog.getByLabel("Trim whitespace for selected columns")).toBeVisible();
  await expect(dialog.getByLabel("Decimal separator for selected columns")).toHaveCount(0);
  await expect(dialog.getByLabel("Thousands separator for selected columns")).toHaveCount(0);
});

test("restores focus on Escape, cancels drafts, validates, and applies a clean profile", async ({
  page,
}) => {
  await page.goto("/?mock=csv");
  await installCleanCsvSelection(page);
  await openMockFile(page, "csv", "quoted-multiline.csv");
  await expectCleanCsvSelectionUsed(page);
  await expect(page.getByText(/structural CSV row issue/)).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "CSV Parsing Profile" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });
  await expect(dialog.getByRole("button", { name: "Validate entire file" })).toBeFocused();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });
  await dialog.getByRole("checkbox", { name: "Select name" }).click();
  await dialog.getByLabel("Type for selected columns").selectOption("Boolean");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });
  await expect(dialog.getByLabel("Type for name")).toHaveValue("Auto");
  await dialog.getByRole("checkbox", { name: "Select name" }).click();
  await dialog.getByLabel("Type for selected columns").selectOption("Text");
  await dialog.getByRole("button", { name: "Raw" }).click();
  await expect(dialog.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Converted" }).click();
  await dialog.getByRole("button", { name: "Refresh preview" }).click();

  await dialog.getByRole("button", { name: "Validate entire file" }).click();
  await expect(dialog.getByText("complete", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("CSV: Custom")).toBeVisible();
  await expect(page.getByRole("grid", { name: "Data preview" })).toBeVisible();
});
