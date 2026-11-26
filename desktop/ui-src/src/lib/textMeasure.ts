// Text widths for the fitted table columns (#482), measured on a canvas in
// the font of an element, and cached: the same names and ages come back
// with every watch batch and every scroll.
import type { Measure } from "./columnFit";

const MAX_CACHED = 8000;

/**
 * A `Measure` for text drawn like `el`'s (its font, letter spacing and
 * text-transform). Without a canvas (tests outside a browser), about 7 px a
 * character.
 */
export function measurerFor(el: Element): Measure {
  const style = getComputedStyle(el);
  const ctx = document.createElement("canvas").getContext("2d");
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (ctx) ctx.font = font;
  const spacing = parseFloat(style.letterSpacing) || 0;
  const upper = style.textTransform === "uppercase";
  const cache = new Map<string, number>();
  return (text: string) => {
    let w = cache.get(text);
    if (w === undefined) {
      const t = upper ? text.toUpperCase() : text;
      // Rounded up a pixel: sub-pixel layout may draw it a little wider.
      w = Math.ceil((ctx ? ctx.measureText(t).width : t.length * 7) + spacing * t.length) + 1;
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(text, w);
    }
    return w;
  };
}

/** `fn(text, width)`, cached by both (a cut name is worked out once per
 *  column width, not on every redraw). */
export function cached(fn: (text: string, width: number) => string): ((text: string, width: number) => string) & {
  clear(): void;
} {
  const cache = new Map<string, string>();
  const get = (text: string, width: number) => {
    const k = `${width}\u0000${text}`;
    let v = cache.get(k);
    if (v === undefined) {
      v = fn(text, width);
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(k, v);
    }
    return v;
  };
  return Object.assign(get, { clear: () => cache.clear() });
}
