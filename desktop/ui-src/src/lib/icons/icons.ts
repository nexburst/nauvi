// nauvi's one icon set (#480): line icons drawn on a 24x24 grid, as path
// data only, rendered by `Icon.svelte` with the stroke of the text around
// them (`currentColor`, `--icon-stroke`, round caps and joins). No icon
// font, no runtime dependency, nothing fetched.
//
// Use: `<Icon name="pod" />`, sized with `size` (16 by default; the
// `--icon-sm`, `--icon` and `--icon-lg` tokens in app.css are the sizes to
// pick from). An icon next to text is decoration: it stays `aria-hidden`.
// An icon alone on a button gets the button's `aria-label`, or a `title`.
//
// Adding one: add a key below with its paths, drawn on the same grid
// (keep 2 units clear of the edges, strokes not fills, a dot is `h.01`),
// and say what it stands for. Use the same icon for the same thing
// everywhere (a pod is always `pod`). The keys are the names `Icon` takes.

/** A circle as path data, so every icon is a list of paths. */
export function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

/** A rectangle with rounded corners (radius `r`) as path data. */
export function rect(x: number, y: number, w: number, h: number, r = 0): string {
  if (r <= 0) return `M${x} ${y}h${w}v${h}h${-w}z`;
  const a = (dx: number, dy: number) => `a${r} ${r} 0 0 1 ${dx} ${dy}`;
  return (
    `M${x + r} ${y}h${w - 2 * r}${a(r, r)}v${h - 2 * r}${a(-r, r)}` +
    `h${-(w - 2 * r)}${a(-r, -r)}v${-(h - 2 * r)}${a(r, -r)}z`
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A cog: `teeth` teeth between radius `inner` and `outer`, centred on 12,12. */
export function gear(teeth: number, inner: number, outer: number): string {
  const step = (2 * Math.PI) / teeth;
  const at = (r: number, a: number) => `${round(12 + r * Math.cos(a))} ${round(12 + r * Math.sin(a))}`;
  // Each tooth spans 40% of its step at the root and 26% at the tip.
  const root = step * 0.2;
  const tip = step * 0.13;
  let d = `M${at(inner, -root)}`;
  for (let i = 0; i < teeth; i++) {
    const c = i * step;
    d += `L${at(outer, c - tip)}L${at(outer, c + tip)}L${at(inner, c + root)}`;
    d += `A${inner} ${inner} 0 0 1 ${at(inner, c + step - root)}`;
  }
  return `${d}z`;
}

const DOT = "h.01";

export const ICONS = {
  // Navigation and the top bar.
  /** History: back. */
  arrowLeft: ["M19 12H5", "M11 6l-6 6 6 6"],
  /** History: forward. */
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  chevronRight: ["M9.5 6l6 6-6 6"],
  chevronDown: ["M6 9.5l6 6 6-6"],
  /** The palette, "Go to". */
  search: [circle(11, 11, 6.5), "M20 20l-4.2-4.2"],
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66L20 8.7", "M20 3.5v5.2h-5.2"],
  settings: [gear(8, 7.4, 9.6), circle(12, 12, 3)],
  help: [circle(12, 12, 9), "M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1.1.8-1.1 1.5v.6", `M12 16.9${DOT}`],
  bell: ["M6 10a6 6 0 0 1 12 0c0 4.5 1.5 6 2 7H4c.5-1 2-2.5 2-7z", "M10 20a2 2 0 0 0 4 0"],
  /** Ask AI. */
  sparkles: [
    "M11 3.5l1.8 4.7 4.7 1.8-4.7 1.8L11 16.5l-1.8-4.7L4.5 10l4.7-1.8z",
    "M18 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  ],
  /** The cluster catalog. */
  grid: [rect(4, 4, 6.5, 6.5, 1.2), rect(13.5, 4, 6.5, 6.5, 1.2), rect(4, 13.5, 6.5, 6.5, 1.2), rect(13.5, 13.5, 6.5, 6.5, 1.2)],
  /** Opens in a new window. */
  external: ["M14 4h6v6", "M20 4l-8.5 8.5", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"],
  close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],

  // Kubernetes objects.
  /** A pod (and the pod count). */
  pod: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"],
  /** A node. */
  node: [rect(4, 4, 16, 7, 1.5), rect(4, 13, 16, 7, 1.5), `M8 7.5${DOT}`, `M8 16.5${DOT}`],
  /** A namespace. */
  namespace: ["M12 3.5l8.5 4.5-8.5 4.5L3.5 8z", "M3.5 12l8.5 4.5 8.5-4.5", "M3.5 16l8.5 4.5 8.5-4.5"],

  // States: the same icon, the same meaning (with --green, --amber, --red).
  /** Running, healthy, done right. */
  ok: [circle(12, 12, 9), "M8.3 12.3l2.5 2.5 4.9-5"],
  /** Pending, waiting. */
  pending: [circle(12, 12, 9), "M12 7.5V12l3 2"],
  /** An error that needs a look. */
  error: [circle(12, 12, 9), "M12 7.5v5.2", `M12 16.3${DOT}`],
  /** Failed for good. */
  failed: [circle(12, 12, 9), "M9.2 9.2l5.6 5.6", "M14.8 9.2l-5.6 5.6"],
  /** Completed (a Job's pods). */
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  /** A warning event. */
  warning: ["M12 4L21 19.5H3z", "M12 10v4", `M12 16.9${DOT}`],

  // Actions and sections.
  /** A pod's logs. */
  logs: ["M4 6h16", "M4 10h16", "M4 14h11", "M4 18h7"],
  /** A shell in a pod (#482). */
  terminal: [rect(3, 4.5, 18, 15, 2), "M7.5 10l3 2.5-3 2.5", "M13 15h3.5"],
  /** Edit an object's YAML (#482). */
  edit: ["M13 20h7", "M16.5 4a2.1 2.1 0 0 1 3 3L8 18.5l-4 1 1-4z"],
  /** Describe: the object's detail panel. */
  describe: [rect(3.5, 4.5, 17, 15, 2), "M14.5 4.5v15", "M6.8 9h4.4", "M6.8 12.5h4.4"],
  /** Capacity: requests against what the nodes can allocate. */
  gauge: ["M4.6 17.5a8.5 8.5 0 1 1 14.8 0", "M12 13.5l4-4", `M12 13.5${DOT}`],
  cpu: [
    rect(6, 6, 12, 12, 1.5),
    rect(9.5, 9.5, 5, 5, 0.6),
    "M9.5 3v3",
    "M14.5 3v3",
    "M9.5 18v3",
    "M14.5 18v3",
    "M3 9.5h3",
    "M3 14.5h3",
    "M18 9.5h3",
    "M18 14.5h3",
  ],
  memory: [rect(3, 6.5, 18, 10, 1.5), "M7.5 10v3", "M12 10v3", "M16.5 10v3", "M6.5 16.5v3", "M12 16.5v3", "M17.5 16.5v3"],
  /** Lists, tables. */
  list: ["M9 6h11", "M9 12h11", "M9 18h11", `M4.5 6${DOT}`, `M4.5 12${DOT}`, `M4.5 18${DOT}`],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;
