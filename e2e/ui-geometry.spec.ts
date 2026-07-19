import { expect, test } from "@playwright/test";
import {
  expectInsideViewport,
  expectNoHorizontalPageOverflow,
  expectVisibleControlsInside,
  openMockFile,
} from "./helpers";

test("keeps primary UI, dialogs, and query popovers unclipped", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const artifactName = {
    "desktop-compact": "compact",
    "desktop-minimum": "minimum",
    "desktop-wide": "wide",
  }[testInfo.project.name];
  if (!artifactName) throw new Error(`Unexpected Playwright project: ${testInfo.project.name}`);
  await page.goto("/");
  await expectNoHorizontalPageOverflow(page);
  await expectInsideViewport(page.locator(".app-toolbar"));
  await expectInsideViewport(page.locator(".document-tabs"));
  await expectInsideViewport(page.locator(".workspace-tabs"));
  await expectInsideViewport(page.getByTestId("status-bar"));

  await openMockFile(page, "csv", "quoted-multiline.csv");
  await expectInsideViewport(page.locator(".virtual-grid-shell"));
  await page.getByRole("button", { name: "CSV Parsing Profile" }).click();
  const csvDialog = page.getByRole("dialog", { name: "CSV Parsing Profile" });
  await expectInsideViewport(csvDialog);
  await expectVisibleControlsInside(csvDialog);
  await expectNoHorizontalPageOverflow(page);
  await csvDialog.press("Escape");

  await page.getByRole("button", { name: "Copy options" }).click();
  await page.getByRole("menuitem", { name: "Copy settings" }).click();
  const copyDialog = page.getByRole("dialog", { name: "Copy settings" });
  await expectInsideViewport(copyDialog);
  await expectVisibleControlsInside(copyDialog);
  await copyDialog.press("Escape");

  await page.getByRole("button", { name: "Settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Application settings" });
  await expectInsideViewport(settingsDialog);
  await expectVisibleControlsInside(settingsDialog);
  await settingsDialog.screenshot({
    path: `artifacts/phase-10/ui/settings-${artifactName}.png`,
  });
  await settingsDialog.press("Escape");

  await page.getByRole("button", { name: "Close quoted-multiline.csv" }).click();
  await openMockFile(page, "parquet", "typed-row-groups.parquet");
  await page.getByRole("button", { name: "Filter id" }).click();
  const filter = page.getByRole("dialog", { name: "Filter id" });
  await expectInsideViewport(filter);
  await expectVisibleControlsInside(filter);
  await expectNoHorizontalPageOverflow(page);

  await testInfo.attach(`phase9-ui-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.screenshot({
    fullPage: true,
    path: `artifacts/phase-9/ui/browser-${artifactName}.png`,
  });
  await expect(page.locator(".app-shell")).toBeVisible();
});
