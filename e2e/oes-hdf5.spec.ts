import { expect, test } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow, openMockFile } from "./helpers";

test("opens a projected OES matrix and reaches the final wavelength without query controls", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await openMockFile(page, "oes", "spectrometer.oes.h5");

  await expect(page.getByLabel("Current file summary")).toContainText("OES HDF5");
  await expect(page.getByText("65 / 65 columns")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search data" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Filter / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sort / })).toHaveCount(0);

  const grid = page.getByRole("grid", { name: "Data preview" });
  await expect(grid).toHaveAttribute("aria-colcount", "65");
  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(grid.getByRole("columnheader", { name: "463" })).toBeVisible();

  const finalCell = grid.locator('[data-grid-row="0"][data-grid-column="64"]');
  await expect(finalCell).toHaveText("63");
  await finalCell.click();
  await expect(grid).toHaveAttribute("data-selection-left", "64");
  await expect(grid).toHaveAttribute("data-selection-right", "64");
  await page.getByRole("button", { name: "Copy selection" }).click();
  await expect(page.locator(".copy-status")).toHaveText("Copied 1 rows.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("63");

  await expectInsideViewport(page.locator(".virtual-grid-shell"));
  await expectNoHorizontalPageOverflow(page);
});
