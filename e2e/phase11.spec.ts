import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectInsideViewport, expectNoHorizontalPageOverflow, openMockFile } from "./helpers";

function viewportName(projectName: string): string {
  const name = {
    "desktop-wide": "wide",
    "desktop-compact": "compact",
    "desktop-minimum": "minimum",
  }[projectName];
  if (!name) throw new Error(`Unexpected Playwright project: ${projectName}`);
  return name;
}

test("keeps a 5.85M-row grid navigable through the final-row segment", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await openMockFile(page, "large", "large-5850000.parquet");

  const grid = page.getByRole("grid", { name: "Data preview" });
  await expect(grid).toHaveAttribute("aria-rowcount", "5850000");
  await expect(grid).toHaveAttribute("aria-colcount", "15");

  const labelSeparator = page.getByRole("separator", { name: "Resize label" });
  await expect(labelSeparator).toHaveAttribute("aria-valuenow", "180");
  await labelSeparator.dblclick();
  await expect
    .poll(async () => Number(await labelSeparator.getAttribute("aria-valuenow")))
    .toBeLessThan(180);

  const firstCell = grid.locator('[data-grid-row="0"][data-grid-column="0"]');
  await firstCell.click();
  await grid.press("Control+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  await grid.press("Control+Shift+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid).toHaveAttribute("data-selection-top", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "5849999");
  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");
  await expect(grid).toHaveAttribute("data-selection-top", "5849999");
  await grid.press("Control+Alt+Shift+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid).toHaveAttribute("data-selection-top", "0");
  await expect(grid).toHaveAttribute("data-selection-bottom", "5849999");
  await grid.press("Control+Alt+ArrowDown");
  await expect(grid).toHaveAttribute("data-active-row", "5849999");

  const lastCell = grid.locator('[data-grid-row="5849999"][data-grid-column="0"]');
  await expect(lastCell).toHaveText("584999900");
  await expect(lastCell).toBeVisible();
  const geometry = await lastCell.evaluate(
    (cell, gridElement) => {
      const cellRect = cell.getBoundingClientRect();
      const gridRect = (gridElement as HTMLElement).getBoundingClientRect();
      return {
        cellTop: cellRect.top,
        cellBottom: cellRect.bottom,
        gridTop: gridRect.top,
        gridBottom: gridRect.bottom,
      };
    },
    await grid.elementHandle(),
  );
  expect(geometry.cellTop).toBeGreaterThanOrEqual(geometry.gridTop + 36);
  expect(geometry.cellBottom).toBeLessThanOrEqual(geometry.gridBottom + 1);

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Application settings" });
  await settings.getByLabel("Integer grouping").selectOption("comma");
  if (testInfo.project.name === "desktop-wide") {
    const settingsGeometry = await settings.evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    });
    await writeFile(
      "artifacts/phase-11/ui/geometry-results.json",
      `${JSON.stringify(
        {
          result: "PASS",
          project: testInfo.project.name,
          viewport: page.viewportSize(),
          finalRow: geometry,
          settings: settingsGeometry,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  await settings.screenshot({
    path: `artifacts/phase-11/ui/settings-${viewportName(testInfo.project.name)}.png`,
  });
  await settings.getByRole("button", { name: "Apply" }).click();
  await expect(lastCell).toHaveText("584,999,900");
  await page.screenshot({
    path: `artifacts/phase-11/ui/last-row-${viewportName(testInfo.project.name)}.png`,
    fullPage: true,
  });

  await grid.press("Control+Alt+ArrowUp");
  await expect(grid).toHaveAttribute("data-active-row", "0");
  await expect(grid.locator('[data-grid-row="0"][data-grid-column="0"]')).toHaveText("0");
  await expect(grid).toBeFocused();
  await expectInsideViewport(page.locator(".virtual-grid-shell"));
  await expectNoHorizontalPageOverflow(page);
});

test("renders multiline strings in fixed two-line rows and keeps timestamp display timezone-free", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await openMockFile(page, "csv", "quoted-multiline.csv");
  const grid = page.getByRole("grid", { name: "Data preview" });
  const multiline = grid.locator('[data-grid-row="0"][data-grid-column="1"]');
  await expect(multiline).toHaveText("line one\nline two");
  const rowGeometry = await multiline.evaluate((cell) => {
    const row = cell.closest('[role="row"]');
    return {
      cellHeight: cell.getBoundingClientRect().height,
      lineClamp: getComputedStyle(cell.querySelector("span") ?? cell).webkitLineClamp,
      rowHeight: row?.getBoundingClientRect().height ?? 0,
      whiteSpace: getComputedStyle(cell.querySelector("span") ?? cell).whiteSpace,
    };
  });
  expect(rowGeometry.cellHeight).toBe(48);
  expect(rowGeometry.rowHeight).toBe(48);
  expect(rowGeometry.lineClamp).toBe("2");
  expect(rowGeometry.whiteSpace).toBe("pre-wrap");
  await page.screenshot({
    path: `artifacts/phase-11/ui/multiline-${viewportName(testInfo.project.name)}.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Close quoted-multiline.csv" }).click();
  await openMockFile(page, "parquet", "typed-row-groups.parquet");
  const parquetGrid = page.getByRole("grid", { name: "Data preview" });
  await parquetGrid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll"));
  });
  const timestamp = parquetGrid.locator('[data-grid-row="0"][data-grid-column="3"]');
  await expect(timestamp).toHaveText("2026-07-14 12:34:56.123456789");
  await expect(timestamp).not.toContainText("+09:00");
});
