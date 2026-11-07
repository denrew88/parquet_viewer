import fs from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const editor = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const popup = (page: Page) => page.locator(".cm-tooltip-autocomplete");
const text = (workspace: Locator) =>
  editor(workspace)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));
const labels = (page: Page) => popup(page).locator(".cm-completionLabel");
const joinPrefix = "SELECT * FROM orders o JOIN customers c ON ";

async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend not loaded");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend.sqlWorkspace;
    if (!backend) throw new Error("SQL mock missing");
    const calls: Record<string, number> = {};
    Reflect.set(window, "__joinCompletionCalls", calls);
    for (const key of [
      "describeTables",
      "startQuery",
      "getStatus",
      "readPage",
      "readCell",
    ] as const) {
      calls[key] = 0;
      const original = backend[key];
      Reflect.set(backend, key, (...args: unknown[]) => {
        calls[key]++;
        return Reflect.apply(original, backend, args);
      });
    }
  });
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  await expect(workspace.getByRole("button", { name: "orders", exact: true })).toBeVisible();
  return workspace;
}
const calls = (page: Page) =>
  page.evaluate(() => ({ ...Reflect.get(window, "__joinCompletionCalls") })) as Promise<
    Record<string, number>
  >;
async function mode(page: Page, value: "contextual" | "automatic" | "manual") {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings", exact: true });
  await dialog
    .getByRole("combobox", { name: "SQL suggestion mode", exact: true })
    .selectOption(value);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function quiet(page: Page) {
  // Poll through several activation windows; an immediate absent assertion can
  // pass before CodeMirror's delayed provider has run.
  await expect
    .poll(
      async () => {
        let opened = false;
        for (let i = 0; i < 4; i++) {
          opened ||= (await popup(page).count()) > 0;
          await page.waitForTimeout(70);
        }
        return opened;
      },
      { timeout: 1500 },
    )
    .toBe(false);
}
async function onContext(page: Page, workspace: Locator) {
  await editor(workspace).fill(joinPrefix.trimEnd());
  await editor(workspace).press("End");
  await page.keyboard.type(" ");
  await expect(popup(page)).toBeVisible();
}

test("T-P22-JOIN-001/002/003/008/009 inferred ON joins use original names and physical modes", async ({
  page,
}, info) => {
  const workspace = await setup(page),
    before = await calls(page);
  for (const [left, right] of [
    ["name", "name"],
    ["ordinal", "name"],
    ["name", "ordinal"],
    ["ordinal", "ordinal"],
  ] as const) {
    await workspace.getByRole("button", { name: "orders", exact: true }).click();
    await workspace
      .getByRole("radio", { name: left === "name" ? /^Original names only/ : /^c-numbers only/ })
      .check();
    await workspace.getByRole("button", { name: "customers", exact: true }).click();
    await workspace
      .getByRole("radio", { name: right === "name" ? /^Original names only/ : /^c-numbers only/ })
      .check();
    await onContext(page, workspace);
    const leftLabel = left === "name" ? "고객 번호" : "c2",
      rightLabel = right === "name" ? "고객 번호" : "c1";
    await expect(labels(page)).toHaveText([`o.${leftLabel} = c.${rightLabel}`]);
    await expect(popup(page)).toContainText("Suggested JOIN");
    await expect(page.locator(".cm-completionInfo")).toContainText("not a verified foreign key");
    expect(await text(workspace)).toBe(joinPrefix);
    if (left === "name" && right === "name") {
      await expectInsideViewport(popup(page));
      await expectInsideViewport(page.locator(".cm-completionInfo"));
      await expectNoHorizontalPageOverflow(page);
      const geometry = await page.locator(".cm-tooltip").evaluateAll((elements) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect();
          return {
            className: element.className,
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
          };
        }),
      );
      await fs.mkdir("artifacts/phase-22/ui", { recursive: true });
      const prefix = `artifacts/phase-22/ui/join-completion-${info.project.name}`;
      await fs.writeFile(
        `${prefix}.json`,
        JSON.stringify({ viewport: page.viewportSize(), geometry }, null, 2),
      );
      await workspace.screenshot({ path: `${prefix}.png` });
    }
    await editor(workspace).press("Tab");
    const predicate = `o.${left === "name" ? '"고객 번호"' : "c2"} = c.${right === "name" ? '"고객 번호"' : "c1"}`;
    await expect.poll(() => text(workspace)).toBe(joinPrefix + predicate);
    await editor(workspace).press("Control+z");
    await expect.poll(() => text(workspace)).toBe(joinPrefix);
    await editor(workspace).press("Escape");
  }
  await editor(workspace).fill(
    "WITH customers AS (SELECT 1 AS x) SELECT * FROM orders o JOIN customers c ON ",
  );
  await editor(workspace).press("End");
  await editor(workspace).press("Control+Space");
  await expect(popup(page).locator(".cm-completionIcon-join")).toHaveCount(0);
  expect(await calls(page)).toEqual(before);
});

test("T-P22-JOIN-004/005/006 automatic suggestions stay quiet and Shift+Enter preserves newline intent", async ({
  page,
}) => {
  const workspace = await setup(page);
  await editor(workspace).fill("SELECT ");
  await page.keyboard.type("co");
  await quiet(page);
  await onContext(page, workspace);
  const authored = await text(workspace);
  await editor(workspace).press("Shift+Enter");
  const newline = await text(workspace);
  expect(newline).toContain("\n");
  expect(newline.replace(/\n[ \t]*$/, "")).toBe(authored);
  await onContext(page, workspace);
  await editor(workspace).press("ArrowDown");
  await editor(workspace).press("Enter");
  await expect.poll(() => text(workspace)).toContain('o."고객 번호" = c."고객 번호"');
  await mode(page, "automatic");
  await editor(workspace).fill("SELECT ");
  await page.keyboard.type("c");
  await quiet(page);
  await page.keyboard.type("o");
  await expect(popup(page)).toBeVisible();
  await editor(workspace).press("Escape");
  await page.keyboard.type("u");
  await quiet(page);
  expect(await text(workspace)).toBe("SELECT cou");
  await editor(workspace).press("Control+Space");
  await expect(popup(page)).toBeVisible();
  await editor(workspace).press("Escape");
  await editor(workspace).fill("SELECT orders");
  await page.keyboard.type(".");
  await expect(popup(page)).toBeVisible();
  expect((await calls(page)).startQuery).toBe(0);
});

test("T-P22-JOIN-004/006/007 manual setting persists in UI and explicit Enter accepts once", async ({
  page,
}) => {
  const workspace = await setup(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Application settings", exact: true });
  const select = dialog.getByRole("combobox", { name: "SQL suggestion mode", exact: true });
  await expect(select).toHaveValue("contextual");
  await select.selectOption("manual");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(select).toHaveValue("contextual");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await mode(page, "manual");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(select).toHaveValue("manual");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await editor(workspace).fill("SELECT ");
  await page.keyboard.type("co");
  await quiet(page);
  await editor(workspace).fill("SELECT orders");
  await page.keyboard.type(".");
  await quiet(page);
  await editor(workspace).fill(joinPrefix);
  await quiet(page);
  await editor(workspace).press("Control+Space");
  await expect(labels(page)).toHaveText(["o.고객 번호 = c.고객 번호"]);
  await editor(workspace).press("Enter");
  await expect.poll(() => text(workspace)).toBe(joinPrefix + 'o."고객 번호" = c."고객 번호"');
  expect((await calls(page)).startQuery).toBe(0);
  await editor(workspace).press("Control+Space");
  await expect(popup(page)).toBeVisible();
  const before = await text(workspace);
  await editor(workspace).evaluate((element) => {
    for (const key of ["Enter", "Tab"])
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: key === "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  expect(await text(workspace)).toBe(before);
  expect((await calls(page)).startQuery).toBe(0);
  await editor(workspace).press("Control+Enter");
  await expect.poll(async () => (await calls(page)).startQuery).toBe(1);
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toBeVisible();
  expect((await calls(page)).startQuery).toBe(1);
});
