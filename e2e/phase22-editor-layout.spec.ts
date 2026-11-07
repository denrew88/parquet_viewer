import fs from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const editor = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const text = (workspace: Locator) =>
  editor(workspace)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));
async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  await expect(workspace.getByRole("button", { name: "orders", exact: true })).toBeVisible();
  return workspace;
}

test("T-P22-LAYOUT-001/002/003 accessible source split preserves selection and cancels drag", async ({
  page,
}) => {
  const workspace = await setup(page);
  const split = workspace.getByRole("separator", {
    name: "Resize tables and columns",
    exact: true,
  });
  await expect(split).toHaveAttribute("aria-orientation", "horizontal");
  const value = async () => Number(await split.getAttribute("aria-valuenow"));
  const authored = "SELECT preserve_manual_query;";
  await editor(workspace).fill(authored);
  await workspace.getByRole("button", { name: "customers", exact: true }).click();
  await workspace.getByRole("radio", { name: /^c-numbers only/ }).check();
  await split.focus();
  await split.press("Home");
  const minimum = Number(await split.getAttribute("aria-valuemin"));
  expect(minimum).toBe(160);
  expect(await value()).toBe(minimum);
  await split.press("End");
  const maximum = Number(await split.getAttribute("aria-valuemax"));
  expect(maximum).toBeGreaterThan(minimum);
  expect(await value()).toBe(maximum);
  await split.press("ArrowUp");
  expect(await value()).toBe(Math.max(minimum, maximum - 10));
  await split.press("ArrowDown");
  expect(await value()).toBe(maximum);
  await split.press("Home");
  let box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 35, { steps: 4 });
  expect(await value()).toBeGreaterThan(minimum);
  await page.mouse.up();
  const committed = await value();
  box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await value()).toBe(committed);
  box = (await split.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 15);
  await split.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  expect(await value()).toBe(committed);
  await expect(workspace.getByRole("radio", { name: /^c-numbers only/ })).toBeChecked();
  await expect(workspace.locator(".sql-column-area h2")).toContainText("customers columns");
  expect(await text(workspace)).toBe(authored);
  await expectInsideViewport(split);
  await expectInsideViewport(workspace.locator(".sql-table-area"));
  await expectInsideViewport(workspace.locator(".sql-column-area"));
  expect(await workspace.locator(".sql-column-list .sql-column").count()).toBeLessThanOrEqual(30);
  await expectNoHorizontalPageOverflow(page);
});

test("T-P22-LAYOUT-004/007 long query scroll exposes its tail without widening the page", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  const long =
    "SELECT " + Array.from({ length: 140 }, (_, i) => `field_${i}`).join(", ") + " AS END_TAIL";
  await editor(workspace).fill(long);
  await editor(workspace).press("Control+End");
  const scroller = workspace.locator(".cm-scroller");
  const openWidth = (await scroller.boundingBox())!.width;
  const captures = [];
  for (const help of ["open", "closed"]) {
    if (help === "closed") {
      await workspace.getByRole("button", { name: "Examples & help", exact: true }).click();
      await expect(
        workspace.getByRole("button", { name: "Examples & help", exact: true }),
      ).toHaveAttribute("aria-expanded", "false");
      await expect
        .poll(async () => (await scroller.boundingBox())!.width)
        .toBeGreaterThan(openWidth);
    }
    const range = await scroller.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
      left: element.scrollLeft,
    }));
    expect(range.scroll).toBeGreaterThan(range.client);
    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const geometry = await scroller.evaluate((element) => {
      const line = element.querySelector(".cm-line")!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node: Node | null,
        last: Node | null = null;
      while ((node = walker.nextNode())) last = node;
      if (!last) throw Error("Missing rendered query tail");
      const range = document.createRange();
      range.selectNodeContents(last);
      const tail = range.getBoundingClientRect(),
        view = element.getBoundingClientRect(),
        host = element.closest(".sql-code-editor")!.getBoundingClientRect();
      return {
        left: element.scrollLeft,
        client: element.clientWidth,
        scroll: element.scrollWidth,
        tail: { left: tail.left, right: tail.right },
        view: { left: view.left, right: view.right, bottom: view.bottom },
        hostBottom: host.bottom,
        visibleText: last.textContent,
      };
    });
    expect(geometry.left).toBeGreaterThan(0);
    expect(geometry.visibleText).toContain("END_TAIL");
    expect(geometry.tail.right).toBeLessThanOrEqual(geometry.view.right + 1);
    expect(geometry.tail.left).toBeGreaterThanOrEqual(geometry.view.left);
    expect(geometry.view.bottom).toBeLessThanOrEqual(geometry.hostBottom + 1);
    captures.push({ help, ...geometry });
    expect(await text(workspace)).toBe(long);
    await expectNoHorizontalPageOverflow(page);
    await fs.mkdir("artifacts/phase-22/ui", { recursive: true });
    const prefix = `artifacts/phase-22/ui/editor-layout-${help}-${info.project.name}`;
    await fs.writeFile(
      `${prefix}.json`,
      JSON.stringify({ viewport: page.viewportSize(), geometry }, null, 2),
    );
    await workspace.screenshot({ path: `${prefix}.png` });
  }
  await fs.writeFile(
    `artifacts/phase-22/ui/editor-layout-${info.project.name}.json`,
    JSON.stringify({ viewport: page.viewportSize(), captures }, null, 2),
  );
});

test("T-P22-LAYOUT-005/006 Enter preserves manual indentation and completion intent", async ({
  page,
}) => {
  const workspace = await setup(page);
  await editor(workspace).fill("SELECT (");
  await editor(workspace).press("End");
  await editor(workspace).press("Enter");
  expect(await text(workspace)).toBe("SELECT (\n");
  await editor(workspace).fill("    SELECT (");
  await editor(workspace).press("End");
  await editor(workspace).press("Enter");
  expect(await text(workspace)).toBe("    SELECT (\n    ");
  await editor(workspace).press("Control+z");
  expect(await text(workspace)).toBe("    SELECT (");
  await editor(workspace).press("Shift+Enter");
  expect(await text(workspace)).toBe("    SELECT (\n    ");
  await editor(workspace).fill("SELECT * FROM orders o JOIN customers c ON ");
  await editor(workspace).press("End");
  await page.keyboard.type(" ");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  const before = await text(workspace);
  await editor(workspace).press("Shift+Enter");
  expect(await text(workspace)).toBe(before + "\n");
  await editor(workspace).fill("SELECT * FROM ord");
  await editor(workspace).press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await editor(workspace).press("Enter");
  expect(await text(workspace)).toBe("SELECT * FROM orders");
});
