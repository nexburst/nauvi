/**
 * The app's tooltips (#483): every `title` shows as one styled tip, sooner
 * than the engine's and on keyboard focus too (components/Tooltips.svelte).
 * Here: where the tip goes, and how long it waits.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room kept between the tip, its anchor and the window's edges. */
export const TIP_GAP = 6;
export const TIP_MARGIN = 4;
/** The wait before a tip shows, and the shorter one right after another tip. */
export const TIP_DELAY_MS = 450;
export const TIP_QUICK_MS = 60;
/** How long after a tip hides the next one counts as "right after". */
export const TIP_WARM_MS = 600;

/** Under the anchor, centred on it, or above it when there is no room below; always inside the window. */
export function placeTip(
  anchor: Box,
  tip: { width: number; height: number },
  view: { width: number; height: number },
): { x: number; y: number; above: boolean } {
  const centre = anchor.x + anchor.width / 2;
  const x = Math.max(TIP_MARGIN, Math.min(centre - tip.width / 2, view.width - tip.width - TIP_MARGIN));
  const below = anchor.y + anchor.height + TIP_GAP;
  const fitsBelow = below + tip.height + TIP_MARGIN <= view.height;
  const aboveY = anchor.y - TIP_GAP - tip.height;
  if (fitsBelow || aboveY < TIP_MARGIN) {
    return { x, y: Math.max(TIP_MARGIN, Math.min(below, view.height - tip.height - TIP_MARGIN)), above: false };
  }
  return { x, y: aboveY, above: true };
}

/** The wait before showing a tip, given when the last one hid (0: never). */
export function tipDelay(now: number, lastHidden: number): number {
  return lastHidden > 0 && now - lastHidden < TIP_WARM_MS ? TIP_QUICK_MS : TIP_DELAY_MS;
}
