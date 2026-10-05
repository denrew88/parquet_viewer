import { expect, test, type Page } from "@playwright/test";
import { openMockFile } from "./helpers";

interface Phase19Probe {
  lastExecuteQuery: import("../src/backend").ExecuteQueryRequest | null;
}

async function installPhase19Probe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const backendUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname === "/src/backend.ts");
    if (!backendUrl) throw new Error("The browser mock backend module was not loaded.");
    const module = (await (0, eval)(
      `import(${JSON.stringify(backendUrl)})`,
    )) as typeof import("../src/backend");
    const backend = module.browserMockBackend;
    const probe: Phase19Probe = { lastExecuteQuery: null };
    Reflect.set(window, "__phase19Probe", probe);
    const executeQuery = backend.executeQuery.bind(backend);
    backend.executeQuery = async (request) => {
      probe.lastExecuteQuery = request;
      return executeQuery(request);
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await installPhase19Probe(page);
});

test("dictionary categorical exposes text filtering and submits a text plan", async ({ page }) => {
  await openMockFile(page, "large", "large-5850000.parquet");

  await page.getByRole("button", { name: "Filter category" }).click();
  const dialog = page.getByRole("dialog", { name: "Filter category" });
  const operator = dialog.getByRole("combobox", { name: "Filter operator" });
  await expect(operator.getByRole("option", { name: "Contains" })).toHaveCount(1);
  await expect(operator.getByRole("option", { name: "Greater than" })).toHaveCount(0);
  await operator.selectOption("startsWith");
  await dialog.getByRole("textbox", { name: "Value", exact: true }).fill("category-1");
  await dialog.getByRole("button", { name: "Apply" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Reflect.get(window, "__phase19Probe") as Phase19Probe).lastExecuteQuery?.plan
            .filters[0] ?? null,
      ),
    )
    .toEqual({
      id: "filter:category",
      columnId: "category",
      scalarType: "text",
      operator: "startsWith",
      values: ["category-1"],
    });
});
