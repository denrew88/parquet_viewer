import fs from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

// UI-only lifecycle fixture: dependencies are explicitly declared by this test,
// never inferred from SQL strings. Real DuckDB binding/worker/leases are native gates.
async function setup(page: Page) {
  await page.goto("/?mock=sql22");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!url) throw new Error("Browser backend module unavailable");
    const module = (await (0, eval)(
      `import(${JSON.stringify(url)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend,
      api = backend.sqlWorkspace;
    if (!api) throw new Error("SQL mock unavailable");
    const originalStart = api.startQuery.bind(api),
      originalStatus = api.getStatus.bind(api),
      originalCancel = api.cancelQuery.bind(api),
      originalClose = backend.closeDataFile.bind(backend);
    const probe = { referenceAlias: "orders", manualCancels: 0, closedReferences: [] as string[] };
    const refs = new Map<string, { documentId: string; sessionId: string; alias: string }[]>();
    const reasons = new Map<string, string>();
    Reflect.set(window, "__sourceLifecycle", probe);
    api.startQuery = async (request) => {
      refs.set(
        request.runId,
        request.tables.filter((table) => table.alias === probe.referenceAlias),
      );
      return originalStart(request);
    };
    api.cancelQuery = async (runId) => {
      probe.manualCancels++;
      return originalCancel(runId);
    };
    api.getStatus = async (runId) => {
      const status = await originalStatus(runId),
        reason = reasons.get(runId);
      return reason && status.state === "cancelled"
        ? { ...status, error: { code: "TaskCancelled", message: reason } }
        : status;
    };
    backend.closeDataFile = async (documentId, sessionId) => {
      await originalClose(documentId, sessionId);
      for (const [runId, sources] of refs) {
        const source = sources.find(
          (item) => item.documentId === documentId && item.sessionId === sessionId,
        );
        if (!source) continue;
        const status = await originalStatus(runId);
        if (!["queued", "running"].includes(status.state)) continue;
        reasons.set(
          runId,
          `SQL execution cancelled because input ${source.alias} was closed. The previous successful result is unchanged.`,
        );
        probe.closedReferences.push(source.alias);
        await originalCancel(runId);
      }
    };
  });
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  await expect(table(workspace, "orders")).toBeVisible();
  return workspace;
}
const table = (workspace: Locator, alias: string) =>
  workspace.getByRole("button", { name: alias, exact: true });
const editor = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const sqlText = (workspace: Locator) =>
  editor(workspace)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));
const probe = (page: Page) =>
  page.evaluate(() => {
    const value = Reflect.get(window, "__sourceLifecycle");
    return {
      manualCancels: value.manualCancels as number,
      closedReferences: [...value.closedReferences] as string[],
    };
  });
async function retainedResult(workspace: Locator) {
  await editor(workspace).fill("SELECT * FROM orders LIMIT 4;");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toBeVisible();
  const result = workspace.getByRole("tabpanel", { name: "Results", exact: true });
  const values = await result.getByRole("gridcell").allTextContents();
  expect(values.length).toBeGreaterThan(0);
  return { result, values };
}

test("T-P22-LIFE-006/008 card path, mode, padding and keyboard select; pencil remains separate", async ({
  page,
}, info) => {
  const workspace = await setup(page);
  await editor(workspace).fill("SELECT preserve_authored_sql;");
  await table(workspace, "orders_2").locator(".sql-table__path").click();
  await expect(table(workspace, "orders_2")).toHaveAttribute("aria-pressed", "true");
  await expect(workspace.getByRole("heading", { name: "orders_2 columns" })).toBeVisible();
  await expect(workspace.getByRole("textbox", { name: "Table alias", exact: true })).toHaveCount(0);
  await table(workspace, "customers").locator(".sql-table__mode").click();
  await expect(table(workspace, "customers")).toHaveAttribute("aria-pressed", "true");
  await expect(workspace.getByRole("heading", { name: "customers columns" })).toBeVisible();
  const orders = table(workspace, "orders");
  await orders.scrollIntoViewIfNeeded();
  const size = await orders.boundingBox();
  if (!size) throw new Error("Source selection button has no geometry");
  await orders.click({ position: { x: size.width - 5, y: size.height - 5 } });
  await expect(orders).toHaveAttribute("aria-pressed", "true");
  const archived = table(workspace, "orders_2");
  await archived.focus();
  await archived.press("Space");
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  await orders.focus();
  await orders.press("Enter");
  await expect(orders).toHaveAttribute("aria-pressed", "true");
  await archived.click();
  await workspace.getByRole("button", { name: "Rename table orders", exact: true }).click();
  const alias = workspace.getByRole("textbox", { name: "Table alias", exact: true });
  await expect(alias).toBeFocused();
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  await alias.fill("discarded_alias");
  await alias.press("Escape");
  await expect(orders).toHaveCount(1);
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  expect(await sqlText(workspace)).toBe("SELECT preserve_authored_sql;");
  await expectNoHorizontalPageOverflow(page);
  await archived.scrollIntoViewIfNeeded();
  await expectInsideViewport(archived);
  const geometry = await workspace.locator(".sql-table").evaluateAll((cards) =>
    cards.map((card) => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const button = card.querySelector(".sql-table__select"),
        pencil = card.querySelector(".sql-icon-button"),
        list = card.closest(".sql-table-list"),
        path = button?.querySelector(".sql-table__path"),
        mode = button?.querySelector(".sql-table__mode");
      if (!button || !pencil || !list || !path || !mode)
        throw new Error("Source card controls missing");
      return {
        label: button.getAttribute("aria-label"),
        selected: button.getAttribute("aria-pressed") === "true",
        card: rect(card),
        button: rect(button),
        pencil: rect(pencil),
        list: rect(list),
        path: rect(path),
        mode: rect(mode),
        nestedButtons: button.querySelectorAll("button").length,
      };
    }),
  );
  for (const item of geometry) {
    expect(item.nestedButtons).toBe(0);
    expect(item.button.left).toBeGreaterThanOrEqual(item.card.left - 1);
    expect(item.button.right).toBeLessThanOrEqual(item.card.right + 1);
    expect(item.button.width).toBeGreaterThanOrEqual(item.card.width - 3);
    if (item.selected) {
      for (const bounds of [item.button, item.path, item.mode]) {
        expect(bounds.top, `${item.label} selected content top`).toBeGreaterThanOrEqual(
          item.list.top - 1,
        );
        expect(bounds.bottom, `${item.label} selected content bottom`).toBeLessThanOrEqual(
          item.list.bottom + 1,
        );
        expect(bounds.left, `${item.label} selected content left`).toBeGreaterThanOrEqual(
          item.list.left - 1,
        );
        expect(bounds.right, `${item.label} selected content right`).toBeLessThanOrEqual(
          item.list.right + 1,
        );
      }
    }
  }
  expect(geometry.filter((item) => item.selected)).toHaveLength(1);
  await fs.mkdir("artifacts/phase-22/ui", { recursive: true });
  const prefix = `artifacts/phase-22/ui/source-lifecycle-${info.project.name}`;
  await fs.writeFile(
    `${prefix}.json`,
    JSON.stringify({ viewport: page.viewportSize(), geometry }, null, 2),
  );
  await workspace.screenshot({ path: `${prefix}.png` });
});

test("T-P22-LIFE-002/005 unrelated close keeps run, SQL, completion refresh and prior result", async ({
  page,
}) => {
  const workspace = await setup(page);
  const { result, values } = await retainedResult(workspace);
  const authored = "SELECT /* slow */ * FROM orders o";
  await editor(workspace).fill(authored);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close customers.parquet", exact: true }).click();
  await expect(table(workspace, "customers")).toHaveCount(0);
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  expect(await sqlText(workspace)).toBe(authored);
  expect(await result.getByRole("gridcell").allTextContents()).toEqual(values);
  expect(await probe(page)).toEqual({ manualCancels: 0, closedReferences: [] });
  await editor(workspace).focus();
  await editor(workspace).press("Control+Home");
  for (let i = 0; i < authored.indexOf("FROM ") + 5; i++) await page.keyboard.press("ArrowRight");
  await editor(workspace).press("Control+Space");
  const labels = page.locator(".cm-tooltip-autocomplete .cm-completionLabel");
  await expect(labels.filter({ hasText: /^orders$/ })).toBeVisible();
  await expect(labels.filter({ hasText: /^customers$/ })).toHaveCount(0);
  await editor(workspace).press("Escape");
  expect(await sqlText(workspace)).toBe(authored);
  await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    workspace.getByRole("status").filter({ hasText: "previous successful result is unchanged" }),
  ).toBeVisible();
  expect(await result.getByRole("gridcell").allTextContents()).toEqual(values);
});

test("T-P22-LIFE-003/004/005 explicit mock source-close reason keeps authored SQL and independent result", async ({
  page,
}) => {
  const workspace = await setup(page);
  const { result, values } = await retainedResult(workspace);
  await page.evaluate(() => {
    Reflect.get(window, "__sourceLifecycle").referenceAlias = "customers";
  });
  const authored = "SELECT /* slow */ * FROM customers";
  await editor(workspace).fill(authored);
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close customers.parquet", exact: true }).click();
  await expect(
    workspace.getByRole("status").filter({ hasText: "input customers was closed" }),
  ).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  expect(await sqlText(workspace)).toBe(authored);
  expect(await result.getByRole("gridcell").allTextContents()).toEqual(values);
  expect(await probe(page)).toEqual({ manualCancels: 0, closedReferences: ["customers"] });
  await workspace.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(workspace.getByRole("tabpanel", { name: "Messages", exact: true })).toContainText(
    "input customers was closed",
  );
  await page.getByRole("button", { name: "Close orders.csv (sales)", exact: true }).click();
  await expect(table(workspace, "orders")).toHaveCount(0);
  expect(await sqlText(workspace)).toBe(authored);
  await workspace.getByRole("tab", { name: "Results", exact: true }).click();
  expect(await result.getByRole("gridcell").allTextContents()).toEqual(values);
});
