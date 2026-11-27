// The order of a table's columns (#547), remembered per kind as a list of
// column keys (`KindSettings.order`).

/**
 * `cols` in the user's `order`. A column `order` does not name (new in a
 * later version, or added since) stays right after the column it follows
 * in the kind's own order, or first when it is first there. Keys in `order`
 * that no longer exist are ignored.
 */
export function orderColumns<T extends { key: string }>(cols: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...cols];
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const out: T[] = [];
  for (const key of order) {
    const c = byKey.get(key);
    if (c && !out.includes(c)) out.push(c);
  }
  cols.forEach((c, i) => {
    if (out.includes(c)) return;
    const before = i > 0 ? out.indexOf(cols[i - 1]) : -1;
    out.splice(before + 1, 0, c);
  });
  return out;
}

/** `keys` with `key` moved `delta` places (clamped to the ends). */
export function moveKey(keys: readonly string[], key: string, delta: number): string[] {
  const from = keys.indexOf(key);
  if (from < 0) return [...keys];
  const to = Math.max(0, Math.min(keys.length - 1, from + delta));
  return moveTo(keys, key, to);
}

/** `keys` with `key` moved to index `to` (of the list without it). */
export function moveTo(keys: readonly string[], key: string, to: number): string[] {
  const rest = keys.filter((k) => k !== key);
  if (rest.length === keys.length) return [...keys];
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** Whether `order` puts `cols` in another order than their own. */
export function orderChanged(cols: readonly { key: string }[], order: readonly string[]): boolean {
  const ordered = orderColumns(cols, order);
  return ordered.some((c, i) => c !== cols[i]);
}
