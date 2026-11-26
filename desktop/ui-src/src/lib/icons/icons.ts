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

  // The sidebar (#481): its controls, and one icon per kind of object
  // (lib/kindIcons.ts says which kind takes which). A class of something
  // (IngressClass, StorageClass...) is a `tag`, a binding a `link`.
  /** Pin a kind to the top of the sidebar. */
  pin: ["M9 3.5h6", "M10 3.5v5.5l-3.5 4.5h11L14 9V3.5", "M12 13.5v7"],
  /** Filter a list. */
  filter: ["M4 5h16l-6 7.5v5.5l-4 2v-7.5z"],
  /** Collapse the sidebar to a rail of icons. */
  sidebarCollapse: [rect(3.5, 4.5, 17, 15, 2), "M9 4.5v15", "M15.5 9.5L13 12l2.5 2.5"],
  /** Expand the rail into the sidebar. */
  sidebarExpand: [rect(3.5, 4.5, 17, 15, 2), "M9 4.5v15", "M13 9.5l2.5 2.5-2.5 2.5"],
  /** Every kind of the cluster. */
  compass: [circle(12, 12, 9), "M15.5 8.5l-2 5-5 2 2-5z"],
  /** A cluster's Overview. */
  dashboard: [rect(3.5, 3.5, 7, 9, 1.5), rect(13.5, 3.5, 7, 5, 1.5), rect(3.5, 15.5, 7, 5, 1.5), rect(13.5, 11.5, 7, 9, 1.5)],
  /** Counts per kind (the Workloads overview). */
  bars: ["M5.5 20V11", "M12 20V4.5", "M18.5 20v-6.5"],
  /** Applications: workloads grouped by app. */
  apps: [rect(3.5, 3.5, 7, 7, 2), rect(13.5, 3.5, 7, 7, 2), rect(3.5, 13.5, 7, 7, 2), circle(17, 17, 3.5)],
  deployment: [rect(3.5, 8.5, 12, 12, 2), "M8.5 5.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-.5"],
  /** ReplicaSets, ReplicationControllers: copies of a pod. */
  replicas: [rect(3.5, 3.5, 7, 7, 1.5), rect(13.5, 3.5, 7, 7, 1.5), rect(8.5, 13.5, 7, 7, 1.5)],
  /** StatefulSets: pods that keep their data. */
  database: [
    "M5 6.5c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z",
    "M5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11",
    "M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  ],
  /** DaemonSets: a pod on every node. */
  daemon: [rect(3.5, 15, 17, 5, 1.5), rect(5, 5.5, 5.5, 5.5, 1.2), rect(13.5, 5.5, 5.5, 5.5, 1.2)],
  /** Jobs: run to completion. */
  job: ["M8 5.5v13l10-6.5z"],
  /** CronJobs: on a schedule. */
  calendar: [rect(3.5, 5, 17, 15.5, 2), "M3.5 10h17", "M8 3v4", "M16 3v4"],
  service: [
    circle(12, 12, 2.8),
    circle(12, 4.5, 1.8),
    circle(5, 18, 1.8),
    circle(19, 18, 1.8),
    "M12 9.2V6.3",
    "M9.8 13.7l-3.4 3.1",
    "M14.2 13.7l3.4 3.1",
  ],
  ingress: ["M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4", "M3.5 12H14", "M10 8l4 4-4 4"],
  /** Endpoints, EndpointSlices: where a Service sends traffic. */
  target: [circle(12, 12, 8.5), circle(12, 12, 4.5), `M12 12${DOT}`],
  /** Policies: NetworkPolicies, admission policies. */
  shield: ["M12 3.5l7.5 3v5.3c0 4.4-3.1 7.7-7.5 8.9-4.4-1.2-7.5-4.5-7.5-8.9V6.5z"],
  /** PodDisruptionBudgets: how many may go at once. */
  shieldCheck: ["M12 3.5l7.5 3v5.3c0 4.4-3.1 7.7-7.5 8.9-4.4-1.2-7.5-4.5-7.5-8.9V6.5z", "M8.8 12l2.2 2.2 4.2-4.2"],
  /** Port forwards: traffic both ways. */
  forward: ["M4 8h13", "M14 4.5L17.5 8 14 11.5", "M20 16H7", "M10 12.5L6.5 16l3.5 3.5"],
  /** ConfigMaps: a file of settings. */
  file: ["M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z", "M14 3.5V8h4.5", "M9 12.5h6", "M9 16h6"],
  secret: [circle(8, 15.5, 4), "M11 12.5l8.5-8.5", "M16.5 7l2.5 2.5", "M14 9.5l2 2"],
  /** HorizontalPodAutoscalers: more or fewer pods. */
  scale: ["M12 3.5v17", "M8.5 7L12 3.5 15.5 7", "M8.5 17l3.5 3.5 3.5-3.5", "M4 12h4", "M16 12h4"],
  /** ResourceQuotas: a share of the whole. */
  pie: [circle(12, 12, 8.5), "M12 3.5V12h8.5"],
  /** LimitRanges: bounds per container. */
  sliders: ["M4 7h8.5", "M17.5 7H20", circle(15, 7, 2.5), "M4 17h2.5", "M11.5 17H20", circle(9, 17, 2.5)],
  /** PriorityClasses. */
  flag: ["M5.5 21V3.5", "M5.5 4.5h12l-2.5 4 2.5 4h-12"],
  /** A class of something: IngressClass, StorageClass, DeviceClass. */
  tag: ["M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3-8.7 8.7z", `M8 8${DOT}`],
  /** Leases: held for a while. */
  hourglass: [
    "M6.5 3.5h11",
    "M6.5 20.5h11",
    "M7.5 3.5c0 4.5 9 5.5 9 8.5s-9 4-9 8.5",
    "M16.5 3.5c0 4.5-9 5.5-9 8.5s9 4 9 8.5",
  ],
  /** Webhook configurations: called on every change. */
  plug: ["M9 3.5v4", "M15 3.5v4", "M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z", "M12 16v4.5"],
  /** PersistentVolumes: a disk. */
  volume: [rect(3.5, 13, 17, 7, 2), `M7.5 16.5${DOT}`, "M4.5 13.5L7 5.5h10l2.5 8"],
  /** PersistentVolumeClaims: a disk asked for. */
  volumeClaim: [rect(3.5, 13, 17, 7, 2), `M7.5 16.5${DOT}`, "M12 3.5v6.5", "M9 7.5l3 3 3-3"],
  /** Events: what happened. */
  activity: ["M3.5 12h4l2.5-6.5 4 13 2.5-6.5h4"],
  /** ServiceAccounts: who a pod acts as. */
  user: [circle(12, 8, 3.8), "M4.5 20.5a7.5 7.5 0 0 1 15 0"],
  /** Roles, ClusterRoles: what may be done. */
  role: [rect(3.5, 5, 17, 14, 2), circle(9, 10.5, 2.2), "M5.8 16a3.5 3.5 0 0 1 6.4 0", "M14.5 10h3", "M14.5 13.5h3"],
  /** Bindings: who gets a role. */
  link: [
    "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1",
    "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  ],
  /** Helm releases. */
  helm: [
    circle(12, 12, 6),
    circle(12, 12, 2),
    "M12 10V3",
    "M12 14v7",
    "M10 12H3",
    "M14 12h7",
    "M10.59 10.59L5.64 5.64",
    "M13.41 13.41l4.95 4.95",
    "M13.41 10.59l4.95-4.95",
    "M10.59 13.41l-4.95 4.95",
  ],
  /** Helm charts: a package. */
  package: [rect(3.5, 8, 17, 12.5, 1.5), "M3.5 8L6 3.5h12L20.5 8", "M12 3.5V8", "M9.5 12h5"],
  /** CustomResourceDefinitions. */
  braces: [
    "M8.5 4C6.5 4 6 5 6 6.5v3c0 1.2-.8 2.5-2.2 2.5 1.4 0 2.2 1.3 2.2 2.5v3C6 19 6.5 20 8.5 20",
    "M15.5 4c2 0 2.5 1 2.5 2.5v3c0 1.2.8 2.5 2.2 2.5-1.4 0-2.2 1.3-2.2 2.5v3c0 1.5-.5 2.5-2.5 2.5",
  ],
  /** Custom resources and kinds nauvi does not know. */
  shapes: [circle(7.5, 7.5, 3.5), rect(13.5, 4, 7, 7, 1.2), "M12 20.5l-4.5-7h9z"],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;
