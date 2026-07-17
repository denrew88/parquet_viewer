export const GRID_PAGE_COLUMN_LIMIT = 64;

export function sameProjectedColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

export function orderedProjectionForWindow(
  logicalColumns: readonly string[],
  mountedLogicalOrdinals: readonly number[],
  currentProjection: readonly string[],
): string[] {
  if (logicalColumns.length === 0) return [];
  const mounted = mountedLogicalOrdinals.filter(
    (ordinal) => ordinal >= 0 && ordinal < logicalColumns.length,
  );
  if (mounted.length === 0) {
    return currentProjection.length > 0
      ? [...currentProjection]
      : logicalColumns.slice(0, GRID_PAGE_COLUMN_LIMIT);
  }
  const current = new Set(currentProjection);
  if (
    currentProjection.length <= GRID_PAGE_COLUMN_LIMIT &&
    mounted.every((ordinal) => current.has(logicalColumns[ordinal]))
  ) {
    return [...currentProjection];
  }
  const lastMounted = Math.max(...mounted);
  const start = Math.min(
    Math.max(0, lastMounted - GRID_PAGE_COLUMN_LIMIT + 1),
    Math.max(0, logicalColumns.length - GRID_PAGE_COLUMN_LIMIT),
  );
  const selected = new Set(mounted.slice(0, GRID_PAGE_COLUMN_LIMIT));
  for (
    let ordinal = start;
    ordinal < logicalColumns.length && selected.size < GRID_PAGE_COLUMN_LIMIT;
    ordinal += 1
  ) {
    selected.add(ordinal);
  }
  for (
    let ordinal = start - 1;
    ordinal >= 0 && selected.size < GRID_PAGE_COLUMN_LIMIT;
    ordinal -= 1
  ) {
    selected.add(ordinal);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((ordinal) => logicalColumns[ordinal]);
}
