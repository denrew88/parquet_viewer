import fs from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { expectInsideViewport, expectNoHorizontalPageOverflow } from "./helpers";

// Browser tests assert interaction/layout against an explicit SQL mock. Real SQL
// semantics, worker isolation, storage and OS clipboard require native evidence.
async function openSql(page: Page) {
  await page.goto("/?mock=sql22");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("button", { name: "SQL workspace", exact: true }).click();
  const workspace = page.getByRole("region", { name: "SQL workspace", exact: true });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("button", { name: "orders", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "orders_2", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "customers", exact: true })).toBeVisible();
  return workspace;
}

const namesRadio = (workspace: Locator) =>
  workspace.getByRole("radio", { name: /^Original names only/ });
const ordinalRadio = (workspace: Locator) =>
  workspace.getByRole("radio", { name: /^c-numbers only/ });
const editor = (workspace: Locator) =>
  workspace.getByRole("textbox", { name: "SQL editor", exact: true });
const columnList = (workspace: Locator) => workspace.locator('[aria-label="SQL column list"]');

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expectInsideViewport(control);
  expect(
    await control.evaluate((target) => {
      const r = target.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (target === hit || target.contains(hit));
    }),
  ).toBe(true);
}

async function chooseTable(workspace: Locator, alias: string) {
  await workspace.getByRole("button", { name: alias, exact: true }).click();
  await expect(workspace.getByRole("button", { name: alias, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

async function measure(workspace: Locator, name: string, info: TestInfo) {
  await expectInsideViewport(workspace);
  const value = await workspace.evaluate((element) => {
    const rectangle = (target: Element) => {
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
    const visible = (target: Element) => {
      const bounds = target.getBoundingClientRect(),
        style = getComputedStyle(target);
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const mode = element.querySelector("fieldset"),
      text = element.querySelector("textarea");
    const body = document.body;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      workspace: rectangle(element),
      body: { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth },
      mode: mode ? rectangle(mode) : null,
      editor: text ? rectangle(text) : null,
      controls: Array.from(element.querySelectorAll("button, input, textarea"))
        .filter(visible)
        // Virtual-column children intentionally scroll within a bounded list.
        .filter((target) => !target.closest('[aria-label="SQL column list"]'))
        .map((target) => ({
          label: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName,
          ...rectangle(target),
        })),
      renderedColumns: element.querySelectorAll('[aria-label="SQL column list"] button').length,
      selectedRadios: element.querySelectorAll('fieldset input[type="radio"]:checked').length,
      alignment: Array.from(element.querySelectorAll('[data-grid-row="0"][data-grid-column]')).map(
        (cell) => {
          const index = cell.getAttribute("data-grid-column");
          const header = element.querySelector(
            `.virtual-grid__column-header[data-column-index="${index}"]`,
          );
          if (!header) return { index, missingHeader: true, leftDelta: 0, widthDelta: 0 };
          const a = cell.getBoundingClientRect(),
            b = header.getBoundingClientRect();
          return {
            index,
            missingHeader: false,
            leftDelta: Math.abs(a.left - b.left),
            widthDelta: Math.abs(a.width - b.width),
          };
        },
      ),
    };
  });
  expect(value.body.scrollWidth).toBeLessThanOrEqual(value.body.clientWidth + 1);
  expect(value.selectedRadios).toBe(1);
  for (const column of value.alignment) {
    expect(column.missingHeader, `header ${column.index}`).toBe(false);
    expect(column.leftDelta, `column ${column.index} start`).toBeLessThanOrEqual(1);
    expect(column.widthDelta, `column ${column.index} width`).toBeLessThanOrEqual(1);
  }
  for (const control of value.controls) {
    expect(control.left, control.label).toBeGreaterThanOrEqual(value.workspace.left - 1);
    expect(control.right, control.label).toBeLessThanOrEqual(value.workspace.right + 1);
  }
  const directory = "artifacts/phase-22/ui";
  await fs.mkdir(directory, { recursive: true });
  const imagePath = `${directory}/${name}-${info.project.name}.png`;
  await fs.writeFile(
    `${directory}/${name}-${info.project.name}.json`,
    JSON.stringify(value, null, 2),
  );
  await workspace.screenshot({ path: imagePath });
  await info.attach(name, { path: imagePath, contentType: "image/png" });
  return value;
}

test("T-P22-002/003/019 raw header eligibility and one independent mode per table", async ({
  page,
}, info) => {
  const workspace = await openSql(page);
  await expect(namesRadio(workspace)).toBeChecked();
  await expect(ordinalRadio(workspace)).not.toBeChecked();
  await editor(workspace).fill("SELECT untouched_sql;");
  await ordinalRadio(workspace).check();
  await expect(namesRadio(workspace)).not.toBeChecked();
  await expect(ordinalRadio(workspace)).toBeChecked();
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe("SELECT untouched_sql;");
  await expect(
    workspace.getByRole("status").filter({ hasText: "Existing SQL was not rewritten" }),
  ).toBeVisible();
  await chooseTable(workspace, "customers");
  await expect(namesRadio(workspace)).toBeChecked();
  await chooseTable(workspace, "orders");
  await expect(ordinalRadio(workspace)).toBeChecked();
  await ordinalRadio(workspace).focus();
  await page.keyboard.press("ArrowUp");
  await expect(namesRadio(workspace)).toBeChecked();
  await chooseTable(workspace, "orders_2");
  await expect(namesRadio(workspace)).toBeDisabled();
  await expect(ordinalRadio(workspace)).toBeChecked();
  await expect(workspace.getByRole("group", { name: "SQL column reference" })).toContainText(
    /duplicate/i,
  );
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe("SELECT untouched_sql;");
  await measure(workspace, "blocked-name-mode", info);
  await expectNoHorizontalPageOverflow(page);
});

test("T-P22-001/004/019 alias editing and examples preserve SQL until explicit insertion", async ({
  page,
}) => {
  const workspace = await openSql(page);
  await editor(workspace).fill("SELECT preserve_this_text;");
  await workspace.getByRole("button", { name: "Rename table orders", exact: true }).click();
  const alias = workspace.getByRole("textbox", { name: "Table alias", exact: true });
  await alias.fill("customers");
  await workspace.getByRole("button", { name: "Save table alias", exact: true }).click();
  await expect(workspace.getByRole("alert")).toContainText(/already in use/i);
  await alias.fill("discarded_alias");
  await alias.press("Escape");
  await expect(workspace.getByRole("button", { name: "orders", exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "orders", exact: true }).dblclick();
  await workspace.getByRole("textbox", { name: "Table alias", exact: true }).fill("current_orders");
  await workspace.getByRole("textbox", { name: "Table alias", exact: true }).press("Enter");
  await expect(
    workspace.getByRole("button", { name: "current_orders", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe("SELECT preserve_this_text;");
  await workspace.getByRole("button", { name: "JOIN", exact: true }).click();
  const example = workspace.locator('pre[aria-label="SQL example"]');
  await expect(example).toContainText("current_orders AS a");
  await expect(example).toContainText('a."');
  await ordinalRadio(workspace).check();
  await expect(example).toContainText("a.c1");
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe("SELECT preserve_this_text;");
  await workspace.getByRole("button", { name: "Insert example", exact: true }).click();
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe((await example.textContent()) ?? "");
  await expect(
    workspace.getByRole("status").filter({ hasText: "It has not been executed" }),
  ).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toHaveCount(0);
});

test("T-P22-004/019 selected-table column search, original ordinals and quoting", async ({
  page,
}) => {
  const workspace = await openSql(page);
  const search = workspace.getByRole("textbox", { name: "Search SQL columns", exact: true });
  const list = columnList(workspace);
  const initialCount = await list.getByRole("button").count();
  expect(initialCount).toBeLessThan(38);
  await search.fill("표시명");
  await expect(list.getByRole("button")).toHaveCount(1);
  await editor(workspace).fill("SELECT ");
  await list.getByRole("button").dblclick();
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe('SELECT "상품 ""표시명"""');
  await search.fill("");
  await ordinalRadio(workspace).check();
  await search.fill("c38");
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(list.getByRole("button")).toContainText("c38");
  await editor(workspace).fill("SELECT ");
  await list.getByRole("button").dblclick();
  await expect
    .poll(() =>
      editor(workspace)
        .locator(".cm-line")
        .allTextContents()
        .then((lines) => lines.join("\n")),
    )
    .toBe("SELECT c38");
  await chooseTable(workspace, "customers");
  await expect(search).toHaveValue("");
  await expect(list.getByRole("button")).toHaveCount(5);
});

test("T-P22-018/019/021 examples, writing help and result-free plan states", async ({
  page,
}, info) => {
  const workspace = await openSql(page);
  await workspace.getByRole("tab", { name: "Writing guide", exact: true }).click();
  await expect(
    workspace.getByRole("heading", { name: "One mode per table", exact: true }),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "Examples & help", exact: true }).click();
  await expect(
    workspace.getByRole("complementary", { name: "SQL examples and help", exact: true }),
  ).toHaveCount(0);
  await workspace.getByRole("button", { name: "Examples & help", exact: true }).click();
  await workspace.getByRole("tab", { name: "Examples", exact: true }).click();
  await expectReachable(workspace.getByRole("button", { name: "Insert example", exact: true }));
  await workspace.getByRole("button", { name: "Insert example", exact: true }).click();
  await workspace.getByRole("button", { name: "Explain", exact: true }).click();
  const plan = workspace.getByRole("tabpanel", { name: "Execution plan", exact: true });
  await expect(plan).toBeVisible();
  await expect(plan.locator('[aria-label="Execution plan nodes"] button').first()).toBeVisible();
  await expect(plan).toContainText("Not provided");
  await plan.getByText("Raw execution plan", { exact: true }).click();
  await expect(plan.locator("pre")).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toHaveCount(0);
  await measure(workspace, "execution-plan", info);
});

test("T-P22-FLOW-004/005 Analyze ranks measured operators and plan panes scroll independently", async ({
  page,
}, info) => {
  const workspace = await openSql(page);
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
    const start = api.startQuery.bind(api);
    const status = api.getStatus.bind(api);
    const analyzedRuns = new Set<string>();
    api.startQuery = async (request) => {
      if (request.action === "analyze") analyzedRuns.add(request.runId);
      return start(request);
    };
    api.getStatus = async (runId) => {
      const result = await status(runId);
      if (result.state !== "complete" || !analyzedRuns.has(runId)) return result;
      return {
        ...result,
        elapsedMs: 100,
        planText: "deterministic Analyze plan",
        planJson: {
          latency: 0.1,
          children: [
            {
              operator_name: "HASH_JOIN",
              operator_timing: 0.03,
              extra_info: Object.fromEntries(
                Array.from({ length: 30 }, (_, index) => [
                  `Test detail ${index + 1}`,
                  `value ${index + 1}`,
                ]),
              ),
              children: [
                { operator_name: "PARQUET_SCAN", operator_timing: 0.01 },
                ...Array.from({ length: 24 }, (_, index) => ({
                  operator_name: `FILTER ${index + 1}`,
                  operator_timing: 0,
                })),
              ],
            },
          ],
        },
      };
    };
  });
  await editor(workspace).fill("SELECT 1;");
  const plan = workspace.getByRole("tabpanel", { name: "Execution plan", exact: true });
  await workspace.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(plan.getByRole("button", { name: "HASH_JOIN", exact: true })).toBeVisible();
  const summary = plan.getByRole("region", { name: "Operator timing summary", exact: true });
  await expect(summary).toHaveCount(0);
  await workspace.getByRole("button", { name: "Analyze", exact: true }).click();

  const nodes = plan.getByRole("region", { name: "Execution plan nodes", exact: true });
  const detail = plan.getByRole("region", { name: "Execution plan detail", exact: true });
  await expect(summary).toContainText("Slowest operator");
  await expect(summary).toContainText("HASH_JOIN");
  await expect(summary).toContainText("30 ms");
  await expect(summary).toContainText("75%");
  await expect(nodes.getByRole("button", { name: /PARQUET_SCAN/ })).toContainText("10 ms");
  await expect(nodes.getByRole("button", { name: /PARQUET_SCAN/ })).toContainText("25%");
  await expect(nodes.getByRole("button", { name: /HASH_JOIN/ })).toContainText("Slowest");

  const position = (pane: Locator) => pane.evaluate((element) => element.scrollTop);
  const paneGeometry = [];
  for (const pane of [nodes, detail]) {
    await expectInsideViewport(pane);
    const geometry = await pane.evaluate((element) => ({
      label: element.getAttribute("aria-label"),
      bounds: element.getBoundingClientRect().toJSON(),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    paneGeometry.push(geometry);
    expect(await position(pane)).toBe(0);
  }
  const [tree, properties] = paneGeometry.map(({ bounds }) => bounds);
  expect(tree.right <= properties.left + 1 || tree.bottom <= properties.top + 1).toBe(true);
  await expectNoHorizontalPageOverflow(page);
  await info.attach("measured plan geometry", {
    body: JSON.stringify(paneGeometry, null, 2),
    contentType: "application/json",
  });
  await info.attach("measured plan panes", {
    body: await workspace.screenshot(),
    contentType: "image/png",
  });
  await nodes.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => position(nodes)).toBeGreaterThan(0);
  expect(await position(detail)).toBe(0);
  const treePosition = await position(nodes);
  await detail.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => position(detail)).toBeGreaterThan(0);
  expect(await position(nodes)).toBe(treePosition);
  await plan.getByText("Raw execution plan", { exact: true }).click();
  await expect(plan.locator("pre")).toHaveText("deterministic Analyze plan");
});

test("T-P22-014/017/020/021 execution failure and cancellation preserve the prior result", async ({
  page,
}, info) => {
  const workspace = await openSql(page);
  const run = workspace.getByRole("button", { name: "Run", exact: true });
  await editor(workspace).fill("SELECT 1;");
  await run.click();
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toBeVisible();
  const results = workspace.getByRole("tabpanel", { name: "Results", exact: true });
  const baseline = await results.getByRole("gridcell").allTextContents();
  expect(baseline.length).toBeGreaterThan(0);
  await measure(workspace, "browser", info);
  await editor(workspace).fill("SELECT /* slow */ 1;");
  await editor(workspace).press("Control+End");
  await editor(workspace).press("ArrowLeft");
  await editor(workspace).press("Control+Enter");
  await expect(workspace.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await expect(namesRadio(workspace)).toBeDisabled();
  await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    workspace.getByRole("status").filter({ hasText: "previous successful result is unchanged" }),
  ).toBeVisible();
  await expect(results).toBeVisible();
  expect(await results.getByRole("gridcell").allTextContents()).toEqual(baseline);
  await editor(workspace).fill("SELECT /* fail */ 1;");
  await run.click();
  await expect(
    workspace.getByRole("tabpanel", { name: "Messages", exact: true }).getByRole("alert"),
  ).toBeVisible();
  await workspace.getByRole("tab", { name: "Results", exact: true }).click();
  expect(await results.getByRole("gridcell").allTextContents()).toEqual(baseline);
  await expectNoHorizontalPageOverflow(page);
});

test("T-P22-009/013/020 duplicate result labels retain independent selection and copy", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const workspace = await openSql(page);
  await editor(workspace).fill("SELECT 1 AS value, 'Seoul' AS value;");
  await editor(workspace).press("Control+End");
  await editor(workspace).press("ArrowLeft");
  await editor(workspace).press("Control+Enter");
  const results = workspace.getByRole("tabpanel", { name: "Results", exact: true });
  await expect(workspace.getByRole("button", { name: "Clear result", exact: true })).toBeVisible();
  const grid = results.getByRole("grid", { name: "Data preview" });
  await expect(grid.getByRole("columnheader", { name: "value (r0)", exact: true })).toHaveAttribute(
    "data-column-id",
    "r0",
  );
  await expect(grid.getByRole("columnheader", { name: "value (r1)", exact: true })).toHaveAttribute(
    "data-column-id",
    "r1",
  );
  const first = grid.locator('[data-grid-row="0"][data-grid-column="0"]');
  const second = grid.locator('[data-grid-row="0"][data-grid-column="1"]');
  await expect(first).toHaveText("1");
  await expect(second).toHaveText("Seoul");
  await first.click();
  await grid.press("Shift+ArrowRight");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(second).toHaveAttribute("aria-selected", "true");
  expect(await first.evaluate((cell) => getComputedStyle(cell).boxShadow)).toContain("inset");
  await grid.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("1\tSeoul");
  await editor(workspace).fill("SELECT 2;");
  await editor(workspace).press("ArrowDown");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await workspace.getByRole("button", { name: "Clear result", exact: true }).click();
  await expect(results.getByRole("grid")).toHaveCount(0);
  await expect(results).toContainText("Run a query to view its result");
});

test("T-P22-EXPORT-001/002 exports the retained result as files or full clipboard TSV", async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const workspace = await openSql(page);
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
    const start = api.startQuery.bind(api);
    const state = {
      runIds: [] as string[],
      requests: [] as { runId: string; resultId: string; format: string }[],
    };
    Reflect.set(window, "__sqlExport", state);
    api.startQuery = async (request) => {
      state.runIds.push(request.runId);
      return start(request);
    };
    Reflect.set(api, "exportResult", async (request: (typeof state.requests)[number]) => {
      state.requests.push(request);
      if (request.format === "parquet") throw new Error("Export write test failure");
      return request.format === "csv";
    });
  });
  await editor(workspace).fill("SELECT 1;");
  await workspace.getByRole("button", { name: "Run", exact: true }).click();
  const results = workspace.getByRole("tabpanel", { name: "Results", exact: true });
  const grid = results.getByRole("grid", { name: "Data preview" });
  await expect(grid).toBeVisible();
  const exportButton = results.getByRole("button", { name: "Export results", exact: true });
  const formats = results.getByRole("group", { name: "Export format", exact: true });
  await editor(workspace).fill("SELECT 999;");
  await grid.locator('[data-grid-row="0"][data-grid-column="0"]').click();
  for (const format of ["CSV", "TSV", "Parquet", "Clipboard"]) {
    await exportButton.click();
    await expectNoHorizontalPageOverflow(page);
    await expectInsideViewport(formats);
    if (format === "CSV") {
      await info.attach("result export menu", {
        body: await workspace.screenshot(),
        contentType: "image/png",
      });
    }
    await formats.getByRole("button", { name: format, exact: true }).click();
    await expect(exportButton).toBeEnabled();
    await expect(grid).toBeVisible();
    if (format === "CSV") await expect(results.getByText("Result exported.")).toBeVisible();
    if (format === "TSV") await expect(results.getByText("Export cancelled.")).toBeVisible();
    if (format === "Parquet")
      await expect(results.getByRole("alert")).toContainText("Export write test failure");
  }
  const state = await page.evaluate(
    () =>
      Reflect.get(window, "__sqlExport") as {
        runIds: string[];
        requests: { runId: string; resultId: string; format: string }[];
      },
  );
  expect(state.runIds).toHaveLength(1);
  const [runId] = state.runIds;
  expect(state.requests).toEqual(
    ["csv", "tsv", "parquet"].map((format) => ({
      format,
      runId,
      resultId: `sql-result-${runId}`,
    })),
  );
  await expect
    .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/))
    .toEqual([
      "value\tvalue\tamount",
      "1\tSeoul\t100000.25",
      "2\tBusan\t200000.25",
      "3\tIncheon\t300000.25",
      "4\tDaegu\t400000.25",
    ]);
});
