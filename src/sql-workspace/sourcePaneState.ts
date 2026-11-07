export const SOURCE_SEPARATOR_PX = 7;
export const MIN_TABLES_PX = 160;
export const MIN_COLUMNS_PX = 180;

export function sourcePaneBounds(totalHeight: number) {
  const available = Math.max(
    0,
    Math.floor(Number.isFinite(totalHeight) ? totalHeight : 0) - SOURCE_SEPARATOR_PX,
  );
  const min =
    available >= MIN_TABLES_PX + MIN_COLUMNS_PX
      ? MIN_TABLES_PX
      : Math.floor((available * MIN_TABLES_PX) / (MIN_TABLES_PX + MIN_COLUMNS_PX));
  const max = available >= MIN_TABLES_PX + MIN_COLUMNS_PX ? available - MIN_COLUMNS_PX : min;
  return { available, min, max };
}
export function clampSourcePane(totalHeight: number, preferred: number | null) {
  const bounds = sourcePaneBounds(totalHeight);
  const requested =
    preferred !== null && Number.isFinite(preferred) ? preferred : bounds.available * 0.32;
  return { ...bounds, top: Math.max(bounds.min, Math.min(bounds.max, Math.round(requested))) };
}
