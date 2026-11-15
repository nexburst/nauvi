// The width a scroller's vertical scrollbar takes from its rows, so a table
// header outside the scroller can leave the same space and keep its columns
// over the cells (#123). Chromium reserves a gutter (`scrollbar-gutter:
// stable`); WebKitGTK's overlay scrollbars take none.

/** Pixels between the scroller's border box and its content (0 if none). */
export function gutterWidth(el: { offsetWidth: number; clientWidth: number }): number {
  return Math.max(0, el.offsetWidth - el.clientWidth);
}

/**
 * Call `set` with `el`'s gutter now and whenever it may change (the scroller
 * resizes, a classic scrollbar comes or goes). Returns the stop function.
 */
export function watchGutter(el: HTMLElement, set: (px: number) => void): () => void {
  set(gutterWidth(el));
  if (typeof ResizeObserver === "undefined") return () => {};
  const ro = new ResizeObserver(() => set(gutterWidth(el)));
  ro.observe(el);
  return () => ro.disconnect();
}
