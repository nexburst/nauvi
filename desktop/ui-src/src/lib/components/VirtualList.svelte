<script lang="ts">
  import { untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { get } from "svelte/store";
  import { createVirtualizer } from "@tanstack/svelte-virtual";

  interface Props {
    count: number;
    /** Row height in px (the estimate when `dynamic`). */
    rowHeight?: number;
    /**
     * Stable key of row `i`. Pass a new function whenever the data behind it
     * changes so the virtualizer re-reads the keys.
     */
    getKey: (index: number) => string | number;
    row: Snippet<[number]>;
    /** Measure rows instead of assuming `rowHeight` (wrapped log lines). */
    dynamic?: boolean;
    overscan?: number;
    /** Allow horizontal scrolling (unwrapped log lines). */
    scrollX?: boolean;
    scrollEl?: HTMLDivElement | null;
    onscroll?: (e: Event) => void;
  }

  let {
    count,
    rowHeight = 28,
    getKey,
    row,
    dynamic = false,
    overscan = 10,
    scrollX = false,
    scrollEl = $bindable(null),
    onscroll,
  }: Props = $props();

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
  });

  // Push the changed count / keys into the virtualizer. `get()` + `untrack`
  // keep this effect from re-triggering itself through the store.
  $effect(() => {
    const c = count;
    const keyFn = getKey;
    const over = overscan;
    void scrollEl;
    untrack(() => get(virtualizer).setOptions({ count: c, getItemKey: keyFn, overscan: over }));
  });

  // A new row height (Settings → Tables, #330): drop the sizes measured
  // with the old one.
  let lastHeight = untrack(() => rowHeight);
  $effect(() => {
    const h = rowHeight;
    if (h === lastHeight) return;
    lastHeight = h;
    untrack(() => {
      const v = get(virtualizer);
      v.setOptions({ estimateSize: () => h });
      v.measure();
    });
  });

  function measure(node: HTMLElement) {
    if (dynamic) get(virtualizer).measureElement(node);
  }

  export function scrollToBottom() {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  export function scrollToTop() {
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  /** Scroll just enough to show row `index` (keyboard focus), or put it at `align`. */
  export function scrollToIndex(index: number, align: "auto" | "start" | "center" = "auto") {
    if (index >= 0 && index < count) get(virtualizer).scrollToIndex(index, { align });
  }

  /**
   * Drop a `scrollToIndex` that is still settling: the virtualizer re-checks
   * its target index for a few frames, and once rows are removed above, that
   * index points at another row (#317).
   */
  export function cancelScroll() {
    get(virtualizer).cancelScroll();
  }
</script>

<div class="scroller" class:scroll-x={scrollX} bind:this={scrollEl} {onscroll}>
  <div class="sizer" style:height="{$virtualizer.getTotalSize()}px">
    {#each $virtualizer.getVirtualItems() as vi (vi.key)}
      <div
        class="vrow"
        data-index={vi.index}
        style:transform="translateY({vi.start}px)"
        style:height={dynamic ? undefined : `${vi.size}px`}
        use:measure
      >
        {@render row(vi.index)}
      </div>
    {/each}
  </div>
</div>

<style>
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    position: relative;
  }
  .scroller.scroll-x {
    overflow-x: auto;
  }
  .sizer {
    position: relative;
    width: 100%;
  }
  .vrow {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
  }
</style>
