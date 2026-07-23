export function normalizedIdOrder(
  availableIds: readonly string[],
  preferredIds: readonly string[],
): string[] {
  const available = new Set(availableIds);
  const seen = new Set<string>();
  const ordered = preferredIds.filter((id) => {
    if (!available.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const id of availableIds) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

export function moveId(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function moveIdBefore(ids: readonly string[], movingId: string, targetId: string): string[] {
  if (movingId === targetId || !ids.includes(movingId) || !ids.includes(targetId)) return [...ids];
  const next = ids.filter((id) => id !== movingId);
  next.splice(next.indexOf(targetId), 0, movingId);
  return next;
}

export function restoreSourceOrder(
  sourceIds: readonly string[],
  appliedIds: readonly string[],
): string[] {
  const applied = new Set(appliedIds);
  const restored = sourceIds.filter((id) => applied.has(id));
  const known = new Set(restored);
  for (const id of appliedIds) {
    if (!known.has(id)) {
      restored.push(id);
      known.add(id);
    }
  }
  return restored;
}

export function columnReflowOffsets(
  appliedIds: readonly string[],
  previewIds: readonly string[],
  widths: Readonly<Record<string, number>>,
): Record<string, number> {
  const starts = (ids: readonly string[]) => {
    const result: Record<string, number> = {};
    let offset = 0;
    for (const id of ids) {
      result[id] = offset;
      offset += widths[id] ?? 0;
    }
    return result;
  };
  const appliedStarts = starts(appliedIds);
  const previewStarts = starts(previewIds);
  return Object.fromEntries(
    appliedIds.map((id) => [
      id,
      (previewStarts[id] ?? appliedStarts[id] ?? 0) - (appliedStarts[id] ?? 0),
    ]),
  );
}
