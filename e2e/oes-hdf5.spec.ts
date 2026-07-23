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
  await expect(page.locator(".copy-status")).toContainText("completed: 1 rows copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("63");

  await grid.press("Control+Shift+ArrowLeft");
  await expect(grid).toHaveAttribute("data-active-column", "0");
  await expect(grid).toHaveAttribute("data-selection-left", "0");
  await expect(grid).toHaveAttribute("data-selection-right", "64");
  await expect(grid.locator('[data-grid-row="0"][data-grid-column="0"]')).toHaveText("1000000");

  await grid.press("Control+Alt+ArrowRight");
  await expect(grid).toHaveAttribute("data-active-column", "64");
  await expect(grid).toHaveAttribute("data-selection-left", "64");
  await grid.press("Control+ArrowLeft");
  await expect(grid).toHaveAttribute("data-active-column", "0");
  await grid.press("Control+Alt+Shift+ArrowRight");
  await expect(grid).toHaveAttribute("data-active-column", "64");
  await expect(grid).toHaveAttribute("data-selection-left", "0");
  await expect(grid).toHaveAttribute("data-selection-right", "64");

  await grid.press("Control+Alt+Shift+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "479");
  await expect(grid).toHaveAttribute("data-selection-top", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "479");
  const bottomCell = grid.locator('[data-grid-row="479"][data-grid-column="64"]');
  await expect(bottomCell).toHaveText("479063");
  await expect(bottomCell).toBeVisible();
  await expect
    .poll(async () => {
      const [cellBox, gridBox] = await Promise.all([bottomCell.boundingBox(), grid.boundingBox()]);
      if (!cellBox || !gridBox) return Number.POSITIVE_INFINITY;
      return cellBox.y + cellBox.height - (gridBox.y + gridBox.height);
    })
    .toBeLessThanOrEqual(1);
  const bottomGeometry = await bottomCell.evaluate(
    (cell, gridElement) => {
      const cellRect = cell.getBoundingClientRect();
      const gridRect = (gridElement as HTMLElement).getBoundingClientRect();
      return {
        cellTop: cellRect.top,
        cellBottom: cellRect.bottom,
        cellHeight: cellRect.height,
        gridTop: gridRect.top,
        gridBottom: gridRect.bottom,
        gridContentBottom: gridRect.top + (gridElement as HTMLElement).clientHeight,
        bottomClearance: Number((gridElement as HTMLElement).dataset.bottomClearance),
      };
    },
    await grid.elementHandle(),
  );
  expect(bottomGeometry.cellTop).toBeGreaterThanOrEqual(bottomGeometry.gridTop + 36);
  expect(bottomGeometry.cellHeight).toBe(48);
  expect(bottomGeometry.cellBottom).toBeLessThanOrEqual(
    bottomGeometry.gridContentBottom - bottomGeometry.bottomClearance + 1,
  );
  expect(bottomGeometry.gridContentBottom).toBeLessThanOrEqual(bottomGeometry.gridBottom);
  await expect(grid).toBeFocused();

  await grid.press("Control+Alt+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid.locator('[data-grid-row="0"][data-grid-column="64"]')).toHaveText("63");
  await grid.press("Control+Alt+ArrowDown");
  await grid.press("Control+Shift+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid).toHaveAttribute("data-selection-top", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "479");

  await grid.press("Control+A");
  await expect(grid).toHaveAttribute("data-selection-left", "0");
  await expect(grid).toHaveAttribute("data-selection-right", "64");
  await expect(grid).toHaveAttribute("data-selection-top", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "479");
  await page.getByRole("button", { name: "Copy selection" }).click();
  await expect(page.locator(".copy-status")).toContainText("completed: 480 rows copied");

  const copiedRows = (await page.evaluate(() => navigator.clipboard.readText()))
    .split(/\r?\n/)
    .map((row) => row.split("\t"));
  expect(copiedRows).toHaveLength(480);
  expect(copiedRows.every((row) => row.length === 65)).toBe(true);
  expect(copiedRows[0]).toEqual([
    "1000000",
    ...Array.from({ length: 64 }, (_, index) => String(index)),
  ]);
  expect(copiedRows[239]?.[0]).toBe("1000239");
  expect(copiedRows[239]?.[63]).toBe("239062");
  expect(copiedRows[239]?.[64]).toBe("239063");
  expect(copiedRows[479]?.[0]).toBe("1000479");
  expect(copiedRows[479]?.[63]).toBe("479062");
  expect(copiedRows[479]?.[64]).toBe("479063");
  expect(
    copiedRows.reduce(
      (checksum, row) => checksum + row.reduce((sum, value) => sum + Number(value), 0),
      0,
    ),
  ).toBe(7_838_522_640);

  await expectInsideViewport(page.locator(".virtual-grid-shell"));
  await expectNoHorizontalPageOverflow(page);
});
