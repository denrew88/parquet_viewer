import { expect, type Locator, type Page } from "@playwright/test";

export async function setMockScenario(page: Page, scenario: string): Promise<void> {
  await page.evaluate((value) => {
    window.history.replaceState(null, "", `/?mock=${value}`);
  }, scenario);
}

export async function openMockFile(page: Page, scenario: string, tabName: string): Promise<void> {
  await setMockScenario(page, scenario);
  await page.getByRole("button", { name: "Open file" }).click();
  await expect(page.getByRole("tab", { name: tabName })).toBeVisible();
}

export async function installCleanCsvSelection(page: Page): Promise<void> {
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
    const withoutStructuralIssues = <T extends { csvMetadata: unknown }>(summary: T): T => ({
      ...summary,
      csvMetadata:
        summary.csvMetadata && typeof summary.csvMetadata === "object"
          ? {
              ...summary.csvMetadata,
              structureIssueCount: 0,
              structureIssues: [],
            }
          : null,
    });
    const original = backend.selectDataFilePath.bind(backend);
    backend.selectDataFilePath = async (requestId) => {
      Reflect.set(window, "__cleanCsvSelectionCalled", true);
      const response = await original(requestId);
      if (!response || !("opened" in response)) return response;
      return {
        ...response,
        opened: response.opened.map((opened) => ({
          ...opened,
          summary: withoutStructuralIssues(opened.summary),
        })),
      };
    };
    const originalStatus = backend.getDataFileStatus.bind(backend);
    backend.getDataFileStatus = async (documentId, sessionId) => {
      const response = await originalStatus(documentId, sessionId);
      return "summary" in response
        ? { ...response, summary: withoutStructuralIssues(response.summary) }
        : withoutStructuralIssues(response);
    };
  });
}

export async function expectCleanCsvSelectionUsed(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__cleanCsvSelectionCalled")))
    .toBe(true);
}

export async function expectInsideViewport(locator: Locator): Promise<void> {
  const geometry = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
}

export async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const geometry = await page.locator("body").evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

export async function expectVisibleControlsInside(locator: Locator): Promise<void> {
  const clipped = await locator.evaluate((container) => {
    const parent = container.getBoundingClientRect();
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        "button, input, select, [role='checkbox'], [role='separator']",
      ),
    )
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
          left: bounds.left,
          right: bounds.right,
        };
      })
      .filter((control) => control.left < parent.left - 1 || control.right > parent.right + 1);
  });
  expect(clipped).toEqual([]);
}
