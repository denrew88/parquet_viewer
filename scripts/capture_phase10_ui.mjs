import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "artifacts", "phase-10", "ui");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:1420";
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1024, height: 768 },
  { name: "minimum", width: 800, height: 600 },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.evaluate(() => window.history.replaceState(null, "", "/?mock=oes"));
    await page.getByRole("button", { name: "Open file" }).click();
    await page.getByRole("tab", { name: "spectrometer.oes.h5" }).waitFor();

    const grid = page.getByRole("grid", { name: "Data preview" });
    await grid.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      element.dispatchEvent(new Event("scroll"));
    });
    await grid.getByRole("columnheader", { name: "463" }).waitFor();
    const finalCell = grid.locator('[data-grid-row="0"][data-grid-column="64"]');
    await finalCell.click();

    const geometry = await page.evaluate(() => {
      const grid = document.querySelector('[role="grid"][aria-label="Data preview"]');
      const shell = document.querySelector(".virtual-grid-shell");
      const header = document.querySelector('[role="columnheader"][data-column-index="64"]');
      const cell = document.querySelector('[role="gridcell"][data-grid-column="64"]');
      if (!(grid instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
        throw new Error("OES grid was not rendered.");
      }
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      };
      const headerRect = rect(header);
      const cellRect = rect(cell);
      return {
        body: {
          clientWidth: document.body.clientWidth,
          scrollWidth: document.body.scrollWidth,
        },
        cell: cellRect,
        columnAlignmentError:
          headerRect && cellRect
            ? Math.max(
                Math.abs(headerRect.left - cellRect.left),
                Math.abs(headerRect.width - cellRect.width),
              )
            : null,
        grid: {
          ariaColumnCount: grid.getAttribute("aria-colcount"),
          mountedCells: Number(grid.dataset.mountedCells),
          mountedColumns: Number(grid.dataset.mountedColumns),
          mountedRows: Number(grid.dataset.mountedRows),
          selection: {
            bottom: grid.dataset.selectionBottom,
            left: grid.dataset.selectionLeft,
            right: grid.dataset.selectionRight,
            top: grid.dataset.selectionTop,
          },
        },
        header: headerRect,
        shell: rect(shell),
        viewport: { height: window.innerHeight, width: window.innerWidth },
      };
    });
    results.push({ name: viewport.name, ...geometry });
    await page.screenshot({
      path: path.join(output, `browser-${viewport.name}.png`),
      fullPage: true,
    });
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(
  path.join(output, "geometry-results.json"),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2)}\n`,
  "utf8",
);
