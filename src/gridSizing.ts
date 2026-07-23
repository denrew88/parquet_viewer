export const GRID_ROW_HEIGHT = 48;
export const GRID_HEADER_HEIGHT = 36;
export const GRID_ROW_NUMBER_WIDTH = 56;
export const GRID_DEFAULT_COLUMN_WIDTH = 180;
export const GRID_MIN_COLUMN_WIDTH = 80;
export const GRID_MAX_COLUMN_WIDTH = 800;
export const GRID_ROW_OVERSCAN = 8;
export const GRID_COLUMN_OVERSCAN = 3;
export const GRID_PREFETCH_DISTANCE = 40;
export const GRID_MAX_SEGMENT_ROWS = 200_000;
// WebView2 can paint an overlay scrollbar over the scrollable content. Keep the
// final row clear of that track even when clientHeight does not subtract it.
export const GRID_BOTTOM_CLEARANCE = 18;

export function segmentStartForRow(row: number, rowCount: number): number {
  if (rowCount <= GRID_MAX_SEGMENT_ROWS) return 0;
  const clampedRow = Math.min(Math.max(0, row), rowCount - 1);
  return Math.min(
    rowCount - GRID_MAX_SEGMENT_ROWS,
    Math.max(0, clampedRow - Math.floor(GRID_MAX_SEGMENT_ROWS / 2)),
  );
}

export function autoFitColumnWidth(
  header: string,
  displays: readonly (string | null | undefined)[],
  measure: (value: string, header: boolean) => number,
  allowance = 28,
): number {
  let width = measure(header, true);
  for (const display of displays) {
    if (display === null || display === undefined) continue;
    for (const line of display.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
      width = Math.max(width, measure(line, false));
    }
  }
  return Math.min(
    GRID_MAX_COLUMN_WIDTH,
    Math.max(GRID_MIN_COLUMN_WIDTH, Math.ceil(width + allowance)),
  );
}
