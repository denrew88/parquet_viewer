import fs from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

const helpKey = "data-viewer.sql.examples-help-open.v1";
const editor = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const text = (workspace: Locator) =>
  editor(workspace)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));
const popup = (page: Page) => page.locator(".cm-tooltip-autocomplete");
const resultContext = (workspace: Locator) => workspace.locator('[aria-label="Result context"]');
const planContext = (workspace: Locator) => workspace.locator('[aria-label="Plan context"]');
const sqlA = "SELECT * FROM orders LIMIT 4;";
const sqlB = "SELECT * FROM customers LIMIT 4;";

async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend missing");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const api = module.browserMockBackend.sqlWorkspace;
    if (!api) throw new Error("SQL mock missing");
    const state = {
      holdStatus: false,
      failNextPage: false,
      starts: [] as { runId: string; sql: string }[],
      calls: {} as Record<string, number>,
    };
    Reflect.set(window, "__editorUsability", state);
    for (const key of [
      "describeTables",
      "startQuery",
      "getStatus",
      "readPage",
      "readCell",
    ] as const) {
      const original = api[key];
      state.calls[key] = 0;
      Reflect.set(api, key, (...args: unknown[]) => {
        state.calls[key]++;
        return Reflect.apply(original, api, args);
      });
    }
    const start = api.startQuery.bind(api),
      status = api.getStatus.bind(api),
      read = api.readPage.bind(api);
    const initial = new Map<string, Awaited<ReturnType<typeof api.startQuery>>>();
    api.startQuery = async (request) => {
      state.starts.push({ runId: request.runId, sql: request.sql });
      const response = await start(request);
      initial.set(request.runId, response);
      return response;
    };
    // Explicit response/page barriers test frontend snapshot provenance only;
    // they do not emulate real SQL execution or engine races.
    api.getStatus = async (runId) =>
      state.holdStatus && initial.has(runId) ? structuredClone(initial.get(runId)!) : status(runId);
    api.readPage = async (request) => {
      if (state.failNextPage) {
        state.failNextPage = false;
        throw new Error("Independent result-page retry fixture");
      }
      return read(request);
    };
  });
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  await expect(workspace.getByRole("button", { name: "orders", exact: true })).toBeVisible();
  return workspace;
}
async function documentAt(page: Page, workspace: Locator, marked: string) {
  const cursor = marked.indexOf("|"),
    value = cursor < 0 ? marked : marked.slice(0, cursor) + marked.slice(cursor + 1);
  await editor(workspace).fill(value);
  await expect.poll(() => text(workspace)).toBe(value);
  if (cursor >= 0) {
    await editor(workspace).press("Control+Home");
    for (let i = 0; i < cursor; i++) await page.keyboard.press("ArrowRight");
  }
}
async function execute(workspace: Locator, sql: string) {
  await editor(workspace).fill(sql);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toBeVisible();
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "true");
}
async function capture(page: Page, workspace: Locator, name: string, info: TestInfo) {
  await expectInsideViewport(workspace);
  await expectNoHorizontalPageOverflow(page);
  const geometry = await workspace.evaluate((element) => {
    const rect = (target: Element) => {
      const r = target.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    return {
      workspace: rect(element),
      viewport: { width: innerWidth, height: innerHeight },
      context: [...element.querySelectorAll(".sql-output-context")].map((target) => ({
        text: target.textContent,
        current: target.getAttribute("data-current"),
        ...rect(target),
      })),
      tooltips: [...document.querySelectorAll(".cm-tooltip")].map(rect),
    };
  });
  for (const bounds of geometry.tooltips) {
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
    expect(bounds.top).toBeGreaterThanOrEqual(-1);
    expect(bounds.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  }
  await fs.mkdir("artifacts/phase-22/ui", { recursive: true });
  const prefix = `artifacts/phase-22/ui/editor-usability-${name}-${info.project.name}`;
  await fs.writeFile(`${prefix}.json`, JSON.stringify(geometry, null, 2));
  await workspace.screenshot({ path: `${prefix}.png` });
}

test("T-P22-USE-001/002/003/007 concise candidates, explicit JOIN explanation and honest alias help", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  const before = await page.evaluate(() => ({ ...Reflect.get(window, "__editorUsability").calls }));
  await documentAt(page, workspace, "SELECT o.| FROM orders o");
  await editor(workspace).press("Control+Space");
  const first = popup(page).getByRole("option").first();
  await expect(first.locator(".cm-completionLabel")).toHaveText("주문 번호");
  await expect(first.locator(".cm-completionDetail")).toHaveText("BIGINT");
  await editor(workspace).press("Escape");
  await workspace.getByRole("radio", { name: /^c-numbers only/ }).check();
  await documentAt(page, workspace, "SELECT o.| FROM orders o");
  await editor(workspace).press("Control+Space");
  await expect(first.locator(".cm-completionLabel")).toHaveText("c1");
  await expect(first.locator(".cm-completionDetail")).toHaveText("BIGINT · 주문 번호");
  await editor(workspace).press("Escape");
  await documentAt(page, workspace, "SELECT c.");
  await editor(workspace).press("Control+Space");
  await expect(popup(page)).toHaveCount(0);
  await expect(workspace.locator('[aria-label="Column completion help"]')).toContainText("orders.");
  await expect(workspace.locator('[aria-label="Column completion help"]')).toContainText(
    "c. needs a declared alias",
  );
  await documentAt(page, workspace, "SELECT customers.");
  await editor(workspace).press("Control+Space");
  await expect(popup(page).getByRole("option")).toHaveCount(5);
  await documentAt(page, workspace, "SELECT c.| FROM customers c");
  await editor(workspace).press("Control+Space");
  await expect(first.locator(".cm-completionLabel")).toHaveText("고객 번호");
  await editor(workspace).press("Escape");
  await workspace.getByRole("radio", { name: /^Original names only/ }).check();
  const authored = "SELECT * FROM orders o JOIN customers c ON ";
  await documentAt(page, workspace, authored);
  await editor(workspace).press("Control+Space");
  await expect(first.locator(".cm-completionDetail")).toHaveText("Suggested JOIN");
  const explanation = page.locator(".sql-completion-info");
  const details = explanation.locator("details");
  await expect(explanation.locator("p").first()).toHaveText(
    "Inferred, not a verified foreign key.",
  );
  await expect(details).not.toHaveAttribute("open");
  await expect(details.locator("p")).toBeHidden();
  await capture(page, workspace, "join-closed", info);
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator("p")).toBeVisible();
  await expect(details.locator("p")).toContainText("uniqueness and matching data were not checked");
  expect(await text(workspace)).toBe(authored);
  await expect(popup(page)).toBeVisible();
  await capture(page, workspace, "join-expanded", info);
  await details.locator("summary").click();
  await expect(details).not.toHaveAttribute("open");
  expect(await text(workspace)).toBe(authored);
  const after = await page.evaluate(() => ({ ...Reflect.get(window, "__editorUsability").calls }));
  expect(after).toEqual(before);
});

test("T-P22-USE-005/007 results and plans compare their own exact SQL and binding snapshots", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  await execute(workspace, sqlA);
  await editor(workspace).fill(sqlB);
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "false");
  await expect(resultContext(workspace)).toContainText("SQL changed · previous result");
  await editor(workspace).fill(sqlA);
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "true");
  await editor(workspace).press("End");
  await page.keyboard.type(" ");
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "false");
  await editor(workspace).fill(sqlA);
  await workspace.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(planContext(workspace)).toBeVisible();
  await expect(planContext(workspace)).toHaveAttribute("data-current", "true");
  await execute(workspace, sqlB);
  await workspace.getByRole("tab", { name: "Execution plan", exact: true }).click();
  await expect(planContext(workspace)).toHaveAttribute("data-current", "false");
  await expect(planContext(workspace)).toContainText("SQL changed · previous plan");
  await editor(workspace).fill(sqlA);
  await expect(planContext(workspace)).toHaveAttribute("data-current", "true");
  await workspace.getByRole("button", { name: "orders", exact: true }).click();
  await workspace.getByRole("radio", { name: /^c-numbers only/ }).check();
  await expect(planContext(workspace)).toContainText("Table setup changed · previous plan");
  await workspace.getByRole("radio", { name: /^Original names only/ }).check();
  await expect(planContext(workspace)).toHaveAttribute("data-current", "true");
  await workspace.getByRole("button", { name: "Rename table orders", exact: true }).click();
  await workspace.getByRole("textbox", { name: "Table alias", exact: true }).fill("renamed_orders");
  await workspace.getByRole("button", { name: "Save table alias", exact: true }).click();
  await expect(planContext(workspace)).toHaveAttribute("data-current", "false");
  await workspace.getByRole("button", { name: "Rename table renamed_orders", exact: true }).click();
  await workspace.getByRole("textbox", { name: "Table alias", exact: true }).fill("orders");
  await workspace.getByRole("button", { name: "Save table alias", exact: true }).click();
  await expect(planContext(workspace)).toHaveAttribute("data-current", "true");
  expect(await text(workspace)).toBe(sqlA);
  await workspace.getByRole("tab", { name: "Results", exact: true }).click();
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "false");
  await expect(resultContext(workspace)).toContainText("SQL changed · previous result");
  await capture(page, workspace, "previous-result", info);
});

test("T-P22-USE-005/006 running edits, cancellation, failure and page retry preserve original provenance", async ({
  page,
}) => {
  const workspace = await setup(page);
  await execute(workspace, sqlA);
  await editor(workspace).fill(sqlA);
  await workspace.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(planContext(workspace)).toBeVisible();
  await page.evaluate(() => {
    Reflect.get(window, "__editorUsability").holdStatus = true;
  });
  await editor(workspace).fill(sqlB);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await editor(workspace).fill(sqlA);
  await page.evaluate(() => {
    Reflect.get(window, "__editorUsability").holdStatus = false;
  });
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(resultContext(workspace)).toContainText("SQL changed · previous result");
  await editor(workspace).fill(sqlB);
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "true");
  await execute(workspace, sqlA);
  await editor(workspace).fill("SELECT /* slow */ * FROM customers;");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(resultContext(workspace)).toContainText("Latest execution cancelled");
  await editor(workspace).fill(sqlA);
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "true");
  await expect(resultContext(workspace)).toContainText("Current result");
  await expect(resultContext(workspace)).toContainText("Latest execution cancelled");
  await editor(workspace).fill("SELECT /* fail */ * FROM customers;");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    workspace.getByRole("tabpanel", { name: "Messages", exact: true }).getByRole("alert"),
  ).toBeVisible();
  await editor(workspace).fill(sqlA);
  await workspace.getByRole("tab", { name: "Results", exact: true }).click();
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "true");
  await expect(resultContext(workspace)).toContainText("Latest execution failed");
  await workspace.getByRole("tab", { name: "Execution plan", exact: true }).click();
  await expect(planContext(workspace)).toHaveAttribute("data-current", "true");
  await expect(planContext(workspace)).toContainText("Latest execution failed");
  await page.evaluate(() => {
    Reflect.get(window, "__editorUsability").failNextPage = true;
  });
  const submitted = "SELECT * FROM orders LIMIT 3;",
    edited = "SELECT * FROM orders LIMIT 2;";
  await editor(workspace).fill(submitted);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    workspace.getByRole("button", { name: "Retry result page", exact: true }),
  ).toBeVisible();
  await editor(workspace).fill(edited);
  await workspace.getByRole("button", { name: "Retry result page", exact: true }).click();
  await expect(
    workspace.getByRole("button", { name: "Retry result page", exact: true }),
  ).toHaveCount(0);
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "false");
  const lastRun = await page.evaluate(() => Reflect.get(window, "__editorUsability").starts.at(-1));
  expect(lastRun.sql).toBe(submitted);
  await expect(workspace.getByRole("grid", { name: "Data preview", exact: true })).toHaveAttribute(
    "data-query-id",
    lastRun.runId,
  );
  await editor(workspace).fill(submitted);
  await expect(resultContext(workspace)).toHaveAttribute("data-current", "true");
});

test("T-P22-USE-004 help visibility survives reload without changing SQL or backend settings", async ({
  page,
}) => {
  let workspace = await setup(page);
  const help = () => workspace.getByRole("button", { name: "Examples & help", exact: true });
  await expect(help()).toHaveAttribute("aria-expanded", "true");
  await editor(workspace).fill(sqlA);
  await help().click();
  await expect(help()).toHaveAttribute("aria-expanded", "false");
  expect(await text(workspace)).toBe(sqlA);
  expect(await page.evaluate((key) => localStorage.getItem(key), helpKey)).toBe("false");
  await page.getByRole("tab", { name: "orders.csv (sales)", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  await expect(help()).toHaveAttribute("aria-expanded", "false");
  expect(await text(workspace)).toBe(sqlA);
  workspace = await setup(page);
  await expect(help()).toHaveAttribute("aria-expanded", "false");
  await help().click();
  expect(await page.evaluate((key) => localStorage.getItem(key), helpKey)).toBe("true");
  workspace = await setup(page);
  await expect(help()).toHaveAttribute("aria-expanded", "true");
  await page.evaluate((key) => localStorage.setItem(key, "invalid-preference"), helpKey);
  workspace = await setup(page);
  await expect(help()).toHaveAttribute("aria-expanded", "true");
});
