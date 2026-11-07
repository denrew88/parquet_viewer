import fs from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const input = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const popup = (page: Page) => page.locator(".cm-tooltip-autocomplete");
const option = (page: Page, label: string) =>
  popup(page)
    .getByRole("option")
    .filter({
      has: page
        .locator(".cm-completionLabel")
        .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
    });
const text = (workspace: Locator) =>
  input(workspace)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));

async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend module not loaded");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend.sqlWorkspace;
    if (!backend) throw new Error("SQL mock not installed");
    const counts: Record<string, number> = {};
    Reflect.set(window, "__intellisenseCalls", counts);
    const submitted: string[] = [];
    Reflect.set(window, "__intellisenseSql", submitted);
    for (const key of [
      "describeTables",
      "startQuery",
      "getStatus",
      "readPage",
      "readCell",
    ] as const) {
      const original = backend[key];
      counts[key] = 0;
      Reflect.set(backend, key, (...args: unknown[]) => {
        counts[key]++;
        if (key === "startQuery") submitted.push((args[0] as { sql: string }).sql);
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
const counts = (page: Page) =>
  page.evaluate(() => ({ ...Reflect.get(window, "__intellisenseCalls") })) as Promise<
    Record<string, number>
  >;
async function doc(page: Page, workspace: Locator, marked: string) {
  const position = marked.indexOf("|");
  const value = position < 0 ? marked : marked.slice(0, position) + marked.slice(position + 1);
  await input(workspace).fill(value);
  await expect.poll(() => text(workspace)).toBe(value);
  if (position >= 0) {
    await input(workspace).press("Control+Home");
    for (let i = 0; i < position; i++) await page.keyboard.press("ArrowRight");
  }
}

test("T-P22-INT-002/005/007 automatic table and forward alias completion respects column mode", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  await doc(page, workspace, "SELECT * FROM");
  await page.keyboard.type(" ");
  await expect(option(page, "orders")).toBeVisible();
  await expectInsideViewport(popup(page));
  await info.attach("automatic table suggestions", {
    body: await workspace.screenshot(),
    contentType: "image/png",
  });
  await page.keyboard.type("ord");
  await expect(option(page, "customers")).toHaveCount(0);
  await input(workspace).press("Tab");
  await expect.poll(() => text(workspace)).toBe("SELECT * FROM orders");
  await expect(input(workspace)).toBeFocused();
  await page.keyboard.type(" LEFT JOIN ");
  await expect(option(page, "customers")).toBeVisible();
  await option(page, "customers").click();
  await expect.poll(() => text(workspace)).toBe("SELECT * FROM orders LEFT JOIN customers");
  await doc(page, workspace, "SELECT o| FROM orders AS o");
  await page.keyboard.type(".");
  await expect(option(page, "주문 번호")).toBeVisible();
  await expect(option(page, "주문 번호")).toContainText("BIGINT");
  await option(page, '상품 "표시명"').click();
  await expect.poll(() => text(workspace)).toBe('SELECT o."상품 ""표시명""" FROM orders AS o');
  await input(workspace).press("Control+z");
  await expect.poll(() => text(workspace)).toBe("SELECT o. FROM orders AS o");
  await input(workspace).press("Escape");
  await expect(popup(page)).toHaveCount(0);
  const preserved = await text(workspace);
  await workspace.getByRole("radio", { name: /^c-numbers only/ }).check();
  expect(await text(workspace)).toBe(preserved);
  await input(workspace).focus();
  await input(workspace).press("Control+Space");
  await expect(option(page, "c1")).toBeVisible();
  await expect(option(page, "주문 번호")).toHaveCount(0);
  await input(workspace).press("Enter");
  await expect.poll(() => text(workspace)).toBe("SELECT o.c1 FROM orders AS o");
  await doc(page, workspace, "SELECT o.c3| FROM orders o");
  await input(workspace).press("Control+Space");
  await expect(option(page, "c3")).toBeVisible();
  await input(workspace).press("Tab");
  await expect.poll(() => text(workspace)).toBe("SELECT o.c3 FROM orders o");
  expect((await counts(page)).startQuery).toBe(0);
});

test("T-P22-FLOW-001/002 HAVING offers scoped columns and Enter accepts once", async ({ page }) => {
  const workspace = await setup(page);
  const grouped = 'SELECT o."주문 번호" FROM orders AS o GROUP BY o."주문 번호" HAVING';
  await doc(page, workspace, grouped);
  await page.keyboard.type(" ");
  await expect(option(page, "주문 번호")).toBeVisible();
  await page.keyboard.type("o.");
  await expect(option(page, "주문 번호")).toBeVisible();
  await page.keyboard.type("상품");
  await expect(option(page, '상품 "표시명"')).toBeVisible();
  await expect(option(page, "주문 번호")).toHaveCount(0);
  await input(workspace).press("Enter");
  await expect.poll(() => text(workspace)).toBe(`${grouped} o."상품 ""표시명"""`);
  await expect(popup(page)).toHaveCount(0);
  const aggregate =
    'SELECT o."주문 번호", count(*) AS cnt FROM orders o GROUP BY o."주문 번호" HAVING';
  await doc(page, workspace, aggregate);
  await page.keyboard.type(" cn");
  await expect(option(page, "cnt")).toBeVisible();
  await input(workspace).press("Enter");
  await expect.poll(() => text(workspace)).toBe(`${aggregate} cnt`);
  expect((await counts(page)).startQuery).toBe(0);
});

test("T-P22-FLOW-003 Ctrl+Enter submits the cursor statement without editing the document", async ({
  page,
}) => {
  const workspace = await setup(page);
  const submitted = () => page.evaluate(() => Reflect.get(window, "__intellisenseSql") as string[]);
  const first = "SELECT ';' AS first_value;";
  const second = "/* outer ; /* inner ; */ */ SELECT $$a;b$$ AS second_value;";
  const third = "SELECT 3 AS third_value";
  const script = `${first}\n${second}\n${third}`;
  const clearResult = workspace.getByRole("button", { name: "Clear result", exact: true });

  await doc(page, workspace, script.replace("second_value;", "second_value|;"));
  await input(workspace).press("Control+Enter");
  await expect.poll(submitted).toEqual([second]);
  await expect(clearResult).toBeEnabled();
  const resultContext = workspace.getByRole("status", { name: "Result context", exact: true });
  await expect(resultContext).toHaveAttribute("data-current", "true");
  await expect.poll(() => text(workspace)).toBe(script);
  await page.keyboard.type("x");
  await expect(resultContext).toHaveAttribute("data-current", "false");
  await clearResult.click();

  await doc(page, workspace, `${first}|\n${second}\n${third}`);
  await input(workspace).press("Control+Enter");
  await expect.poll(submitted).toEqual([second, second]);
  await expect(clearResult).toBeEnabled();
  await clearResult.click();

  await doc(page, workspace, `${script}|`);
  await input(workspace).press("Control+Enter");
  await expect.poll(submitted).toEqual([second, second, third]);
  await expect(clearResult).toBeEnabled();
  await clearResult.click();

  await doc(page, workspace, `${first}\n-- trailing comment ;\n|`);
  await input(workspace).press("Control+Enter");
  expect(await submitted()).toEqual([second, second, third]);

  await doc(page, workspace, `${first}|\n-- trailing comment ;`);
  await input(workspace).press("Control+Enter");
  await expect.poll(submitted).toEqual([second, second, third, first]);
});

test("T-P22-ID-001/002/004/006 inserted identifiers keep keywords and unsafe names quoted", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  let previous = "orders";
  await doc(page, workspace, 'SELECT * FROM "ord|ers"');
  await input(workspace).press("Control+Space");
  await option(page, "orders").click();
  await expect.poll(() => text(workspace)).toBe("SELECT * FROM orders");
  await input(workspace).press("Control+z");
  await expect.poll(() => text(workspace)).toBe('SELECT * FROM "orders"');
  const cases = [
    ["_Safe9", "_Safe9"],
    ["SELECT", '"SELECT"'],
    ["Qualify", '"Qualify"'],
    ["asof", '"asof"'],
    ["two words", '"two words"'],
    ["1table", '"1table"'],
    ["고객", '"고객"'],
    ['x"; DROP TABLE orders;--', '"x""; DROP TABLE orders;--"'],
  ];
  for (const [alias, inserted] of cases) {
    await doc(page, workspace, "SELECT preserve_authored_text;");
    await workspace.getByRole("button", { name: `Rename table ${previous}`, exact: true }).click();
    const field = workspace.getByRole("textbox", { name: "Table alias", exact: true });
    await field.fill(alias);
    await field.press("Enter");
    await expect(workspace.getByRole("button", { name: alias, exact: true })).toBeVisible();
    expect(await text(workspace)).toBe("SELECT preserve_authored_text;");
    await doc(page, workspace, "SELECT * FROM ");
    await input(workspace).press("Control+Space");
    await expect(option(page, alias)).toBeVisible();
    if (alias === cases[cases.length - 1][0]) {
      await expectInsideViewport(popup(page));
      await expectNoHorizontalPageOverflow(page);
      await fs.mkdir("artifacts/phase-22/ui", { recursive: true });
      const geometry = await popup(page).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      await fs.writeFile(
        `artifacts/phase-22/ui/identifier-insertion-${info.project.name}.json`,
        JSON.stringify({ viewport: page.viewportSize(), geometry }, null, 2),
      );
      await workspace.screenshot({
        path: `artifacts/phase-22/ui/identifier-insertion-${info.project.name}.png`,
      });
    }
    await option(page, alias).click();
    await expect.poll(() => text(workspace)).toBe(`SELECT * FROM ${inserted}`);
    await expect(input(workspace)).toBeFocused();
    await input(workspace).press("Control+z");
    await expect.poll(() => text(workspace)).toBe("SELECT * FROM ");
    previous = alias;
  }
  expect((await counts(page)).startQuery).toBe(0);
});

test("T-P22-INT-003/004/006/010/011 lexical scope, function hints and local-only typing", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  const before = await counts(page);
  for (const source of [
    "SELECT 'o.|' FROM orders o",
    "SELECT 1 -- o.|",
    "SELECT /* o.| */ 1 FROM orders o",
    "WITH /* comment */ orders AS (SELECT 1 AS hidden) SELECT orders.| FROM orders",
    "SELECT o.| FROM (SELECT 1 AS hidden) o",
  ]) {
    await doc(page, workspace, source);
    await input(workspace).press("Control+Space");
    await expect(popup(page)).toHaveCount(0);
  }
  await doc(page, workspace, "SELECT read_");
  await input(workspace).press("Control+Space");
  await expect(popup(page)).toHaveCount(0);
  await doc(page, workspace, 'SELECT COALESCE(o."주문 번호", |) FROM orders o');
  await input(workspace).press("Control+Space");
  await expect(option(page, "주문 번호")).toBeVisible();
  await expect(option(page, "주문 번호")).toContainText("BIGINT");
  await doc(page, workspace, "SELECT COALESCE('a,b', o.|) FROM orders o");
  await input(workspace).press("Control+Space");
  await expect(option(page, "주문 번호")).toBeVisible();
  const hint = page.getByRole("tooltip", { name: "SQL function signature", exact: true });
  await expect(hint).toContainText("COALESCE(value, fallback");
  await expect(hint).toContainText("Argument 2");
  await expectInsideViewport(popup(page));
  await expectInsideViewport(hint);
  await expectNoHorizontalPageOverflow(page);
  expect(await popup(page).getByRole("option").count()).toBeLessThanOrEqual(40);
  const geometry = await page.locator(".cm-tooltip").evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect();
      return {
        className: element.className,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    }),
  );
  await fs.mkdir("artifacts/phase-22/ui", { recursive: true });
  const prefix = `artifacts/phase-22/ui/intellisense-${info.project.name}`;
  await fs.writeFile(
    `${prefix}.json`,
    JSON.stringify({ viewport: page.viewportSize(), geometry }, null, 2),
  );
  await workspace.screenshot({ path: `${prefix}.png` });
  await input(workspace).press("Escape");
  expect(await counts(page)).toEqual(before);
});

test("T-P22-INT-001/007/009 undo, find and existing insertions preserve editor focus", async ({
  page,
}) => {
  const workspace = await setup(page);
  await doc(page, workspace, "SELECT ");
  const search = workspace.getByRole("textbox", { name: "Search SQL columns", exact: true });
  await search.fill("표시명");
  await workspace.locator('[aria-label="SQL column list"]').getByRole("button").dblclick();
  await expect.poll(() => text(workspace)).toBe('SELECT "상품 ""표시명"""');
  await expect(input(workspace)).toBeFocused();
  await input(workspace).press("Control+z");
  await expect.poll(() => text(workspace)).toBe("SELECT ");
  await input(workspace).press("Control+y");
  await expect.poll(() => text(workspace)).toBe('SELECT "상품 ""표시명"""');
  await input(workspace).press("Control+f");
  const find = workspace.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeFocused();
  await find.fill("상품");
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  expect((await counts(page)).startQuery).toBe(0);
});

test("T-P22-INT-007/008 popup run is once and composing shortcuts do not accept or run", async ({
  page,
}) => {
  const workspace = await setup(page);
  await doc(page, workspace, "SELECT ");
  await input(workspace).press("Control+Space");
  await expect(popup(page)).toBeVisible();
  const before = await text(workspace);
  await input(workspace).evaluate((element) => {
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
  expect((await counts(page)).startQuery).toBe(0);
  await input(workspace).press("Control+Enter");
  await expect.poll(async () => (await counts(page)).startQuery).toBe(1);
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toBeVisible();
  expect((await counts(page)).startQuery).toBe(1);
});
