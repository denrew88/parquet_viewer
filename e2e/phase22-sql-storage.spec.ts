import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

// UI/wire verification only. Real enforcement, restart persistence and active
// worker snapshots belong to the native acceptance matrix, not this mock.
async function settings(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend module not loaded");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    return module.browserMockBackend.getSettings();
  });
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Application settings", exact: true });
}

test("T-P22-SQLSTORE-003 rejects invalid SQL disk caps and cancels without applying", async ({
  page,
}) => {
  await page.goto("/");
  const before = await settings(page);
  const dialog = await openSettings(page);
  const cap = dialog.getByRole("spinbutton", {
    name: "SQL temporary storage per query (GiB)",
    exact: true,
  });
  await expect(cap).toHaveValue("0.5");
  for (const value of ["0.0624999999", "10.0000000001", "", "-0.5"]) {
    await cap.fill(value);
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  }
  await cap.fill("1");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Reset SQL temporary storage", exact: true }).click();
  await expect(cap).toHaveValue("0.5");
  expect(await settings(page)).toEqual(before);
  await cap.fill("1");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await settings(page)).toEqual(before);
  await openSettings(page);
  await expect(cap).toHaveValue("0.5");
});

test("T-P22-SQLSTORE-001/003/008 decimal caps reach wire and remain independent of overall budget", async ({
  page,
}, info) => {
  await page.goto("/");
  const before = await settings(page);
  const corpus = JSON.parse(
    await fs.readFile("fixtures/phase-22/sql-storage-boundaries.json", "utf8"),
  ) as {
    uiCases: { text: string; valid: boolean; bytes?: number }[];
  };
  for (const item of corpus.uiCases.filter((entry) => entry.valid)) {
    const dialog = await openSettings(page);
    const cap = dialog.getByRole("spinbutton", {
      name: "SQL temporary storage per query (GiB)",
      exact: true,
    });
    await cap.fill(item.text);
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const current = await settings(page);
    expect(current.sqlTempLimitBytes).toBe(item.bytes);
    expect({ ...current, sqlTempLimitBytes: before.sqlTempLimitBytes }).toEqual(before);
  }
  const dialog = await openSettings(page);
  const overall = dialog.getByRole("spinbutton", {
    name: "Overall managed storage limit",
    exact: true,
  });
  const cap = dialog.getByRole("spinbutton", {
    name: "SQL temporary storage per query (GiB)",
    exact: true,
  });
  await overall.fill("0.3");
  await cap.fill("1");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await cap.scrollIntoViewIfNeeded();
  await expectInsideViewport(cap);
  await expectNoHorizontalPageOverflow(page);
  const geometry = await cap.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      unobscured: hit === element || (hit !== null && element.contains(hit)),
    };
  });
  expect(geometry.unobscured).toBe(true);
  const directory = "artifacts/phase-22/ui";
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    `${directory}/sql-storage-setting-${info.project.name}.json`,
    JSON.stringify(geometry, null, 2),
  );
  await dialog.screenshot({ path: `${directory}/sql-storage-setting-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const current = await settings(page);
  expect(current.queryTempLimitBytes).toBe(322122547);
  expect(current.sqlTempLimitBytes).toBe(1073741824);
  await openSettings(page);
  await expect(overall).toHaveValue("0.3");
  await expect(cap).toHaveValue("1");
});
